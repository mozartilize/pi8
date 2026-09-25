/**
 * Pure routing-decision policy.
 *
 * Owns: scoring invocation, trajectory-friction handoff,
 * context-pressure metadata (advisory only), and all decision metadata/reason
 * suffixes. No I/O, no global-state reads or writes — everything is threaded
 * through the input and the returned result.
 *
 * The caller (provider.ts) is responsible for: registry wait, config load,
 * classification/consult cache, candidate construction, thinking resolution,
 * and delegation.
 */
import type { Candidate, DecisionCause, Dimension, RoutingDecision } from '../../types.js';
import { addReasonDetail } from '../score/decision-reason.js';
import type { ClassifyResult } from '../classify/classifier.js';
import type { AutoRouterConfig } from '../../types.js';
import { DIMENSION_STRENGTH } from '../classify/classifier-keywords.js';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import {
  pickBest,
  escalationChain,
  isValidEscalationCandidate,
  candidateKey,
  capabilityForDimension,
  type ScoreOpts,
} from '../score/scorer.js';
import type { PendingTrajectoryEscalation } from '../struggle/types.js';

// ─── Public interfaces ───────────────────────────────────────────────

export interface RoutingPolicyInput {
  candidates: Candidate[];
  classifyResult: ClassifyResult;
  baseDimension: Dimension;
  baseCause: DecisionCause;
  /** Same-dimension quality-first repick from objective trajectory friction. */
  trajectoryEscalation?: PendingTrajectoryEscalation;
  /**
   * Explicit user/session thinking request. When `userReasoningOverride` is
   * set, trajectory stronger-proofs must compare the effort that will actually
   * serve, not the labelled candidate effort.
   */
  userReasoning?: ThinkingLevel;
  userReasoningOverride?: boolean;
  estimatedContextTokens: number;
  /**
   * Tokens each candidate key's own prompt cache still holds (see
   * `ScoreOpts.warmPrefixTokens`). Feeds the switch bonus so an effort change
   * onto a recently served level is priced below a cold one.
   */
  warmPrefixTokens?: ReadonlyMap<string, number>;
  needsVision: boolean;
  incumbentRegistryId?: string;
  /**
   * The dimension the previous decision resolved at. When the incumbent model
   * stays sticky within a task, this carries forward as an up-only effort
   * floor so a cheap-phrased same-task follow-up cannot serve the strong
   * incumbent at a shallow thinking level. Stands down on an off-topic reset
   * and the same sanctioned downward moves as the incumbent model floor (R3).
   */
  incumbentResolvedDimension?: Dimension;
  /**
   * True when this invocation shares the previous decision's intent key — i.e.
   * it is a continuation of the same user entry (a post-tool re-invocation),
   * not a fresh user turn. The incumbent capability floor uses it so an
   * off-topic reset can only fire on a genuine new entry, never on every
   * re-invocation of one cached intent.
   */
  sameIntentAsLast?: boolean;
  /**
   * Task-axis ratio an accepted handoff requires of the next phase's model
   * (see `ScoreOpts.handoffMinimum`). For an execution contract the caller has
   * already removed excluded executor models from `candidates`.
   */
  handoffMinimum?: number;
  /**
   * True while a handoff boundary has not yet been served: both incumbent
   * minimums stand down so the scorer may pick a cheaper or stronger model
   * for the new phase. Once a model serves the phase, it is the incumbent.
   */
  handoffPending?: boolean;
  /**
   * Task type the entry owes the user when it differs from the routed phase
   * (an investigation before planning or review). The off-topic reset keys
   * on it, so an on-topic planning follow-up keeps its incumbent.
   */
  deliverable?: Dimension;
  config: Pick<
    AutoRouterConfig,
    | 'dimensionWeights'
    | 'switchMargin'
    | 'lowConfidenceThreshold'
  >;
}

export interface RoutingPolicyResult {
  decision: RoutingDecision;
  /** True when trajectory friction selected a stronger head pick. */
  trajectoryApplied: boolean;
  /** True when a new entry reset the incumbent minimums as off-topic. */
  offTopicReset: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Causes that carry no active routing intent. A trajectory-friction
 * same-dimension repick may claim these, but a consult that raised the
 * dimension owns that decision — the repick is secondary model selection and
 * should not claim the dimension-owning cause.
 */
export const POLICY_PASSIVE_CAUSES: ReadonlySet<DecisionCause> = new Set([
  'heuristic',
  'continuation-context',
  'no-data',
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

// ─── Decision steps ──────────────────────────────────────────────────

function applyTrajectoryRepick(
  decision: RoutingDecision,
  cause: DecisionCause,
  candidates: Candidate[],
  dimension: Dimension,
  trajectory: PendingTrajectoryEscalation | undefined,
  baseOpts: ScoreOpts,
  compareOpts: { userReasoning?: ThinkingLevel; userReasoningOverride?: boolean },
): { decision: RoutingDecision; cause: DecisionCause; applied: boolean } {
  if (!trajectory) return { decision, cause, applied: false };
  const friction = {
    tfi: trajectory.tfi,
    signals: trajectory.signals.map((signal) => ({
      kind: signal.kind,
      severity: signal.severity as 'warning' | 'severe',
      evidenceCount: signal.evidenceCount,
    })),
    fromModel: trajectory.fromModel,
    preOutput: trajectory.preOutput,
  };
  // Context/vision guards, strictly-stronger filter, and strongest-by-quality
  // pick all live in `escalationChain` so this and the pre-output hop can never
  // disagree on the target. No stronger reachable → keep the routed decision
  // and mark the friction unavailable (the provider gate owns what to do next).
  const picked = escalationChain(candidates, dimension, trajectory.fromModel, baseOpts, compareOpts);
  if (!picked) {
    decision.trajectoryFriction = { ...friction, unavailable: true };
    return { decision, cause, applied: false };
  }
  // Friction only owns the head pick. Everything behind it is objective-failure
  // recovery, so the ordinary chain stays reachable: a stronger model that
  // 421s or has no credentials must not strand the turn behind a
  // stronger-only chain. The struggling source itself stays excluded — the
  // evidence is about that exact (model, effort).
  const recovery = decision.fallbackChain.filter((key) =>
    isValidEscalationCandidate(key, trajectory.fromModel));
  decision = {
    ...picked,
    fallbackChain: [...new Set([...picked.fallbackChain, ...recovery])],
    trajectoryFriction: friction,
  };
  if (POLICY_PASSIVE_CAUSES.has(cause)) cause = 'trajectory-escalation';
  return { decision, cause, applied: true };
}

/**
 * Incumbent capability floor. The served model is sticky within one task: a
 * per-invocation rescore must not fall below the incumbent's known
 * capability at the routed dimension. Select the first already-scored chain
 * candidate that meets that minimum, which may be a cheaper model. An
 * incumbent filtered out for context or vision never enters the chain, so
 * this cannot bypass a safety filter or capability tier.
 */
function applyIncumbentModelFloor(
  decision: RoutingDecision,
  candidates: Candidate[],
  dimension: Dimension,
  incumbentRegistryId: string | undefined,
  standsDown: boolean,
): void {
  if (incumbentRegistryId == null || incumbentRegistryId === decision.chosen || standsDown) {
    return;
  }
  const incumbentCandidate = candidates.find((c) => candidateKey(c) === incumbentRegistryId);
  const chosenCandidate = candidates.find((c) => candidateKey(c) === decision.chosen);
  const incumbentInChain = decision.fallbackChain.indexOf(incumbentRegistryId);
  if (incumbentCandidate && chosenCandidate && incumbentInChain >= 0) {
    const incumbentQuality = capabilityForDimension(incumbentCandidate, dimension);
    const chosenQuality = capabilityForDimension(chosenCandidate, dimension);
    if (incumbentQuality != null && chosenQuality != null && incumbentQuality > chosenQuality) {
      const target = decision.fallbackChain.find((key) => {
        const candidate = candidates.find((c) => candidateKey(c) === key);
        const quality = candidate && capabilityForDimension(candidate, dimension);
        return quality != null && quality >= incumbentQuality;
      });
      if (!target) return;
      const chain = decision.fallbackChain.slice();
      chain.splice(chain.indexOf(target), 1);
      chain.unshift(target);
      decision.fallbackChain = chain;
      decision.chosen = target;
      addReasonDetail(decision, { kind: target === incumbentRegistryId ? 'incumbent-model' : 'incumbent-capability' });
    }
  }
}

/**
 * Incumbent effort floor. Holding the strong incumbent model on a
 * cheap-classified same-task follow-up (whether re-picked naturally or
 * restored by the model floor) would otherwise serve it at the cheap
 * dimension's shallow thinking floor — right model, wrong effort. Carry the
 * incumbent's resolved dimension forward as an up-only effort floor. This
 * never lowers effort (max only), never changes the routed dimension or
 * model (so no DecisionCause — it is a secondary mechanism recorded in the
 * reason).
 */
function applyIncumbentEffortFloor(
  decision: RoutingDecision,
  dimension: Dimension,
  incumbentResolvedDimension: Dimension | undefined,
  standsDown: boolean,
): void {
  if (
    incumbentResolvedDimension == null ||
    standsDown ||
    DIMENSION_STRENGTH[incumbentResolvedDimension] <= DIMENSION_STRENGTH[dimension]
  ) {
    return;
  }
  decision.effortFloorDimension = incumbentResolvedDimension;
  addReasonDetail(decision, { kind: 'incumbent-effort' });
}

/**
 * Apply context-pressure metadata as advisory only, then reason suffixes.
 * Pressure is structural advice for the user/caller, not a cause that owns
 * the routing decision or changes the selected dimension. Reason suffixes
 * are applied after context-pressure so ordering is stable.
 */
function annotateDecision(
  decision: RoutingDecision,
  dimension: Dimension,
  cause: DecisionCause,
  classifyResult: ClassifyResult,
  candidates: Candidate[],
  estimatedContextTokens: number,
  incumbentRegistryId: string | undefined,
  config: RoutingPolicyInput['config'],
  baseOpts: ScoreOpts,
): void {
  decision.dimension = dimension;
  decision.confidence = classifyResult.confidence;
  // Cause names the mechanism that changed the task type; model preferences
  // and context-pressure advice belong in metadata, not a replacement cause.
  decision.cause = cause;
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
    addReasonDetail(decision, { kind: 'context-pressure' });
  }

  if (cause === 'no-data') {
    addReasonDetail(decision, { kind: 'no-data' });
  }
  if (cause === 'trajectory-escalation') {
    addReasonDetail(decision, { kind: 'trajectory', fromModel: decision.trajectoryFriction?.fromModel ?? 'previous model' });
  } else if (cause === 'router-consult' && decision.assessment) {
    addReasonDetail(decision, {
      kind: 'assessment',
      task: decision.assessment.kind,
      scope: decision.assessment.scope,
      confidence: decision.assessment.confidence,
    });
  }

  decision.switched = incumbentRegistryId != null && incumbentRegistryId !== decision.chosen;
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
    trajectoryEscalation,
    userReasoning,
    userReasoningOverride,
    estimatedContextTokens,
    warmPrefixTokens,
    needsVision,
    incumbentRegistryId,
    incumbentResolvedDimension,
    sameIntentAsLast,
    config,
    handoffMinimum,
    handoffPending,
    deliverable = baseDimension,
  } = input;

  // The caller's base dimension and cause are the routed task type. Context
  // size never changes it: a token count cannot tell synthesis over gathered
  // material from a long session with a small question.
  const dimension: Dimension = baseDimension;
  let cause: DecisionCause = baseCause;

  const hasAnyBenchmark = candidates.some((candidate) => candidate.bench !== undefined);
  if (!hasAnyBenchmark && cause === 'heuristic') cause = 'no-data';

  // Score with the configured active-dimension weights.
  // The handoff minimum is request-local to the primary pick: a trajectory
  // repick and the routed-pick counterfactual answer different questions, so
  // they score with ordinary options.
  const baseOpts: ScoreOpts = {
    estimatedContextTokens,
    incumbentRegistryId,
    needsVision,
    isSubagentSpawn: false,
    switchMargin: config.switchMargin,
    ...(warmPrefixTokens != null ? { warmPrefixTokens } : {}),
  };
  const pickOpts: ScoreOpts = handoffMinimum != null
    ? { ...baseOpts, handoffMinimum }
    : baseOpts;
  let decision = pickBest(candidates, dimension, config.dimensionWeights[dimension], pickOpts);

  // Objective trajectory friction may repick away from the source
  // model when scoring would keep it.
  const trajectory = applyTrajectoryRepick(
    decision,
    cause,
    candidates,
    dimension,
    trajectoryEscalation,
    baseOpts,
    { userReasoning, userReasoningOverride },
  );
  decision = trajectory.decision;
  cause = trajectory.cause;

  // The floor stands down for the sanctioned downward moves, never widening
  // them (R3): an applied trajectory handoff owns the model (its repick
  // deliberately excludes the source model, so the floor must not restore
  // it); a consult that actually lowered the dimension; and a genuine new-entry,
  // high-confidence trivial classification (an off-topic follow-up that
  // resets to a cheap model); and a handoff boundary until a model serves the
  // new phase. Same-intent re-invocations never reset, so the stickiness
  // holds across a whole tool loop.
  const consultLoweredDimension =
    cause === 'router-consult' &&
    DIMENSION_STRENGTH[baseDimension] < DIMENSION_STRENGTH[classifyResult.dimension];
  // Reset keys on the entry's FINAL resolved deliverable, not the heuristic
  // or a temporary investigation phase: a fresh entry whose heuristic gather
  // was raised to an involved dimension (adopted consult, embedding) is not
  // off-topic, so the floor must still hold.
  const offTopicReset =
    !sameIntentAsLast &&
    classifyResult.confidence >= config.lowConfidenceThreshold &&
    DIMENSION_STRENGTH[deliverable] <= DIMENSION_STRENGTH['gather'];
  const incumbentFloorStandsDown =
    trajectory.applied ||
    consultLoweredDimension ||
    offTopicReset ||
    handoffPending === true;

  // Incumbent capability floor.
  applyIncumbentModelFloor(
    decision,
    candidates,
    dimension,
    incumbentRegistryId,
    incumbentFloorStandsDown,
  );

  // Incumbent effort floor.
  applyIncumbentEffortFloor(
    decision,
    dimension,
    incumbentResolvedDimension,
    incumbentFloorStandsDown,
  );

  // Metadata and reason suffixes.
  annotateDecision(
    decision,
    dimension,
    cause,
    classifyResult,
    candidates,
    estimatedContextTokens,
    incumbentRegistryId,
    config,
    baseOpts,
  );

  return { decision, trajectoryApplied: trajectory.applied, offTopicReset };
}
