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

import type { BenchModel, Candidate, Dimension, DecisionCause, AutoRouterConfig } from '../types.js';
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
  isThinkingSupportedByRegistryModel,
  resolveThinkingLevel,
  MODEL_THINKING_LEVELS,
  type RegistryModelInfo,
} from '../routing/score/scorer.js';
import { pickBaseline } from './baseline.js';
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
import { runDelegationLoop } from './delegation.js';
import { makeTerminalErrorEvent } from './error-event.js';
import { resolveRoutingDecision, wouldDepthEscalate, applyEscalationPrecedence } from '../routing/policy/routing-policy.js';
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

/** Dispatch + adopt only. Does not write the intent cache or touch the stream. */
async function runEntryAssessment(args: {
  cacheHit: boolean;
  turnInputKey: string;
  assessmentConfig: AssessmentConfig;
  assessmentStillCurrent: () => boolean;
  assessment: import('../types.js').RoutingAssessment | undefined;
  fallbackReason: import('../types.js').AssessmentFallbackReason | undefined;
  assessmentDispatched: boolean;
  context: Context;
  config: AutoRouterConfig;
  pi: ExtensionAPI;
  registry: ReturnType<typeof getCurrentModelRegistry>;
  routableCandidates: Candidate[];
  classifyResult: ReturnType<typeof classify>;
  baseDimension: Dimension;
  baseCause: DecisionCause;
  session: RouterSession;
}): Promise<{
  assessment: typeof args.assessment;
  fallbackReason: typeof args.fallbackReason;
  assessmentDispatched: boolean;
  baseDimension: Dimension;
  baseCause: DecisionCause;
  aborted: boolean;
}> {
  let {
    assessment,
    fallbackReason,
    assessmentDispatched,
    baseDimension,
    baseCause,
  } = args;

  if (!args.cacheHit && args.assessmentConfig.enabled) {
    const evidence = evidenceForAssessment(args.context, args.config, args.pi, args.session);
    const heuristicDimension = args.classifyResult.dimension;
    assessmentDispatched = true;
    const attempt = await runAssessment(
      args.assessmentConfig,
      args.registry,
      args.routableCandidates,
      evidence,
      args.session.getAssessorStrikes(),
      (fb) => args.session.getAssessorTokenEstimate(fb),
    );
    if (!args.assessmentStillCurrent()) {
      return {
        assessment,
        fallbackReason,
        assessmentDispatched,
        baseDimension,
        baseCause,
        aborted: true,
      };
    }
    recordAssessorOutcome(attempt, args.session);
    if (attempt.ok) {
      args.session.addAssessmentCost(attempt.assessment.costUsd);
      assessment = attempt.assessment;
      const assessed = adoptAssessment({
        heuristic: heuristicDimension,
        rawHeuristic: args.classifyResult.rawDimension,
        ambiguityBumped: args.classifyResult.ambiguityBumped,
        assessment,
        latchEngaged: args.session.getLatchGeneration() > 0,
      });
      appendAssessmentMetric({
        intentKey: args.turnInputKey,
        heuristicDimension,
        counterfactualDimension: assessed.dimension,
        assessment,
      });
    } else {
      args.session.addAssessmentCost(attempt.costUsd);
      fallbackReason = attempt.fallbackReason;
      appendAssessmentMetric({
        intentKey: args.turnInputKey,
        heuristicDimension,
        fallbackReason,
      });
    }
  }

  // On cache hit, baseDimension and baseCause were already adopted on the first invocation.
  // Re-running adoptAssessment on later tool-loop turns would allow downward adoption
  // to cascade across multiple turns, violating Rule 12.
  if (!args.cacheHit && assessment) {
    const adoption = adoptAssessment({
      heuristic: baseDimension,
      rawHeuristic: args.classifyResult.rawDimension,
      ambiguityBumped: args.classifyResult.ambiguityBumped,
      assessment,
      latchEngaged: args.session.getLatchGeneration() > 0,
    });
    if (adoption.changed) {
      baseDimension = adoption.dimension;
      baseCause = 'router-consult';
    }
  }

  return {
    assessment,
    fallbackReason,
    assessmentDispatched,
    baseDimension,
    baseCause,
    aborted: false,
  };
}

/**
 * Latch transition. Receives the parent-computed depthWouldEscalate boolean;
 * ANDs with the session's latch generation being 0 itself. Does not call
 * applyEscalationPrecedence or wouldDepthEscalate. Does not touch the stream.
 */
async function evaluateDepthLatch(args: {
  depthWouldEscalate: boolean;
  turnInputKey: string;
  baseDimension: Dimension;
  assessmentConfig: AssessmentConfig;
  assessmentStillCurrent: () => boolean;
  assessment: import('../types.js').RoutingAssessment | undefined;
  fallbackReason: import('../types.js').AssessmentFallbackReason | undefined;
  assessmentDispatched: boolean;
  context: Context;
  config: AutoRouterConfig;
  pi: ExtensionAPI;
  registry: ReturnType<typeof getCurrentModelRegistry>;
  routableCandidates: Candidate[];
  session: RouterSession;
}): Promise<{
  vetoDepthEscalation: boolean;
  assessment: import('../types.js').RoutingAssessment | undefined;
  fallbackReason: import('../types.js').AssessmentFallbackReason | undefined;
  assessmentDispatched: boolean;
  aborted: boolean;
}> {
  let { assessment, fallbackReason, assessmentDispatched } = args;
  let vetoDepthEscalation = args.session.getLatchVetoIntentKey() === args.turnInputKey;
  const latchGen = args.session.getLatchGeneration();
  const atLatchTransition = latchGen === 0 && args.depthWouldEscalate;

  if (!vetoDepthEscalation && atLatchTransition) {
    args.session.bumpLatchGeneration();
    if (args.assessmentConfig.enabled) {
      let latchVerdict = assessment;
      if (!latchVerdict && !assessmentDispatched) {
        assessmentDispatched = true;
        const attempt = await runAssessment(
          args.assessmentConfig,
          args.registry,
          args.routableCandidates,
          evidenceForAssessment(args.context, args.config, args.pi, args.session),
          args.session.getAssessorStrikes(),
          (fb) => args.session.getAssessorTokenEstimate(fb),
        );
        if (!args.assessmentStillCurrent()) {
          return {
            vetoDepthEscalation,
            assessment,
            fallbackReason,
            assessmentDispatched,
            aborted: true,
          };
        }
        recordAssessorOutcome(attempt, args.session);
        if (attempt.ok) {
          args.session.addAssessmentCost(attempt.assessment.costUsd);
          latchVerdict = attempt.assessment;
        } else {
          args.session.addAssessmentCost(attempt.costUsd);
          fallbackReason = attempt.fallbackReason;
        }
      }

      if (latchVerdict) {
        vetoDepthEscalation = shouldVetoLatch(latchVerdict);
        if (vetoDepthEscalation) {
          args.session.setLatchVetoIntentKey(args.turnInputKey);
        }
        assessment = { ...latchVerdict, vetoedLatch: vetoDepthEscalation };
        appendAssessmentMetric({
          intentKey: args.turnInputKey,
          heuristicDimension: args.baseDimension,
          latchTransition: true,
          wouldVetoLatch: vetoDepthEscalation,
          assessment: latchVerdict,
        });
      } else if (fallbackReason) {
        appendAssessmentMetric({
          intentKey: args.turnInputKey,
          heuristicDimension: args.baseDimension,
          latchTransition: true,
          wouldVetoLatch: false,
          fallbackReason,
        });
      }
    }
  }

  return {
    vetoDepthEscalation,
    assessment,
    fallbackReason,
    assessmentDispatched,
    aborted: false,
  };
}

function advanceWorkPhase(args: {
  cacheHit: boolean;
  turnInput: ReturnType<typeof getTurnClassificationInput>;
  classifyResult: ReturnType<typeof classify>;
  vetoDepthEscalation: boolean;
  depthWouldEscalate: boolean;
  preDepth: ReturnType<typeof applyEscalationPrecedence>;
  session: RouterSession;
}) {
  const resolvedDimensionForPhase: Dimension =
    !args.vetoDepthEscalation && args.depthWouldEscalate
      ? (args.preDepth.dimension === 'lightweight' ? 'gather' : 'implement')
      : args.preDepth.dimension;
  const capabilityRepickActive = args.preDepth.userApplied && !args.preDepth.userRaised;

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
              capabilityRepickActive,
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
      capabilityRepickActive,
    );
  }
  const multiWorkPolicy = workPhaseState
    ? scoringPolicyForState(workPhaseState, resolvedDimensionForPhase, capabilityRepickActive)
    : undefined;
  args.session.commitWorkPhaseState(workPhaseState);
  return { multiWorkPolicy };
}

function resolveTurnEffort(args: {
  chosenCandidate: Candidate | undefined;
  options: SimpleStreamOptions | undefined;
  decision: { dimension: Dimension; chosen: string };
  pi: ExtensionAPI;
  session: RouterSession;
}) {
  const requestedReasoning = typeof args.options?.reasoning === 'string' ? args.options.reasoning : undefined;
  const inheritedReasoning = requestedReasoning === args.session.getLastResolvedThinkingLevel();
  const reasoning = resolveThinkingLevel(
    args.chosenCandidate,
    inheritedReasoning ? undefined : requestedReasoning,
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
          session.setLastServed(undefined);
          const turnTimer = startTimer();
          try {
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
            const { turnInput, systemPrompt, needsVision, estContextTokens, staticPrefixTokens } = measured;
            const intent = await resolveBaseIntent({ turnInput, systemPrompt, config }, session);
            const { cacheHit, cachedIntent, classifyResult, confidence } = intent;
            let { baseDimension, baseCause } = intent;

            session.bindTrajectoryIntent(turnInput.key);
            // Blocked preflights never emit tool_result. Finalize that batch
            // here, before peeking, so a sibling's evidence can arm this
            // invocation rather than stalling behind an impossible result.
            session.flushAndArmUnresolvedTrajectory();

            // Peek only: a pending /router-escalate request is consumed after
            // the decision is recorded, so a router-internal failure before
            // that point cannot silently swallow the user's request.
            const userEscalation = session.peekPendingUserEscalation();
            const trajectoryEscalation = session.peekPendingTrajectoryEscalation();

            const candidates = buildRoutableCandidates({
              regModels: regModels as unknown[],
              extensionContext,
              config,
              session,
            });
            let routableCandidates = applyRuntimeExclusions(candidates, session);

            const endIfNoRoutableCandidates = (): boolean => {
              if (routableCandidates.length > 0) return false;
              const excludedProviders = session.getBlacklistedProviders();
              stream.push(
                makeTerminalErrorEvent(
                  'error',
                  excludedProviders.size > 0
                    ? `No routable models: providers excluded for usage limits this session (${[...excludedProviders].sort().join(', ')}).`
                    : 'No routable models: the `models` allowlist in `~/.pi/agent/pi8/config.json` matched none of the available models.',
                ),
              );
              stream.end();
              return true;
            };
            if (endIfNoRoutableCandidates()) return;

            const assessmentConfig: AssessmentConfig = {
              enabled: config.consultRouter,
              modelRef: config.consultModel,
              deadlineMs: config.assessmentDeadlineMs,
              maxInputChars: config.assessmentMaxInputChars,
              assessorQualityRatio: config.assessorQualityRatio,
            };

            const assessmentSessionGeneration = session.getSessionGeneration();
            const assessmentStillCurrent = (): boolean =>
              session.getSessionGeneration() === assessmentSessionGeneration;
            let assessment = cacheHit ? cachedIntent?.assessment : undefined;
            let fallbackReason = cacheHit ? cachedIntent?.fallbackReason : undefined;
            // One bounded assessment per real user entry, whatever asks for it
            // (privacy/egress rule). A cache hit means the entry already spent
            // its one dispatch, successful or not.
            let assessmentDispatched = cacheHit;
            const entryAssessment = await runEntryAssessment({
              cacheHit,
              turnInputKey: turnInput.key,
              assessmentConfig,
              assessmentStillCurrent,
              assessment,
              fallbackReason,
              assessmentDispatched,
              context,
              config,
              pi,
              registry,
              routableCandidates,
              classifyResult,
              baseDimension,
              baseCause,
              session,
            });
            if (entryAssessment.aborted) {
              stream.push(makeTerminalErrorEvent('aborted', 'Router session changed during assessment.'));
              stream.end();
              return;
            }
            assessment = entryAssessment.assessment;
            fallbackReason = entryAssessment.fallbackReason;
            assessmentDispatched = entryAssessment.assessmentDispatched;
            baseDimension = entryAssessment.baseDimension;
            baseCause = entryAssessment.baseCause;

            if (!cacheHit) {
              session.setCachedIntent({
                key: turnInput.key,
                classifyResult,
                dimension: baseDimension,
                cause: baseCause,
                thin: turnInput.thin,
                contextChars: turnInput.contextChars,
                assessment,
                fallbackReason,
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
            const preDepth = applyEscalationPrecedence({
              dimension: baseDimension,
              cause: baseCause,
              userEscalation,
            });
            const depthWouldEscalate = wouldDepthEscalate({
              dimension: preDepth.dimension,
              cause: preDepth.cause,
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
            const latch = await evaluateDepthLatch({
              depthWouldEscalate,
              turnInputKey: turnInput.key,
              baseDimension,
              assessmentConfig,
              assessmentStillCurrent,
              assessment,
              fallbackReason,
              assessmentDispatched,
              context,
              config,
              pi,
              registry,
              routableCandidates,
              session,
            });
            if (latch.aborted) {
              stream.push(makeTerminalErrorEvent('aborted', 'Router session changed during assessment.'));
              stream.end();
              return;
            }
            const vetoDepthEscalation = latch.vetoDepthEscalation;
            assessment = latch.assessment;
            fallbackReason = latch.fallbackReason;
            assessmentDispatched = latch.assessmentDispatched;

            // An awaited assessment can add a provider-wide usage-limit
            // exclusion after this turn's initial candidate snapshot. Apply
            // live runtime exclusions again before scoring/delegation so the
            // assessor failure cannot immediately re-hit the same provider as
            // the serving model in this turn.
            routableCandidates = applyRuntimeExclusions(candidates, session);
            if (endIfNoRoutableCandidates()) return;

            const { multiWorkPolicy } = advanceWorkPhase({
              cacheHit,
              turnInput,
              classifyResult,
              vetoDepthEscalation,
              depthWouldEscalate,
              preDepth,
              session,
            });

            const requestedReasoning = typeof options?.reasoning === 'string' ? options.reasoning : undefined;
            const userReasoningOverride =
              requestedReasoning != null
              && requestedReasoning !== session.getLastResolvedThinkingLevel();
            const policy = resolveRoutingDecision({
              candidates: routableCandidates,
              classifyResult,
              baseDimension,
              baseCause,
              userEscalation,
              trajectoryEscalation,
              userReasoning: requestedReasoning as ThinkingLevel | undefined,
              userReasoningOverride,
              estimatedContextTokens: estContextTokens,
              staticPrefixTokens,
              needsVision,
              incumbentRegistryId: session.getLastChosenRegistryId(),
              incumbentResolvedDimension: session.getLastDecision()?.effortFloorDimension ?? session.getLastDecision()?.dimension,
              sameIntentAsLast: session.getLastDecision()?.intentKey === turnInput.key,
              vetoDepthEscalation,
              ...(multiWorkPolicy ? { multiWorkPolicy } : {}),
              config,
            });
            const decision = policy.decision;
            if (assessment) decision.assessment = assessment;
            if (fallbackReason) decision.fallbackReason = fallbackReason;
            decision.intentKey = turnInput.key;
            decision.provenanceCounts = turnInput.provenanceCounts;
            try {
              // Counterfactual baseline for /router-report. Never blocks
              // routing (rule 2): a failure here only omits baseline
              // telemetry for the turn.
              decision.baseline = pickBaseline(
                routableCandidates,
                decision.dimension,
                config.baselineModel,
              );
            } catch {
              // Best-effort telemetry only.
            }
            session.setLastDecision(decision);
            if (userEscalation) session.consumePendingUserEscalation();
            // Trajectory pending is consumed only after a successful serve of
            // an applied handoff. Peeking it here must not drop evidence when
            // no stronger target exists, user escalation won, or delegation
            // fails.

            debugLog('decision', {
              dimension: decision.dimension,
              confidence: Number(confidence.toFixed(3)),
              candidates: candidates.length,
              routable: routableCandidates.length,
              chosen: decision.chosen,
              chainLen: decision.fallbackChain.length,
              estContextTokens,
            });

            const chosenCandidate = routableCandidates.find(
              (c) => candidateKey(c) === decision.chosen,
            );
            const {
              resolvedReasoning,
              delegatedOptions,
              inheritedReasoning,
            } = resolveTurnEffort({
              chosenCandidate,
              options,
              decision,
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
              stream.push(makeTerminalErrorEvent('error', decision.reason));
              stream.end();
              return;
            }

            const pendingTrajectory = session.peekPendingTrajectoryEscalation();
            const delegationSessionGeneration = session.getSessionGeneration();
            const result = await runDelegationLoop(
              {
                decision,
                registry: registry!,
                context,
                options: delegatedOptions,
                candidates: routableCandidates,
                reasoning: resolvedReasoning as string | undefined,
                userReasoningOverride:
                  !inheritedReasoning && requestedReasoning != null,
                extensionContext,
                notifyOnRoute: config.prompt,
                turnTimer,
                session,
              },
              stream,
            );

            if (
              result.capabilityHandoff
              && pendingTrajectory
              && result.capabilityHandoff.fromModel === pendingTrajectory.fromModel
              && session.peekPendingTrajectoryEscalation() === pendingTrajectory
              && session.getSessionGeneration() === delegationSessionGeneration
              && assessmentStillCurrent()
            ) {
              session.consumePendingTrajectoryEscalation();
            }

            if (!result.streamFinalized && !result.success) {
              stream.push(
                makeTerminalErrorEvent(
                  'error',
                  `All routing fallbacks exhausted${result.lastError ? ` (last error: ${result.lastError})` : ''}.`,
                ),
              );
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
