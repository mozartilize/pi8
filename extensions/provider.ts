/**
 * Provider registration for the `router/auto` model.
 *
 * Pattern: register a synthetic model with Pi (`pi.registerProvider`) that
 * classifies each turn locally, scores candidates from the live model
 * registry, and delegates the stream to the best match with a fallback
 * chain. One bounded, cancellable assessment per real user entry answers
 * what kind of work this is; in shadow mode it runs detached and never
 * touches routing.
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
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

import type { BenchModel, Candidate, Dimension, DecisionCause, AutoRouterConfig } from './types.js';
import { ROUTER_PROVIDER_ID, AUTO_MODEL_ID } from './types.js';
import { loadStore, activeModels } from './store.js';
import { classify, estimateTokenCount } from './classifier.js';
import { DIMENSION_STRENGTH } from './classifier.js';
import { DEFAULT_EMBEDDING_MIN_CONFIDENCE } from './constants.js';
import { embedAndClassify } from './embedding.js';
import { getTurnClassificationInput, buildRoleLabelledContext } from './continuation.js';
import { loadModelFilter, buildExcludeFilter, buildScopedModelFilter } from './allowlist.js';
import { loadConfig } from './config.js';
import { runAssessment, type AssessmentAttempt, type AssessmentConfig } from './consult.js';
import { adoptAssessment, shouldVetoLatch } from './assessment-adoption.js';
import { latestSummaryText, countToolActivity } from './message-provenance.js';
import { applyEscalation, ROUTE_UP_TOOL } from './escalation.js';
import { appendDecision, appendShadowAssessment } from './decisionlog.js';
import { renderRouterStatus } from './ui.js';
import {
  buildCandidate,
  buildRouterThinkingLevelMap,
  candidateKey,
  isThinkingSupportedByRegistryModel,
  resolveThinkingLevel,
  MODEL_THINKING_LEVELS,
  type RegistryModelInfo,
} from './scorer.js';
import {
  completeMeasuredRow,
  effortDropsPerStep,
  estimateRow,
  type EffortDrops,
} from './effort-estimate.js';
import {
  getAccumulatedCost,
  getActiveSkillNames,
  getSessionGeneration,
  getCachedRoutingIntent,
  getLatchGeneration,
  getLatchVetoIntentKey,
  setLatchVetoIntentKey,
  getLastResolvedThinkingLevel,
  getLastDecision,
  getLastChosenRegistryId,
  getLastRegisteredModels,
  getLastServed,
  getLastExtensionContext,
  getCurrentModelRegistry,
  getWorkPhaseState,
  commitWorkPhaseState,
  peekPendingUserEscalation,
  consumePendingUserEscalation,
  addAssessmentCost,
  recordEmbedding,
  getEmbeddingStats,
  getAssessorStrikes,
  strikeAssessor,
  clearAssessorStrikes,
  recordSuccessfulAssessorUsage,
  bumpLatchGeneration,
  setCachedRoutingIntent,
  setCurrentModelRegistry,
  setLastExtensionContext,
  setLastRegisteredModels,
  setLastServed,
  setLastDecision,
  setLastResolvedThinkingLevel,
} from './router-session-state.js';
import { debugLog, startTimer } from './debuglog.js';
import { runDelegationLoop } from './delegation.js';
import { makeTerminalErrorEvent } from './error-event.js';
import { resolveRoutingDecision, wouldDepthEscalate, applyEscalationPrecedence } from './routing-policy.js';
import {
  advanceForRoutingOwner,
  capabilityBandFor,
  deriveInitialPhase,
  inheritThinContinuation,
  nextProviderInvocation,
  scoringPolicyForState,
  terminalRequirement,
} from './work-phase.js';
import {
  getBlacklistedModels,
  getBlacklistedProviders,
  blacklistProvider,
  getSessionBlacklistPatterns,
} from './blacklist.js';

export {
  addSessionBlacklistPatterns,
  blacklistModel,
  blacklistProvider,
  clearBlacklistedModels,
  clearBlacklistedProviders,
  clearSessionBlacklist,
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

export const getProviderState = () => ({
  lastDecision: getLastDecision(),
  lastChosenRegistryId: getLastChosenRegistryId(),
  lastServed: getLastServed(),
  accumulatedCost: getAccumulatedCost(),
  embeddingStats: getEmbeddingStats(),
  blacklistedModels: [...getBlacklistedModels()].sort(),
  blacklistedProviders: [...getBlacklistedProviders()].sort(),
  workPhaseState: getWorkPhaseState(),
});

// ─── Helpers ────────────────────────────────────────────────────────

function textFromBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
    return ((block as Record<string, unknown>).text as string) ?? '';
  }
  return '';
}

function hasImageAttachment(messages: readonly Message[] | undefined): boolean {
  for (const msg of messages ?? []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object') {
          const b = block as unknown as Record<string, unknown>;
          if (b.type === 'image' || b.type === 'image_url') return true;
        }
      }
    }
  }
  return false;
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
    skillNames: getActiveSkillNames(),
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
  affectServingHealth = true,
): void {
  if (attempt.ok) {
    recordSuccessfulAssessorUsage(attempt.assessment.usage);
    clearAssessorStrikes(attempt.assessment.model);
    return;
  }
  // The assessor hit the same shared usage cap the serving path would:
  // exclude the whole provider so later turns fail fast there too.
  if (affectServingHealth && attempt.usageLimitProvider) {
    blacklistProvider(attempt.usageLimitProvider);
  }
  if (
    attempt.model &&
    attempt.producedOutput === false &&
    (attempt.fallbackReason === 'expiry' || attempt.fallbackReason === 'error')
  ) {
    strikeAssessor(attempt.model);
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
): void {
  if (ctx) {
    setCurrentModelRegistry(ctx.modelRegistry);
    setLastExtensionContext(ctx);
  }

  const regModels = ctx?.modelRegistry?.getAvailable() ?? [];
  const registryModels = regModels as unknown as RegistryModelInfo[];

  let maxCw = DEFAULT_CONTEXT_WINDOW;
  let maxMT = DEFAULT_MAX_TOKENS;
  for (const m of registryModels) {
    if (m.contextWindow && m.contextWindow > maxCw) maxCw = m.contextWindow;
    if (m.maxTokens && m.maxTokens > maxMT) maxMT = m.maxTokens;
  }
  const routerThinkingLevelMap = buildRouterThinkingLevelMap(registryModels);

  const modelSetKey = registryModels.map((m) => `${m.provider}/${m.id}`).sort().join(',');
  const modelsKey = `${modelSetKey}|${maxCw}|${maxMT}`;
  if (modelsKey === getLastRegisteredModels()) return;

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
          contextWindow: maxCw,
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
          setLastServed(undefined);
          const turnTimer = startTimer();
          try {
            const waitTimer = startTimer();
            const registry = await waitForRegistry(getCurrentModelRegistry);
            const extensionContext = getLastExtensionContext();
            const regModels = registry?.getAvailable() ?? [];
            debugLog('turn.start', {
              waitForRegistryMs: waitTimer(),
              registryModels: (regModels as unknown[]).length,
            });

            const config = loadConfig();

            const turnInput = getTurnClassificationInput(
              context.messages,
              undefined,
              { syntheticPrefixes: config.syntheticPrefixes },
            );
            const { classifyText } = turnInput;
            const systemPrompt = extractSystemPrompt(context);
            const needsVision = hasImageAttachment(context.messages);

            // Pi delivers the system prompt in `context.systemPrompt`, not as a
            // message, so include it in the token estimate that feeds
            // context-pressure detection — otherwise a large system prompt
            // (tool snippets, skills, guidelines) is silently uncounted.
            const fullText =
              (systemPrompt ? systemPrompt + '\n' : '') + allMessagesText(context.messages);
            const estContextTokens = estimateTokenCount(fullText);

            const cachedIntent = getCachedRoutingIntent();
            const cacheHit = cachedIntent?.key === turnInput.key;
            const classifyResult = cacheHit
              ? cachedIntent.classifyResult
              : classify(classifyText, systemPrompt, {
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
            const confidence = classifyResult.confidence;

            // ─── Embedding classifier ────────────────────────────────────
            // When the keyword classifier has no categorical evidence
            // (non-English prompts, ambiguous English prompts), the local
            // multilingual embedding classifier supplies the dimension.
            // Blends up only: never overrides keyword downward. The whole
            // call — engine load + inference — is bounded by
            // `embeddingDeadlineMs`; on timeout or failure we degrade to
            // the keyword result (R2, R5). Runs once per user entry
            // because it sits on the fresh-classify path (`!cacheHit`).
            if (
              !classifyResult.hasCategoricalEvidence &&
              config.embeddingClassifier &&
              !cacheHit
            ) {
              try {
                const embeddingResult = await embedAndClassify(classifyText, {
                  deadlineMs: config.embeddingDeadlineMs,
                });
                if (embeddingResult) {
                  recordEmbedding('fired');
                  // Abstain below the confidence floor: a low-confidence
                  // embedding verdict must not move routing at all (R3 —
                  // abstention never routes cheaper; the keyword result
                  // stands). Only a confident verdict may apply the blend.
                  const minConfidence =
                    config.embeddingMinConfidence ?? DEFAULT_EMBEDDING_MIN_CONFIDENCE;
                  if (embeddingResult.confidence >= minConfidence) {
                    const keywordStrength = DIMENSION_STRENGTH[baseDimension];
                    const embeddingStrength = DIMENSION_STRENGTH[embeddingResult.dimension];
                    // Blend up only: embedding can raise but never lower the
                    // keyword dimension (R3: uncertainty routes up).
                    if (embeddingStrength > keywordStrength) {
                      baseDimension = embeddingResult.dimension;
                      baseCause = 'embedding-classify';
                      recordEmbedding('promoted');
                    }
                    // If embedding agrees with keyword or is weaker, keep keyword.
                    // This covers: keyword=gather, embedding=lightweight → keep gather.
                  } else {
                    recordEmbedding('abstainedLowConf');
                  }
                } else {
                  // No verdict (timeout/unavailable) — keyword stands (R2).
                  recordEmbedding('degraded');
                }
              } catch {
                // Embedding inference failed — degrade to keyword result (R2).
                recordEmbedding('degraded');
              }
            }

            // Consume an active route_up request once per low-level Pi turn, as
            // before. Its effect is applied after the cached base intent is
            // resolved so escalation itself is never cached.
            const escalation = applyEscalation(classifyResult.dimension);

            // Peek only: a pending /router-escalate request is consumed after
            // the decision is recorded, so a router-internal failure before
            // that point cannot silently swallow the user's request.
            const userEscalation = peekPendingUserEscalation();

            const store = loadStore();
            const benchModels = store ? activeModels(store) : [];
            // Rows are pre-merged per (registryId, effort) by the store, so a
            // model with effort rows maps to several rows.
            const rowsByModel = new Map<string, BenchModel[]>();
            for (const b of benchModels) {
              const list = rowsByModel.get(b.registryId) ?? [];
              list.push(b);
              rowsByModel.set(b.registryId, list);
            }
            // Derived from the whole store, so it re-tunes on every sync
            // instead of pinning a constant that a new model generation
            // invalidates.
            const effortDrops = effortDropsPerStep(benchModels);

            const isModelAllowed = loadModelFilter();
            const isBlacklisted = buildExcludeFilter(getSessionBlacklistPatterns());
            const blacklistedProviders = getBlacklistedProviders();
            // Pi's native session scoping (--models / enabledModels) is the
            // authoritative user-intent signal for which models are usable.
            const isScoped = buildScopedModelFilter(
              extensionContext?.scopedModels as
                | readonly { model: { provider: string; id: string } }[]
                | undefined,
            );
            const allCandidates = (regModels as unknown as RegistryModelInfo[])
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
            const candidates = allCandidates.filter(
              (candidate) => !getBlacklistedModels().has(candidateKey(candidate)),
            );
            const routableCandidates = candidates.length > 0 ? candidates : [];

            if (routableCandidates.length === 0) {
              const excludedProviders = getBlacklistedProviders();
              stream.push(
                makeTerminalErrorEvent(
                  'error',
                  excludedProviders.size > 0
                    ? `No routable models: providers excluded for usage limits this session (${[...excludedProviders].sort().join(', ')}).`
                    : 'No routable models: the `models` allowlist in `~/.pi/agent/pi8/config.json` matched none of the available models.',
                ),
              );
              stream.end();
              return;
            }

            const assessmentConfig: AssessmentConfig = {
              enabled: config.consultRouter,
              mode: config.assessmentMode,
              modelRef: config.consultModel,
              // Shadow is detached (adds no turn latency), so it gets the
              // generous shadow budget; active must stay tight to bound
              // perceptible turn latency.
              deadlineMs:
                config.assessmentMode === 'shadow'
                  ? config.assessmentShadowDeadlineMs
                  : config.assessmentDeadlineMs,
              maxInputChars: config.assessmentMaxInputChars,
              assessorQualityRatio: config.assessorQualityRatio,
            };

            const assessmentSessionGeneration = getSessionGeneration();
            const assessmentStillCurrent = (): boolean =>
              getSessionGeneration() === assessmentSessionGeneration;
            let assessment = cacheHit ? cachedIntent.assessment : undefined;
            let fallbackReason = cacheHit ? cachedIntent.fallbackReason : undefined;
            // One bounded assessment per real user entry, whatever asks for it
            // (privacy/egress rule). A cache hit means the entry already spent
            // its one dispatch, successful or not.
            let assessmentDispatched = cacheHit;
            let shadowAssessment: Promise<AssessmentAttempt> | undefined;

            if (!cacheHit && assessmentConfig.enabled) {
              const evidence = evidenceForAssessment(context, config, pi);

              if (assessmentConfig.mode === 'active') {
                assessmentDispatched = true;
                const attempt = await runAssessment(
                  assessmentConfig,
                  registry,
                  routableCandidates,
                  evidence,
                  getAssessorStrikes(),
                );
                if (!assessmentStillCurrent()) {
                  stream.push(makeTerminalErrorEvent('aborted', 'Router session changed during assessment.'));
                  stream.end();
                  return;
                }
                recordAssessorOutcome(attempt);
                if (attempt.ok) {
                  addAssessmentCost(attempt.assessment.costUsd);
                  assessment = attempt.assessment;
                } else {
                  addAssessmentCost(attempt.costUsd);
                  fallbackReason = attempt.fallbackReason;
                }
              } else {
                // Shadow adds no wall-clock cost to the turn: dispatch and
                // forget. The verdict lands in its own log record joined by
                // intent key, so routing stays byte-identical to the fully
                // deterministic path.
                const intentKey = turnInput.key;
                const heuristicDimension = classifyResult.dimension;
                assessmentDispatched = true;
                shadowAssessment = runAssessment(
                  assessmentConfig,
                  registry,
                  routableCandidates,
                  evidence,
                  getAssessorStrikes(),
                );
                void shadowAssessment
                  .then((attempt) => {
                    if (!assessmentStillCurrent()) return;
                    recordAssessorOutcome(attempt, false);
                    if (attempt.ok) {
                      const counterfactual = adoptAssessment({
                        heuristic: heuristicDimension,
                        assessment: attempt.assessment,
                        mode: 'active',
                        latchEngaged: getLatchGeneration() > 0,
                      });
                      addAssessmentCost(attempt.assessment.costUsd);
                      appendShadowAssessment({
                        intentKey,
                        heuristicDimension,
                        counterfactualDimension: counterfactual.dimension,
                        assessment: attempt.assessment,
                      });
                    } else {
                      addAssessmentCost(attempt.costUsd);
                      appendShadowAssessment({
                        intentKey,
                        heuristicDimension,
                        fallbackReason: attempt.fallbackReason,
                      });
                    }
                  })
                  .catch(() => {
                    // A detached assessment must never surface into the turn.
                  });
              }
            }

            if (assessment) {
              const adoption = adoptAssessment({
                heuristic: baseDimension,
                assessment,
                mode: assessmentConfig.mode,
                latchEngaged: getLatchGeneration() > 0,
              });
              if (adoption.changed) {
                baseDimension = adoption.dimension;
                baseCause = 'router-consult';
              }
            }

            if (!cacheHit) {
              setCachedRoutingIntent({
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

            // The latch is the one automatic mid-loop transition. It fires on a
            // token counter, so the first transition in a session gets one
            // assessment before it is allowed to ratchet the rest of the
            // session upward. Every failure path still escalates.
            // Compute post-escalation-precedence state via the same helper
            // resolveRoutingDecision uses, so a pending user escalation does
            // not consume the one-shot latch assessment on a turn where user
            // intent would have superseded depth anyway.
            const preDepth = applyEscalationPrecedence({
              dimension: baseDimension,
              cause: baseCause,
              userEscalation,
              escalation,
            });
            const atLatchTransition =
              getLatchGeneration() === 0 &&
              wouldDepthEscalate({
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
            let vetoDepthEscalation = getLatchVetoIntentKey() === turnInput.key;

            if (!vetoDepthEscalation && atLatchTransition) {
              bumpLatchGeneration();
              if (assessmentConfig.enabled) {
                // Reuse the ordinary entry verdict for the latch question;
                // a dedicated dispatch would ask the same thing.
                let latchVerdict = assessment;
                if (!latchVerdict && !assessmentDispatched && assessmentConfig.mode === 'active') {
                  assessmentDispatched = true;
                  const attempt = await runAssessment(
                    assessmentConfig,
                    registry,
                    routableCandidates,
                    evidenceForAssessment(context, config, pi),
                    getAssessorStrikes(),
                  );
                  if (!assessmentStillCurrent()) {
                    stream.push(makeTerminalErrorEvent('aborted', 'Router session changed during assessment.'));
                    stream.end();
                    return;
                  }
                  recordAssessorOutcome(attempt);
                  if (attempt.ok) {
                    addAssessmentCost(attempt.assessment.costUsd);
                    latchVerdict = attempt.assessment;
                  } else {
                    addAssessmentCost(attempt.costUsd);
                  }
                }

                if (latchVerdict) {
                  vetoDepthEscalation = shouldVetoLatch(latchVerdict);
                  if (vetoDepthEscalation) {
                    setLatchVetoIntentKey(turnInput.key);
                  }
                  // Tag the assessment so consumers can see whether the latch
                  // was evaluated and which way it went.
                  assessment = { ...latchVerdict, vetoedLatch: vetoDepthEscalation };
                }

                // Shadow mode: log the latch transition, preferring the
                // ordinary assessment's verdict when one is available.
                if (assessmentConfig.mode === 'shadow') {
                  if (latchVerdict) {
                    appendShadowAssessment({
                      intentKey: turnInput.key,
                      heuristicDimension: baseDimension,
                      latchTransition: true,
                      wouldVetoLatch: vetoDepthEscalation,
                      assessment: latchVerdict,
                    });
                  } else if (shadowAssessment) {
                    // The entry's own detached assessment answers the latch
                    // question too, so chain the latch record onto it rather
                    // than paying a second egress. Cost is accounted by the
                    // entry-level handler.
                    void shadowAssessment
                      .then((attempt) => {
                        if (!assessmentStillCurrent()) return;
                        appendShadowAssessment({
                          intentKey: turnInput.key,
                          heuristicDimension: baseDimension,
                          latchTransition: true,
                          wouldVetoLatch: attempt.ok
                            ? shouldVetoLatch(attempt.assessment)
                            : false,
                          assessment: attempt.ok ? attempt.assessment : undefined,
                          fallbackReason: attempt.ok ? undefined : attempt.fallbackReason,
                        });
                      })
                      .catch(() => {
                        // A detached assessment must never surface into the turn.
                      });
                  } else if (!assessmentDispatched) {
                    // No entry-level assessment ran for this intent (the latch
                    // fired on a later invocation), so this is the entry's one
                    // dispatch.
                    assessmentDispatched = true;
                    const latchEvidence = evidenceForAssessment(context, config, pi);
                    void runAssessment(
                      assessmentConfig,
                      registry,
                      routableCandidates,
                      latchEvidence,
                      getAssessorStrikes(),
                    )
                      .then((attempt) => {
                        if (!assessmentStillCurrent()) return;
                        recordAssessorOutcome(attempt, false);
                        if (attempt.ok) {
                          addAssessmentCost(attempt.assessment.costUsd);
                        } else {
                          addAssessmentCost(attempt.costUsd);
                        }
                        appendShadowAssessment({
                          intentKey: turnInput.key,
                          heuristicDimension: baseDimension,
                          latchTransition: true,
                          wouldVetoLatch: attempt.ok
                            ? shouldVetoLatch(attempt.assessment)
                            : false,
                          assessment: attempt.ok ? attempt.assessment : undefined,
                          fallbackReason: attempt.ok ? undefined : attempt.fallbackReason,
                        });
                      })
                      .catch(() => {
                        // A detached assessment must never surface into the turn.
                      });
                  }
                }
              }
              // Deterministic mode still consumes the generation so the latch
              // is evaluated once per session either way.
            }

            // ── Per-intent multi-work phase lifecycle ──────────────────────
            // Mirrors resolveRoutingDecision's own precedence/depth-escalation
            // computation so the phase engine and the scorer agree on which
            // dimension actually owns this invocation, without a second
            // resolveRoutingDecision call (rule 12: score once per invocation).
            const resolvedDimensionForPhase: Dimension =
              !vetoDepthEscalation &&
              wouldDepthEscalate({
                dimension: preDepth.dimension,
                cause: preDepth.cause,
                estimatedContextTokens: estContextTokens,
                config,
              })
                ? (preDepth.dimension === 'lightweight' ? 'gather' : 'implement')
                : preDepth.dimension;
            const capabilityRepickActive =
              (preDepth.userApplied && !preDepth.userRaised) ||
              (preDepth.escalationApplied && !preDepth.escalationRaised);

            let workPhaseState = getWorkPhaseState();
            if (!cacheHit) {
              workPhaseState =
                workPhaseState && turnInput.thin
                  ? inheritThinContinuation(turnInput.key, workPhaseState)
                  : (() => {
                      const terminal = classifyResult.terminal;
                      const requirement = terminalRequirement(terminal);
                      const band = capabilityBandFor(requirement);
                      const initial = deriveInitialPhase(terminal, band, {
                        resolvedDimension: resolvedDimensionForPhase,
                        capabilityRepickActive,
                      });
                      return {
                        intentKey: turnInput.key,
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
            commitWorkPhaseState(workPhaseState);

            const policy = resolveRoutingDecision({
              candidates: routableCandidates,
              classifyResult,
              baseDimension,
              baseCause,
              userEscalation,
              escalation,
              estimatedContextTokens: estContextTokens,
              needsVision,
              incumbentRegistryId: getLastChosenRegistryId(),
              vetoDepthEscalation,
              ...(multiWorkPolicy ? { multiWorkPolicy } : {}),
              config,
            });
            const decision = policy.decision;
            if (assessment) decision.assessment = assessment;
            if (fallbackReason) decision.fallbackReason = fallbackReason;
            decision.intentKey = turnInput.key;
            decision.assessmentMode = config.assessmentMode;
            decision.provenanceCounts = turnInput.provenanceCounts;
            setLastDecision(decision);
            if (userEscalation) consumePendingUserEscalation();

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
            const requestedReasoning = typeof options?.reasoning === 'string' ? options.reasoning : undefined;
            // Pi's ctx.thinkingLevel mirrors whatever level we last actually
            // resolved and sent downstream (it's "the current effective level",
            // not a dedicated user-override flag). So compare the incoming
            // request against the *resolved* value we returned last turn, not
            // the raw request we received last turn — otherwise every turn
            // where adaptivity changes the level looks like a user override on
            // the very next turn, and dimension-based adaptation only fires
            // every other turn at best.
            const inheritedReasoning = requestedReasoning === getLastResolvedThinkingLevel();
            const reasoning = resolveThinkingLevel(
              chosenCandidate,
              inheritedReasoning ? undefined : requestedReasoning,
              decision.dimension,
            );
            setLastResolvedThinkingLevel(reasoning);
            debugLog('decision.thinking', {
              dimension: decision.dimension,
              chosen: decision.chosen,
              requested: requestedReasoning ?? null,
              inherited: inheritedReasoning,
              resolved: reasoning ?? 'off',
            });
            // Sync Pi's own footer/session thinking-level state to what the
            // router actually resolved for this turn. Without this call,
            // agent.state.thinkingLevel only changes via the user's own
            // thinking-selector/model-switch actions, so the footer would
            // keep showing a stale level (e.g. "thinking off") even while the
            // router silently ran a different candidate at a higher level.
            try {
              pi.setThinkingLevel((reasoning ?? 'off') as never);
            } catch {
              // Footer sync is cosmetic; never let it break a turn.
            }
            // `off` is represented by omitting the reasoning option: pi's
            // providers treat absent reasoning as thinking disabled, and
            // SimpleStreamOptions.reasoning has no 'off' value. The resolved
            // level is still recorded as 'off' for the footer and the next
            // turn's inheritance check.
            const resolvedReasoning = reasoning && reasoning !== 'off' ? reasoning : undefined;
            const delegatedOptions: SimpleStreamOptions = resolvedReasoning
              ? { ...(options ?? {}), reasoning: resolvedReasoning }
              : { ...(options ?? {}) };

            // Guidance is decided per delegation attempt because effort floors,
            // model maps, and fallback can change the source effort actually
            // shown in status. Never advertise route_up without a valid target
            // from the attempt that receives the prompt.
            const enableRouteUpGuidance =
              config.escalationTool !== false &&
              (!context.tools ||
                context.tools.some((t) => (t as { name?: string }).name === ROUTE_UP_TOOL));

            if (decision.fallbackChain.length === 0) {
              // A strict escalation can legitimately have no eligible target.
              // Surface and persist that specific outcome instead of entering
              // delegation and replacing it with a generic exhaustion error.
              renderRouterStatus(extensionContext, decision, undefined);
              appendDecision(decision, {
                registryId: '',
                viaFallback: false,
                accumulatedCost: getAccumulatedCost(),
              });
              stream.push(makeTerminalErrorEvent('error', decision.reason));
              stream.end();
              return;
            }

            const result = await runDelegationLoop(
              {
                decision,
                registry: registry!,
                context,
                options: delegatedOptions,
                enableRouteUpGuidance,
                reasoning: resolvedReasoning as string | undefined,
                userReasoningOverride:
                  !inheritedReasoning && requestedReasoning != null,
                extensionContext,
                notifyOnRoute: config.prompt,
                turnTimer,
              },
              stream,
            );

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

    setLastRegisteredModels(modelsKey);
  } catch {
    // Registration failed — don't poison the dedup guard.
  }
}
