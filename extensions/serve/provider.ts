/**
 * Provider registration for the `router/auto` model.
 *
 * Pattern: register a synthetic model with Pi (`pi.registerProvider`) that
 * classifies each turn locally, scores candidates from the live model
 * registry, and delegates the stream to the best match with a fallback
 * chain. One bounded, cancellable assessment per real user entry answers
 * what kind of work this is and may adjust the routed dimension under the
 * assessment safety caps.
 */
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
import { classify, estimateTokenCount } from '../routing/classify/classifier.js';
import { DIMENSION_STRENGTH } from '../routing/classify/classifier.js';
import { DEFAULT_EMBEDDING_MIN_CONFIDENCE } from '../constants.js';
import { embedAndClassify } from '../embed/embedding.js';
import { getTurnClassificationInput, buildRoleLabelledContext } from '../routing/policy/continuation.js';
import { loadModelFilter, buildExcludeFilter, buildScopedModelFilter, loadConfigBlacklistFilter } from '../routing/policy/allowlist.js';
import { loadConfig } from '../config.js';
import { runAssessment, type AssessmentConfig } from '../routing/consult/consult.js';
import { adoptAssessment, shouldVetoLatch } from '../routing/consult/assessment-adoption.js';
import { latestSummaryText, countToolActivity } from '../routing/consult/message-provenance.js';

import { appendDecision, appendAssessmentMetric } from '../host/decisionlog.js';
import { renderRouterStatus } from '../host/ui.js';
import {
  buildCandidate,
  buildRouterThinkingLevelMap,
  candidateKey,
  parseCandidateKey,
  isThinkingSupportedByRegistryModel,
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
  getCachedRoutingIntent,
  getCurrentModelRegistry,
} from './router-session-state.js';
import { debugLog, startTimer } from '../host/debuglog.js';
import { runDelegationLoop, type DelegationOptions } from './delegation.js';
import { makeTerminalErrorEvent } from './error-event.js';
import { resolveRoutingDecision, wouldDepthEscalate } from '../routing/policy/routing-policy.js';
import {
  advanceForRoutingOwner,
  capabilityBandFor,
  deriveInitialPhase,
  inheritThinContinuation,
  nextProviderInvocation,
  scoringPolicyForState,
  terminalRequirement,
} from '../routing/policy/work-phase.js';

export {
  addSessionBlacklistPatterns,
  blacklistModel,
  blacklistProvider,
  clearBlacklistedModels,
  clearBlacklistedProviders,
  clearSessionBlacklist,
  getBlacklistDebugState,
  getBlacklistedModels,
  getBlacklistedProviders,
  getSessionBlacklistPatterns,
  removeBlacklistedModel,
  removeBlacklistedProvider,
  removeSessionBlacklistPatterns,
} from './blacklist.js';

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
  getRegistry: () => ReturnType<typeof getCurrentModelRegistry>,
  timeoutMs = REGISTRY_WAIT_TIMEOUT_MS,
): Promise<ReturnType<typeof getCurrentModelRegistry>> {
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
  embeddingStats: session.getEmbeddingStats(),
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

function evidenceForAssessment(
  context: Context,
  config: AutoRouterConfig,
  pi: ExtensionAPI,
  session: RouterSession = defaultRouterSession,
): Parameters<typeof runAssessment>[3] {
  let toolNames: string[] = [];
  try {
    toolNames = pi.getActiveTools() ?? [];
  } catch {
    toolNames = [];
  }
  return {
    conversation: buildRoleLabelledContext(
      context.messages ?? [],
      (context.messages?.length ?? 1) - 1,
      config.assessmentMaxInputChars,
      config.syntheticPrefixes,
    ),
    summary: latestSummaryText(context.messages),
    toolNames,
    skillNames: session.getActiveSkillNames(),
    toolActivity: countToolActivity(context.messages),
  };
}

/**
 * Update per-session assessor strikes from one attempt. A successful verdict
 * clears the chosen model's strikes (self-heal); a failure that produced NO
 * output before an `expiry`/`error` deadline strikes it, so `selectAssessor`
 * stops repicking a model that structurally cannot deliver a verdict here.
 * auth/parse/no-assessor/disabled are not slowness signals and never strike.
 */
function recordAssessorOutcome(
  attempt: Awaited<ReturnType<typeof runAssessment>>,
  session: RouterSession = defaultRouterSession,
): void {
  if (attempt.ok) {
    session.recordSuccessfulAssessorUsage(attempt.assessment.usage);
    session.clearAssessorStrikes(attempt.assessment.model);
    return;
  }
  // The assessor hit the same shared usage cap the serving path would:
  // exclude the whole provider so later turns fail fast there too.
  if (attempt.usageLimitProvider) {
    session.blacklistProvider(attempt.usageLimitProvider);
  }
  if (
    attempt.model &&
    attempt.producedOutput === false &&
    (attempt.fallbackReason === 'expiry' || attempt.fallbackReason === 'error')
  ) {
    session.strikeAssessor(attempt.model);
  }
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
 * `off` is universally serveable: non-reasoning registry models run exactly
 * the mode an off row measures, so an off row never drops a model's only
 * measurement.
 */
export function expandModelCandidates(
  rm: RegistryModelInfo,
  rows: readonly BenchModel[],
  drops: EffortDrops = {},
): Candidate[] {
  const qualityBearing = (r: BenchModel): boolean =>
    Object.values(r.quality).some((v) => v !== undefined);

  const modelWideKnowledge = rows.find(
    (row) => row.effort == null && row.quality.knowledge != null,
  )?.quality.knowledge;
  const supportedReasoningLevels = MODEL_THINKING_LEVELS.filter(
    (level) => level !== 'off' && isThinkingSupportedByRegistryModel(rm, level),
  );
  const modelWideKnowledgeByEffort: Candidate['knowledgeByEffort'] = {};
  if (modelWideKnowledge != null) {
    for (const level of supportedReasoningLevels) {
      modelWideKnowledgeByEffort[level] = modelWideKnowledge;
    }
  }
  const rawLabelled = rows.filter(
    (r): r is BenchModel & { effort: ModelThinkingLevel } =>
      r.effort != null,
  );
  if (rawLabelled.length === 0) {
    const fallback = rows.find(qualityBearing) ?? rows[0];
    // BenchLM's unlabelled Omniscience entry represents the flagship run. If
    // max is serveable, preserve that evidence/serving contract explicitly;
    // otherwise keep the ordinary effort-less fallback.
    const flagship = fallback && modelWideKnowledge != null
      && isThinkingSupportedByRegistryModel(rm, 'max')
      ? {
          ...fallback,
          effort: 'max' as const,
          quality: { ...fallback.quality, knowledge: modelWideKnowledge },
        }
      : fallback;
    const candidate = buildCandidate(rm, flagship);
    return Object.keys(modelWideKnowledgeByEffort).length > 0
      ? [{ ...candidate, knowledgeByEffort: modelWideKnowledgeByEffort }]
      : [candidate];
  }

  // AA-Omniscience measures model-level factual reliability rather than a
  // reasoning-effort curve. Apply an unlabelled model-wide score to every
  // reasoning level; exact effort-labelled scores remain authoritative.
  const labelled = rawLabelled.map((row) =>
    row.effort !== 'off' && row.quality.knowledge == null && modelWideKnowledge != null
      ? { ...row, quality: { ...row.quality, knowledge: modelWideKnowledge } }
      : row,
  );
  const knowledgeByEffort: Candidate['knowledgeByEffort'] = {
    ...modelWideKnowledgeByEffort,
  };
  for (const row of labelled) {
    if (row.quality.knowledge != null) knowledgeByEffort[row.effort] = row.quality.knowledge;
  }
  const hasEffortKnowledge = Object.keys(knowledgeByEffort).length > 0;
  const attachKnowledge = (candidate: Candidate): Candidate => hasEffortKnowledge
    ? { ...candidate, knowledgeByEffort }
    : candidate;

  const byLevel = new Map(labelled.map((row) => [row.effort, row]));
  const supported = MODEL_THINKING_LEVELS.filter(
    (level) => level === 'off' || isThinkingSupportedByRegistryModel(rm, level),
  )
    .map((level) => {
      const measured = byLevel.get(level);
      // A source may publish a target-level pricing/performance row with only
      // some (or none) of the quality axes. Preserve its measured axes and
      // exact-level metadata while filling only the missing axes from above.
      return measured
        ? completeMeasuredRow(measured, labelled, drops)
        : estimateRow(level, labelled, drops);
    })
    .filter((row): row is BenchModel => row != null)
    .map((row) => attachKnowledge(buildCandidate(rm, row)));
  if (supported.length > 0) return supported;
  // All measured efforts are unsupported by this model's thinkingLevelMap, or
  // the source supplied only quality-empty rows. Keep the model routable with
  // an effort-less candidate, preferring any row the scorer can actually use.
  const fallback = labelled.find(qualityBearing) ?? labelled[0];
  return [attachKnowledge(buildCandidate(rm, { ...fallback, effort: undefined }))];
}

// ─── Turn-callback stages ────────────────────────────────────────────

function measureTurnInput(context: Context, config: AutoRouterConfig) {
  const turnInput = getTurnClassificationInput(
    context.messages,
    undefined,
    { syntheticPrefixes: config.syntheticPrefixes },
  );
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
  // The static system prefix survives an incumbent effort change in
  // the provider cache (effort only invalidates message blocks), so
  // the switch bonus credits it. Tool-schema tokens aren't counted
  // here, so this under-states the preserved prefix — the safe way to
  // err (never over-credit a switch).
  const staticPrefixTokens = systemPrompt ? estimateTokenCount(systemPrompt) : 0;
  return { turnInput, systemPrompt, needsVision, estContextTokens, staticPrefixTokens };
}

/**
 * Keyword classify plus embedding blend. Blends up only: never overrides
 * keyword downward. Timeout/failure degrades to the keyword result.
 * Escalation is not resolved here — it must not be cached.
 */
async function resolveBaseIntent(
  args: {
    turnInput: ReturnType<typeof getTurnClassificationInput>;
    systemPrompt: string | undefined;
    config: AutoRouterConfig;
  },
  session?: RouterSession,
) {
  const { turnInput, systemPrompt, config } = args;
  const cachedIntent = session ? session.getCachedIntent() : getCachedRoutingIntent();
  const cacheHit = cachedIntent?.key === turnInput.key;
  const classifyResult = cacheHit
    ? cachedIntent.classifyResult
    : classify(turnInput.classifyText, systemPrompt, {
        lowConfidenceThreshold: config.lowConfidenceThreshold,
      });
  let baseDimension: Dimension = cacheHit
    ? cachedIntent.dimension
    : classifyResult.dimension;
  let baseCause: DecisionCause = cacheHit
    ? cachedIntent.cause
    : turnInput.thin
      ? 'continuation-context'
      : 'heuristic';

  if (
    !classifyResult.hasCategoricalEvidence &&
    config.embeddingClassifier &&
    !cacheHit
  ) {
    try {
      const embeddingResult = await embedAndClassify(turnInput.classifyText, {
        deadlineMs: config.embeddingDeadlineMs,
      });
      if (embeddingResult) {
        const targetSession = session ?? defaultRouterSession;
        targetSession.recordEmbedding('fired');
        const minConfidence =
          config.embeddingMinConfidence ?? DEFAULT_EMBEDDING_MIN_CONFIDENCE;
        if (embeddingResult.confidence >= minConfidence) {
          const keywordStrength = DIMENSION_STRENGTH[baseDimension];
          const embeddingStrength = DIMENSION_STRENGTH[embeddingResult.dimension];
          if (embeddingStrength > keywordStrength) {
            baseDimension = embeddingResult.dimension;
            baseCause = 'embedding-classify';
            targetSession.recordEmbedding('promoted');
          }
        } else {
          targetSession.recordEmbedding('abstainedLowConf');
        }
      } else {
        (session ?? defaultRouterSession).recordEmbedding('degraded');
      }
    } catch {
      (session ?? defaultRouterSession).recordEmbedding('degraded');
    }
  }

  return {
    cacheHit,
    cachedIntent,
    classifyResult,
    baseDimension,
    baseCause,
    confidence: classifyResult.confidence,
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
 * Everything an assessment dispatch needs that is constant for the whole
 * turn. Both the entry assessment and the depth latch resolve against this
 * same environment, so they cannot disagree about the assessor, the routable
 * pool, or which session generation is current.
 */
interface AssessmentEnv {
  assessmentConfig: AssessmentConfig;
  stillCurrent: () => boolean;
  turnInputKey: string;
  context: Context;
  config: AutoRouterConfig;
  pi: ExtensionAPI;
  registry: ReturnType<typeof getCurrentModelRegistry>;
  routableCandidates: Candidate[];
  session: RouterSession;
}

/**
 * The entry's single assessment budget and its verdict so far. Mutated in
 * place by the two phases below: the privacy rule is one dispatch per real
 * user entry whatever asks for it, so `dispatched` has to be one flag both
 * phases read and write, not a value threaded out and back.
 */
interface AssessmentState {
  assessment: import('../types.js').RoutingAssessment | undefined;
  fallbackReason: import('../types.js').AssessmentFallbackReason | undefined;
  dispatched: boolean;
}

type AssessmentDispatch =
  | { kind: 'aborted' }
  | { kind: 'verdict'; assessment: import('../types.js').RoutingAssessment }
  | { kind: 'fallback' };

/**
 * Spend the entry's one assessment dispatch and fold the outcome into
 * `state`. `dispatched` is set before the await so a failure still counts as
 * the entry's spend; a session change during the await yields `aborted` with
 * `state` untouched beyond that flag.
 */
async function dispatchAssessment(
  env: AssessmentEnv,
  state: AssessmentState,
): Promise<AssessmentDispatch> {
  state.dispatched = true;
  const attempt = await runAssessment(
    env.assessmentConfig,
    env.registry,
    env.routableCandidates,
    evidenceForAssessment(env.context, env.config, env.pi, env.session),
    env.session.getAssessorStrikes(),
    (fb) => env.session.getAssessorTokenEstimate(fb),
  );
  if (!env.stillCurrent()) return { kind: 'aborted' };
  recordAssessorOutcome(attempt, env.session);
  if (attempt.ok) {
    env.session.addAssessmentCost(attempt.assessment.costUsd);
    return { kind: 'verdict', assessment: attempt.assessment };
  }
  env.session.addAssessmentCost(attempt.costUsd);
  state.fallbackReason = attempt.fallbackReason;
  return { kind: 'fallback' };
}

/** Dispatch + adopt only. Does not write the intent cache or touch the stream. */
async function runEntryAssessment(
  env: AssessmentEnv,
  state: AssessmentState,
  entry: {
    cacheHit: boolean;
    classifyResult: ReturnType<typeof classify>;
    dimension: Dimension;
    cause: DecisionCause;
  },
): Promise<{ dimension: Dimension; cause: DecisionCause; aborted: boolean }> {
  let { dimension, cause } = entry;
  const { classifyResult } = entry;

  if (!entry.cacheHit && env.assessmentConfig.enabled) {
    const heuristicDimension = classifyResult.dimension;
    const dispatched = await dispatchAssessment(env, state);
    if (dispatched.kind === 'aborted') return { dimension, cause, aborted: true };
    if (dispatched.kind === 'verdict') {
      state.assessment = dispatched.assessment;
      const assessed = adoptAssessment({
        heuristic: heuristicDimension,
        rawHeuristic: classifyResult.rawDimension,
        ambiguityBumped: classifyResult.ambiguityBumped,
        assessment: dispatched.assessment,
        latchEngaged: env.session.getLatchGeneration() > 0,
      });
      appendAssessmentMetric({
        intentKey: env.turnInputKey,
        heuristicDimension,
        counterfactualDimension: assessed.dimension,
        assessment: dispatched.assessment,
      });
    } else {
      appendAssessmentMetric({
        intentKey: env.turnInputKey,
        heuristicDimension,
        fallbackReason: state.fallbackReason,
      });
    }
  }

  // On cache hit, dimension and cause were already adopted on the first invocation.
  // Re-running adoptAssessment on later tool-loop turns would allow downward adoption
  // to cascade across multiple turns, violating Rule 12.
  if (!entry.cacheHit && state.assessment) {
    const adoption = adoptAssessment({
      heuristic: dimension,
      rawHeuristic: classifyResult.rawDimension,
      ambiguityBumped: classifyResult.ambiguityBumped,
      assessment: state.assessment,
      latchEngaged: env.session.getLatchGeneration() > 0,
    });
    if (adoption.changed) {
      dimension = adoption.dimension;
      cause = 'router-consult';
    }
  }

  return { dimension, cause, aborted: false };
}

/**
 * Latch transition. Receives the parent-computed depthWouldEscalate boolean;
 * ANDs with the session's latch generation being 0 itself. Does not call
 * wouldDepthEscalate. Does not touch the stream.
 */
async function evaluateDepthLatch(
  env: AssessmentEnv,
  state: AssessmentState,
  latch: { depthWouldEscalate: boolean; baseDimension: Dimension },
): Promise<{ vetoDepthEscalation: boolean; aborted: boolean }> {
  let vetoDepthEscalation = env.session.getLatchVetoIntentKey() === env.turnInputKey;
  const atLatchTransition = env.session.getLatchGeneration() === 0 && latch.depthWouldEscalate;
  if (vetoDepthEscalation || !atLatchTransition) return { vetoDepthEscalation, aborted: false };

  env.session.bumpLatchGeneration();
  if (!env.assessmentConfig.enabled) return { vetoDepthEscalation, aborted: false };

  let latchVerdict = state.assessment;
  if (!latchVerdict && !state.dispatched) {
    const dispatched = await dispatchAssessment(env, state);
    if (dispatched.kind === 'aborted') return { vetoDepthEscalation, aborted: true };
    if (dispatched.kind === 'verdict') latchVerdict = dispatched.assessment;
  }

  if (latchVerdict) {
    vetoDepthEscalation = shouldVetoLatch(latchVerdict);
    if (vetoDepthEscalation) env.session.setLatchVetoIntentKey(env.turnInputKey);
    state.assessment = { ...latchVerdict, vetoedLatch: vetoDepthEscalation };
    appendAssessmentMetric({
      intentKey: env.turnInputKey,
      heuristicDimension: latch.baseDimension,
      latchTransition: true,
      wouldVetoLatch: vetoDepthEscalation,
      assessment: latchVerdict,
    });
  } else if (state.fallbackReason) {
    appendAssessmentMetric({
      intentKey: env.turnInputKey,
      heuristicDimension: latch.baseDimension,
      latchTransition: true,
      wouldVetoLatch: false,
      fallbackReason: state.fallbackReason,
    });
  }

  return { vetoDepthEscalation, aborted: false };
}

function advanceWorkPhase(args: {
  cacheHit: boolean;
  turnInput: ReturnType<typeof getTurnClassificationInput>;
  classifyResult: ReturnType<typeof classify>;
  vetoDepthEscalation: boolean;
  depthWouldEscalate: boolean;
  baseDimension: Dimension;
  session: RouterSession;
}) {
  const resolvedDimensionForPhase: Dimension =
    !args.vetoDepthEscalation && args.depthWouldEscalate
      ? (args.baseDimension === 'lightweight' ? 'gather' : 'implement')
      : args.baseDimension;

  let workPhaseState = args.session.getWorkPhaseState();
  if (!args.cacheHit) {
    workPhaseState =
      workPhaseState && args.turnInput.thin
        ? inheritThinContinuation(args.turnInput.key, workPhaseState)
        : (() => {
            const terminal = args.classifyResult.terminal;
            const requirement = terminalRequirement(terminal);
            const band = capabilityBandFor(requirement);
            const initial = deriveInitialPhase(terminal, band, {
              resolvedDimension: resolvedDimensionForPhase,
            });
            return {
              intentKey: args.turnInput.key,
              terminal,
              terminalRequirement: requirement,
              terminalBand: band,
              phase: initial.phase,
              phaseReason: initial.phaseReason,
              multiWorkEngaged: initial.multiWorkEngaged,
              providerInvocation: 1,
              mutationGateBlocks: 0,
              mutationGateTriggered: false,
              mutationCompleted: false,
              pendingMutationToolCallIds: new Set<string>(),
              observedReadTools: 0,
              observedMutationTools: 0,
            };
          })();
  } else if (workPhaseState) {
    workPhaseState = nextProviderInvocation(workPhaseState);
  }
  if (workPhaseState) {
    workPhaseState = advanceForRoutingOwner(
      workPhaseState,
      resolvedDimensionForPhase,
    );
  }
  const multiWorkPolicy = workPhaseState
    ? scoringPolicyForState(workPhaseState, resolvedDimensionForPhase)
    : undefined;
  args.session.commitWorkPhaseState(workPhaseState);
  return { multiWorkPolicy };
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
  const reasoning = resolveThinkingLevel(
    args.chosenCandidate,
    inheritedReasoning ? undefined : requestedReasoning as ThinkingLevel | undefined,
    args.decision.dimension,
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

const ASSESSMENT_ABORTED: RouterTurnOutcome = {
  kind: 'terminal',
  reason: 'aborted',
  message: 'Router session changed during assessment.',
};

function noRoutableCandidates(session: RouterSession): RouterTurnOutcome {
  const excludedProviders = session.getBlacklistedProviders();
  return {
    kind: 'terminal',
    reason: 'error',
    message:
      excludedProviders.size > 0
        ? `No routable models: providers excluded for usage limits this session (${[...excludedProviders].sort().join(', ')}).`
        : 'No routable models: the `models` allowlist in `~/.pi/agent/pi8/config.json` matched none of the available models.',
  };
}

interface PreparedTurn {
  registry: ReturnType<typeof getCurrentModelRegistry>;
  extensionContext: ExtensionContext | undefined;
  config: AutoRouterConfig;
  measured: ReturnType<typeof measureTurnInput>;
  intent: Awaited<ReturnType<typeof resolveBaseIntent>>;
  trajectoryEscalation: ReturnType<RouterSession['peekPendingTrajectoryEscalation']>;
  /**
   * Pre-exclusion pool. Kept because an awaited assessment can blacklist a
   * provider mid-turn, so scoring re-filters this rather than the snapshot.
   */
  candidates: Candidate[];
  routableCandidates: Candidate[];
}

interface AssessedTurn {
  assessment: import('../types.js').RoutingAssessment | undefined;
  fallbackReason: import('../types.js').AssessmentFallbackReason | undefined;
  baseDimension: Dimension;
  baseCause: DecisionCause;
  depthWouldEscalate: boolean;
  vetoDepthEscalation: boolean;
  assessmentStillCurrent: () => boolean;
}

interface ScoredTurn {
  decision: ReturnType<typeof resolveRoutingDecision>['decision'];
  routableCandidates: Candidate[];
  requestedReasoning: string | undefined;
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
  const intent = await resolveBaseIntent(
    { turnInput: measured.turnInput, systemPrompt: measured.systemPrompt, config },
    session,
  );

  session.bindTrajectoryIntent(measured.turnInput.key);
  // Blocked preflights never emit tool_result. Finalize that batch
  // here, before peeking, so a sibling's evidence can arm this
  // invocation rather than stalling behind an impossible result.
  session.flushAndArmUnresolvedTrajectory();

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

/** Spend this entry's one bounded assessment and settle the depth latch. */
async function assessRouterTurn(args: {
  prepared: PreparedTurn;
  context: Context;
  pi: ExtensionAPI;
  session: RouterSession;
}): Promise<{ kind: 'ready'; assessed: AssessedTurn } | RouterTurnOutcome> {
  const { prepared, context, pi, session } = args;
  const { config, measured, intent, registry, routableCandidates } = prepared;
  const { turnInput, estContextTokens } = measured;
  const { cacheHit, cachedIntent, classifyResult } = intent;

  const assessmentSessionGeneration = session.getSessionGeneration();
  const assessmentStillCurrent = (): boolean =>
    session.getSessionGeneration() === assessmentSessionGeneration;
  const env: AssessmentEnv = {
    assessmentConfig: {
      enabled: config.consultRouter,
      modelRef: config.consultModel,
      deadlineMs: config.assessmentDeadlineMs,
      maxInputChars: config.assessmentMaxInputChars,
      assessorQualityRatio: config.assessorQualityRatio,
    },
    stillCurrent: assessmentStillCurrent,
    turnInputKey: turnInput.key,
    context,
    config,
    pi,
    registry,
    routableCandidates,
    session,
  };
  // A cache hit means the entry already spent its one dispatch, successful or
  // not, so the budget starts closed and the cached verdict carries forward.
  const state: AssessmentState = {
    assessment: cacheHit ? cachedIntent?.assessment : undefined,
    fallbackReason: cacheHit ? cachedIntent?.fallbackReason : undefined,
    dispatched: cacheHit,
  };

  const entry = await runEntryAssessment(env, state, {
    cacheHit,
    classifyResult,
    dimension: intent.baseDimension,
    cause: intent.baseCause,
  });
  if (entry.aborted) return ASSESSMENT_ABORTED;
  const baseDimension = entry.dimension;
  const baseCause = entry.cause;

  if (!cacheHit) {
    session.setCachedIntent({
      key: turnInput.key,
      classifyResult,
      dimension: baseDimension,
      cause: baseCause,
      thin: turnInput.thin,
      contextChars: turnInput.contextChars,
      assessment: state.assessment,
      fallbackReason: state.fallbackReason,
    });
  }
  debugLog('classify.context', {
    thin: turnInput.thin,
    cacheHit,
    contextChars: turnInput.contextChars,
    key: turnInput.key,
  });

  // Shared with resolveRoutingDecision so the latch probe and the
  // policy's depth gate agree. Computed once here; the latch ANDs
  // with generation === 0 itself, and the phase engine reuses the
  // boolean rather than probing again.
  const depthWouldEscalate = wouldDepthEscalate({
    dimension: baseDimension,
    cause: baseCause,
    estimatedContextTokens: estContextTokens,
    config,
  });

  // A veto holds until the next real user entry, so the first
  // invocation sets the latchVetoIntentKey and subsequent
  // invocations of the same entry reuse it.  The latch question —
  // "is the stated deliverable still bounded?" — is the same
  // question the ordinary assessment already answered, so when an
  // entry-level verdict already exists we reuse it instead of
  // dispatching a dedicated latch assessment.
  const latch = await evaluateDepthLatch(env, state, { depthWouldEscalate, baseDimension });
  if (latch.aborted) return ASSESSMENT_ABORTED;

  return {
    kind: 'ready',
    assessed: {
      assessment: state.assessment,
      fallbackReason: state.fallbackReason,
      baseDimension,
      baseCause,
      depthWouldEscalate,
      vetoDepthEscalation: latch.vetoDepthEscalation,
      assessmentStillCurrent,
    },
  };
}

/** Advance the work phase, score the live pool, and record the decision. */
function scoreRouterTurn(args: {
  prepared: PreparedTurn;
  assessed: AssessedTurn;
  options: SimpleStreamOptions | undefined;
  session: RouterSession;
}): { kind: 'ready'; scored: ScoredTurn } | RouterTurnOutcome {
  const { prepared, assessed, options, session } = args;
  const { config, measured, intent, candidates, trajectoryEscalation } = prepared;
  const { turnInput, needsVision, estContextTokens, staticPrefixTokens } = measured;
  const { classifyResult, cacheHit, confidence } = intent;
  const { baseDimension, baseCause, depthWouldEscalate, vetoDepthEscalation } = assessed;

  // An awaited assessment can add a provider-wide usage-limit
  // exclusion after this turn's initial candidate snapshot. Apply
  // live runtime exclusions again before scoring/delegation so the
  // assessor failure cannot immediately re-hit the same provider as
  // the serving model in this turn.
  const routableCandidates = applyRuntimeExclusions(candidates, session);
  if (routableCandidates.length === 0) return noRoutableCandidates(session);

  const { multiWorkPolicy } = advanceWorkPhase({
    cacheHit,
    turnInput,
    classifyResult,
    vetoDepthEscalation,
    depthWouldEscalate,
    baseDimension,
    session,
  });

  const requestedReasoning = typeof options?.reasoning === 'string' ? options.reasoning : undefined;
  const userReasoningOverride =
    requestedReasoning != null && requestedReasoning !== session.getLastResolvedThinkingLevel();
  const policy = resolveRoutingDecision({
    candidates: routableCandidates,
    classifyResult,
    baseDimension,
    baseCause,
    trajectoryEscalation,
    userReasoning: requestedReasoning as ThinkingLevel | undefined,
    userReasoningOverride,
    estimatedContextTokens: estContextTokens,
    staticPrefixTokens,
    needsVision,
    incumbentRegistryId: session.getLastChosenRegistryId(),
    incumbentResolvedDimension:
      session.getLastDecision()?.effortFloorDimension ?? session.getLastDecision()?.dimension,
    sameIntentAsLast: session.getLastDecision()?.intentKey === turnInput.key,
    vetoDepthEscalation,
    ...(multiWorkPolicy ? { multiWorkPolicy } : {}),
    config,
  });
  const decision = policy.decision;
  if (assessed.assessment) decision.assessment = assessed.assessment;
  if (assessed.fallbackReason) decision.fallbackReason = assessed.fallbackReason;
  decision.intentKey = turnInput.key;
  decision.provenanceCounts = turnInput.provenanceCounts;
  try {
    // Counterfactual baseline for /router-report. Never blocks
    // routing (rule 2): a failure here only omits baseline
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
    confidence: Number(confidence.toFixed(3)),
    candidates: candidates.length,
    routable: routableCandidates.length,
    chosen: decision.chosen,
    chainLen: decision.fallbackChain.length,
    estContextTokens,
  });

  return { kind: 'ready', scored: { decision, routableCandidates, requestedReasoning } };
}

/** Resolve the served effort, run the fallback walk, and settle the handoff. */
async function delegateRouterTurn(args: {
  prepared: PreparedTurn;
  assessed: AssessedTurn;
  scored: ScoredTurn;
  context: Context;
  options: SimpleStreamOptions | undefined;
  pi: ExtensionAPI;
  session: RouterSession;
  turnTimer: () => number;
  stream: AssistantMessageEventStream;
}): Promise<RouterTurnOutcome> {
  const { prepared, assessed, scored, context, options, pi, session, turnTimer, stream } = args;
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
  const delegationOptions: DelegationOptions = {
    decision,
    registry: registry!,
    context,
    options: delegatedOptions,
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
  const result = await runDelegationLoop(delegationOptions, stream);

  if (
    result.capabilityHandoff
    && pendingTrajectory
    && result.capabilityHandoff.fromModel === pendingTrajectory.fromModel
    && session.peekPendingTrajectoryEscalation() === pendingTrajectory
    && session.getSessionGeneration() === delegationSessionGeneration
    && assessed.assessmentStillCurrent()
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
    routedUp: false,
    routedDown: false,
  };
  // These annotations belonged to the auto pick this override replaces.
  delete decision.routedPickChanged;
  delete decision.trajectoryFriction;
  try {
    decision.baseline = pickBaseline(
      applyRuntimeExclusions(prepared.candidates, session),
      decision.dimension,
      prepared.config.baselineModel,
    );
  } catch {
    // Best-effort report telemetry only (rule 2).
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
 * pick (rule 2); dismissing the dialog cancels the turn instead of switching.
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
    // Same-entry tool-loop continuations are not a new switch (rule 12). A
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
  if (!prepared.intent.cacheHit) {
    const { turnInput } = prepared.measured;
    session.setCachedIntent({
      key: turnInput.key,
      classifyResult: prepared.intent.classifyResult,
      dimension: prepared.intent.baseDimension,
      cause: prepared.intent.baseCause,
      thin: turnInput.thin,
      contextChars: turnInput.contextChars,
      assessment: undefined,
      fallbackReason: undefined,
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
  const assessed: AssessedTurn = {
    assessment: undefined,
    fallbackReason: undefined,
    baseDimension: prepared.intent.baseDimension,
    baseCause: cause,
    depthWouldEscalate: false,
    vetoDepthEscalation: true,
    assessmentStillCurrent: () => true,
  };
  const scoring = scoreRouterTurn({ prepared: manualPrepared, assessed, options, session });
  if (scoring.kind !== 'ready') return scoring;

  const { decision } = scoring.scored;
  decision.cause = cause;
  decision.reason = cause === 'semi-hold' ? `Semi mode: kept ${manualModel} for this turn` : `Manual model pin: ${manualModel}`;
  decision.routedUp = false;
  decision.routedDown = false;
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
    assessed,
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

  const { turnInput } = prepared.measured;
  if (!prepared.intent.cacheHit) {
    session.setCachedIntent({
      key: turnInput.key,
      classifyResult: prepared.intent.classifyResult,
      dimension: prepared.intent.baseDimension,
      cause: prepared.intent.baseCause,
      thin: turnInput.thin,
      contextChars: turnInput.contextChars,
      assessment: undefined,
      fallbackReason: undefined,
    });
  }

  const decision: RoutingDecision = {
    ...resume,
    chosen: chain[0],
    fallbackChain: chain,
    cause: 'resume',
    reason: `Resumed prior route: ${chain[0]}`,
    routedUp: false,
    routedDown: false,
    intentKey: turnInput.key,
    provenanceCounts: turnInput.provenanceCounts,
  };
  // Drop annotations that belonged to the snapshot's own turn: this turn did
  // not re-derive friction or a pick change.
  delete decision.trajectoryFriction;
  delete decision.routedPickChanged;
  try {
    decision.baseline = pickBaseline(routableCandidates, decision.dimension, prepared.config.baselineModel);
  } catch {
    // Best-effort report telemetry only.
  }
  session.setLastDecision(decision);

  const assessed: AssessedTurn = {
    assessment: undefined,
    fallbackReason: undefined,
    baseDimension: decision.dimension,
    baseCause: 'resume',
    depthWouldEscalate: false,
    vetoDepthEscalation: true,
    assessmentStillCurrent: () => true,
  };
  const scored: ScoredTurn = {
    decision,
    routableCandidates,
    requestedReasoning: typeof options?.reasoning === 'string' ? options.reasoning : undefined,
  };
  return delegateRouterTurn({
    prepared,
    assessed,
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
 * Ordered phases for one router turn. The order is a real dependency chain:
 * an awaited assessment can exclude a provider, so scoring must re-filter
 * after it, and the trajectory handoff is acknowledged only once a stronger
 * model has actually served.
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

  const preparation = await prepareRouterTurn({ context, session, runtime });
  if (preparation.kind !== 'ready') return preparation;
  const { prepared } = preparation;

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

  const assessment = await assessRouterTurn({ prepared, context, pi, session });
  if (assessment.kind !== 'ready') return assessment;
  const { assessed } = assessment;

  const scoring = scoreRouterTurn({ prepared, assessed, options, session });
  if (scoring.kind !== 'ready') return scoring;

  const semi = await resolveSemiGate({ prepared, scored: scoring.scored, options, session });
  if (semi.kind === 'terminal') return semi;
  const scored = semi.kind === 'override' ? semi.scored : scoring.scored;

  return delegateRouterTurn({
    prepared,
    assessed,
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

  const regModels = ctx?.modelRegistry?.getAvailable() ?? [];
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
  // Pi tunes compaction to the session model's window. Advertising the largest
  // routable window (the default) delays compaction and biases long sessions
  // toward large-window models; a configured `routerContextWindow` lets the
  // user advertise a smaller effective window so Pi compacts earlier and keeps
  // cheaper models eligible longer. An override above the largest routable
  // window (or above the synthetic fallback, when no routable model exists)
  // would advertise capacity nothing actually has, so it is clamped down to
  // `maxCw`, never up.
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
            stream.end();
          } catch (err) {
            if (options?.signal?.aborted) {
              const msg = err instanceof Error ? err.message : String(err);
              stream.push(makeTerminalErrorEvent('aborted', msg));
              stream.end();
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            debugLog('turn.error', {
              message: msg,
              stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
              totalMs: turnTimer(),
            });
            stream.push(makeTerminalErrorEvent('error', `Router error: ${msg}`));
            stream.end();
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
