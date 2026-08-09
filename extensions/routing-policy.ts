/**
 * Pure routing-decision policy.
 *
 * Owns: user-escalation application, model-escalation application, depth
 * escalation, scoring invocation, capability-escalation repick, context-
 * pressure metadata (advisory only), and all decision metadata/reason
 * suffixes. No I/O, no global-state reads or writes — everything is
 * threaded through the input and the returned result.
 *
 * The caller (provider.ts) is responsible for: registry wait, config load,
 * classification/consult cache, candidate construction, thinking resolution,
 * guidance injection, and delegation.
 */
import type { Candidate, DecisionCause, Dimension, MultiWorkScoringPolicy, RoutingDecision } from './types.js';
import type { ClassifyResult } from './classifier.js';
import type { AutoRouterConfig } from './types.js';
import type { PendingUserEscalation } from './router-session-state.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';
import { pickBest, pickEscalation, candidateKey, type ScoreOpts } from './scorer.js';

// ─── Public interfaces ───────────────────────────────────────────────

export interface AppliedEscalation {
  dimension: Dimension;
  cause: DecisionCause;
  reason: string;
  fromModel?: string;
}

export interface RoutingPolicyInput {
  candidates: Candidate[];
  classifyResult: ClassifyResult;
  baseDimension: Dimension;
  baseCause: DecisionCause;
  /** One-shot `/router-escalate` request for this invocation. */
  userEscalation?: PendingUserEscalation;
  escalation?: AppliedEscalation;
  estimatedContextTokens: number;
  needsVision: boolean;
  incumbentRegistryId?: string;
  /** True when a bounded high-confidence assessment refused the first latch. */
  vetoDepthEscalation?: boolean;
  /**
   * Request-local terminal/inspect floors for an eligible compound-implement
   * intent. Only the caller's latched-eligible work-phase state supplies
   * this; its absence makes the shared scorer path use current live
   * tier/promotion parameters for non-engaged, non-implement, and active-
   * repick invocations.
   */
  multiWorkPolicy?: MultiWorkScoringPolicy;
  config: Pick<
    AutoRouterConfig,
    | 'dimensionWeights'
    | 'switchMargin'
    | 'lowConfidenceThreshold'
    | 'depthEscalation'
    | 'depthEscalationTokens'
  >;
}

export interface RoutingPolicyResult {
  decision: RoutingDecision;
}

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Causes that carry no active routing intent. Depth escalation may replace
 * these, but it never overrides a cause that already owns the dimension.
 *
 * Capability-escalation same-dimension repicks use POLICY_PASSIVE_CAUSES
 * because a consult that raised the
 * dimension owns that decision — the repick is secondary model selection
 * and should not claim the dimension-owning cause.
 */
export const POLICY_PASSIVE_CAUSES: ReadonlySet<DecisionCause> = new Set([
  'heuristic',
  'continuation-context',
  'no-data',
] satisfies DecisionCause[]);

/**
 * Depth escalation asks "is the context deep enough that the token counter
 * should override the classifier?". An assessment answers what kind of work
 * this is, not how deep the context got, so a consult-owned dimension is
 * still a legitimate depth-gate subject. The narrower POLICY_PASSIVE_CAUSES
 * remains correct for capability repicks, which do compete for dimension
 * ownership.
 */
const DEPTH_PASSIVE_CAUSES: ReadonlySet<DecisionCause> = new Set([
  ...POLICY_PASSIVE_CAUSES,
  'router-consult',
] satisfies DecisionCause[]);

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Dimensions ordered by strength, indexable by {@link DIMENSION_STRENGTH}.
 * Keep in sync with DIMENSION_STRENGTH in classifier-keywords.ts.
 */
export const STRENGTH_ORDER: Dimension[] = ['lightweight', 'gather', 'implement', 'review', 'plan'];

/** One tier up, capped at the top dimension. */
export function nextStrongerDimension(dimension: Dimension): Dimension {
  const next = Math.min(DIMENSION_STRENGTH[dimension] + 1, STRENGTH_ORDER.length - 1);
  return STRENGTH_ORDER[next]!;
}

/**
 * Context usage ratio above which advisory pressure metadata is attached.
 * This threshold is intentionally not configurable: it reflects a structural
 * constraint (near-full context = degraded planning quality) rather than a
 * user preference.
 */
const CONTEXT_PRESSURE_THRESHOLD = 0.6;

export interface DepthEscalationProbe {
  dimension: Dimension;
  cause: DecisionCause;
  estimatedContextTokens: number;
  config: Pick<AutoRouterConfig, 'depthEscalation' | 'depthEscalationTokens'>;
}

/**
 * Exported so the caller can ask "is this the latch transition?" without
 * duplicating the condition. Two copies of this predicate would drift, and a
 * drifted copy means the veto fires on turns the latch would not have
 * escalated.
 */
export function wouldDepthEscalate(probe: DepthEscalationProbe): boolean {
  return (
    probe.config.depthEscalation &&
    DEPTH_PASSIVE_CAUSES.has(probe.cause) &&
    DIMENSION_STRENGTH[probe.dimension] <= DIMENSION_STRENGTH['gather'] &&
    probe.estimatedContextTokens >= probe.config.depthEscalationTokens
  );
}

// ─── Escalation precedence ───────────────────────────────────────────

/** Input for {@link applyEscalationPrecedence}. */
export interface EscalationPrecedenceInput {
  dimension: Dimension;
  cause: DecisionCause;
  userEscalation?: PendingUserEscalation;
  escalation?: AppliedEscalation;
}

/** Output of {@link applyEscalationPrecedence}. */
export interface EscalationPrecedenceResult {
  dimension: Dimension;
  cause: DecisionCause;
  userApplied: boolean;
  userRaised: boolean;
  escalationApplied: boolean;
  escalationRaised: boolean;
}

/**
 * Resolve user- and model-escalation precedence over a base dimension and
 * cause. Shared by the depth-escalation probe in provider.ts so it computes
 * the latch transition from the same post-escalation state that
 * resolveRoutingDecision's depth gate sees, keeping the two from drifting.
 *
 * Pure: reads only its inputs.
 */
export function applyEscalationPrecedence(
  input: EscalationPrecedenceInput,
): EscalationPrecedenceResult {
  let dimension: Dimension = input.dimension;
  let cause: DecisionCause = input.cause;

  // Step 2: apply an explicit user escalation. A no-arg request raises one
  // tier; an explicit target is honoured as-is. An equal target is meaningful
  // — it asks for a different model at the same dimension.
  let userApplied = false;
  let userRaised = false;
  if (input.userEscalation) {
    const target = input.userEscalation.target ?? nextStrongerDimension(dimension);
    if (DIMENSION_STRENGTH[target] >= DIMENSION_STRENGTH[dimension]) {
      userRaised = DIMENSION_STRENGTH[target] > DIMENSION_STRENGTH[dimension];
      dimension = target;
      cause = 'user-escalation';
      userApplied = true;
    }
  }

  // Step 3: apply active model escalation when it is at least as strong.
  // An explicit user request outranks a model's earlier route_up for this
  // invocation, so the override may still contribute metadata but must not
  // move the dimension or claim the cause.
  let escalationApplied = false;
  let escalationRaised = false;
  if (
    input.escalation &&
    !userApplied &&
    DIMENSION_STRENGTH[input.escalation.dimension] >= DIMENSION_STRENGTH[dimension]
  ) {
    escalationRaised =
      DIMENSION_STRENGTH[input.escalation.dimension] > DIMENSION_STRENGTH[dimension];
    dimension = input.escalation.dimension;
    if (escalationRaised) cause = 'model-escalation';
    escalationApplied = true;
  }

  return { dimension, cause, userApplied, userRaised, escalationApplied, escalationRaised };
}

// ─── Core function ───────────────────────────────────────────────────

/**
 * Resolve the routing dimension, cause, scoring, and decision metadata for
 * one provider invocation. Pure: reads only its inputs and returns a fresh
 * RoutingDecision; never reads or writes module-level state.
 */
export function resolveRoutingDecision(input: RoutingPolicyInput): RoutingPolicyResult {
  const {
    candidates,
    classifyResult,
    baseDimension,
    baseCause,
    userEscalation,
    escalation,
    estimatedContextTokens,
    needsVision,
    incumbentRegistryId,
    config,
    multiWorkPolicy,
  } = input;

  // Step 1-3: start from base dimension/cause then apply user and model
  // escalation via the shared precedence helper so the provider's depth probe
  // and the policy's depth gate agree on the pre-depth state.
  const precedence = applyEscalationPrecedence({
    dimension: baseDimension,
    cause: baseCause,
    userEscalation,
    escalation,
  });
  let dimension: Dimension = precedence.dimension;
  let cause: DecisionCause = precedence.cause;
  let escalationReason: string | undefined;
  if (precedence.escalationApplied) {
    escalationReason = escalation?.reason;
  }

  const hasAnyBenchmark = candidates.some((candidate) => candidate.bench !== undefined);
  if (!hasAnyBenchmark && cause === 'heuristic') cause = 'no-data';

  // Step 4: depth escalation. A token counter cannot distinguish "synthesizing
  // over gathered material" from "long session, small question", so a bounded
  // high-confidence assessment may veto the first transition in a session. A
  // veto retains the existing cause, which is why no new DecisionCause value
  // exists for it and POLICY_PASSIVE_CAUSES is unchanged.
  if (
    !input.vetoDepthEscalation &&
    wouldDepthEscalate({
      dimension,
      cause,
      estimatedContextTokens,
      config,
    })
  ) {
    dimension = dimension === 'lightweight' ? 'gather' : 'implement';
    cause = 'context-depth';
  }

  // Step 5: score with the configured active-dimension weights.
  // The multi-work phase floors are request-local to the primary pick: a
  // capability repick and the routed-pick counterfactual answer different
  // questions, so they score with ordinary options.
  const baseOpts: ScoreOpts = {
    estimatedContextTokens,
    incumbentRegistryId,
    needsVision,
    isSubagentSpawn: false,
    switchMargin: config.switchMargin,
  };
  const pickOpts: ScoreOpts = multiWorkPolicy ? { ...baseOpts, multiWorkPolicy } : baseOpts;
  let decision = pickBest(candidates, dimension, config.dimensionWeights[dimension], pickOpts);

  // Step 6: repick away from the source model when scoring would keep it, or
  // when the request is a same-dimension capability repick. The pure escalation
  // picker excludes the source model and ranks alternatives quality-first.
  const repick = precedence.userApplied
    ? { fromModel: userEscalation?.fromModel, raisedDimension: precedence.userRaised }
    : precedence.escalationApplied
      ? { fromModel: escalation?.fromModel, raisedDimension: precedence.escalationRaised }
      : undefined;
  if (
    repick?.fromModel &&
    (decision.chosen === repick.fromModel || !repick.raisedDimension)
  ) {
    const escalationDecision = pickEscalation(
      candidates,
      dimension,
      repick.fromModel,
      baseOpts,
    );
    if (escalationDecision) {
      decision = escalationDecision;
      // A same-dimension capability repick only overwrites causes that
      // carry no active routing intent. When an earlier step (user request,
      // consult, depth escalation) already owns the dimension, the repick is
      // a secondary model selection — the dimension-owning cause must be
      // preserved.
      if (!repick.raisedDimension && POLICY_PASSIVE_CAUSES.has(cause)) {
        cause = 'capability-escalation';
      }
    }
  }

  // Step 7: apply context-pressure metadata as advisory only.
  // Pressure is structural advice for the user/caller, not a cause that owns
  // the routing decision or changes the selected dimension.
  decision.dimension = dimension;
  decision.confidence = classifyResult.confidence;
  decision.cause = cause;
  if (escalation) {
    decision.escalation = {
      requestedDimension: escalation.dimension,
      heuristicDimension: classifyResult.dimension,
      reason: escalation.reason,
    };
  }
  // "Changed" is not "stronger". Direction has to come from the strength
  // ordering, because the downstream consumers — context-pressure advice, the
  // status widget, `/router-why` — mean different things for each direction.
  decision.routedUp =
    DIMENSION_STRENGTH[dimension] > DIMENSION_STRENGTH[classifyResult.dimension];
  decision.routedDown =
    DIMENSION_STRENGTH[dimension] < DIMENSION_STRENGTH[classifyResult.dimension];

  // The status widgets promise "routed-up/down = a different-strength model was
  // actually served", not merely "the dimension label moved". A raise that
  // re-selects the model the heuristic dimension would have picked served
  // nothing stronger, so record whether the pick truly moved and let the UI
  // suppress a misleading label. Bounded to turns where a direction fired.
  if (decision.routedUp || decision.routedDown) {
    const heuristicPick = pickBest(
      candidates,
      classifyResult.dimension,
      config.dimensionWeights[classifyResult.dimension],
      baseOpts,
    );
    decision.routedPickChanged = heuristicPick.chosen !== decision.chosen;
  }

  const chosenCandidateForContext = candidates.find(
    (c) => candidateKey(c) === decision.chosen,
  );
  const chosenContextWindow = chosenCandidateForContext?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextUsageRatio = estimatedContextTokens / Math.max(1, chosenContextWindow);
  const undercertainty =
    classifyResult.confidence < config.lowConfidenceThreshold || decision.routedUp;
  if (undercertainty && contextUsageRatio >= CONTEXT_PRESSURE_THRESHOLD) {
    decision.contextPressure = {
      usageRatio: contextUsageRatio,
      threshold: CONTEXT_PRESSURE_THRESHOLD,
      suggestion:
        'Parent context is dense: offload planning to a fresh-context planner subagent, then run execution in the parent with a cheaper model.',
    };
    // Advisory only: do NOT change decision.cause here
    decision.reason += ' [context-pressure: prefer fresh planner handoff]';
  }

  // Step 8: reason suffixes (applied after context-pressure so ordering is stable)
  if (cause === 'context-depth') {
    decision.reason += ` [context-depth: ${estimatedContextTokens} tokens ≥ ${config.depthEscalationTokens}]`;
  }
  if (cause === 'no-data') {
    decision.reason += ' [no benchmark quality data]';
  }
  if (cause === 'model-escalation' && escalationReason) {
    decision.reason += ` [escalated: ${escalationReason}]`;
  } else if (cause === 'user-escalation') {
    decision.reason += ` [user escalation → ${dimension}]`;
  } else if (cause === 'router-consult' && decision.assessment) {
    decision.reason +=
      ` [assessment ${decision.assessment.kind} ` +
      `${decision.assessment.scope}/${decision.assessment.confidence}]`;
  }

  decision.switched = incumbentRegistryId != null && incumbentRegistryId !== decision.chosen;

  return { decision };
}
