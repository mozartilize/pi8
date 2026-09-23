/**
 * Delegation fallback loop for `router/auto`.
 *
 * Walks the ranked fallback chain produced by the scorer, attempts each model
 * in turn, and pumps stream events back to the caller until one candidate
 * succeeds or the chain is exhausted. Pi's registry owns request auth and
 * provider dispatch; the router owns bounded setup/output waits, same-model
 * retries, blacklisting, and provider circuit-breaking.
 */
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

import { ROUTER_PROVIDER_ID } from '../types.js';
import type { Candidate, DecisionCause, Dimension, RoutingDecision } from '../types.js';
import {
  RouterSession,
  defaultRouterSession,
} from './router-session-state.js';
import { renderRouterStatus, notifyRouting, servedKey, type ServedInfo } from '../host/ui.js';
import { debugLog, startTimer } from '../host/debuglog.js';
import { appendDecision } from '../host/decisionlog.js';
import { makeTerminalErrorEvent } from './error-event.js';
import {
  isStrictlyStrongerCandidate,
  isValidEscalationCandidate,
  findSourceCandidate,
  escalationChain,
  candidateKey,
  parseCandidateKey,
  servedEffort,
  type StrongerCompareOpts,
  type ScoreOpts,
} from '../routing/score/scorer.js';
import { POLICY_PASSIVE_CAUSES } from '../routing/policy/routing-policy.js';
import { ReasoningLoopDetector } from '../routing/struggle/reasoning-loop.js';
import type { PendingTrajectoryEscalation } from '../routing/struggle/types.js';
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

/** Stop waiting even when a provider ignores cancellation; remove each wait's listener. */
function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  let onAbort: () => void;
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return iterator.next();
    }).then(resolve, reject);
  }).finally(() => signal.removeEventListener('abort', onAbort));
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
  /** Live routable set, used to require a strictly stronger pre-output hop. */
  candidates?: Candidate[];
  /** When true, show a TUI notification on a model pick/switch (config.prompt). */
  notifyOnRoute?: boolean;
  /** Confirm a fallback before any provider request; undefined cancels the turn. */
  beforeFallback?: (candidateId: string, previousId: string) => Promise<string | undefined>;
  /** Total-turn timer, used for final debug log timestamps. */
  turnTimer: () => number;
  /** Owning session state for this delegation loop. */
  session?: RouterSession;
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
  /** Set when a strictly stronger trajectory hop actually served the turn. */
  capabilityHandoff?: { fromModel: string; served: string };
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
  return servedEffort(
    { ...chosen, effort: entryEffort },
    effortFloorDimension,
    {
      userReasoning: typeof turnReasoning === 'string' ? (turnReasoning as ThinkingLevel) : undefined,
      userReasoningOverride,
    },
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
  session?: RouterSession,
): void {
  if (!usage) return;
  if (usage.cost?.total) {
    (session ?? defaultRouterSession).addAccumulatedCost(usage.cost.total);
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

function usageFromUnknown(value: unknown): Parameters<typeof accumulateAttemptUsage>[0] {
  if (!value || typeof value !== 'object') return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const rec = usage as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  return rec;
}

/** Latest usage on a stream event: terminal message, error payload, or partial. */
function eventUsage(event: unknown): Parameters<typeof accumulateAttemptUsage>[0] {
  if (!event || typeof event !== 'object') return undefined;
  const rec = event as Record<string, unknown>;
  return usageFromUnknown(rec.message) ?? usageFromUnknown(rec.error) ?? usageFromUnknown(rec.partial);
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
 * starts with `rotateServedForNewTurn()`, and `updateLastServed` is a no-op
 * patch while state is undefined. Notify against `lastNotifiedModel`, not
 * `lastChosenRegistryId`, because the provider already recorded this turn's
 * decision before delegation starts.
 */
function recordServedAttempt(
  ctx: DelegationContext,
  candidate: PreparedCandidate,
): { lastServed: ServedInfo; finalDecision: RoutingDecision } {
  const { decision, session } = ctx;
  const { candidateId, candidateIndex } = candidate;
  const viaFallback = candidateIndex > 0;
  // A capability hop and a failure fallback reach the same later candidate by
  // different mechanisms, and `/router-why` distinguishes them by cause.
  const hop = candidate.servingHop;
  const hopCause: DecisionCause = hop
    ? (POLICY_PASSIVE_CAUSES.has(decision.cause) ? 'trajectory-escalation' : decision.cause)
    : decision.cause === 'manual-override' ? 'manual-override' : 'error-fallback';
  const baseDecision = viaFallback
    ? {
        ...decision,
        chosen: candidateId,
        cause: hopCause,
        ...(hop
          ? {
              trajectoryFriction: {
                tfi: hop.tfi,
                signals: hop.signals.map((signal) => ({
                  kind: signal.kind,
                  severity: signal.severity as 'warning' | 'severe',
                  evidenceCount: signal.evidenceCount,
                })),
                fromModel: hop.fromModel,
                preOutput: true,
              },
            }
          : {}),
        reason: hop
          ? `${decision.reason}; capability hop after pre-output reasoning loop on ${hop.fromModel}`
          : `${decision.reason}; fallback served after an earlier candidate failed`,
        fallbackChain: [
          ...new Set([
            ...decision.fallbackChain.slice(candidateIndex),
            ...decision.fallbackChain.slice(0, candidateIndex),
          ]),
        ],
      }
    : decision;
  // Terminal capability is scored for every candidate up front, but only
  // the model that actually streams the turn's output has "served"
  // capability — fallback can substitute a lower-tier sibling.
  const servedCandidateCapability = baseDecision.multiWork?.candidateCapability[candidateId];
  const finalMultiWork = baseDecision.multiWork && servedCandidateCapability
    ? {
        ...baseDecision.multiWork,
        servedCandidateKey: candidateId,
        servedCapability: servedCandidateCapability,
      }
    : baseDecision.multiWork;
  const finalDecision = finalMultiWork
    ? { ...baseDecision, multiWork: finalMultiWork }
    : baseDecision;
  const lastServed: ServedInfo = {
    registryId: `${candidate.provider}/${candidate.modelId}`,
    thinkingLevel: (candidate.effectiveReasoning
      ?? ctx.opts.options?.reasoning) as string | undefined,
    viaFallback,
    fallbackRank: viaFallback ? candidateIndex + 1 : undefined,
    accumulatedCost: session.getAccumulatedCost(),
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
  // Evaluated here, not at attempt start: a newer session or intent may have
  // taken ownership while this attempt was streaming.
  if (ctx.stillCurrent()) {
    session.setLastServed(lastServed);
    session.setLastDecision(finalDecision);
    renderRouterStatus(ctx.opts.extensionContext, finalDecision, lastServed);
    if (ctx.opts.notifyOnRoute && candidateId !== session.getLastNotifiedModel()) {
      notifyRouting(ctx.opts.extensionContext, finalDecision, lastServed);
    }
    session.setLastNotifiedModel(candidateId);
  }
  return { lastServed, finalDecision };
}

interface TurnSpend {
  routedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  incomplete: boolean;
}

/** Price the served turn and every failed attempt on the same registry basis. */
function stampTurnSpend(decision: RoutingDecision, spend: TurnSpend): RoutingDecision {
  const usage = {
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    cacheRead: spend.cacheReadTokens,
    cacheWrite: spend.cacheWriteTokens,
  };
  return {
    ...decision,
    usage,
    spend: {
      routedCost: spend.routedCost,
      baselineCost: priceTokens(decision.baseline?.cost, usage),
      ...(spend.incomplete ? { incomplete: true } : {}),
    },
  };
}

/** Only a proven strictly stronger serving pick consumes the handoff. */
function resolveCapabilityHandoff(
  served: ServedInfo | undefined,
  fromModel: string | undefined,
  dimension: Dimension,
  candidates: Candidate[] | undefined,
  compareOpts: StrongerCompareOpts,
): DelegationResult['capabilityHandoff'] {
  if (!served || !fromModel || !candidates) return undefined;
  const key = servedKey(served);
  const dest = candidates.find((candidate) => candidateKey(candidate) === key)
    ?? findSourceCandidate(candidates, key);
  const source = findSourceCandidate(candidates, fromModel);
  return dest && isStrictlyStrongerCandidate(dest, fromModel, dimension, source, compareOpts)
    ? { fromModel, served: key }
    : undefined;
}

/** Keep weaker recovery entries behind the quality-selected hop, in order. */
function planTrajectoryHop(remaining: string[], strongerKeys: string[]): string[] {
  const strongerSet = new Set(strongerKeys);
  return [...strongerKeys, ...remaining.filter((key) => !strongerSet.has(key))];
}

type DelegatedEvent = { type: string };

type AttemptEventDisposition =
  | { kind: 'continue' }
  | { kind: 'trajectory' }
  | { kind: 'output-limit'; message: string }
  | {
      kind: 'provider-error';
      message: string;
      error: { stopReason?: string; errorMessage?: string } | undefined;
    };

type CandidateAttemptResult =
  | {
      kind: 'served';
      lastServed: ServedInfo | undefined;
      finalDecision: RoutingDecision;
      effectiveSource: string;
    }
  | { kind: 'trajectory'; message: string; effectiveSource: string; usageObserved: boolean }
  | { kind: 'aborted'; message: string }
  | { kind: 'finalize'; message: string }
  | { kind: 'provider-dead'; message: string }
  | { kind: 'retry'; message: string; transient: boolean; outputLimitExhausted: boolean }
  | { kind: 'next-candidate'; message: string; transient: boolean; outputLimitExhausted: boolean };

type CandidateFailure = Extract<CandidateAttemptResult, { kind: 'trajectory' | 'provider-dead' | 'next-candidate' }>;
type RetryAttempt = Extract<CandidateAttemptResult, { kind: 'retry' }>;

/** Provider-wide caps bypass the circuit; strikes still record one failed candidate. */
function failureConsequence(
  failure: CandidateFailure,
  lastRetry: RetryAttempt | undefined,
): { blacklistModel: boolean; strikeProvider: boolean; killProvider: boolean } {
  if (failure.kind === 'trajectory') {
    return { blacklistModel: false, strikeProvider: false, killProvider: false };
  }
  if (failure.kind === 'provider-dead') {
    // A transient retry already proved that the model itself need not be
    // excluded; the provider-wide usage cap still excludes every sibling.
    return { blacklistModel: !lastRetry?.transient, strikeProvider: true, killProvider: true };
  }
  return {
    blacklistModel: !failure.transient && !failure.outputLimitExhausted,
    strikeProvider: !failure.outputLimitExhausted,
    killProvider: false,
  };
}

/** Turn-level inputs, constant for the whole delegation walk. */
interface DelegationContext {
  opts: DelegationOptions;
  stream: AssistantMessageEventStream;
  decision: RoutingDecision;
  turnSpend: TurnSpend;
  session: RouterSession;
  stillCurrent: () => boolean;
}

/**
 * One candidate resolved against the registry and ready to stream. Every
 * field is constant across that candidate's retries — including the resolved
 * effort and the stronger-target probe, which depend on the candidate and the
 * chain rather than on the attempt number.
 */
interface PreparedCandidate {
  candidateId: string;
  candidateIndex: number;
  attemptIndex: number;
  provider: string;
  modelId: string;
  chosen: Model<Api>;
  effectiveReasoning: ModelThinkingLevel | undefined;
  effectiveSource: string;
  remainingHasStronger: boolean;
  servingHop: PendingTrajectoryEscalation | undefined;
}

/**
 * Single owner for one provider attempt's event-derived state. Pi's stream is
 * a consumable queue, not a broadcast channel, so buffering, replay safety,
 * liveness, usage, and reasoning-loop detection must observe each event in
 * one ordered transition before anything reaches the consumer stream.
 */
class AttemptController {
  visibleTextReceived = false;
  toolCallReceived = false;
  thinkingReceived = false;
  meaningfulOutputReceived = false;
  sawFirstEvent = false;
  /**
   * Latched once a severe pre-output reasoning loop is observed, independent of
   * whether a stronger target exists. The share-based severe verdict can decay
   * as windows age out, so it must be remembered: the answerless gate reads it
   * to distinguish capability struggle (rule 8: no blacklist, no provider
   * strike) from an anonymous empty completion.
   */
  severePreOutputSeen = false;
  observedUsage: Parameters<typeof accumulateAttemptUsage>[0];
  terminalAccounting = false;
  lastServed: ServedInfo | undefined;
  finalDecision: RoutingDecision;

  private servedTracked = false;
  private usageCommitted = false;
  private readonly reasoningLoop = new ReasoningLoopDetector();
  private readonly attemptBuffer: ReturnType<typeof createAttemptBuffer>;

  constructor(
    private readonly ctx: DelegationContext,
    private readonly candidate: PreparedCandidate,
  ) {
    this.finalDecision = ctx.decision;
    this.attemptBuffer = createAttemptBuffer(ctx.stream, candidate.candidateId);
  }

  get committedToStream(): boolean {
    return this.attemptBuffer.committedToStream;
  }

  accept(event: DelegatedEvent): AttemptEventDisposition {
    const latestUsage = eventUsage(event);
    if (latestUsage) {
      this.observedUsage = latestUsage;
      if (event.type === 'done' || event.type === 'error') this.terminalAccounting = true;
    }

    if (isServedOutputEvent(event.type)) this.meaningfulOutputReceived = true;
    if (event.type === 'text_delta') this.visibleTextReceived = true;
    if (event.type === 'thinking_delta') {
      this.thinkingReceived = true;
      const rec = event as { delta?: unknown; text?: unknown; content?: unknown };
      const delta = typeof rec.delta === 'string'
        ? rec.delta
        : typeof rec.text === 'string'
          ? rec.text
          : typeof rec.content === 'string'
            ? rec.content
            : '';
      this.reasoningLoop.update(delta);
      const severePreOutput =
        !this.meaningfulOutputReceived
        && !this.attemptBuffer.committedToStream
        && this.reasoningLoop.severity() === 'severe';
      if (severePreOutput) this.severePreOutputSeen = true;
      // Abort now only when a reachable stronger target exists. With none, the
      // attempt runs to its natural finish; the answerless gate then promotes
      // the latched observation rather than routing down on a probabilistic
      // signal.
      if (this.candidate.remainingHasStronger && severePreOutput) {
        return { kind: 'trajectory' };
      }
    }
    if (isToolCallEvent(event.type)) this.toolCallReceived = true;

    const classified = classifyTerminalEvent(
      event,
      this.visibleTextReceived,
      this.toolCallReceived,
      this.candidate.candidateId,
    );
    if (classified.kind === 'output-limit') {
      return {
        kind: 'output-limit',
        message: this.thinkingReceived
          ? `reasoning exhausted the output limit before an answer: ${this.candidate.candidateId}`
          : `output limit reached before an answer: ${this.candidate.candidateId}`,
      };
    }
    if (classified.kind === 'provider-error') {
      return { kind: 'provider-error', message: classified.message, error: classified.error };
    }

    if (!this.servedTracked && isServedOutputEvent(event.type)) {
      this.servedTracked = true;
      const recorded = recordServedAttempt(this.ctx, this.candidate);
      this.lastServed = recorded.lastServed;
      this.finalDecision = recorded.finalDecision;
    }
    this.attemptBuffer.forward(event);
    return { kind: 'continue' };
  }

  commitUsage(providerAttempted: boolean): void {
    if (this.usageCommitted) return;
    this.usageCommitted = true;
    if (this.observedUsage) {
      accumulateAttemptUsage(
        this.observedUsage,
        (this.candidate.chosen as unknown as { cost?: Candidate['cost'] }).cost,
        this.ctx.turnSpend,
        this.ctx.session,
      );
    }
    // Auth/setup failures happen inside ModelRuntime's lazy stream but before
    // provider dispatch, so they spent no provider tokens and cannot make
    // routed spend incomplete.
    if (providerAttempted && !this.terminalAccounting) this.ctx.turnSpend.incomplete = true;
    debugLog('attempt.usage', {
      candidate: this.candidate.candidateId,
      usage: this.observedUsage ? 'observed' : 'missing',
    });
  }
}

async function runCandidateAttempt(
  ctx: DelegationContext,
  candidate: PreparedCandidate,
  tries: number,
): Promise<CandidateAttemptResult> {
  const attemptAbort = new AbortController();
  const callerSignal = ctx.opts.options?.signal;
  const forwardAbort = (): void => attemptAbort.abort(new Error('aborted'));
  callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  if (callerSignal?.aborted) forwardAbort();

  let iterator: AsyncIterator<DelegatedEvent> | undefined;
  let networkTimeout = false;
  let failureError: unknown;
  let failureMessageObj: { stopReason?: string; errorMessage?: string } | undefined;
  let outputLimitExhausted = false;
  let trajectoryEscalation = false;
  const streamTimer = startTimer();
  const controller = new AttemptController(ctx, candidate);
  let requestReady = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (ms: number, message: string): void => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      networkTimeout = true;
      attemptAbort.abort(new Error(message));
    }, ms);
  };
  const armOutputDeadline = (): void => armDeadline(
    firstEventTimeoutMs,
    `no response within ${Math.round(firstEventTimeoutMs / 1000)}s: ${candidate.candidateId}`,
  );
  // These values belong to router/auto's resolved request, not the destination.
  // Even the synthetic router API key overrides stored destination credentials.
  const { apiKey: _apiKey, headers: _headers, env: _env, ...options } = ctx.opts.options ?? {};

  try {
    try {
      attemptAbort.signal.throwIfAborted();
      armDeadline(authResolveTimeoutMs, `credential lookup timed out: ${candidate.candidateId}`);
      const delegatedStream = ctx.opts.registry.streamSimple(
        candidate.chosen,
        ctx.opts.context,
        {
          ...options,
          ...(candidate.effectiveReasoning && candidate.effectiveReasoning !== 'off'
            ? { reasoning: candidate.effectiveReasoning }
            : {}),
          signal: attemptAbort.signal,
          // Pi awaits this after request auth, before invoking the provider.
          // A late auth resolution must not dispatch an abandoned attempt.
          transformHeaders: (headers) => {
            attemptAbort.signal.throwIfAborted();
            requestReady = true;
            debugLog('attempt.auth', { candidate: candidate.candidateId, ms: streamTimer(), outcome: 'ok' });
            armOutputDeadline();
            return headers;
          },
        },
      );
      iterator = (delegatedStream as AsyncIterable<DelegatedEvent>)[Symbol.asyncIterator]();

      for (;;) {
        const step = await nextWithAbort(iterator, attemptAbort.signal);
        attemptAbort.signal.throwIfAborted();
        if (!controller.sawFirstEvent) {
          debugLog('attempt.stream', {
            candidate: candidate.candidateId,
            firstEventMs: streamTimer(),
            outcome: 'first-event',
            event: step.done ? 'done' : step.value.type,
          });
        }
        controller.sawFirstEvent = true;
        if (step.done) break;

        const disposition = controller.accept(step.value);
        if (controller.meaningfulOutputReceived) clearTimeout(deadline);
        else if (step.value.type === 'thinking_delta') armOutputDeadline();
        if (disposition.kind === 'continue') continue;
        if (disposition.kind === 'trajectory') {
          trajectoryEscalation = true;
          failureError = new Error(`trajectory reasoning-loop: ${candidate.candidateId}`);
        } else if (disposition.kind === 'output-limit') {
          outputLimitExhausted = true;
          failureError = new Error(disposition.message);
        } else {
          failureMessageObj = disposition.error;
          failureError = new Error(disposition.message);
        }
        break;
      }
      if (!failureError && !controller.meaningfulOutputReceived) {
        if (controller.severePreOutputSeen) {
          // Severe pre-output loop with no reachable stronger target, finished
          // answerless. That is capability struggle for this intent, not a
          // model defect: promote to the trajectory branch so the walk recovers
          // without blacklisting the source or striking its provider (rule 8).
          trajectoryEscalation = true;
          failureError = new Error(`trajectory reasoning-loop (no stronger target): ${candidate.candidateId}`);
        } else {
          failureError = new Error(`stream ended before meaningful output: ${candidate.candidateId}`);
        }
      }
    } catch (error) {
      failureError = error;
    }

    if (!failureError) {
      debugLog('attempt.served', {
        candidate: candidate.candidateId,
        attemptNumber: candidate.attemptIndex + 1,
        retries: tries,
        streamMs: streamTimer(),
      });
      return {
        kind: 'served',
        lastServed: controller.lastServed,
        finalDecision: controller.finalDecision,
        effectiveSource: candidate.effectiveSource,
      };
    }

    const message = failureError instanceof Error ? failureError.message : String(failureError);
    const userAborted = callerSignal?.aborted === true;
    debugLog(requestReady ? 'attempt.stream' : 'attempt.auth', {
      candidate: candidate.candidateId,
      streamMs: streamTimer(),
      outcome: userAborted ? 'aborted' : networkTimeout ? 'timeout' : 'error',
      error: message.slice(0, 120),
    });
    if (userAborted) return { kind: 'aborted', message: 'aborted' };
    // Setup failures have not reached the provider. Do not spend stream retries
    // on missing credentials or an auth resolver that cannot finish.
    if (!requestReady) return { kind: 'next-candidate', message, transient: false, outputLimitExhausted: false };
    if (trajectoryEscalation) {
      return {
        kind: 'trajectory',
        message,
        effectiveSource: candidate.effectiveSource,
        usageObserved: controller.observedUsage != null,
      };
    }
    const failure = decideAfterFailure(
      controller.visibleTextReceived,
      controller.toolCallReceived,
      controller.committedToStream,
      failureMessageObj,
      message,
      tries,
    );
    if (failure.action === 'finalize') return { kind: 'finalize', message };
    if (failure.action === 'provider-dead') return { kind: 'provider-dead', message };
    return {
      kind: failure.action,
      message,
      transient: failure.transient,
      outputLimitExhausted,
    };
  } finally {
    clearTimeout(deadline);
    controller.commitUsage(requestReady);
    callerSignal?.removeEventListener('abort', forwardAbort);
    if (!attemptAbort.signal.aborted) attemptAbort.abort();
    if (iterator) closeIterator(iterator);
  }
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
  const { decision, registry, extensionContext, turnTimer } = opts;
  const session = opts.session ?? defaultRouterSession;
  const startGeneration = session.getSessionGeneration();
  const startIntent = decision.intentKey;
  const stillCurrent = (): boolean =>
    session.getSessionGeneration() === startGeneration
    && (startIntent == null || session.getCachedIntent()?.key === startIntent);
  const compareOpts: StrongerCompareOpts = {
    userReasoning: typeof opts.reasoning === 'string' ? (opts.reasoning as ThinkingLevel) : undefined,
    userReasoningOverride: opts.userReasoningOverride,
    candidates: opts.candidates,
  };
  // Escalation target selection reuses the scorer's guards + quality pick. The
  // remaining chain was already context/vision-guarded at routing time, so no
  // context estimate is needed here.
  const escOpts: ScoreOpts = { estimatedContextTokens: 0 };
  session.flushAndArmUnresolvedTrajectory();

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
    incomplete: false,
  };

  const deadProviders = new Set<string>();
  const strikes = new Map<string, number>();
  const ctx: DelegationContext = { opts, stream, decision, turnSpend, session, stillCurrent };
  // Not-yet-attempted, still-reachable candidates after `index` in the live
  // chain. Anything at or before `index` was already tried, and a dead
  // provider cannot serve a hop, so both the early-abort probe and the hop
  // itself score against exactly this set.
  const reachableRemaining = (index: number): Candidate[] =>
    decision.fallbackChain.slice(index + 1)
      .map((key) => opts.candidates?.find((c) => candidateKey(c) === key))
      .filter((c): c is Candidate =>
        c != null && !deadProviders.has(parseCandidateKey(candidateKey(c)).provider));
  /**
   * Set only for the single hop that immediately follows a pre-output
   * reasoning loop. It gates the *destination* of that hop and is cleared as
   * soon as one candidate is chosen for it, because everything after that is
   * ordinary objective-failure recovery: a stronger model that 421s must not
   * strand the turn behind a stronger-only chain.
   */
  let capabilityHop: PendingTrajectoryEscalation | undefined;
  /** Exact (model, effort) that a pre-output hop abandoned; never retried. */
  let excludeSource: string | undefined;
  /**
   * Provider circuit strikes are scoped to provider-health failures only
   * (credential/auth/transport errors and provider `stopReason: 'error'`).
   * Model-specific failures — missing registry models and output-limit
   * exhaustion — must not condemn a provider whose other models may still
   * serve, so they do not add strikes.
   */
  const strike = (provider: string): void => {
    const n = (strikes.get(provider) ?? 0) + 1;
    strikes.set(provider, n);
    if (n >= MAX_FAILURES_PER_PROVIDER) deadProviders.add(provider);
  };

  const registryIdOf = (key: string): string => {
    const parsed = parseCandidateKey(key);
    return `${parsed.provider}/${parsed.id}`;
  };
  const finalize = (reason: 'aborted' | 'error', message: string): DelegationResult => {
    stream.push(makeTerminalErrorEvent(reason, message));
    stream.end();
    return { success: false, streamFinalized: true, lastError: message, lastServed };
  };
  // Last candidate that actually entered an attempt. Semi-mode asks only when
  // the next attempt would change model — skipped/missing entries are not a
  // switch, and same-model retries stay inside the inner loop.
  let lastAttemptedId: string | undefined;
  for (const [candidateIndex, proposedId] of decision.fallbackChain.entries()) {
    let candidateId = proposedId;
    let { provider, id: modelId, effort: entryEffort } = parseCandidateKey(candidateId);
    if (excludeSource && !isValidEscalationCandidate(candidateId, excludeSource)) continue;
    // Known-unusable candidates are skipped before the hop is consumed: a dead
    // or router-synthetic head must not swallow the one-shot hop provenance and
    // strand a healthy stronger sibling behind it un-marked.
    if (provider === ROUTER_PROVIDER_ID) continue;
    if (deadProviders.has(provider)) continue;
    // `beforeFallback` may replace the proposed candidate and mutate the live
    // candidate pool. Preserve the source row now, but bind and consume the hop
    // only after the actual candidate has passed registry validation.
    const hopSource = capabilityHop && opts.candidates
      ? findSourceCandidate(opts.candidates, capabilityHop.fromModel)
      : undefined;
    attemptIndex++;
    let chosen = registry?.find(provider, modelId);
    if (!chosen) {
      lastError = `not in registry: ${candidateId}`;
      session.blacklistModel(candidateId);
      continue;
    }

    const previousAttempt = lastAttemptedId;
    if (
      opts.beforeFallback
      && previousAttempt
      && registryIdOf(candidateId) !== registryIdOf(previousAttempt)
    ) {
      const confirmed = await opts.beforeFallback(candidateId, previousAttempt);
      if (confirmed === undefined || !stillCurrent()) return finalize('aborted', 'Model switch cancelled.');
      if (confirmed !== candidateId) {
        candidateId = confirmed;
        ({ provider, id: modelId, effort: entryEffort } = parseCandidateKey(candidateId));
        if (provider === ROUTER_PROVIDER_ID || deadProviders.has(provider)) continue;
        chosen = registry?.find(provider, modelId);
        if (!chosen) {
          lastError = `not in registry: ${candidateId}`;
          session.blacklistModel(candidateId);
          continue;
        }
      }
    }
    let servingHop: PendingTrajectoryEscalation | undefined;
    if (capabilityHop) {
      // Remaining chain is stronger-then-recovery, but semi mode can substitute
      // another model. The one-shot provenance belongs only to the actual model
      // that will be attempted, and only when it is still a proven upgrade.
      const dest = opts.candidates?.find((candidate) => candidateKey(candidate) === candidateId);
      if (
        dest
        && isStrictlyStrongerCandidate(
          dest,
          capabilityHop.fromModel,
          decision.dimension,
          hopSource,
          compareOpts,
        )
      ) {
        servingHop = capabilityHop;
      }
      capabilityHop = undefined;
    }
    lastAttemptedId = candidateId;

    // A retry can affect the later usage-limit model blacklist, even though
    // all other consequences follow only the final attempt's result.
    let lastRetry: RetryAttempt | undefined;
    let failure: CandidateFailure | undefined;

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
    const effectiveSource = `${provider}/${modelId}:${effectiveReasoning ?? 'off'}`;
    // Resolved once per candidate, not per retry: a retry changes only the
    // attempt number. A trajectory hop rewrites the remaining chain, but it
    // leaves this candidate immediately, so the next candidate recomputes this
    // against the rewritten chain. The early-abort gate and the hop itself both
    // ask `escalationChain` over the same reachable-remaining set, so they can
    // never disagree on whether a reachable stronger target exists.
    const remainingHasStronger =
      escalationChain(
        reachableRemaining(candidateIndex),
        decision.dimension,
        effectiveSource,
        escOpts,
        compareOpts,
      ) !== undefined;
    const prepared: PreparedCandidate = {
      candidateId,
      candidateIndex,
      attemptIndex,
      provider,
      modelId,
      chosen: chosen as Model<Api>,
      effectiveReasoning,
      effectiveSource,
      remainingHasStronger,
      servingHop,
    };

    // If the request was already aborted before this candidate began, surface
    // the canonical aborted terminal event without blacklisting or retrying.
    // Read into a local so control-flow narrowing does not freeze the live
    // (async-mutable) `signal.aborted` value for the rest of the iteration.
    const alreadyAborted = opts.options?.signal?.aborted === true;
    if (alreadyAborted) {
      return finalize('aborted', 'aborted');
    }

    for (let tries = 0; ; tries++) {
      if (tries > 0) {
        if (opts.options?.signal?.aborted === true) {
          // Aborted during a previous retry's catch while still inside this
          // candidate: finalize canonically now, without blacklisting or
          // falling through to the next candidate.
          return finalize('aborted', 'aborted');
        }
        try {
          await waitForRetry(retryBackoffMs * tries, opts.options?.signal);
        } catch (_retryErr) {
          // Abort during backoff: finalize canonically before a delegated
          // iterator is created or failure bookkeeping runs.
          const abortMessage = _retryErr instanceof Error ? _retryErr.message : String(_retryErr);
          return finalize('aborted', abortMessage);
        }
        debugLog('attempt.retry', { candidate: candidateId, retry: tries });
      }

      const attempt = await runCandidateAttempt(ctx, prepared, tries);

      if (attempt.kind === 'served') {
        success = true;
        lastServed = attempt.lastServed;
        finalDecision = attempt.finalDecision;
        if (lastServed && stillCurrent()) {
          session.updateLastServed({ accumulatedCost: session.getAccumulatedCost() });
          renderRouterStatus(extensionContext, finalDecision, {
            ...lastServed,
            accumulatedCost: session.getAccumulatedCost(),
          });
        }
        break;
      }

      lastError = attempt.message;
      if (attempt.kind === 'trajectory') {
        failure = attempt;
        excludeSource = attempt.effectiveSource;
        // Same target selection as the between-turn repick: strongest reachable
        // stronger model by quality (`escalationChain`), never the highest-score
        // marginal upgrade. No reachable target (the answerless-promotion path)
        // leaves the chain untouched and hops nowhere — the source is already
        // excluded, so the walk falls to ordinary recovery without a strike.
        const remaining = decision.fallbackChain.slice(candidateIndex + 1);
        const esc = escalationChain(
          reachableRemaining(candidateIndex),
          decision.dimension,
          attempt.effectiveSource,
          escOpts,
          compareOpts,
        );
        if (esc) {
          capabilityHop = {
            fromModel: attempt.effectiveSource,
            dimension: decision.dimension,
            signals: [{
              kind: 'reasoning-loop',
              severity: 'severe',
              evidenceIds: [`rl:${candidateId}`],
              evidenceCount: 1,
            }],
            tfi: 1,
            preOutput: true,
          };
          const hopTail = planTrajectoryHop(remaining, esc.fallbackChain);
          // Mutate the live chain in place. The outer walk iterates
          // `fallbackChain.entries()`; replacing the array would leave that
          // iterator on the pre-hop order and skip recovery sitting before the
          // stronger head.
          decision.fallbackChain.splice(
            candidateIndex + 1,
            remaining.length,
            ...hopTail,
          );
        }
        debugLog('attempt.trajectory', {
          candidate: candidateId,
          reason: 'reasoning-loop',
          target: esc?.chosen ?? 'none',
          usage: attempt.usageObserved ? 'partial' : 'missing',
        });
        break;
      }
      if (attempt.kind === 'aborted' || attempt.kind === 'finalize') {
        return finalize(attempt.kind === 'aborted' ? 'aborted' : 'error', attempt.message);
      }
      if (attempt.kind === 'retry') {
        lastRetry = attempt;
        continue;
      }
      failure = attempt;
      break;
    }

    if (success) break; // a candidate served the turn — done
    if (!failure) continue;

    const consequence = failureConsequence(failure, lastRetry);
    if (consequence.killProvider) {
      session.blacklistProvider(provider);
      deadProviders.add(provider);
      debugLog('attempt.usage-limit', { provider, candidate: candidateId });
    }
    if (consequence.blacklistModel) session.blacklistModel(candidateId);
    if (consequence.strikeProvider) strike(provider);
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
    finalDecision = stampTurnSpend(finalDecision, turnSpend);
    if (stillCurrent()) {
      session.setLastDecision(finalDecision);
      appendDecision(finalDecision, lastServed);
    }
  }
  const fromModel = finalDecision.trajectoryFriction?.fromModel ?? excludeSource;
  const capabilityHandoff = resolveCapabilityHandoff(
    lastServed, fromModel, decision.dimension, opts.candidates, compareOpts,
  );
  return { success: true, streamFinalized: false, lastServed, capabilityHandoff };
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
