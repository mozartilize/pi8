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
import { getTurnClassificationInput, buildRoleLabelledContext } from './continuation.js';
import { loadModelFilter, buildExcludeFilter } from './allowlist.js';
import { loadConfig } from './config.js';
import { runAssessment, type AssessmentConfig } from './consult.js';
import { adoptAssessment, shouldVetoLatch } from './assessment-adoption.js';
import { latestSummaryText, countToolActivity } from './message-provenance.js';
import { applyEscalation, appendRouteUpGuidance, ROUTE_UP_TOOL } from './escalation.js';
import { appendShadowAssessment } from './decisionlog.js';
import {
  buildCandidate,
  buildRouterThinkingLevelMap,
  candidateKey,
  isThinkingSupportedByRegistryModel,
  resolveThinkingLevel,
  type RegistryModelInfo,
} from './scorer.js';
import {
  getAccumulatedCost,
  getActiveSkillNames,
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
  peekPendingUserEscalation,
  consumePendingUserEscalation,
  addAssessmentCost,
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
  getBlacklistedModels,
  getSessionBlacklistPatterns,
} from './blacklist.js';

export {
  addSessionBlacklistPatterns,
  blacklistModel,
  clearBlacklistedModels,
  clearSessionBlacklist,
  getBlacklistedModels,
  getSessionBlacklistPatterns,
  removeBlacklistedModel,
  removeSessionBlacklistPatterns,
} from './blacklist.js';

// ─── Registry-wait (mandatory for subagents) ────────────────────────

/** Per-provider timeout for credential probes (ms). */
const AUTH_PROBE_TIMEOUT_MS = 3000;

/**
 * Resolve credentials once per provider and return a membership test.
 *
 * Without this, a registry full of providers the user never logged into (e.g.
 * ~109 amazon-bedrock entries) would produce subagent picks that can never
 * actually spawn, because pi-subagents consumes the model verbatim and
 * hard-fails on an unauthenticated provider.
 *
 * Every `getAuth` call is individually time-boxed via Promise.race so a slow
 * or hanging credential prompt on one provider cannot block the entire router.
 * After the timeout the provider is treated as unauthenticated and routing
 * proceeds with the remaining candidates.
 */
export async function buildSubagentProviderAuthFilter(
  registry: ExtensionContext['modelRegistry'] | undefined,
  models: readonly RegistryModelInfo[],
): Promise<(provider: string) => boolean> {
  // Without a credential probe, never inject an arbitrary provider into a
  // pick-once subagent spawn; Pi's own default resolution remains available.
  if (!registry?.getApiKeyAndHeaders || !registry.find) return () => false;
  const find = registry.find.bind(registry);
  const getAuth = registry.getApiKeyAndHeaders.bind(registry);

  const providers = [...new Set(models.map((m) => m.provider))].filter(
    (p) => p && p !== ROUTER_PROVIDER_ID,
  );

  const usable = new Set<string>();
  await Promise.all(
    providers.map(async (provider) => {
      const probe = models.find((m) => m.provider === provider);
      if (!probe) return;
      try {
        const model = find(provider, probe.id);
        if (!model) return;
        const auth = await Promise.race([
          getAuth(model),
          new Promise<undefined>((_, reject) =>
            setTimeout(() => reject(new Error('auth probe timed out')), AUTH_PROBE_TIMEOUT_MS),
          ),
        ]);
        if (auth?.ok && auth.apiKey) usable.add(provider);
      } catch {
        // Treat a probe failure (or timeout) as "unknown", not as "authenticated".
      }
    }),
  );

  // A total probe failure means authentication is unknown, not successful.
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
  blacklistedModels: [...getBlacklistedModels()].sort(),
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

// ─── Candidate expansion ───────────────────────────────────────────────

/**
 * Expand one registry model into its routable candidates: one per effort
 * level that is BOTH supported by the model's thinkingLevelMap AND present as
 * an active bench row. A model with no effort-labelled rows emits exactly one
 * candidate with no effort, as before. An effort level with no measurement is
 * never synthesized — unmeasured is unknown quality (rule 3), and a cheap
 * unmeasured variant must not become the pick.
 *
 * `off` is universally serveable: non-reasoning registry models run exactly
 * the mode an off row measures, so an off row never drops a model's only
 * measurement.
 */
export function expandModelCandidates(
  rm: RegistryModelInfo,
  rows: readonly BenchModel[],
): Candidate[] {
  const labelled = rows.filter(
    (r): r is BenchModel & { effort: ModelThinkingLevel } => r.effort != null,
  );
  if (labelled.length === 0) return [buildCandidate(rm, rows[0])];
  const supported = labelled
    .filter(
      (row) => row.effort === 'off' || isThinkingSupportedByRegistryModel(rm, row.effort),
    )
    .map((row) => buildCandidate(rm, row));
  if (supported.length > 0) return supported;
  // All measured efforts are unsupported by this model's thinkingLevelMap.
  // Rather than dropping the model entirely (which would make it unroutable),
  // fall back to an effort-less candidate bound to the best available row.
  // Quality still counts; the dimension floor applies at delegation time.
  return [buildCandidate(rm, { ...labelled[0], effort: undefined })];
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

            const isModelAllowed = loadModelFilter();
            const isBlacklisted = buildExcludeFilter(getSessionBlacklistPatterns());
            const allCandidates = (regModels as unknown as RegistryModelInfo[])
              .filter(
                (rm) =>
                  rm.provider &&
                  rm.provider !== ROUTER_PROVIDER_ID &&
                  isModelAllowed(`${rm.provider}/${rm.id}`) &&
                  !isBlacklisted(`${rm.provider}/${rm.id}`),
              )
              .flatMap((rm) => expandModelCandidates(rm, rowsByModel.get(`${rm.provider}/${rm.id}`) ?? []));
            const candidates = allCandidates.filter(
              (candidate) => !getBlacklistedModels().has(candidateKey(candidate)),
            );
            const routableCandidates = candidates.length > 0 ? candidates : [];

            if (routableCandidates.length === 0) {
              stream.push(
                makeTerminalErrorEvent(
                  'error',
                  'No routable models: the `models` allowlist in `~/.pi/agent/pi8/config.json` matched none of the available models.',
                ),
              );
              stream.end();
              return;
            }

            const assessmentConfig: AssessmentConfig = {
              enabled: config.consultRouter,
              mode: config.assessmentMode,
              modelRef: config.consultModel,
              deadlineMs: config.assessmentDeadlineMs,
              maxInputChars: config.assessmentMaxInputChars,
              assessorQualityRatio: config.assessorQualityRatio,
            };

            let assessment = cacheHit ? cachedIntent.assessment : undefined;
            let fallbackReason = cacheHit ? cachedIntent.fallbackReason : undefined;

            if (!cacheHit && assessmentConfig.enabled) {
              const evidence = evidenceForAssessment(context, config, pi);

              if (assessmentConfig.mode === 'active') {
                const attempt = await runAssessment(
                  assessmentConfig,
                  registry,
                  routableCandidates,
                  evidence,
                );
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
                void runAssessment(assessmentConfig, registry, routableCandidates, evidence)
                  .then((attempt) => {
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
                if (!latchVerdict && assessmentConfig.mode === 'active') {
                  const attempt = await runAssessment(
                    assessmentConfig,
                    registry,
                    routableCandidates,
                    evidenceForAssessment(context, config, pi),
                  );
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
                  } else {
                    // No ordinary verdict ran; dispatch detached.
                    const latchEvidence = evidenceForAssessment(context, config, pi);
                    void runAssessment(
                      assessmentConfig,
                      registry,
                      routableCandidates,
                      latchEvidence,
                    )
                      .then((attempt) => {
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

            // Inline route-up guidance whenever this pick has another candidate
            // it can hand off to. Capability escalation can repick within `plan`,
            // so dimension strength is not a proxy for alternative availability.
            // Also require the tool to be enabled and present in this turn's
            // toolset so we never instruct a model to call a tool it lacks.
            const routeUpAvailable =
              config.escalationTool !== false &&
              routableCandidates.some((candidate) => candidateKey(candidate) !== decision.chosen) &&
              (!context.tools ||
                context.tools.some((t) => (t as { name?: string }).name === ROUTE_UP_TOOL));
            const delegatedContext: Context = routeUpAvailable
              ? { ...context, systemPrompt: appendRouteUpGuidance(context.systemPrompt) }
              : context;

            const result = await runDelegationLoop(
              {
                decision,
                registry: registry!,
                context: delegatedContext,
                options: delegatedOptions,
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
