/**
 * Delegation fallback loop for `router/auto`.
 *
 * Walks the ranked fallback chain produced by the scorer, attempts each model
 * in turn, and pumps stream events back to the caller until one candidate
 * succeeds or the chain is exhausted. Handles auth probing, bounded same-model
 * retries on transient provider errors, per-model blacklisting, provider
 * circuit-breaking, first-event timeouts, and provider-specific base-url
 * resolution (e.g. GitHub Copilot proxy endpoints).
 */
import { streamSimple } from '@earendil-works/pi-ai/compat';
import {
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { ROUTER_PROVIDER_ID } from './types.js';
import type { Candidate, Dimension, RoutingDecision } from './types.js';
import { blacklistModel, blacklistProvider } from './blacklist.js';
import {
  addAccumulatedCost,
  getAccumulatedCost,
  getLastNotifiedModel,
  setLastNotifiedModel,
  setLastServed,
  updateLastServed,
  setLastDecision,
} from './router-session-state.js';
import { renderRouterStatus, notifyRouting, type ServedInfo } from './ui.js';
import { debugLog, startTimer } from './debuglog.js';
import { appendDecision } from './decisionlog.js';
import { makeTerminalErrorEvent } from './error-event.js';
import { appendRouteUpGuidance } from './escalation.js';
import {
  clampEffortToFloor,
  isValidEscalationCandidate,
  levelFrom,
  parseCandidateKey,
  resolveThinkingLevel,
} from './scorer.js';
import { isUsageLimitErrorMessage } from './usage-limit.js';
import { priceTokens } from './baseline.js';

const AUTH_RESOLVE_TIMEOUT_MS = 5000;
const FIRST_EVENT_TIMEOUT_MS = 30000;
const MAX_FAILURES_PER_PROVIDER = 3;
/** Same-model retries for a transient provider error (overload/5xx/network). */
const MAX_TRANSIENT_RETRIES = 2;
/** Same-model retries for a generic provider error (e.g. `finish_reason: error`). */
const MAX_GENERIC_RETRIES = 1;
/** Cap on pre-output events buffered for one attempt. Overflow with thinking
 * already in the buffer commits to live streaming; overflow of pure lifecycle
 * spam fails the candidate. */
const MAX_BUFFERED_EVENTS = 10_000;

let authResolveTimeoutMs = AUTH_RESOLVE_TIMEOUT_MS;
let firstEventTimeoutMs = FIRST_EVENT_TIMEOUT_MS;
let retryBackoffMs = 400;

/** Test seam: override delegation timeouts. Call with no args to reset. */
export function setDelegationTimeouts(opts?: { authMs?: number; firstEventMs?: number; retryBackoffMs?: number }): void {
  authResolveTimeoutMs = opts?.authMs ?? AUTH_RESOLVE_TIMEOUT_MS;
  firstEventTimeoutMs = opts?.firstEventMs ?? FIRST_EVENT_TIMEOUT_MS;
  retryBackoffMs = opts?.retryBackoffMs ?? 400;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Abortable retry delay: rejects promptly on signal abort (listener removed). */
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error('aborted')));
    timer = setTimeout(() => finish(() => resolve()), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Best-effort iterator cleanup. Never awaits: a hung stream's `return()`
 * may never resolve, and awaiting it would re-block the timeout-driven
 * fallback. A rejecting `return()` is handled so it cannot leak as an
 * unhandled rejection. */
function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const ret = iterator.return?.();
    if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
      (ret as PromiseLike<unknown>).then(undefined, () => {
        // Swallow a rejecting cleanup; it must not replace the original failure.
      });
    }
  } catch {
    // A synchronous cleanup throw is best-effort and never fatal.
  }
}

export interface DelegationOptions {
  /** The routed decision with fallback chain. */
  decision: RoutingDecision;
  /** Pi's model registry for this session. */
  registry: ExtensionContext['modelRegistry'];
  /** Streaming context (messages, etc.). */
  context: Context;
  /** Passthrough SimpleStreamOptions from the router provider. */
  options: SimpleStreamOptions | undefined;
  /** Requested/selected thinking level for the current turn. */
  reasoning?: string;
  /**
   * True when `reasoning` came from an explicit user/session request rather
   * than the router's own choice. An explicit request always wins: chain
   * entries must not override it with their own measured efforts.
   */
  userReasoningOverride?: boolean;
  /** Per-session Pi extension context, for status widget updates. */
  extensionContext: ExtensionContext | undefined;
  /** When true, add route_up guidance only to attempts with a valid target. */
  enableRouteUpGuidance?: boolean;
  /** When true, show a TUI notification on a model pick/switch (config.prompt). */
  notifyOnRoute?: boolean;
  /** Total-turn timer, used for final debug log timestamps. */
  turnTimer: () => number;
}

export interface DelegationResult {
  /** True if a model produced visible content before the turn failed. */
  success: boolean;
  /**
   * True if the loop already finalized the stream (emitted a terminal error
   * and called stream.end()). The caller must not push further events or
   * call stream.end() again when this is set.
   */
  streamFinalized: boolean;
  lastError?: string;
  lastServed?: ServedInfo;
}

/**
 * The chain entry's own measured effort wins over the turn-level reasoning
 * (a fallback to a different effort of the same model is a legitimate chain
 * step); it is still clamped to the dimension floor (rule 3) and to the
 * entry model's support. Entries without an effort inherit the turn-level
 * reasoning. An explicit user/session reasoning always wins — the router
 * fills a gap, it does not override an instruction.
 *
 * Router-chosen efforts use an up-only walk (levelFrom) so a gap in the
 * model's thinkingLevelMap never resolves below the floor (rule 3). An
 * explicit user request uses the nearest-first walk so the user's choice is
 * honoured as closely as the model supports.
 */
function resolveAttemptEffort(
  entryEffort: ModelThinkingLevel | undefined,
  effortFloorDimension: Dimension,
  userReasoningOverride: boolean | undefined,
  chosen: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'>,
  turnReasoning: string | undefined,
): ModelThinkingLevel | undefined {
  if (entryEffort != null && !userReasoningOverride) {
    const clamped = clampEffortToFloor(entryEffort, effortFloorDimension);
    return levelFrom(clamped, chosen);
  }
  return resolveThinkingLevel(
    chosen,
    typeof turnReasoning === 'string' ? (turnReasoning as ThinkingLevel) : undefined,
    effortFloorDimension,
  );
}

/**
 * Buffer one attempt's events until the candidate proves itself. A failed
 * candidate's pre-output events must never reach Pi: Pi finalizes the turn
 * on the first terminal `done` it sees, so an answerless `done` would persist
 * an empty assistant message and drop the fallback. Once meaningful output
 * has streamed, forwarding is live — partial output is never replayed.
 *
 * `isServedOutputEvent` is checked before the cap: a candidate whose first
 * answer arrives exactly at the boundary must serve, never fail. Overflow
 * with thinking already in the buffer commits to live streaming; overflow
 * of pure lifecycle spam fails the candidate. The overflowing event itself
 * does not count as buffered thinking — `bufferHasThinking` is set after
 * the cap check.
 */
function createAttemptBuffer(
  stream: AssistantMessageEventStream,
  candidateId: string,
) {
  const attemptBuffer: unknown[] = [];
  let passthrough = false;
  let bufferHasThinking = false;
  let committedToStream = false;

  const flush = (): void => {
    for (const buffered of attemptBuffer) stream.push(buffered as never);
    attemptBuffer.length = 0;
  };
  const discard = (): void => {
    attemptBuffer.length = 0;
  };
  const forward = (ev: unknown): void => {
    if (passthrough) {
      stream.push(ev as never);
      return;
    }
    if (isServedOutputEvent((ev as { type: string }).type)) {
      passthrough = true;
      flush();
      stream.push(ev as never);
      return;
    }
    if (attemptBuffer.length >= MAX_BUFFERED_EVENTS) {
      if (bufferHasThinking) {
        passthrough = true;
        committedToStream = true;
        flush();
        stream.push(ev as never);
        return;
      }
      throw new Error(
        `candidate emitted more than ${MAX_BUFFERED_EVENTS} events before meaningful output: ${candidateId}`,
      );
    }
    if ((ev as { type: string }).type === 'thinking_delta') bufferHasThinking = true;
    attemptBuffer.push(ev);
  };

  return {
    forward,
    flush,
    discard,
    get committedToStream(): boolean {
      return committedToStream;
    },
  };
}

/**
 * In-stream terminal interpretation. Output-limit `done` and pre-content
 * `error` throw before `forward()` so their events never reach the consumer.
 * Answerless completion is a later, post-loop gate — a clean iterator can
 * finish with no `done`, and a live `done` after thinking-overflow commit
 * must still be forwarded.
 */
function classifyTerminalEvent(
  event: { type: string },
  visibleTextReceived: boolean,
  toolCallReceived: boolean,
  candidateId: string,
):
  | { kind: 'none' }
  | { kind: 'output-limit' }
  | {
      kind: 'provider-error';
      error: { stopReason?: string; errorMessage?: string } | undefined;
      message: string;
    } {
  if (event.type === 'done') {
    const message = (event as unknown as {
      message?: { stopReason?: string };
    }).message;
    if (
      message?.stopReason === 'length' &&
      !visibleTextReceived &&
      !toolCallReceived
    ) {
      return { kind: 'output-limit' };
    }
    return { kind: 'none' };
  }
  if (event.type === 'error' && !visibleTextReceived && !toolCallReceived) {
    const error = (event as unknown as {
      error?: { stopReason?: string; errorMessage?: string };
    }).error;
    return {
      kind: 'provider-error',
      error,
      message: errorEventMessage(event) ?? `Model failed before sending content: ${candidateId}`,
    };
  }
  return { kind: 'none' };
}

/**
 * Price this attempt's tokens onto the parent-owned turn accumulator at
 * registry $/token. Provider-reported `cost.total` is a separate cross-check
 * (a different scale, often zero for subscription providers) and is never
 * mixed into routed spend.
 */
function accumulateAttemptUsage(
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  } | undefined,
  modelCost: Candidate['cost'] | undefined,
  acc: {
    routedCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): void {
  if (!usage) return;
  if (usage.cost?.total) {
    addAccumulatedCost(usage.cost.total);
  }
  const attemptCost = priceTokens(
    modelCost,
    {
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    },
  );
  if (attemptCost != null) acc.routedCost += attemptCost;
  acc.inputTokens += usage.input ?? 0;
  acc.outputTokens += usage.output ?? 0;
  acc.cacheReadTokens += usage.cacheRead ?? 0;
  acc.cacheWriteTokens += usage.cacheWrite ?? 0;
}

/**
 * Walk decision after a pre-content catch. Abort is request lifecycle and
 * stays in the catch above this. `finalize` is the replay lock: visible
 * text, a tool call, or a thinking-overflow commit already reached the
 * consumer. Usage-limit is first among remaining cases so a 429 is never
 * retried as transient.
 */
function decideAfterFailure(
  visibleTextReceived: boolean,
  toolCallReceived: boolean,
  committedToStream: boolean,
  errorMessageObj: { stopReason?: string; errorMessage?: string } | undefined,
  message: string,
  tries: number,
):
  | { action: 'finalize' }
  | { action: 'provider-dead' }
  | { action: 'retry'; transient: boolean }
  | { action: 'next-candidate'; transient: boolean } {
  if (visibleTextReceived || toolCallReceived || committedToStream) {
    return { action: 'finalize' };
  }
  const isProviderError = errorMessageObj?.stopReason === 'error';
  if (isProviderError && isUsageLimitErrorMessage(errorMessageObj?.errorMessage ?? message)) {
    return { action: 'provider-dead' };
  }
  const transient =
    isProviderError && isRetryableAssistantError(errorMessageObj as unknown as AssistantMessage);
  const maxRetries = transient
    ? MAX_TRANSIENT_RETRIES
    : isProviderError
      ? MAX_GENERIC_RETRIES
      : 0;
  if (tries < maxRetries) return { action: 'retry', transient };
  return { action: 'next-candidate', transient };
}

/**
 * Record the model that actually produced this turn's first answer.
 * First assignment must use the setter, not `updateLastServed`: the turn
 * starts with `setLastServed(undefined)`, and `updateLastServed` is a no-op
 * patch while state is undefined. Notify against `lastNotifiedModel`, not
 * `lastChosenRegistryId`, because the provider already recorded this turn's
 * decision before delegation starts.
 */
function recordServedAttempt(args: {
  decision: RoutingDecision;
  candidateId: string;
  candidateIndex: number;
  provider: string;
  modelId: string;
  effectiveReasoning: ModelThinkingLevel | undefined;
  optionsReasoning: string | undefined;
  notifyOnRoute: boolean | undefined;
  extensionContext: ExtensionContext | undefined;
}): { lastServed: ServedInfo; finalDecision: RoutingDecision } {
  const viaFallback = args.candidateIndex > 0;
  const baseDecision = viaFallback
    ? {
        ...args.decision,
        chosen: args.candidateId,
        cause: 'error-fallback' as const,
        reason: `${args.decision.reason}; fallback served after an earlier candidate failed`,
        fallbackChain: [
          ...new Set([
            ...args.decision.fallbackChain.slice(args.candidateIndex),
            ...args.decision.fallbackChain.slice(0, args.candidateIndex),
          ]),
        ],
      }
    : args.decision;
  // Terminal capability is scored for every candidate up front, but only
  // the model that actually streams the turn's output has "served"
  // capability — fallback can substitute a lower-tier sibling.
  const servedCandidateCapability = baseDecision.multiWork?.candidateCapability[args.candidateId];
  const finalMultiWork = baseDecision.multiWork && servedCandidateCapability
    ? {
        ...baseDecision.multiWork,
        servedCandidateKey: args.candidateId,
        servedCapability: servedCandidateCapability,
      }
    : baseDecision.multiWork;
  const finalDecision = finalMultiWork
    ? { ...baseDecision, multiWork: finalMultiWork }
    : baseDecision;
  const lastServed: ServedInfo = {
    registryId: `${args.provider}/${args.modelId}`,
    thinkingLevel: (args.effectiveReasoning ?? args.optionsReasoning) as string | undefined,
    viaFallback,
    fallbackRank: viaFallback ? args.candidateIndex + 1 : undefined,
    accumulatedCost: getAccumulatedCost(),
    ...(finalMultiWork?.servedCapability
      ? {
          capability: {
            providerInvocation: finalMultiWork.providerInvocation,
            terminalFloor: finalMultiWork.terminalFloor,
            terminalCapableInScoringSet: finalMultiWork.terminalCapableInScoringSet,
            candidate: finalMultiWork.servedCapability,
          },
        }
      : {}),
  };
  setLastServed(lastServed);
  setLastDecision(finalDecision);
  renderRouterStatus(args.extensionContext, finalDecision, lastServed);
  if (args.notifyOnRoute && args.candidateId !== getLastNotifiedModel()) {
    notifyRouting(args.extensionContext, finalDecision, lastServed);
  }
  setLastNotifiedModel(args.candidateId);
  return { lastServed, finalDecision };
}

/**
 * Run the fallback delegation walk and pump stream events into `stream`.
 *
 * On success, returns with streamFinalized false and the caller should end
 * the stream. If a candidate emits visible content and then errors, this
 * function finalizes the stream itself and returns streamFinalized true. If
 * every candidate is exhausted, it returns streamFinalized false so the
 * caller can emit its own terminal error.
 */
export async function runDelegationLoop(
  opts: DelegationOptions,
  stream: AssistantMessageEventStream,
): Promise<DelegationResult> {
  const { decision, registry, context, options, extensionContext, turnTimer } = opts;

  let success = false;
  let lastError: string | undefined;
  let attemptIndex = -1;
  let lastServed: ServedInfo | undefined;
  let finalDecision = decision;

  // Per-turn spend accumulators, summed across every attempt including
  // failed ones (a failed attempt can still have spent tokens before it
  // errored). Both routedCost and the token totals are priced/observed on
  // the SAME registry $/token basis so a later baseline repricing (in
  // provider.ts's chosen baseline) compares like with like — never mixed
  // with provider-reported billing (`cost.total`), which is a different
  // scale and absent for subscription providers.
  const turnSpend = {
    routedCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  const deadProviders = new Set<string>();
  const strikes = new Map<string, number>();
  /**
   * Provider circuit strikes are scoped to provider-health failures only
   * (credential/auth/transport errors and provider `stopReason: 'error'`).
   * Model-specific failures — missing registry models and output-limit
   * exhaustion — must not condemn a provider whose other models may still
   * serve, so they record under the 'model' scope and do not add strikes.
   */
  type FailureScope = 'model' | 'provider';
  const recordFailure = (provider: string, scope: FailureScope): void => {
    if (scope !== 'provider') return;
    const n = (strikes.get(provider) ?? 0) + 1;
    strikes.set(provider, n);
    if (n >= MAX_FAILURES_PER_PROVIDER) deadProviders.add(provider);
  };

  const baseUrlByProvider = new Map<string, string | undefined>();
  const resolveBaseUrl = async (provider: string): Promise<string | undefined> => {
    if (baseUrlByProvider.has(provider)) return baseUrlByProvider.get(provider);
    let baseUrl: string | undefined;
    try {
      const providerAuth = await withTimeout(
        Promise.resolve(registry?.getProviderAuth?.(provider)),
        authResolveTimeoutMs,
      );
      baseUrl = providerAuth?.auth?.baseUrl;
    } catch {
      // Missing or slow provider metadata must fall back to the model's baseUrl.
    }
    baseUrlByProvider.set(provider, baseUrl);
    return baseUrl;
  };

  for (const [candidateIndex, candidateId] of decision.fallbackChain.entries()) {
    const { provider, id: modelId, effort: entryEffort } = parseCandidateKey(candidateId);
    if (provider === ROUTER_PROVIDER_ID) continue;
    if (deadProviders.has(provider)) continue;
    attemptIndex++;
    const chosen = registry?.find(provider, modelId);
    if (!chosen) {
      lastError = `not in registry: ${candidateId}`;
      blacklistModel(candidateId);
      recordFailure(provider, 'model');
      continue;
    }

    let auth;
    const authTimer = startTimer();
    try {
      auth = await withTimeout(
        Promise.resolve(registry?.getApiKeyAndHeaders(chosen)),
        authResolveTimeoutMs,
      );
    } catch {
      lastError = `credential lookup timed out: ${candidateId}`;
      blacklistModel(candidateId);
      recordFailure(provider, 'provider');
      debugLog('attempt.auth', { candidate: candidateId, ms: authTimer(), outcome: 'timeout' });
      continue;
    }
    // Header-only auth (e.g. kimi-coding OAuth Bearer) is valid; apiKey may be absent.
    if (!auth || !auth.ok || (!auth.apiKey && (!auth.headers || Object.keys(auth.headers).length === 0))) {
      lastError = `no usable credentials: ${candidateId}`;
      blacklistModel(candidateId);
      recordFailure(provider, 'provider');
      debugLog('attempt.auth', { candidate: candidateId, ms: authTimer(), outcome: 'no-creds' });
      continue;
    }
    debugLog('attempt.auth', { candidate: candidateId, ms: authTimer(), outcome: 'ok' });

    const resolvedBaseUrl = await resolveBaseUrl(provider);
    const modelForStream = (resolvedBaseUrl
      ? { ...(chosen as Model<Api>), baseUrl: resolvedBaseUrl }
      : chosen) as Model<Api>;
    // A provider registered with its own `streamSimple` (e.g. an OAuth/SDK-backed
    // virtual provider with a non-standard `api` value) must be dispatched through
    // that registered implementation. The generic compat `streamSimple` only
    // resolves built-in `api` types and throws "No API provider registered for
    // api: <custom>" for anything else.
    const providerStreamSimple = registry?.getProvider?.(provider)?.streamSimple ?? streamSimple;

    // A candidate may be retried in place on a transient/generic provider
    // error before we fall over to the next model. `served` breaks the outer
    // walk; the failure classification decides whether the model is blacklisted.
    let served = false;
    let candidateTransient = false;
    let candidateOutputLimitExhausted = false;

    // If the request was already aborted before this candidate began, surface
    // the canonical aborted terminal event without blacklisting or retrying.
    // Read into a local so control-flow narrowing does not freeze the live
    // (async-mutable) `signal.aborted` value for the rest of the iteration.
    const alreadyAborted = opts.options?.signal?.aborted === true;
    if (alreadyAborted) {
      stream.push(makeTerminalErrorEvent('aborted', 'aborted'));
      stream.end();
      return { success: false, streamFinalized: true, lastError: 'aborted', lastServed };
    }

    for (let tries = 0; ; tries++) {
      if (tries > 0) {
        if (opts.options?.signal?.aborted === true) {
          // Aborted during a previous retry's catch while still inside this
          // candidate: finalize canonically now, without blacklisting or
          // falling through to the next candidate.
          stream.push(makeTerminalErrorEvent('aborted', 'aborted'));
          stream.end();
          return { success: false, streamFinalized: true, lastError: 'aborted', lastServed };
        }
        try {
          await waitForRetry(retryBackoffMs * tries, opts.options?.signal);
        } catch (_retryErr) {
          // Abort during backoff: finalize canonically before a delegated
          // iterator is created or failure bookkeeping runs.
          const abortMessage = _retryErr instanceof Error ? _retryErr.message : String(_retryErr);
          stream.push(makeTerminalErrorEvent('aborted', abortMessage));
          stream.end();
          return { success: false, streamFinalized: true, lastError: abortMessage, lastServed };
        }
        debugLog('attempt.retry', { candidate: candidateId, retry: tries });
      }

      // A sticky incumbent held on a cheap-classified follow-up carries the
      // incumbent's resolved dimension as an up-only effort floor, so the
      // served thinking level cannot drop below what the incumbent ran at.
      const effortFloorDimension = decision.effortFloorDimension ?? decision.dimension;
      const effectiveReasoning = resolveAttemptEffort(
        entryEffort,
        effortFloorDimension,
        opts.userReasoningOverride,
        chosen as Pick<Candidate, 'reasoning' | 'thinkingLevelMap'>,
        opts.reasoning,
      );
      // The answer deadline is absolute from stream start. Lifecycle heartbeats
      // (start/done) cannot renew it. Thinking output is the one exception: a
      // reasoning model legitimately streams thinking for a while before its
      // first text/tool-call, so each thinking delta pushes the deadline
      // forward by one stall window — liveness is still enforced (a reasoning
      // stall longer than the window fails the candidate) without a single
      // thinking token disabling the deadline outright.
      let answerDeadline = Date.now() + firstEventTimeoutMs;
      const effectiveSource = `${provider}/${modelId}:${effectiveReasoning ?? 'off'}`;
      const attemptCanRouteUp =
        opts.enableRouteUpGuidance === true &&
        decision.fallbackChain.slice(candidateIndex + 1).some((candidate) =>
          isValidEscalationCandidate(candidate, effectiveSource),
        );
      const attemptContext = attemptCanRouteUp
        ? { ...context, systemPrompt: appendRouteUpGuidance(context.systemPrompt) }
        : context;
      const delegatedStream = providerStreamSimple(modelForStream, attemptContext, {
        ...options,
        ...(effectiveReasoning && effectiveReasoning !== 'off'
          ? { reasoning: effectiveReasoning }
          : {}),
        apiKey: auth.apiKey,
        headers: auth.headers,
      });
      const iterator = (delegatedStream as AsyncIterable<{ type: string }>)[Symbol.asyncIterator]();

      let visibleTextReceived = false;
      let toolCallReceived = false;
      let thinkingReceived = false;
      let servedTracked = false;
      let sawFirstEvent = false;
      let meaningfulOutputReceived = false;
      let networkTimeout = false;
      let errorMessageObj: { stopReason?: string; errorMessage?: string } | undefined;
      const streamTimer = startTimer();
      const attemptBuffer = createAttemptBuffer(stream, candidateId);
      try {
        for (;;) {
          let step: IteratorResult<{ type: string }>;
          if (meaningfulOutputReceived) {
            step = await iterator.next();
          } else {
            try {
              const remainingMs = answerDeadline - Date.now();
              if (remainingMs <= 0) throw new Error('meaningful output deadline elapsed');
              step = await withTimeout(iterator.next(), remainingMs);
            } catch {
              networkTimeout = true;
              debugLog('attempt.stream', { candidate: candidateId, firstEventMs: streamTimer(), outcome: 'timeout' });
              throw new Error(
                `no response within ${Math.round(firstEventTimeoutMs / 1000)}s: ${candidateId}`,
              );
            }
          }
          if (!sawFirstEvent) {
            debugLog('attempt.stream', {
              candidate: candidateId,
              firstEventMs: streamTimer(),
              outcome: 'first-event',
              event: step.done ? 'done' : (step.value as { type: string }).type,
            });
          }
          sawFirstEvent = true;
          if (step.done) break;
          const event = step.value;
          // Only an answer — text or a tool call — proves the candidate served
          // this turn. Thinking is the model's own pre-answer reasoning: it
          // keeps liveness alive (below) but must NOT disarm the answer
          // requirement, so a candidate that emits only thinking then errors is
          // still an answerless failure whose buffered reasoning is discarded
          // with the attempt, never stitched onto the fallback's answer.
          if (isServedOutputEvent(event.type)) meaningfulOutputReceived = true;

          if (event.type === 'text_delta') visibleTextReceived = true;
          if (event.type === 'thinking_delta') {
            thinkingReceived = true;
            answerDeadline = Date.now() + firstEventTimeoutMs;
          }
          if (isToolCallEvent(event.type)) toolCallReceived = true;

          if (event.type === 'done') {
            const message = (event as unknown as {
              message?: {
                usage?: {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  cost?: { total?: number };
                };
              };
            }).message;
            accumulateAttemptUsage(
              message?.usage,
              (chosen as unknown as { cost?: Candidate['cost'] }).cost,
              turnSpend,
            );
          }
          const classified = classifyTerminalEvent(
            event,
            visibleTextReceived,
            toolCallReceived,
            candidateId,
          );
          if (classified.kind === 'output-limit') {
            candidateOutputLimitExhausted = true;
            throw new Error(
              thinkingReceived
                ? `reasoning exhausted the output limit before an answer: ${candidateId}`
                : `output limit reached before an answer: ${candidateId}`,
            );
          }
          if (classified.kind === 'provider-error') {
            errorMessageObj = classified.error;
            throw new Error(classified.message);
          }
          // Record which model served this turn on the first output-bearing
          // event of ANY kind — including tool calls. A turn whose response is
          // pure tool-call output (an "implement" step that opens directly with
          // an edit/write call, no narration) emits no text/thinking deltas, so
          // the status widget and decision log must not depend on text output.
          if (!servedTracked && isServedOutputEvent(event.type)) {
            servedTracked = true;
            const recorded = recordServedAttempt({
              decision,
              candidateId,
              candidateIndex,
              provider,
              modelId,
              effectiveReasoning,
              optionsReasoning: opts.options?.reasoning as string | undefined,
              notifyOnRoute: opts.notifyOnRoute,
              extensionContext,
            });
            lastServed = recorded.lastServed;
            finalDecision = recorded.finalDecision;
          }
          attemptBuffer.forward(event);
        }
        // A clean stream end with no text, thinking, or tool-call output is
        // treated as an answerless completion, not success: a candidate that
        // produced nothing must fall through to the next model. The length-only
        // case above already threw with `candidateOutputLimitExhausted`, so
        // reaching here clean means the provider simply returned nothing.
        if (!meaningfulOutputReceived) {
          throw new Error(`stream ended before meaningful output: ${candidateId}`);
        }
        success = true;
        served = true;
        debugLog('attempt.served', {
          candidate: candidateId,
          attemptNumber: attemptIndex + 1,
          retries: tries,
          streamMs: streamTimer(),
        });
        if (lastServed) {
          updateLastServed({ accumulatedCost: getAccumulatedCost() });
          renderRouterStatus(extensionContext, finalDecision, { ...lastServed, accumulatedCost: getAccumulatedCost() });
        }
        break;
      } catch (_err) {
        const message = _err instanceof Error ? _err.message : String(_err);
        lastError = message;
        const userAborted = opts.options?.signal?.aborted === true;
        if (!networkTimeout) {
          debugLog('attempt.stream', {
            candidate: candidateId,
            streamMs: streamTimer(),
            outcome: userAborted ? 'aborted' : 'error',
            error: message.slice(0, 120),
          });
        }
        closeIterator(iterator as AsyncIterator<unknown>);
        if (userAborted) {
          // User cancelled the request. Surface the standard aborted terminal
          // event, but do not blacklist or penalize the model.
          stream.push(makeTerminalErrorEvent('aborted', message));
          stream.end();
          return { success: false, streamFinalized: true, lastError: message, lastServed };
        }
        const failure = decideAfterFailure(
          visibleTextReceived,
          toolCallReceived,
          attemptBuffer.committedToStream,
          errorMessageObj,
          message,
          tries,
        );
        if (failure.action === 'finalize') {
          // A usable answer or tool action already streamed — or a long
          // reasoning trace was committed live past the buffer cap; replaying
          // on a fallback model could duplicate user-visible output, leak the
          // reasoning into another model's answer, or repeat side effects.
          stream.push(makeTerminalErrorEvent('error', message));
          stream.end();
          return { success: false, streamFinalized: true, lastError: message, lastServed };
        }
        if (failure.action === 'provider-dead') {
          blacklistProvider(provider);
          deadProviders.add(provider);
          debugLog('attempt.usage-limit', { provider, candidate: candidateId });
          break;
        }
        candidateTransient = failure.transient;
        if (failure.action === 'retry') continue;
        break;
      }
    }

    if (served) break; // a candidate served the turn — done

    // Candidate failed after any same-model retries. Transient provider errors
    // and output-limit exhaustion do not prove the model itself is unusable for
    // later turns, so neither failure mode blacklists it for this session.
    // Only provider-health failures count toward circuit strikes; model-level
    // output-limit exhaustion does not.
    if (!candidateTransient && !candidateOutputLimitExhausted) blacklistModel(candidateId);
    recordFailure(provider, candidateOutputLimitExhausted ? 'model' : 'provider');
    continue;
  }

  if (!success) {
    debugLog('turn.exhausted', {
      attempts: attemptIndex + 1,
      totalMs: turnTimer(),
      lastError: lastError?.slice(0, 120),
    });
    return { success: false, streamFinalized: false, lastError, lastServed };
  }

  debugLog('turn.done', {
    served: lastServed?.registryId,
    viaFallback: lastServed?.viaFallback,
    fallbackRank: lastServed?.fallbackRank,
    totalMs: turnTimer(),
  });
  if (lastServed) {
    const turnUsage = {
      inputTokens: turnSpend.inputTokens,
      outputTokens: turnSpend.outputTokens,
      cacheRead: turnSpend.cacheReadTokens,
      cacheWrite: turnSpend.cacheWriteTokens,
    };
    finalDecision = {
      ...finalDecision,
      usage: turnUsage,
      spend: {
        routedCost: turnSpend.routedCost,
        baselineCost: priceTokens(finalDecision.baseline?.cost, turnUsage),
      },
    };
    appendDecision(finalDecision, lastServed);
  }
  return { success: true, streamFinalized: false, lastServed };
}

/**
 * Events that prove the candidate actually produced this turn's answer, as
 * opposed to lifecycle-only `start`/`done` or pre-answer `thinking_delta`.
 * Reaching one flips passthrough (flushing the pre-output buffer) and locks
 * out replay. Tool calls count: an "implement" turn can be pure tool-call
 * output with no text deltas at all. Thinking is deliberately excluded: it is
 * the model's own reasoning, and streaming a failed candidate's reasoning
 * before its answer arrives would leak it into the fallback model's response.
 */
function isServedOutputEvent(type: string): boolean {
  return type === 'text_delta' || isToolCallEvent(type);
}

function isToolCallEvent(type: string): boolean {
  return type === 'toolcall_start' || type === 'toolcall_delta' || type === 'toolcall_end';
}

function errorEventMessage(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const err = (event as Record<string, unknown>).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    for (const key of ['errorMessage', 'message']) {
      if (typeof e[key] === 'string' && e[key]) return e[key] as string;
    }
  }
  const msg = (event as Record<string, unknown>).message;
  return typeof msg === 'string' && msg ? msg : undefined;
}
