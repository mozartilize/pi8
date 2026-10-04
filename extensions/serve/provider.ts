/**
 * Provider registration for the `router/auto` model.
 *
 * Pattern: register a synthetic model with Pi (`pi.registerProvider`) that
 * uses declared task types, scores candidates from the live model
 * registry, and delegates the stream to the best match with a fallback
 * chain. Each real user entry first resolves which work it continues or
 * starts (see context-resolution.ts): deterministically when it can, else
 * by entering context acquisition so the serving model can inspect the
 * session and call `hand_off_context`.
 */
import { appendModelEvent, compliancePenalties, sharedPrefixCredits } from '../bench/model-history.js';
import { modelEventEntry, modelEventSession } from '../host/decisionlog.js';
import { createHash } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type AssistantMessageEventStream,
  type Context,
  type SimpleStreamOptions,
  type Message,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ModelThinkingLevel, ThinkingLevel } from '@earendil-works/pi-ai';

import type { BenchModel, Candidate, Dimension, DecisionCause, AutoRouterConfig, RoutingDecision } from '../types.js';
import { ROUTER_PROVIDER_ID, AUTO_MODEL_ID } from '../types.js';
import { loadStore, activeModels } from '../bench/store.js';
import { estimateTokenCount } from '../routing/token-estimate.js';
import { getTurnClassificationInput } from '../routing/policy/continuation.js';
import { loadModelFilter, buildExcludeFilter, buildScopedModelFilter, loadConfigBlacklistFilter } from '../routing/policy/allowlist.js';
import { loadConfig } from '../config.js';

import {
  appendDecision,
  appendExecutionContractSignal,
  appendContextHandoffSignal,
  appendWorkLifecycleSignal,
} from '../host/decisionlog.js';
import { renderRouterStatus, servedKey, type ServedInfo } from '../host/ui.js';
import {
  buildCandidate,
  buildRouterThinkingLevelMap,
  candidateKey,
  capabilityForDimension,
  findSourceCandidate,
  parseCandidateKey,
  isThinkingSupportedByRegistryModel,
  servesThinkingOff,
  resolveThinkingLevel,
  MODEL_THINKING_LEVELS,
  type RegistryModelInfo,
} from '../routing/score/scorer.js';
import { pickBaseline } from './baseline.js';
import { resolveManualModel } from './manual-model.js';
import {
  completeMeasuredRow,
  effortDropsPerStep,
  estimateRow,
  type EffortDrops,
} from '../routing/score/effort-estimate.js';
import {
  RouterSession,
  RuntimeBindings,
  defaultRouterSession,
  defaultRuntimeBindings,
} from './router-session-state.js';
import { debugLog, startTimer } from '../host/debuglog.js';
import { runDelegationLoop, type DelegationOptions } from './delegation.js';
import { makeTerminalErrorEvent } from './error-event.js';
import { resolveRoutingDecision, scoredIncumbentKey } from '../routing/policy/routing-policy.js';
import {
  penaltiesOf,
  nextProviderInvocation,
  boundaryQualifiers,
  servesBoundary,
  type WorkPhaseState,
} from '../routing/policy/work-phase.js';
import {
  breakContract,
  contractMeta,
  attributeExecutor,
  expireContract,
  isExcludedExecutor,
  isUnderReview,
  serveContractRelease,
  servedBySubmitter,
  type ExecutionContract,
} from '../routing/policy/execution-contract.js';
import { appendContractOutcome, closeContractEntry } from './execution-contract-tool.js';
import {
  ACQUISITION_REQUEST_LIMIT,
  entryPhase,
  owedContext,
  serveContextHandoff,
} from '../routing/policy/context-acquisition.js';
import {
  recordServedWork,
  resolveEntryContext,
  workContextMeta,
  type PendingIdentity,
  type ResolvedEntryContext,
} from './context-resolution.js';
import {
  CLARIFICATION_NOTE,
  closeContextEntry,
  gatheringNote,
} from './gathering-gate.js';
import { applyNotePlans, planRequestNote } from './request-notes.js';
import { planToolsNote } from './router-tools-note.js';
import { completedIncumbent, incumbentWorkItem } from '../routing/policy/work-completion.js';
import { activeWorkNote, completedWorkNote } from './completed-work-gate.js';

/** Pi's model registry once the session binds it; undefined before `session_start`. */
type ModelRegistry = ExtensionContext['modelRegistry'] | undefined;

// ─── Registry-wait (mandatory for subagents) ────────────────────────

/**
 * Build a synchronous per-provider membership test for subagent role injection.
 *
 * Subagent spawns are pick-once: the injected model is consumed verbatim by
 * pi-subagents, which hard-fails on an unauthenticated provider.
 * `getProviderAuthStatus` reads the locally cached credential snapshot
 * synchronously — no network call, no credential-store lock, no OAuth token
 * refresh hazard. `getAvailable()` already pre-filters by provider auth, so
 * this is a belt-and-suspenders per-provider check for the one path where
 * retry-on-failure is impossible.
 */
export function buildSubagentProviderAuthFilter(
  registry: ExtensionContext['modelRegistry'] | undefined,
  models: readonly RegistryModelInfo[],
): (provider: string) => boolean {
  if (!registry?.getProviderAuthStatus) return () => false;

  const providers = [...new Set(models.map((m) => m.provider))].filter(
    (p) => p && p !== ROUTER_PROVIDER_ID,
  );

  const usable = new Set<string>();
  for (const provider of providers) {
    if (registry.getProviderAuthStatus(provider)?.configured) {
      usable.add(provider);
    }
  }

  if (usable.size === 0) return () => false;
  return (provider: string) => usable.has(provider);
}

const REGISTRY_WAIT_TIMEOUT_MS = 5000;
const REGISTRY_WAIT_INITIAL_DELAY_MS = 50;
const REGISTRY_WAIT_MAX_DELAY_MS = 500;

/** Poll the LIVE module variable via a getter until the registry arrives. */
async function waitForRegistry(
  getRegistry: () => ModelRegistry,
  timeoutMs = REGISTRY_WAIT_TIMEOUT_MS,
): Promise<ModelRegistry> {
  const r = getRegistry();
  if (r?.getAvailable) return r;
  const start = Date.now();
  let delay = REGISTRY_WAIT_INITIAL_DELAY_MS;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, delay));
    const current = getRegistry();
    if (current?.getAvailable) return current;
    delay = Math.min(delay * 2, REGISTRY_WAIT_MAX_DELAY_MS);
  }
  return undefined;
}

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 4096;

export const getProviderState = (session: RouterSession = defaultRouterSession) => ({
  lastDecision: session.getLastDecision(),
  lastChosenRegistryId: session.getLastChosenRegistryId(),
  lastServed: session.getLastServed(),
  accumulatedCost: session.getAccumulatedCost(),
  blacklistedModels: [...session.getBlacklistedModels()].sort(),
  blacklistedProviders: [...session.getBlacklistedProviders()].sort(),
  workPhaseState: session.getWorkPhaseState(),
});

// ─── Helpers ────────────────────────────────────────────────────────

function textFromBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
    return ((block as Record<string, unknown>).text as string) ?? '';
  }
  return '';
}

// Pi's compaction estimator charges a flat 4800 chars (~1200 tokens) per
// image block; the router's char-based estimate must account on the same
// scale so context-pressure detection, the long-context guard, and the
// cache-retention bonus don't treat an image-heavy session as near-empty.
const ESTIMATED_IMAGE_CHARS = 4800;
/**
 * How long a served candidate's prompt cache counts as warm: Anthropic's
 * default cache lifetime, and the short end of OpenAI's in-memory retention.
 * The shorter bound never credits a cache that has already expired.
 */
const PROMPT_CACHE_TTL_MS = 5 * 60_000;

function countImageBlocks(messages: readonly Message[] | undefined): number {
  let count = 0;
  for (const msg of messages ?? []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object') {
          const b = block as unknown as Record<string, unknown>;
          if (b.type === 'image' || b.type === 'image_url') count++;
        }
      }
    }
  }
  return count;
}

function hasImageAttachment(messages: readonly Message[] | undefined): boolean {
  return countImageBlocks(messages) > 0;
}

function allMessagesText(messages: readonly Message[] | undefined): string {
  return (messages ?? [])
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map(textFromBlock).join('\n');
      return '';
    })
    .join('\n');
}

function extractSystemPrompt(context: Context): string | undefined {
  // Pi delivers the system prompt in the dedicated `Context.systemPrompt`
  // field, not as a system-role message. Scan messages only as a defensive
  // fallback in case a caller inlines it there instead.
  if (typeof context.systemPrompt === 'string' && context.systemPrompt) {
    return context.systemPrompt;
  }
  for (const msg of context.messages ?? []) {
    if ((msg.role as string) !== 'system') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map(textFromBlock).filter(Boolean).join('\n');
    }
  }
  return undefined;
}

// ─── Candidate expansion ───────────────────────────────────────────────

/**
 * Expand one registry model into its routable candidates: one per effort level
 * that is BOTH supported by the model's thinkingLevelMap AND covered by an
 * active bench row. A model with no effort-labelled rows emits exactly one
 * candidate with no effort, as before.
 *
 * A supported level the source never measured is covered by an estimate
 * stepped down from the nearest measured level above it (see
 * effort-estimate.ts). The estimate is a conservative lower bound on
 * capability, so a variant it makes eligible is one the evidence already
 * supports at that level or better — which is what earns it a place in the
 * candidate set rather than being written off as unknown quality. Estimation
 * is strictly downward: nothing above the highest measured row is ever
 * invented.
 *
 * `off` is a candidate only when a request at `off` runs the mode an off row
 * measures (`servesThinkingOff`): always for a model without reasoning, so an
 * off row never drops such a model's only measurement.
 *
 * `minimal` is never estimated. Sources almost never measure it, and Codex,
 * Anthropic adaptive thinking, and claude-bridge send it as `low`, so an
 * estimate one step below `low` scores a request that serves as `low`. A
 * measured `minimal` row is kept.
 */
export function expandModelCandidates(
  rm: RegistryModelInfo,
  rows: readonly BenchModel[],
  drops: EffortDrops = {},
): Candidate[] {
  const qualityBearing = (r: BenchModel): boolean =>
    Object.values(r.quality).some((v) => v !== undefined);

  const labelled = rows.filter(
    (r): r is BenchModel & { effort: ModelThinkingLevel } =>
      r.effort != null,
  );
  if (labelled.length === 0) {
    return [buildCandidate(rm, rows.find(qualityBearing) ?? rows[0])];
  }

  const exactQualityByEffort: NonNullable<Candidate['exactQualityByEffort']> = {};
  for (const row of labelled) {
    const { knowledge, research, longContext, visionReasoning } = row.quality;
    if (knowledge != null || research != null || longContext != null || visionReasoning != null) {
      exactQualityByEffort[row.effort] = {
        ...(knowledge != null ? { knowledge } : {}),
        ...(research != null ? { research } : {}),
        ...(longContext != null ? { longContext } : {}),
        ...(visionReasoning != null ? { visionReasoning } : {}),
      };
    }
  }
  const attachExactQuality = (candidate: Candidate): Candidate =>
    Object.keys(exactQualityByEffort).length > 0 ? { ...candidate, exactQualityByEffort } : candidate;

  const byLevel = new Map(labelled.map((row) => [row.effort, row]));
  const supported = MODEL_THINKING_LEVELS.filter(
    (level) => level === 'off' ? servesThinkingOff(rm) : isThinkingSupportedByRegistryModel(rm, level),
  )
    .map((level) => {
      const measured = byLevel.get(level);
      // A source may publish a target-level pricing/performance row with only
      // some (or none) of the quality axes. Preserve its measured axes and
      // exact-level metadata while filling only the missing axes from above.
      if (measured) return completeMeasuredRow(measured, labelled, drops);
      return level === 'minimal' ? undefined : estimateRow(level, labelled, drops);
    })
    .filter((row): row is BenchModel => row != null)
    .map((row) => attachExactQuality(buildCandidate(rm, row)));
  if (supported.length > 0) return supported;
  // All measured efforts are unsupported by this model's thinkingLevelMap, or
  // the source supplied only quality-empty rows. Keep the model routable with
  // an effort-less candidate, preferring any row the scorer can actually use.
  const fallback = labelled.find(qualityBearing) ?? labelled[0];
  return [attachExactQuality(buildCandidate(rm, { ...fallback, effort: undefined }))];
}

// ─── Turn-callback stages ────────────────────────────────────────────

/** Hash of what precedes the conversation in every request: system prompt and tool list. */
function promptHeadIdentity(context: Context): string {
  const hash = createHash('sha256');
  hash.update(extractSystemPrompt(context) ?? '');
  for (const tool of context.tools ?? []) hash.update(`\0${tool.name}\0${tool.description}\0${JSON.stringify(tool.parameters)}`);
  return hash.digest('hex');
}

function measureTurnInput(context: Context, config: AutoRouterConfig) {
  const turnInput = getTurnClassificationInput(context.messages, { syntheticPrefixes: config.syntheticPrefixes });
  const systemPrompt = extractSystemPrompt(context);
  const needsVision = hasImageAttachment(context.messages);
  // Pi delivers the system prompt in `context.systemPrompt`, not as a
  // message, so include it in the token estimate that feeds
  // context-pressure detection — otherwise a large system prompt
  // (tool snippets, skills, guidelines) is silently uncounted.
  const fullText =
    (systemPrompt ? systemPrompt + '\n' : '') + allMessagesText(context.messages);
  const imageChars = countImageBlocks(context.messages) * ESTIMATED_IMAGE_CHARS;
  const estContextTokens = estimateTokenCount(fullText) + Math.ceil(imageChars / 4);
  return { turnInput, systemPrompt, needsVision, estContextTokens };
}

/** The handoff owns the task type; without an incumbent, start by gathering. */
function resolveBaseIntent(turnInput: ReturnType<typeof getTurnClassificationInput>, session: RouterSession) {
  const cachedIntent = session.getCachedIntent();
  const cacheHit = cachedIntent?.key === turnInput.key;
  return {
    cacheHit,
    cachedIntent,
    baseDimension: cacheHit ? cachedIntent.dimension : session.context.getIncumbent()?.dimension ?? 'gather',
    baseCause: cacheHit ? cachedIntent.cause : session.context.getIncumbent() ? 'incumbent' as DecisionCause : 'investigation' as DecisionCause,
  };
}

/** Live per-model/provider exclusions. Not part of the expansion-cache key. */
function applyRuntimeExclusions(
  pool: readonly Candidate[],
  session: RouterSession,
): Candidate[] {
  const liveModels = session.getBlacklistedModels();
  const liveProviders = session.getBlacklistedProviders();
  return pool.filter((candidate) => {
    const slash = candidate.registryId.indexOf('/');
    const provider = slash > 0 ? candidate.registryId.slice(0, slash) : candidate.registryId;
    return !liveModels.has(candidateKey(candidate)) && !liveProviders.has(provider);
  });
}

/**
 * Providers that reject a bare `modelRegistry.streamSimple` call. The router
 * delegates with that call, so it never routes to them. A Pi session can
 * still select them as its own model.
 * - cursor (pi-cursor-sdk): a call needs the receipt of the session that owns it.
 */
const PROVIDERS_WITHOUT_DELEGATION: ReadonlySet<string> = new Set(['cursor']);

function buildRoutableCandidates(args: {
  regModels: unknown[];
  extensionContext: ExtensionContext | undefined;
  config: AutoRouterConfig;
  session: RouterSession;
}): Candidate[] {
  const { extensionContext, config, session } = args;
  const store = loadStore();
  const benchModels = store ? activeModels(store) : [];
  const isModelAllowed = loadModelFilter();
  const isBlacklisted = buildExcludeFilter(session.getSessionBlacklistPatterns());
  const blacklistedProviders = session.getBlacklistedProviders();
  const scopedModels = extensionContext?.scopedModels as
    | readonly { model: { provider: string; id: string } }[]
    | undefined;
  const isScoped = buildScopedModelFilter(scopedModels);
  const regModelList = args.regModels as unknown as RegistryModelInfo[];

  // Live per-model/provider runtime exclusions are NOT part of the key — they
  // are applied by `applyRuntimeExclusions` on every invocation. Blacklisted
  // providers ARE in the key because the build-time filter drops them.
  const expansionKey = [
    regModelList.map((rm) => `${rm.provider}/${rm.id}`).join(','),
    `${store?.syncedAt ?? 0}:${benchModels.length}`,
    JSON.stringify(config.models ?? null),
    [...session.getSessionBlacklistPatterns()].slice().sort().join(','),
    [...blacklistedProviders].sort().join(','),
    scopedModels
      ? scopedModels.map((s) => `${s.model.provider}/${s.model.id}`).sort().join(',')
      : '',
  ].join('|');

  const cachedExpansion = session.getCandidateExpansion();
  let allCandidates: Candidate[];
  if (cachedExpansion && cachedExpansion.key === expansionKey) {
    allCandidates = cachedExpansion.candidates;
  } else {
    const rowsByModel = new Map<string, BenchModel[]>();
    for (const b of benchModels) {
      const list = rowsByModel.get(b.registryId) ?? [];
      list.push(b);
      rowsByModel.set(b.registryId, list);
    }
    const effortDrops = effortDropsPerStep(benchModels);
    allCandidates = regModelList
      .filter(
        (rm) =>
          rm.provider &&
          rm.provider !== ROUTER_PROVIDER_ID &&
          !PROVIDERS_WITHOUT_DELEGATION.has(rm.provider) &&
          !blacklistedProviders.has(rm.provider) &&
          isModelAllowed(`${rm.provider}/${rm.id}`) &&
          !isBlacklisted(`${rm.provider}/${rm.id}`) &&
          isScoped(`${rm.provider}/${rm.id}`),
      )
      .flatMap((rm) =>
        expandModelCandidates(rm, rowsByModel.get(`${rm.provider}/${rm.id}`) ?? [], effortDrops),
      );
    session.setCandidateExpansion({ key: expansionKey, candidates: allCandidates });
  }
  return allCandidates.filter(
    (candidate) => !session.getBlacklistedModels().has(candidateKey(candidate)),
  );
}

/**
 * A work-context failure must not block the turn: it routes as it would with
 * no work context at all.
 */
async function failOpen<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (err) {
    debugLog('context.error', { message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/**
 * Resolve the entry's work context. Does not write the intent cache or touch
 * the stream. Identity and task-type adoption happen at `hand_off_context`.
 */
async function resolveEntrySemantics(entry: {
  session: RouterSession;
  stillCurrent: () => boolean;
  cacheHit: boolean;
  dimension: Dimension;
  cause: DecisionCause;
  turn: { key: string; promptText: string };
  context?: ResolvedEntryContext;
  extensionContext: ExtensionContext | undefined;
  syntheticPrefixes: readonly string[];
}): Promise<{ dimension: Dimension; cause: DecisionCause; context?: ResolvedEntryContext; pendingIdentity?: PendingIdentity; aborted: boolean }> {
  const { dimension, cause } = entry;
  if (entry.cacheHit) return { dimension, cause, ...(entry.context ? { context: entry.context } : {}), aborted: false };
  const resolved = await failOpen(() => resolveEntryContext({
    session: entry.session,
    sessionManager: entry.extensionContext?.sessionManager,
    ...(entry.extensionContext?.cwd ? { cwd: entry.extensionContext.cwd } : {}),
    turn: entry.turn,
    deliverable: dimension,
    syntheticPrefixes: entry.syntheticPrefixes,
    stillCurrent: entry.stillCurrent,
  }));
  if (resolved?.kind === 'aborted') return { dimension, cause, aborted: true };
  return { dimension, cause, ...(resolved ? { pendingIdentity: resolved.identity } : {}), aborted: false };
}

function advanceWorkPhase(args: {
  cacheHit: boolean;
  turnInput: ReturnType<typeof getTurnClassificationInput>;
  /** The entry's task type: what it owes the user. */
  deliverable: Dimension;
  pendingIdentity?: PendingIdentity;
  session: RouterSession;
}): void {
  let workPhaseState = args.session.getWorkPhaseState();
  if (!args.cacheHit) {
    // A new entry closes the previous entry's handoffs; log how they ended.
    if (workPhaseState) {
      const previous = args.session.getPreviousServed();
      const served = previous && servedKey(previous);
      workPhaseState = closeContextEntry(workPhaseState, served);
      if (workPhaseState.contract) workPhaseState = closeContractEntry(workPhaseState, served);
    }
    // The work this entry is on is known only at its handoff, which applies
    // the previous work item's penalties when it continues that item.
    const priorWork = workPhaseState && penaltiesOf(workPhaseState);
    workPhaseState = {
      intentKey: args.turnInput.key,
      deliverable: args.deliverable,
      providerInvocation: 1,
      observedMutationTools: 0,
      ...(workPhaseState?.reasoningHandoff ? { previousHandoffId: workPhaseState.reasoningHandoff.id } : {}),
      ...(priorWork ? { priorWork } : {}),
    };
    if (args.session.context.getIncumbent()) workPhaseState = { ...workPhaseState, incumbentServes: true };
    const completed = completedIncumbent(args.session.context.getLedger());
    if (completed) workPhaseState = { ...workPhaseState, priorCompletion: { workItemId: completed.workItem.id } };
    if (args.pendingIdentity) workPhaseState = { ...workPhaseState, pendingIdentity: args.pendingIdentity };
  } else if (workPhaseState) {
    workPhaseState = nextProviderInvocation(workPhaseState);
  }
  args.session.commitWorkPhaseState(workPhaseState);
}

function resolveTurnEffort(args: {
  chosenCandidate: Candidate | undefined;
  options: SimpleStreamOptions | undefined;
  decision: { dimension: Dimension; chosen: string };
  explicitThinking?: ModelThinkingLevel;
  pi: ExtensionAPI;
  session: RouterSession;
}) {
  const requestedReasoning = args.explicitThinking ?? (typeof args.options?.reasoning === 'string' ? args.options.reasoning : undefined);
  const inheritedReasoning = args.explicitThinking == null && requestedReasoning === args.session.getLastResolvedThinkingLevel();
  // A candidate with an effort label serves its scored effort unless the user
  // chose a level. One without a label gets Pi's session thinking level, as
  // Pi sends it when a user selects that model.
  const routerEffort = inheritedReasoning && args.chosenCandidate?.effort != null;
  const reasoning = resolveThinkingLevel(
    args.chosenCandidate,
    routerEffort ? undefined : requestedReasoning as ThinkingLevel | undefined,
  );
  args.session.setLastResolvedThinkingLevel(reasoning);
  debugLog('decision.thinking', {
    dimension: args.decision.dimension,
    chosen: args.decision.chosen,
    requested: requestedReasoning ?? null,
    inherited: inheritedReasoning,
    resolved: reasoning ?? 'off',
  });
  try {
    args.pi.setThinkingLevel((reasoning ?? 'off') as never);
  } catch {
    // Footer sync is cosmetic; never let it break a turn.
  }
  // Read back what Pi actually holds: Pi clamps the level, and a failed sync
  // leaves the old one in place. Either way, this is what Pi sends next.
  args.session.setSyncedThinkingLevel(readPiThinkingLevel(args.pi));
  const resolvedReasoning = reasoning && reasoning !== 'off' ? reasoning : undefined;
  const delegatedOptions: SimpleStreamOptions = resolvedReasoning
    ? { ...(args.options ?? {}), reasoning: resolvedReasoning }
    : { ...(args.options ?? {}) };
  return { reasoning, resolvedReasoning, delegatedOptions, inheritedReasoning, requestedReasoning };
}

// ─── Provider registration ──────────────────────────────────────────

/**
 * Register the `router/auto` provider with Pi.
 *
 * `ctx` is optional: when omitted (called synchronously at extension-init
 * time, before any session exists) the provider is registered with safe
 * default capacities so it lands in the runtime's `pendingProviderRegistrations`
 * BEFORE Pi resolves the session's default model. Otherwise `findInitialModel`
 * cannot find `router/auto` in the registry and falls back to a concrete
 * provider. When `ctx` is present (session_start / turn_start), capacities are
 * refreshed from the live registry; the dedup guard makes that idempotent.
 */
// ─── Turn pipeline ──────────────────────────────────────────────────

/**
 * The user-visible terminal outcome of one routed turn.
 *
 * Phases return this instead of writing to the consumer stream. Pi ends a turn
 * on the first terminal event it receives, so routing all terminal writes
 * through the single gate in `streamSimple` is what stops one phase from
 * finalizing a turn a later phase still treats as live. `runDelegationLoop` is
 * the one exception: it owns its attempt buffer and reports back through
 * `streamFinalized`.
 */
type RouterTurnOutcome =
  | { kind: 'terminal'; reason: 'error' | 'aborted'; message: string }
  | { kind: 'done' };

const SESSION_CHANGED: RouterTurnOutcome = {
  kind: 'terminal',
  reason: 'aborted',
  message: 'Router session changed during this turn.',
};

function noRoutableCandidates(session: RouterSession): RouterTurnOutcome {
  const excludedProviders = session.getBlacklistedProviders();
  const excludedModels = session.getBlacklistedModels();
  return {
    kind: 'terminal',
    reason: 'error',
    message:
      excludedProviders.size > 0
        ? `No routable models: providers excluded for usage limits this session (${[...excludedProviders].sort().join(', ')}).`
        : excludedModels.size > 0
          ? `No routable models: the remaining models failed earlier this session and are excluded (${[...excludedModels].sort().join(', ')}). Run /router-blacklist clear to retry them.`
          : 'No routable models: the `models` allowlist in `~/.pi/agent/pi8/config.json` matched none of the available models.',
  };
}

interface PreparedTurn {
  cacheHead: { identity: string; tokens: number };
  registry: ModelRegistry;
  extensionContext: ExtensionContext | undefined;
  config: AutoRouterConfig;
  measured: ReturnType<typeof measureTurnInput>;
  intent: ReturnType<typeof resolveBaseIntent>;
  trajectoryEscalation: ReturnType<RouterSession['peekPendingTrajectoryEscalation']>;
  /**
   * Pre-exclusion pool. Scoring re-filters this rather than the snapshot so
   * a mid-turn usage-limit exclusion cannot immediately re-hit the same
   * provider as the serving model.
   */
  candidates: Candidate[];
  routableCandidates: Candidate[];
}

interface ResolvedTurn {
  baseDimension: Dimension;
  baseCause: DecisionCause;
  stillCurrent: () => boolean;
  /** The entry's work-context resolution. */
  context?: ResolvedEntryContext;
  pendingIdentity?: PendingIdentity;
}

interface ScoredTurn {
  decision: ReturnType<typeof resolveRoutingDecision>['decision'];
  routableCandidates: Candidate[];
  requestedReasoning: string | undefined;
  /** A broken contract this invocation hands back; consumed only once it serves. */
  restoredContract?: ExecutionContract;
  /** This invocation serves an accepted context handoff's next phase; consumed only once it serves. */
  pendingBoundary?: boolean;
  /** This invocation releases an accepted plan's incumbent minimums; consumed only once it serves. */
  releasesContract?: boolean;
}

/** Resolve the registry, this turn's input identity, and the candidate pool. */
async function prepareRouterTurn(args: {
  context: Context;
  session: RouterSession;
  runtime: RuntimeBindings;
}): Promise<{ kind: 'ready'; prepared: PreparedTurn } | RouterTurnOutcome> {
  const { context, session, runtime } = args;
  const waitTimer = startTimer();
  const registry = await waitForRegistry(() => runtime.getCurrentModelRegistry());
  const extensionContext = runtime.getLastExtensionContext();
  const regModels = registry?.getAvailable() ?? [];
  debugLog('turn.start', {
    waitForRegistryMs: waitTimer(),
    registryModels: (regModels as unknown[]).length,
  });

  const config = loadConfig();
  const measured = measureTurnInput(context, config);
  session.noteRequest(measured.estContextTokens, promptHeadIdentity(context));
  const intent = resolveBaseIntent(measured.turnInput, session);

  session.bindTrajectoryIntent(measured.turnInput.key);
  // Blocked preflights never emit tool_result. Finalize that batch
  // here, before peeking, so a sibling's evidence can set a pending handoff for this
  // invocation rather than stalling behind an impossible result.
  session.flushAndSetUnresolvedTrajectory();

  const trajectoryEscalation = session.peekPendingTrajectoryEscalation();

  const candidates = buildRoutableCandidates({
    regModels: regModels as unknown[],
    extensionContext,
    config,
    session,
  });
  const routableCandidates = applyRuntimeExclusions(candidates, session);
  if (routableCandidates.length === 0 && !session.getManualModel() && !session.getSemiHold(measured.turnInput.key)) return noRoutableCandidates(session);

  return {
    kind: 'ready',
    prepared: {
      cacheHead: { identity: promptHeadIdentity(context), tokens: estimateTokenCount((extractSystemPrompt(context) ?? '') + JSON.stringify(context.tools ?? [])) },
      registry,
      extensionContext,
      config,
      measured,
      intent,
      trajectoryEscalation,
      candidates,
      routableCandidates,
    },
  };
}

/** Resolve this entry's work identity and local task-type floor. */
async function resolveRouterTurn(args: {
  prepared: PreparedTurn;
  session: RouterSession;
}): Promise<{ kind: 'ready'; resolved: ResolvedTurn } | RouterTurnOutcome> {
  const { prepared, session } = args;
  const { turnInput } = prepared.measured;
  const { cacheHit, cachedIntent } = prepared.intent;

  const sessionGeneration = session.getSessionGeneration();
  const stillCurrent = (): boolean => session.getSessionGeneration() === sessionGeneration;

  const entry = await resolveEntrySemantics({
    session,
    stillCurrent,
    cacheHit,
    dimension: prepared.intent.baseDimension,
    cause: prepared.intent.baseCause,
    turn: turnInput,
    ...(cachedIntent?.context && cacheHit ? { context: cachedIntent.context } : {}),
    extensionContext: prepared.extensionContext,
    syntheticPrefixes: prepared.config.syntheticPrefixes,
  });
  if (entry.aborted) return SESSION_CHANGED;
  const baseDimension = entry.dimension;
  const baseCause = entry.cause;
  const settled = turnInput;

  if (!cacheHit) {
    session.setCachedIntent({
      key: settled.key,
      dimension: baseDimension,
      cause: baseCause,
      ...(entry.context ? { context: entry.context } : {}),
    });
  }
  debugLog('entry.context', {
    cacheHit,
    key: settled.key,
  });

  return {
    kind: 'ready',
    resolved: {
      baseDimension,
      baseCause,
      stillCurrent,
      ...(entry.context ? { context: entry.context } : {}),
      ...(entry.pendingIdentity ? { pendingIdentity: entry.pendingIdentity } : {}),
    },
  };
}

/**
 * This entry's execution contract, with the previous invocation's model
 * recorded as its executor, after objective trajectory struggle by an executor
 * other than the submitter has broken it, or after its executor used up the
 * invocation budget. The submitter's own struggle belongs to the trajectory
 * handoff alone.
 */
function settleExecutionContract(
  observed: WorkPhaseState | undefined,
  trajectory: PreparedTurn['trajectoryEscalation'],
  session: RouterSession,
): ExecutionContract | undefined {
  if (!observed?.contract) return undefined;
  const previous = session.getPreviousServed();
  const state = attributeExecutor(observed, previous && servedKey(previous));
  if (state !== observed) session.commitWorkPhaseState(state);
  const contract = state.contract!;
  if (contract.status !== 'active') return contract;
  if (trajectory && parseCandidateKey(trajectory.fromModel).id !== parseCandidateKey(contract.submitter).id) {
    const broken = breakContract(state, trajectory.fromModel, 'struggle');
    session.commitWorkPhaseState(broken);
    appendExecutionContractSignal({
      intentKey: state.intentKey,
      served: trajectory.fromModel,
      action: 'break',
      meta: contractMeta(broken),
    });
    return broken.contract;
  }
  const expired = expireContract(state);
  if (expired === state) return contract;
  session.commitWorkPhaseState(expired);
  appendExecutionContractSignal({
    intentKey: state.intentKey,
    served: contract.executor ?? contract.submitter,
    action: 'execute',
    meta: contractMeta(expired),
  });
  return expired.contract;
}

/**
 * The submitter's candidate key, with the effort it served at when the policy
 * can score that effort; otherwise the unsuffixed benchmark row it matches.
 */
function submitterKey(candidates: readonly Candidate[], submitter: string): string {
  const scored = scoredIncumbentKey(candidates, submitter);
  if (scored) return scored;
  const row = findSourceCandidate(candidates, submitter);
  return row ? candidateKey(row) : submitter;
}

/**
 * Candidates allowed to execute a released contract: no excluded executor
 * model at any effort, and, once any executor is excluded, measured implement
 * quality strictly above the strongest excluded one. Undefined — the
 * submitter keeps the plan with both incumbent minimums — when the contract
 * keeps the submitter, nobody qualifies, or an excluded executor's quality
 * cannot be found, since then no candidate can be shown to be stronger.
 */
function executorPool(
  candidates: Candidate[],
  state: WorkPhaseState | undefined,
  contract: ExecutionContract,
): { pool: Candidate[]; minimum: number } | undefined {
  const minimum = contract.minimum;
  if (minimum == null) return undefined;
  const excluded = state?.excludedExecutors ?? [];
  const excludedQualities = excluded.map((key) => {
    const row = findSourceCandidate(candidates, key);
    return row ? capabilityForDimension(row, 'implement') : undefined;
  });
  if (excludedQualities.some((quality) => quality == null)) return undefined;
  const excludedQuality = Math.max(-Infinity, ...(excludedQualities as number[]));
  const pool = candidates.filter((c) => {
    const key = candidateKey(c);
    if (isExcludedExecutor(state, key)) return false;
    if (excluded.length === 0) return true;
    const quality = capabilityForDimension(c, 'implement');
    return quality != null && quality > excludedQuality;
  });
  return pool.length > 0 ? { pool, minimum } : undefined;
}

/** Advance the work phase, score the live pool, and record the decision. */
function scoreRouterTurn(args: {
  prepared: PreparedTurn;
  resolved: ResolvedTurn;
  options: SimpleStreamOptions | undefined;
  session: RouterSession;
  /** An explicit user pin is served even if it failed earlier this session. */
  pinned?: boolean;
}): { kind: 'ready'; scored: ScoredTurn } | RouterTurnOutcome {
  const { prepared, resolved, options, session, pinned } = args;
  const { config, measured, intent, candidates, trajectoryEscalation } = prepared;
  const { turnInput, needsVision, estContextTokens } = measured;
  const { cacheHit } = intent;
  const { baseDimension, baseCause } = resolved;

  // Re-filter live runtime exclusions before scoring so a mid-turn
  // usage-limit exclusion cannot immediately re-hit the same provider.
  const routableCandidates = pinned ? candidates : applyRuntimeExclusions(candidates, session);
  if (routableCandidates.length === 0) return noRoutableCandidates(session);

  const observed = session.getWorkPhaseState();
  const intentState = observed?.intentKey === turnInput.key ? observed : undefined;
  const mutationObserved = intentState != null && intentState.observedMutationTools > 0;
  const contract = settleExecutionContract(intentState, trajectoryEscalation, session);
  const contractActive = contract?.status === 'active';
  // A plan another model executed returns to its submitter for review: a plan
  // can be completed wrongly without breaking. A plan only the submitter
  // served continues as implementation.
  const reviewing = contract != null && isUnderReview(contract);
  const implementing = contractActive || (contract?.status === 'executed' && !reviewing);
  // A broken contract hands the next invocation back to its submitter at the
  // submitter's task type and thinking level, until an invocation serves.
  const restore = contract?.status === 'broken' ? contract : undefined;
  const handBack = restore ?? (reviewing ? contract : undefined);
  advanceWorkPhase({
    cacheHit,
    turnInput,
    deliverable: baseDimension,
    ...(resolved.pendingIdentity ? { pendingIdentity: resolved.pendingIdentity } : {}),
    session,
  });
  // An entry that owes context acquires it first, read-only; an accepted
  // context handoff routes the rest of the entry as its next phase, including
  // when a broken plan hands back to its submitter. A pinned or held model
  // serves every phase: a pin chooses the model, not what the request owes.
  let entry = session.getWorkPhaseState();
  const phase = entryPhase(entry, baseDimension);
  if (phase.cause === 'investigation' && entry) {
    let next = entry.contextStatus == null ? { ...entry, contextStatus: 'acquiring' as const, contextRequests: 0 } : entry;
    if (next.contextStatus === 'acquiring' && (next.contextRequests ?? 0) >= ACQUISITION_REQUEST_LIMIT) {
      next = { ...next, contextStatus: 'clarification-only' };
      appendContextHandoffSignal({
        intentKey: next.intentKey,
        served: session.getPreviousServed() ? servedKey(session.getPreviousServed()!) : 'unknown/unknown',
        action: 'budget-exhausted',
        contextReasons: owedContext(entry),
      });
    }
    if (next !== entry) session.commitWorkPhaseState(next);
    entry = next;
    // The entry's one clarification request has been sent: nothing more is dispatched.
    if (entry.contextStatus === 'clarification-only' && entry.clarificationDispatched) {
      return {
        kind: 'terminal',
        reason: 'error',
        message: 'Collecting context for this request has ended. Reply with the missing information to continue.',
      };
    }
  }
  const routedDimension = reviewing ? 'review' : implementing ? 'implement' : phase.dimension;
  const routedCause = reviewing || implementing ? 'execution-contract' : phase.cause ?? baseCause;
  // The reasoning phase is scored at its handoff's minimum; its incumbent
  // minimums are skipped once, until a model serves the phase. A recovery
  // entry keeps its deliverable's strength: no rubric discounts it.
  const reasoning = routedDimension === entry?.reasoningHandoff?.target ? entry.reasoningHandoff : undefined;
  const pendingBoundary = entry?.contextStatus === 'ready-pending' && !handBack;
  const reasoningPending = pendingBoundary && reasoning?.pending === true;

  // Pi clears lastServed at stream start; the rotated value is the model and
  // effort that actually served, including an incumbent effort raise or fallback.
  // That effort is the incumbent's minimum thinking level even when no row
  // measures it, so the chosen key stands in only when no row of the model can.
  const previous = session.getPreviousServed();
  const servedCandidateKey = previous && servedKey(previous);
  const incumbentRegistryId = handBack
    ? submitterKey(routableCandidates, handBack.submitter)
    : (servedCandidateKey && scoredIncumbentKey(routableCandidates, servedCandidateKey))
      || session.getLastChosenRegistryId();
  const requestedReasoning = typeof options?.reasoning === 'string' ? options.reasoning : undefined;
  const userReasoningOverride =
    requestedReasoning != null && requestedReasoning !== session.getLastResolvedThinkingLevel();
  const execution = contractActive && contract.release
    ? executorPool(routableCandidates, session.getWorkPhaseState(), contract)
    : undefined;
  const warm = session.warmPrefixTokens(Date.now(), estContextTokens, PROMPT_CACHE_TTL_MS);
  const history = config.reputation === false ? undefined : session.getModelHistory(turnInput.key);
  if (history) {
    for (const [key, tokens] of sharedPrefixCredits(history, prepared.cacheHead.identity, prepared.cacheHead.tokens, modelEventSession())) {
      warm.set(key, Math.max(warm.get(key) ?? 0, tokens));
    }
  }
  const policy = resolveRoutingDecision({
    candidates: execution?.pool ?? routableCandidates,
    baseDimension: routedDimension,
    baseCause: routedCause,
    trajectoryEscalation,
    userReasoning: requestedReasoning as ThinkingLevel | undefined,
    userReasoningOverride,
    estimatedContextTokens: estContextTokens,
    warmPrefixTokens: warm,
    protocolPenalties: history ? compliancePenalties(history, config.reputationWeights, config.switchMargin) : undefined,
    needsVision,
    incumbentRegistryId,
    sameIntentAsLast: session.getLastDecision()?.intentKey === turnInput.key,
    ...(execution
      ? { handoffMinimum: execution.minimum, handoffPending: contract?.releasePending === true }
      : reasoning ? { handoffMinimum: reasoning.minimum, handoffPending: reasoningPending }
        // Any accepted handoff lets the router choose the next phase's model once.
        : pendingBoundary ? { handoffPending: true } : {}),
    // The conservative fallback records new work without evidence of a change.
    ...(resolved.context ? {
      workRelation: resolved.context.resolution.resolver === 'fallback'
        ? 'unknown' as const
        : resolved.context.resolution.relation,
    } : {}),
    config,
  });
  const decision = policy.decision;
  // The scored pool can hold an incumbent row at its served effort that the
  // routable pool does not; later lookups by chain key need it.
  const scoredCandidates = [
    ...routableCandidates,
    ...policy.candidates.filter((c) => !routableCandidates.some((r) => candidateKey(r) === candidateKey(c))),
  ];
  if (reasoning && policy.trajectoryApplied && !reasoning.trajectoryFired) {
    const current = session.getWorkPhaseState()!;
    session.commitWorkPhaseState({ ...current, reasoningHandoff: { ...reasoning, trajectoryFired: true } });
  }
  if (entry?.deliverable && (phase.cause != null || reasoning)) decision.deliverable = entry.deliverable;
  if (reasoning) decision.reasoningHandoff = session.getWorkPhaseState()?.reasoningHandoff ?? reasoning;
  if (entry?.previousHandoffId && session.getLastDecision()?.intentKey !== turnInput.key) {
    decision.previousHandoffId = entry.previousHandoffId;
  }
  if (mutationObserved) decision.mutationObserved = true;
  if (contract) {
    const current = session.getWorkPhaseState();
    const meta = current && contractMeta(current);
    if (meta) decision.executionContract = meta;
  }
  if (resolved.context) decision.workContext = workContextMeta(resolved.context);
  decision.intentKey = turnInput.key;
  decision.provenanceCounts = turnInput.provenanceCounts;
  try {
    // Counterfactual baseline for /router-report. Never blocks
    // routing: a failure here only omits baseline
    // telemetry for the turn.
    decision.baseline = pickBaseline(routableCandidates, decision.dimension, config.baselineModel);
  } catch {
    // Best-effort telemetry only.
  }
  session.setLastDecision(decision);
  // Trajectory pending is consumed only after a successful serve of
  // an applied handoff. Peeking it here must not drop evidence when
  // no stronger target exists or delegation fails.

  debugLog('decision', {
    dimension: decision.dimension,
    candidates: candidates.length,
    routable: routableCandidates.length,
    chosen: decision.chosen,
    chainLen: decision.fallbackChain.length,
    estContextTokens,
  });

  const scored: ScoredTurn = {
    decision,
    routableCandidates: scoredCandidates,
    requestedReasoning,
    ...(restore ? { restoredContract: restore } : {}),
    ...(pendingBoundary ? { pendingBoundary: true } : {}),
    ...(execution && contract?.releasePending ? { releasesContract: true } : {}),
  };
  // Outside collecting context and its boundary, the incumbent serves: only
  // a plan, trajectory evidence, or a pin routes elsewhere.
  const status = session.getWorkPhaseState()?.contextStatus;
  const holds = !pinned && !contract && !policy.trajectoryApplied
    && status !== 'acquiring' && status !== 'clarification-only' && status !== 'ready-pending';
  return { kind: 'ready', scored: (holds && holdIncumbentServing(prepared, scored, session)) || scored };
}

/**
 * The incumbent at its served thinking level, with the scored chain behind it
 * as fallback. Undefined when it is not routable now: an excluded or removed
 * model is never restored by holding it.
 */
function holdIncumbentServing(prepared: PreparedTurn, scored: ScoredTurn, session: RouterSession): ScoredTurn | undefined {
  const incumbent = session.context.getIncumbent();
  if (!incumbent) return undefined;
  const preferred = incumbent.thinkingLevel ? `${incumbent.registryId}:${incumbent.thinkingLevel}` : incumbent.registryId;
  const held = scored.routableCandidates.find((c) => candidateKey(c) === preferred)
    ?? scored.routableCandidates.find((c) => candidateKey(c) === incumbent.registryId);
  if (!held) return undefined;
  const key = candidateKey(held);
  if (key === scored.decision.chosen) return undefined;
  const pinned = pinnedScored({
    base: scored,
    chosen: held,
    routableCandidates: scored.routableCandidates,
    cause: 'incumbent',
    reason: `kept ${key}, the model serving this session`,
    prepared,
    session,
  });
  pinned.decision.fallbackChain = [key, ...scored.decision.fallbackChain.filter((other) => other !== key)];
  return { ...scored, decision: pinned.decision };
}

/**
 * Count one provider request of an entry collecting context, fallbacks and
 * retries included. The limit is checked when an invocation is scored, so
 * the fallback walk of the invocation that reaches it may still finish.
 */
function countAcquisitionRequest(session: RouterSession, intentKey: string): void {
  const state = session.getWorkPhaseState();
  if (!state || state.intentKey !== intentKey || state.contextStatus !== 'acquiring') return;
  session.commitWorkPhaseState({ ...state, contextRequests: (state.contextRequests ?? 0) + 1 });
}

/** Resolve the served effort, run the fallback walk, and settle the handoff. */
/**
 * The delegated context with every recorded note, the tools note when the
 * request does not already say that the router tools are on, and this
 * invocation's note when it differs from the entry's latest one. Without a
 * routed entry the recorded notes are still added, so the prefix stays the
 * same.
 */
function withEntryNotes(
  session: RouterSession,
  context: Context,
  intentKey: string,
  instruction: string | undefined,
  routedEntry: boolean,
): Context {
  const messages = context.messages ?? [];
  const tools = planToolsNote(session.notes.getNotes(), messages, true);
  const entry = routedEntry ? planRequestNote(session.notes.getNotes(), messages, intentKey, instruction) : {};
  return { ...context, messages: applyNotePlans(session.notes, messages, [tools, entry]) };
}

async function delegateRouterTurn(args: {
  prepared: PreparedTurn;
  resolved: ResolvedTurn;
  scored: ScoredTurn;
  context: Context;
  options: SimpleStreamOptions | undefined;
  pi: ExtensionAPI;
  session: RouterSession;
  turnTimer: () => number;
  stream: AssistantMessageEventStream;
}): Promise<RouterTurnOutcome> {
  const { prepared, resolved, scored, context, options, pi, session, turnTimer, stream } = args;
  const { config, extensionContext, registry } = prepared;
  const { decision, routableCandidates, requestedReasoning } = scored;
  const pin = session.getManualModel() ?? session.getSemiHold(prepared.measured.turnInput.key);
  const registryModels = (registry?.getAvailable() ?? []) as unknown as RegistryModelInfo[];
  const explicitThinking = pin ? resolveManualModel(pin, registryModels)?.thinking : undefined;

  const chosenCandidate = routableCandidates.find((c) => candidateKey(c) === decision.chosen);
  const { resolvedReasoning, delegatedOptions, inheritedReasoning } = resolveTurnEffort({
    chosenCandidate,
    options,
    decision,
    explicitThinking,
    pi,
    session,
  });

  if (decision.fallbackChain.length === 0) {
    // A strict escalation can legitimately have no eligible target.
    // Surface and persist that specific outcome instead of entering
    // delegation and replacing it with a generic exhaustion error.
    renderRouterStatus(extensionContext, decision, undefined);
    appendDecision(decision, {
      registryId: '',
      viaFallback: false,
      accumulatedCost: session.getAccumulatedCost(),
    });
    return { kind: 'terminal', reason: 'error', message: decision.reason };
  }

  // Between-turn struggle wanted a stronger model but none is reachable. The
  // router keeps the struggling model regardless; semi mode lets the user stop,
  // otherwise a warning is surfaced.
  const unavailableGate = await resolveTrajectoryUnavailableGate({
    decision,
    semi: config.semi,
    extensionContext,
    options,
    pinned: pin != null,
  });
  if (unavailableGate.kind === 'terminal') {
    renderRouterStatus(extensionContext, decision, undefined);
    appendDecision(decision, {
      registryId: '',
      viaFallback: false,
      accumulatedCost: session.getAccumulatedCost(),
    });
    return { kind: 'terminal', reason: unavailableGate.reason, message: unavailableGate.message };
  }

  const pendingTrajectory = session.peekPendingTrajectoryEscalation();
  const delegationSessionGeneration = session.getSessionGeneration();
  // An entry collecting context carries the router's standing instruction to
  // hand off rather than act. The status, not the decision's cause, decides
  // it: a pinned model acquires under its own cause. Notes stay where they
  // were first sent; see request-notes.ts.
  const intentKey = prepared.measured.turnInput.key;
  const current = session.getWorkPhaseState();
  const entry = current?.intentKey === intentKey ? current : undefined;
  const acquiring = entry?.contextStatus === 'acquiring';
  const clarifying = entry?.contextStatus === 'clarification-only';
  const workNote = entry?.priorCompletion ? completedWorkNote(entry)
    : entry && (session.context.getLedger().activeWorkItemId || entry.completion) ? activeWorkNote : undefined;
  const instruction = !entry ? undefined
    : clarifying ? CLARIFICATION_NOTE
    : acquiring ? gatheringNote(entry)
    : workNote;
  const delegatedContext = withEntryNotes(session, context, intentKey, entry ? instruction : undefined, !!entry);
  // The one clarification request: tools stay defined, so a history with
  // tool calls remains valid, but none may be called, and no fallback follows.
  if (clarifying) decision.fallbackChain = [decision.chosen];
  const delegationOptions: DelegationOptions = {
    decision,
    registry: registry!,
    context: delegatedContext,
    options: clarifying ? { ...delegatedOptions, toolChoice: 'none' } : delegatedOptions,
    ...(acquiring ? {
      onRequest: () => countAcquisitionRequest(session, intentKey),
    } : {}),
    candidates: routableCandidates,
    reasoning: explicitThinking ?? resolvedReasoning,
    userReasoningOverride: explicitThinking != null || (!inheritedReasoning && requestedReasoning != null),
    extensionContext,
    notifyOnRoute: config.prompt,
    turnTimer,
    session,
  };
  if (config.semi && extensionContext?.hasUI && !pin) {
    delegationOptions.beforeFallback = async (candidateId, previousId) => {
      const previous = parseCandidateKey(previousId);
      const semi = await resolveSemiGate({
        prepared,
        scored: { ...scored, decision: { ...decision, chosen: candidateId } },
        options,
        session,
        incumbent: `${previous.provider}/${previous.id}`,
        fallback: true,
      });
      if (semi.kind === 'terminal') return { kind: 'cancel' };
      if (semi.kind === 'proceed') return { kind: 'proceed' };
      const manual = session.getManualModel() ?? session.getSemiHold(prepared.measured.turnInput.key);
      const thinking = manual ? resolveManualModel(manual, registryModels)?.thinking : undefined;
      return {
        kind: 'substitute',
        decision: semi.scored.decision,
        candidates: semi.scored.routableCandidates,
        ...(thinking ? { reasoning: thinking } : {}),
      };
    };
  }
  // Settled before the loop records the decision, so the decision log and
  // `/router-why` show the boundary's owner for the invocation that took it.
  delegationOptions.settleServed = (lastServed, finalDecision) => {
    const settled = settleBoundary(lastServed, finalDecision);
    noteIncumbent(lastServed, settled);
    return settled;
  };
  // The model that served outside collecting context, and not by a pin, is the incumbent.
  const noteIncumbent = (lastServed: ServedInfo, decision: RoutingDecision): void => {
    try {
      const status = session.getWorkPhaseState()?.contextStatus;
      if (status === 'acquiring' || status === 'clarification-only') return;
      if (session.getManualModel() || session.getSemiHold(intentKey)) return;
      const state = session.getWorkPhaseState();
      const ownedWork = state?.workItemId ?? state?.completion?.workItemId ?? state?.priorCompletion?.workItemId;
      const workItemId = incumbentWorkItem(session.context.getLedger(), lastServed.registryId, ownedWork);
      session.context.recordIncumbent(lastServed, decision.dimension, session.context.getEntrySource() ?? intentKey, workItemId);
      if (state?.priorCompletion && state.providerInvocation === 1) {
        appendWorkLifecycleSignal({ intentKey, served: servedKey(lastServed), action: 'prior-completion', workItemId: state.priorCompletion.workItemId });
      }
    } catch {
      // A lost record only means the next entry is routed afresh.
    }
  };
  const settleBoundary = (lastServed: ServedInfo, finalDecision: RoutingDecision): RoutingDecision => {
    const served = servedKey(lastServed);
    const settling = session.getWorkPhaseState();
    // Marked only after a model served: a failed clarification request can retry.
    if (settling?.intentKey === intentKey && settling.contextStatus === 'clarification-only' && !settling.clarificationDispatched) {
      session.commitWorkPhaseState({ ...settling, clarificationDispatched: true });
    }
    // Like the trajectory handoff, a broken contract's handback is consumed only
    // by an invocation its submitter served: a failed one, or a fallback to
    // another model, leaves the next invocation bound to the submitter too.
    const restored = scored.restoredContract;
    const afterServe = session.getWorkPhaseState();
    if (restored && afterServe?.contract === restored && servedBySubmitter(restored, served)) {
      appendContractOutcome(afterServe, 'broken');
      session.commitWorkPhaseState({ ...afterServe, contract: undefined });
    }
    // A plan's release and a reasoning handoff's boundary belong to the first
    // invocation served by a candidate that clears the phase's minimum. A
    // fallback below it leaves the boundary pending; when no candidate clears
    // it, whichever serves is the best the pool offers.
    const qualifiers = boundaryQualifiers(scored.decision);
    if (qualifiers.length > 0 && !servesBoundary(served, qualifiers)) return finalDecision;
    const releasing = session.getWorkPhaseState();
    if (scored.releasesContract && releasing?.contract?.status === 'active') {
      session.commitWorkPhaseState(serveContractRelease(releasing));
    }
    const current = session.getWorkPhaseState();
    if (!scored.pendingBoundary || current?.intentKey !== intentKey || current.contextStatus !== 'ready-pending') {
      return finalDecision;
    }
    const owned = serveContextHandoff(current, served);
    session.commitWorkPhaseState(owned);
    const handoff = owned.reasoningHandoff;
    appendContextHandoffSignal({
      intentKey: owned.intentKey,
      served: handoff?.owner ?? served,
      action: 'served',
      ...(handoff ? { handoff } : { deliverable: owned.deliverable }),
    });
    return handoff ? { ...finalDecision, reasoningHandoff: handoff } : finalDecision;
  };
  const result = await runDelegationLoop(delegationOptions, stream);
  if (result.success && session.getSessionGeneration() === delegationSessionGeneration) {
    recordServedWork(session, session.getWorkPhaseState()?.workItemId);
    const actual = session.getLastServed();
    if (config.reputation !== false && actual) {
      appendModelEvent({
        kind: 'served', model: servedKey(actual), entry: modelEventEntry(intentKey), session: modelEventSession(),
        dimension: decision.dimension, prefix: prepared.cacheHead.identity, prefixTokens: prepared.cacheHead.tokens,
      });
    }
  }

  if (
    result.capabilityHandoff
    && pendingTrajectory
    && result.capabilityHandoff.fromModel === pendingTrajectory.fromModel
    && session.peekPendingTrajectoryEscalation() === pendingTrajectory
    && session.getSessionGeneration() === delegationSessionGeneration
    && resolved.stillCurrent()
  ) {
    session.consumePendingTrajectoryEscalation();
  }

  if (!result.streamFinalized && !result.success) {
    return {
      kind: 'terminal',
      reason: 'error',
      message: `All routing fallbacks exhausted${result.lastError ? ` (last error: ${result.lastError})` : ''}.`,
    };
  }
  return { kind: 'done' };
}

function readPiThinkingLevel(pi: ExtensionAPI): string | undefined {
  try {
    const level: unknown = pi.getThinkingLevel?.();
    return typeof level === 'string' ? level : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A thinking-level change the router did not write (Shift+Tab, settings, or
 * another extension) is an explicit user choice: pin the model that served the
 * previous turn at that level. Pi reports no source for the change, so the
 * router compares the requested level with the level Pi held after the
 * router's own last sync. Before any model has served, the change stays a
 * one-turn effort override.
 */
function pinOnThinkingChange(
  prepared: PreparedTurn,
  options: SimpleStreamOptions | undefined,
  session: RouterSession,
): void {
  try {
    const synced = session.getSyncedThinkingLevel();
    if (synced === undefined) return;
    // Pi omits `reasoning` for `off`.
    const requested = typeof options?.reasoning === 'string' ? options.reasoning : 'off';
    if (requested === synced) return;
    session.setSyncedThinkingLevel(requested);
    const models = (prepared.registry?.getAvailable() ?? []) as unknown as RegistryModelInfo[];
    const manual = session.getManualModel();
    const registryId = manual
      ? resolveManualModel(manual, models)?.registryId
      : session.getPreviousServed()?.registryId;
    const model = registryId ? models.find((m) => `${m.provider}/${m.id}` === registryId) : undefined;
    if (!registryId || !model) return;
    const level = resolveThinkingLevel(model, requested as ThinkingLevel);
    const pin = level ? `${registryId}:${level}` : registryId;
    if (!resolveManualModel(pin, models)) return;
    session.setManualModel(pin);
    const ctx = prepared.extensionContext;
    if (ctx?.hasUI) {
      ctx.ui.notify(
        `Manual override: ${pin} (thinking level changed). Run /router-manual resume to return to automatic routing.`,
        'info',
      );
    }
  } catch {
    // A failed pin leaves ordinary routing in place.
  }
}

/**
 * Candidates for a manual pin. A pin is an explicit user override, so it must
 * serve even a model the router's own allowlist / config-blacklist / scoped set
 * would exclude — the picker offers the same models as Pi's `/model`. Prefer the
 * already-expanded routable pool when the pin is in it; otherwise expand the pin
 * directly from the live registry, bypassing the build-time routing filters.
 * Live runtime exclusions (session blacklist / usage limits) still apply later
 * in scoring, matching the pinned-only, surface-failure contract.
 */
function manualCandidates(prepared: PreparedTurn, manualModel: string): Candidate[] {
  const regModels = (prepared.registry?.getAvailable() ?? []) as unknown as RegistryModelInfo[];
  const pin = resolveManualModel(manualModel, regModels);
  if (!pin) return [];
  let candidates = prepared.candidates.filter((candidate) => candidate.registryId === pin.registryId);
  if (candidates.length === 0) {
    const rm = regModels.find((m) => `${m.provider}/${m.id}` === pin.registryId)!;
    const store = loadStore();
    const benchModels = store ? activeModels(store) : [];
    candidates = expandModelCandidates(rm, benchModels.filter((b) => b.registryId === pin.registryId), effortDropsPerStep(benchModels));
  }
  if (pin.thinking) {
    const measured = candidates.find((c) => c.effort === pin.thinking);
    const base = candidates[0];
    return measured ? [measured] : base ? [{ ...base, effort: pin.thinking }] : [];
  }
  return candidates;
}

/** Rebuild a decision that pins one candidate for this turn (semi hold/pin). */
function pinnedScored(args: {
  base: ScoredTurn;
  chosen: Candidate;
  routableCandidates: Candidate[];
  cause: DecisionCause;
  reason: string;
  prepared: PreparedTurn;
  session: RouterSession;
}): ScoredTurn {
  const { base, chosen, routableCandidates, cause, reason, prepared, session } = args;
  const key = candidateKey(chosen);
  const decision: RoutingDecision = {
    ...base.decision,
    chosen: key,
    fallbackChain: [key],
    cause,
    reason,
  };
  // These annotations belonged to the auto pick this override replaces.
  delete decision.scoredReason;
  delete decision.routedPickChanged;
  delete decision.trajectoryFriction;
  try {
    decision.baseline = pickBaseline(
      applyRuntimeExclusions(prepared.candidates, session),
      decision.dimension,
      prepared.config.baselineModel,
    );
  } catch {
    // Best-effort report telemetry only; failure must not stop routing.
  }
  session.setLastDecision(decision);
  return { decision, routableCandidates, requestedReasoning: base.requestedReasoning };
}

type SemiOutcome = { kind: 'proceed' } | { kind: 'override'; scored: ScoredTurn } | { kind: 'terminal'; reason: 'error' | 'aborted'; message: string };

/**
 * Semi-automatic confirmation gate. When `semi` is on and the routed pick
 * differs from the model that served the previous turn, ask the user before
 * delegating. Runs once per turn, after scoring, transforming the already-
 * scored decision in place (never a second `scoreRouterTurn`, which would
 * double-advance the work phase). Unexpected failures degrade to the router's
 * pick; dismissing the dialog cancels the turn instead of switching.
 */
async function resolveSemiGate(args: {
  prepared: PreparedTurn;
  scored: ScoredTurn;
  options: SimpleStreamOptions | undefined;
  session: RouterSession;
  incumbent?: string;
  fallback?: boolean;
}): Promise<SemiOutcome> {
  const { prepared, scored, options, session } = args;
  const generation = session.getSessionGeneration();
  const pinAtStart = session.getManualModel();
  const cancelled = (): boolean => options?.signal?.aborted === true
    || session.getSessionGeneration() !== generation
    || session.getManualModel() !== pinAtStart;
  const aborted = { kind: 'terminal', reason: 'aborted', message: 'Model switch cancelled.' } as const;
  try {
    if (!prepared.config.semi) return { kind: 'proceed' };
    // Same-entry tool-loop continuations are not a new switch. A
    // declined switch is reused via `getSemiHold` before scoring; an accepted
    // one sticks through ordinary incumbent scoring.
    if (prepared.intent.cacheHit && !args.fallback) return { kind: 'proceed' };
    const ctx = prepared.extensionContext;
    if (!ctx?.hasUI) return { kind: 'proceed' };
    const ui = ctx.ui;
    const previous = session.getPreviousServed();
    const incumbent = args.incumbent ?? previous?.registryId;
    // Only a switch away from an established incumbent is a "model changed".
    if (!incumbent) return { kind: 'proceed' };
    const routed = parseCandidateKey(scored.decision.chosen);
    const routedId = `${routed.provider}/${routed.id}`;
    if (routedId === incumbent) return { kind: 'proceed' };

    const dialogOpts = options?.signal ? { signal: options.signal } : undefined;
    const useNew = `Yes — use ${routedId}`;
    const keep = `No — keep ${incumbent}`;
    const pickOther = 'Specific model…';
    const choice = await ui.select(
      `Router wants to switch: ${incumbent} \u2192 ${routedId}`,
      [useNew, keep, pickOther],
      dialogOpts,
    );
    if (cancelled() || choice === undefined) return aborted;
    if (choice === useNew) return { kind: 'proceed' };

    if (choice === keep) {
      // A fallback ask means the previous candidate already failed. "No" is
      // refuse-the-switch, not retry-the-dead-model.
      if (args.fallback) return aborted;
      const level = previous?.registryId === incumbent ? previous.thinkingLevel : undefined;
      return holdIncumbent(prepared, scored, session, incumbent, level);
    }
    if (choice !== pickOther) return aborted;
    const pinned = await promptPin(prepared, scored, session, ui, incumbent, dialogOpts, cancelled);
    return pinned ?? aborted;
  } catch {
    return { kind: 'proceed' };
  }
}

/** Keep the incumbent for this turn, at its served thinking level when it is still available. */
function holdIncumbent(
  prepared: PreparedTurn,
  scored: ScoredTurn,
  session: RouterSession,
  incumbent: string,
  level: string | undefined,
): SemiOutcome {
  const preferred = level ? `${incumbent}:${level}` : incumbent;
  const heldCandidates = applyRuntimeExclusions(manualCandidates(prepared, preferred), session);
  const candidates = heldCandidates.length > 0
    ? heldCandidates
    : applyRuntimeExclusions(manualCandidates(prepared, incumbent), session);
  const held = candidates[0];
  if (!held) return { kind: 'terminal', reason: 'error', message: `Cannot keep ${incumbent}: model is unavailable.` };
  session.setSemiHold(
    prepared.measured.turnInput.key,
    heldCandidates.length > 0 ? preferred : incumbent,
  );
  return {
    kind: 'override',
    scored: pinnedScored({
      base: scored,
      chosen: held,
      routableCandidates: candidates,
      cause: 'semi-hold',
      reason: `Semi mode: kept ${incumbent} for this turn`,
      prepared,
      session,
    }),
  };
}

/**
 * Ask for a model to pin until the user names an available one. Returns
 * undefined when the dialog is dismissed or the gate is cancelled.
 */
async function promptPin(
  prepared: PreparedTurn,
  scored: ScoredTurn,
  session: RouterSession,
  ui: ExtensionContext['ui'],
  incumbent: string,
  dialogOpts: { signal: AbortSignal } | undefined,
  cancelled: () => boolean,
): Promise<SemiOutcome | undefined> {
  for (;;) {
    const raw = await ui.input('Model to pin: provider/model-id[:thinking]', incumbent, dialogOpts);
    if (cancelled() || raw === undefined) return undefined;
    const model = raw.trim();
    const candidates = applyRuntimeExclusions(manualCandidates(prepared, model), session);
    if (candidates.length === 0) {
      ui.notify('Model or thinking level is unavailable. Choose another model.', 'warning');
      continue;
    }
    session.setManualModel(model);
    return {
      kind: 'override',
      scored: pinnedScored({
        base: scored,
        chosen: candidates[0]!,
        routableCandidates: candidates,
        cause: 'manual-override',
        reason: `Manual model pin: ${model}`,
        prepared,
        session,
      }),
    };
  }
}

/**
 * Between-turn escalation gate for the "struggle wanted a stronger model but
 * none is reachable" outcome (`trajectoryFriction.unavailable`). The router
 * keeps the struggling model either way; this only decides whether the user
 * gets a say (semi) or a heads-up (warn). A user pin already fixed the model,
 * so the gate is skipped..
 */
async function resolveTrajectoryUnavailableGate(args: {
  decision: RoutingDecision;
  semi: boolean;
  extensionContext: ExtensionContext | undefined;
  options: SimpleStreamOptions | undefined;
  pinned: boolean;
}): Promise<{ kind: 'proceed' } | { kind: 'terminal'; reason: 'aborted'; message: string }> {
  const { decision, semi, extensionContext: ctx, options, pinned } = args;
  try {
    if (pinned) return { kind: 'proceed' };
    if (decision.trajectoryFriction?.unavailable !== true) return { kind: 'proceed' };
    const fromModel = decision.trajectoryFriction.fromModel;
    const message = `${fromModel} is struggling and no stronger model is available for this turn.`;
    if (semi && ctx?.hasUI) {
      const cont = 'Yes \u2014 continue with the current model';
      const stop = 'No \u2014 stop';
      const choice = await ctx.ui.select(
        `${message} Continue?`,
        [cont, stop],
        options?.signal ? { signal: options.signal } : undefined,
      );
      if (choice === undefined || choice === stop) {
        return { kind: 'terminal', reason: 'aborted', message: 'Stopped: no stronger model available for a struggling turn.' };
      }
      return { kind: 'proceed' };
    }
    if (ctx?.hasUI) ctx.ui.notify(`${message} Continuing.`, 'warning');
    return { kind: 'proceed' };
  } catch {
    return { kind: 'proceed' };
  }
}

/**
 * Resolve a pinned or resumed entry's work context. Only the deterministic
 * tiers apply; the pin chooses the model, not whether context is owed.
 */
async function resolvePinnedEntryContext(
  prepared: PreparedTurn,
  session: RouterSession,
): Promise<ResolvedEntryContext | PendingIdentity | undefined | 'aborted'> {
  if (prepared.intent.cacheHit) return prepared.intent.cachedIntent?.context
    ?? session.getWorkPhaseState()?.pendingIdentity;
  const generation = session.getSessionGeneration();
  const resolved = await failOpen(() => resolveEntryContext({
    session,
    sessionManager: prepared.extensionContext?.sessionManager,
    ...(prepared.extensionContext?.cwd ? { cwd: prepared.extensionContext.cwd } : {}),
    turn: prepared.measured.turnInput,
    deliverable: prepared.intent.baseDimension,
    ...(prepared.config.syntheticPrefixes.length > 0
      ? { syntheticPrefixes: prepared.config.syntheticPrefixes }
      : {}),
    stillCurrent: () => session.getSessionGeneration() === generation,
  }));
  return resolved?.kind === 'aborted' ? 'aborted' : resolved?.identity;
}

function isPendingIdentity(value: ResolvedEntryContext | PendingIdentity | undefined): value is PendingIdentity {
  return !!value && 'catalog' in value;
}

/** Serve the session-scoped manual pin and nothing else. */
async function runManualTurn(args: {
  prepared: PreparedTurn;
  manualModel: string;
  cause?: 'manual-override' | 'semi-hold';
  context: Context;
  options: SimpleStreamOptions | undefined;
  pi: ExtensionAPI;
  session: RouterSession;
  turnTimer: () => number;
  stream: AssistantMessageEventStream;
}): Promise<RouterTurnOutcome> {
  const { prepared, manualModel, cause = 'manual-override', context, options, pi, session, turnTimer, stream } = args;
  const entryContext = await resolvePinnedEntryContext(prepared, session);
  if (entryContext === 'aborted') return SESSION_CHANGED;
  const pendingIdentity = isPendingIdentity(entryContext) ? entryContext : undefined;
  const resolvedContext = entryContext && 'resolution' in entryContext ? entryContext : undefined;
  if (!prepared.intent.cacheHit) {
    const { turnInput } = prepared.measured;
    session.setCachedIntent({
      key: turnInput.key,
      dimension: prepared.intent.baseDimension,
      cause: prepared.intent.baseCause,
      ...(resolvedContext ? { context: resolvedContext } : {}),
    });
  }
  const candidates = manualCandidates(prepared, manualModel);
  if (candidates.length === 0) {
    return {
      kind: 'terminal',
      reason: 'error',
      message: `Manual model ${manualModel} is not available. Choose an available model or run /router-manual resume.`,
    };
  }

  const manualPrepared: PreparedTurn = {
    ...prepared,
    candidates,
    routableCandidates: candidates,
    trajectoryEscalation: undefined,
  };
  const resolved: ResolvedTurn = {
    baseDimension: prepared.intent.baseDimension,
    baseCause: cause,
    stillCurrent: () => true,
    ...(resolvedContext ? { context: resolvedContext } : {}),
    ...(pendingIdentity ? { pendingIdentity } : {}),
  };
  const scoring = scoreRouterTurn({
    prepared: manualPrepared,
    resolved,
    options,
    session,
    pinned: cause === 'manual-override',
  });
  if (scoring.kind !== 'ready') return scoring;

  const { decision } = scoring.scored;
  decision.cause = cause;
  decision.reason = cause === 'semi-hold' ? `Semi mode: kept ${manualModel} for this turn` : `Manual model pin: ${manualModel}`;
  delete decision.scoredReason;
  delete decision.routedUp;
  delete decision.routedDown;
  delete decision.confidence;
  delete decision.routedPickChanged;
  delete decision.trajectoryFriction;
  // The scorer may rank several measured effort variants of the same model.
  // Manual mode is pinned-only, so delegation receives exactly one chain entry.
  decision.fallbackChain = [decision.chosen];
  try {
    decision.baseline = pickBaseline(
      applyRuntimeExclusions(prepared.candidates, session),
      decision.dimension,
      prepared.config.baselineModel,
    );
  } catch {
    // Best-effort report telemetry only.
  }

  return delegateRouterTurn({
    prepared: manualPrepared,
    resolved,
    scored: scoring.scored,
    context,
    options,
    pi,
    session,
    turnTimer,
    stream,
  });
}

/**
 * Serve `/router-manual resume`: reuse the pre-pin auto decision's model and
 * fallback chain for this user entry instead of recomputing. Returns
 * `{ kind: 'recompute' }` when none of the snapshot's chain survives the live
 * runtime exclusions, so the caller falls through to ordinary auto routing.
 */
async function runResumeTurn(args: {
  prepared: PreparedTurn;
  resume: RoutingDecision;
  context: Context;
  options: SimpleStreamOptions | undefined;
  pi: ExtensionAPI;
  session: RouterSession;
  turnTimer: () => number;
  stream: AssistantMessageEventStream;
}): Promise<RouterTurnOutcome | { kind: 'recompute' }> {
  const { prepared, resume, context, options, pi, session, turnTimer, stream } = args;
  const routableCandidates = applyRuntimeExclusions(prepared.candidates, session);
  const present = new Set(routableCandidates.map((c) => candidateKey(c)));
  const chain = resume.fallbackChain.filter((key) => present.has(key));
  if (chain.length === 0) {
    // The remembered route no longer exists (blacklisted/usage-limited); expire
    // the one-shot and recompute rather than serve an empty chain.
    session.clearPendingResume();
    return { kind: 'recompute' };
  }

  const entryContext = await resolvePinnedEntryContext(prepared, session);
  const { turnInput } = prepared.measured;
  if (entryContext === 'aborted') return SESSION_CHANGED;
  if (isPendingIdentity(entryContext)) {
    session.clearPendingResume();
    return { kind: 'recompute' };
  }
  if (!prepared.intent.cacheHit) {
    session.setCachedIntent({
      key: turnInput.key,
      dimension: prepared.intent.baseDimension,
      cause: prepared.intent.baseCause,
      ...(entryContext ? { context: entryContext } : {}),
    });
  }

  const decision: RoutingDecision = {
    ...resume,
    chosen: chain[0],
    fallbackChain: chain,
    cause: 'resume',
    reason: `Resumed prior route: ${chain[0]}`,
    intentKey: turnInput.key,
    provenanceCounts: turnInput.provenanceCounts,
    ...(entryContext ? { workContext: workContextMeta(entryContext) } : {}),
  };
  // Drop annotations that belonged to the snapshot's own turn: this turn did
  // not re-derive friction, a pick change, or its work context.
  delete decision.trajectoryFriction;
  delete decision.confidence;
  delete decision.routedUp;
  delete decision.routedDown;
  if (!entryContext) delete decision.workContext;
  delete decision.routedPickChanged;
  try {
    decision.baseline = pickBaseline(routableCandidates, decision.dimension, prepared.config.baselineModel);
  } catch {
    // Best-effort report telemetry only.
  }
  session.setLastDecision(decision);

  const resolved: ResolvedTurn = {
    baseDimension: decision.dimension,
    baseCause: 'resume',
    stillCurrent: () => true,
  };
  const scored: ScoredTurn = {
    decision,
    routableCandidates,
    requestedReasoning: typeof options?.reasoning === 'string' ? options.reasoning : undefined,
  };
  return delegateRouterTurn({
    prepared,
    resolved,
    scored,
    context,
    options,
    pi,
    session,
    turnTimer,
    stream,
  });
}

/**
 * Ordered phases for one router turn. Scoring re-filters the candidate pool
 * after identity resolution, and the trajectory handoff is acknowledged only
 * once a stronger model has actually served.
 */
async function runRouterTurn(args: {
  context: Context;
  options: SimpleStreamOptions | undefined;
  pi: ExtensionAPI;
  session: RouterSession;
  runtime: RuntimeBindings;
  turnTimer: () => number;
  stream: AssistantMessageEventStream;
}): Promise<RouterTurnOutcome> {
  const { context, options, pi, session, runtime, turnTimer, stream } = args;

  if (!session.getManualModel()) {
    const benchmarks = runtime.checkBenchmarks();
    if (!benchmarks.ready) return { kind: 'terminal', reason: 'error', message: benchmarks.message };
  }

  const preparation = await prepareRouterTurn({ context, session, runtime });
  if (preparation.kind !== 'ready') return preparation;
  const { prepared } = preparation;

  pinOnThinkingChange(prepared, options, session);
  const manualModel = session.getManualModel();
  if (manualModel) {
    return runManualTurn({
      prepared,
      manualModel,
      context,
      options,
      pi,
      session,
      turnTimer,
      stream,
    });
  }

  const hold = session.getSemiHold(prepared.measured.turnInput.key);
  if (prepared.config.semi && hold) {
    return runManualTurn({ prepared, manualModel: hold, cause: 'semi-hold', context, options, pi, session, turnTimer, stream });
  }

  const resume = session.resolveResumeDecision(prepared.measured.turnInput.key);
  if (resume) {
    const outcome = await runResumeTurn({
      prepared,
      resume,
      context,
      options,
      pi,
      session,
      turnTimer,
      stream,
    });
    if (outcome.kind !== 'recompute') return outcome;
  }

  const resolvedTurn = await resolveRouterTurn({ prepared, session });
  if (resolvedTurn.kind !== 'ready') return resolvedTurn;
  const { resolved } = resolvedTurn;

  const scoring = scoreRouterTurn({ prepared, resolved, options, session });
  if (scoring.kind !== 'ready') return scoring;

  const semi = await resolveSemiGate({ prepared, scored: scoring.scored, options, session });
  if (semi.kind === 'terminal') return semi;
  const scored = semi.kind === 'override' ? semi.scored : scoring.scored;

  return delegateRouterTurn({
    prepared,
    resolved,
    scored,
    context,
    options,
    pi,
    session,
    turnTimer,
    stream,
  });
}

export function registerAutoRouterProvider(
  pi: ExtensionAPI,
  ctx?: ExtensionContext,
  session: RouterSession = defaultRouterSession,
  runtime: RuntimeBindings = defaultRuntimeBindings,
): void {
  if (ctx) {
    runtime.setCurrentModelRegistry(ctx.modelRegistry);
    runtime.setLastExtensionContext(ctx);
  }

  const registry = ctx?.modelRegistry ?? runtime.getCurrentModelRegistry();
  const regModels = registry?.getAvailable() ?? [];
  const registryModels = regModels as unknown as RegistryModelInfo[];

  // "Largest routable window" means largest among models the user's
  // `models`/`blacklist` config actually lets the router pick, not every
  // model in Pi's registry — an unrelated provider's huge context window
  // must not delay compaction for a session scoped away from it.
  let isModelAllowed: (registryId: string) => boolean = () => true;
  let isModelBlacklisted: (registryId: string) => boolean = () => false;
  try {
    isModelAllowed = loadModelFilter();
    isModelBlacklisted = loadConfigBlacklistFilter();
  } catch {
    // Fall through to allow-all/exclude-none; registration must not fail.
  }
  const routableRegistryModels = registryModels.filter((m) => {
    const id = `${m.provider}/${m.id}`;
    return isModelAllowed(id) && !isModelBlacklisted(id);
  });

  // Only routable models feed the aggregate: an allowlist that (transiently,
  // e.g. mid-config-edit) matches nothing must NOT leak a disallowed
  // provider's window into the advertised capacity. `DEFAULT_CONTEXT_WINDOW`/
  // `DEFAULT_MAX_TOKENS` are a synthetic placeholder used only when zero
  // routable models exist, never a floor that inflates a genuinely small
  // routable maximum.
  let maxCw = 0;
  let maxMT = 0;
  for (const m of routableRegistryModels) {
    if (m.contextWindow && m.contextWindow > maxCw) maxCw = m.contextWindow;
    if (m.maxTokens && m.maxTokens > maxMT) maxMT = m.maxTokens;
  }
  if (maxCw <= 0) maxCw = DEFAULT_CONTEXT_WINDOW;
  if (maxMT <= 0) maxMT = DEFAULT_MAX_TOKENS;
  // Pi compacts against the session model's window, and the session model is
  // `router/auto`. Once a model has served, the conversation lives in that
  // model's window, so advertise its limits; the routable maximum only covers
  // a session that has not served yet.
  const served = session.getLastServed() ?? session.getPreviousServed();
  const slash = served?.registryId.indexOf('/') ?? -1;
  const servedModel = served && slash > 0
    ? registryModels.find((m) =>
      m.provider === served.registryId.slice(0, slash) && m.id === served.registryId.slice(slash + 1))
    : undefined;
  if (servedModel?.contextWindow && servedModel.contextWindow > 0) maxCw = servedModel.contextWindow;
  if (servedModel?.maxTokens && servedModel.maxTokens > 0) maxMT = servedModel.maxTokens;
  // A configured `routerContextWindow` lets the user advertise a smaller
  // effective window so Pi compacts earlier and keeps cheaper models eligible
  // longer. An override above the served model's window (or the largest
  // routable window before anything has served) would advertise capacity the
  // conversation does not have, so it is clamped down to `maxCw`, never up.
  let configuredCw: number | undefined;
  try {
    configuredCw = loadConfig().routerContextWindow;
  } catch {
    configuredCw = undefined;
  }
  const advertisedCw = configuredCw && configuredCw > 0 ? Math.min(configuredCw, maxCw) : maxCw;
  const routerThinkingLevelMap = buildRouterThinkingLevelMap(registryModels);

  const modelSetKey = registryModels.map((m) => `${m.provider}/${m.id}`).sort().join(',');
  const modelsKey = `${modelSetKey}|${advertisedCw}|${maxMT}`;
  if (modelsKey === runtime.getLastRegisteredModels()) return;

  try {
    pi.registerProvider('router', {
      baseUrl: 'router://local',
      apiKey: 'pi8',
      api: 'router-auto-api',
      models: [
        {
          id: AUTO_MODEL_ID,
          name: 'Auto Router',
          api: 'router-auto-api' as Api,
          contextWindow: advertisedCw,
          maxTokens: maxMT,
          input: ['text', 'image'] as ('text' | 'image')[],
          reasoning: true,
          thinkingLevelMap: routerThinkingLevelMap,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],

      streamSimple(
        _model: Model<Api>,
        context: Context,
        options?: SimpleStreamOptions,
      ): AssistantMessageEventStream {
        const stream = createAssistantMessageEventStream();
        // Re-advertise before the stream ends, so Pi's next compaction check
        // already sees the window of the model that just served.
        const end = (): void => {
          try {
            registerAutoRouterProvider(pi, undefined, session, runtime);
          } catch {
            // Advertised limits are advisory; the turn result stands.
          }
          stream.end();
        };

        (async () => {
          // Preserve the prior served model for the semi-mode switch gate before
          // clearing it for this turn.
          session.rotateServedForNewTurn();
          const turnTimer = startTimer();
          try {
            const outcome = await runRouterTurn({
              context,
              options,
              pi,
              session,
              runtime,
              turnTimer,
              stream,
            });
            if (outcome.kind === 'terminal') {
              stream.push(makeTerminalErrorEvent(outcome.reason, outcome.message));
            }
            end();
          } catch (err) {
            if (options?.signal?.aborted) {
              const msg = err instanceof Error ? err.message : String(err);
              stream.push(makeTerminalErrorEvent('aborted', msg));
              end();
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            debugLog('turn.error', {
              message: msg,
              stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
              totalMs: turnTimer(),
            });
            stream.push(makeTerminalErrorEvent('error', `Router error: ${msg}`));
            end();
          }
        })();

        return stream;
      },
    });

    runtime.setLastRegisteredModels(modelsKey);
  } catch {
    // Registration failed — don't poison the dedup guard.
  }
}
