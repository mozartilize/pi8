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
import type { AutoRouterConfig } from '../../types.js';
import type { ModelThinkingLevel, ThinkingLevel } from '@earendil-works/pi-ai';
import {
  pickBest,
  escalationChain,
  isValidEscalationCandidate,
  candidateKey,
  capabilityForDimension,
  parseCandidateKey,
  levelFrom,
  MODEL_THINKING_LEVELS,
  type ScoreOpts,
} from '../score/scorer.js';
import type { PendingTrajectoryEscalation } from '../struggle/types.js';
import type { EntryResolution } from '../context/types.js';
import type { PolicyVersion } from './policy-version.js';

// ─── Public interfaces ───────────────────────────────────────────────

export interface RoutingPolicyInput {
  candidates: Candidate[];
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
  protocolPenalties?: ReadonlyMap<string, number>;
  needsVision: boolean;
  /** The incumbent's candidate key, with the effort it served at. */
  incumbentRegistryId?: string;
  /**
   * True when this invocation shares the previous decision's intent key — i.e.
   * it is a continuation of the same user entry (a post-tool re-invocation),
   * not a fresh user turn. A cached work relation may release the unrelated
   * incumbent only at entry start, not on each post-tool invocation.
   */
  sameIntentAsLast?: boolean;
  /**
   * Requirement an accepted handoff sets for the next phase's model
   * (see `ScoreOpts.handoffMinimum`). For an execution contract the caller has
   * already removed excluded executor models from `candidates`.
   */
  handoffMinimum?: number;
  /**
   * True while a handoff boundary has not yet been served: both incumbent
   * minimums are skipped so the scorer may pick a cheaper or stronger model
   * for the new phase. Once a model serves the phase, it is the incumbent.
   */
  handoffPending?: boolean;
  /** Recorded semantic relation. Missing or unknown resolution keeps both incumbent minimums. */
  workRelation?: EntryResolution['relation'];
  config: Pick<
    AutoRouterConfig,
    | 'dimensionWeights'
    | 'switchMargin'
  >;
}

export interface RoutingPolicyResult {
  decision: RoutingDecision;
  /**
   * The pool the decision was scored on. It differs from the input only
   * when the incumbent minimum thinking level replaced lower efforts of the
   * incumbent model, so chain keys can name a row the input does not have.
   */
  candidates: Candidate[];
  /** True when trajectory friction selected a stronger head pick. */
  trajectoryApplied: boolean;
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
  version: PolicyVersion,
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
  const picked = escalationChain(candidates, dimension, trajectory.fromModel, baseOpts, compareOpts, version);
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
 * Incumbent capability floor. The served model keeps serving one task: a
 * per-invocation rescore must not fall below the incumbent's known
 * capability at the routed dimension. Select the first already-scored chain
 * candidate that meets that minimum, which may be a cheaper model. An
 * incumbent filtered out for context or vision never enters the chain.
 * Missing measurements do not erase its measured capability minimum. A
 * measured minimum failure cannot displace a candidate without such a failure.
 */
function applyIncumbentModelFloor(
  decision: RoutingDecision,
  candidates: Candidate[],
  dimension: Dimension,
  incumbentRegistryId: string | undefined,
  skip: boolean,
): void {
  if (incumbentRegistryId == null || incumbentRegistryId === decision.chosen || skip) {
    return;
  }
  const incumbentCandidate = candidates.find((c) => candidateKey(c) === incumbentRegistryId);
  const chosenCandidate = candidates.find((c) => candidateKey(c) === decision.chosen);
  const incumbentInChain = decision.fallbackChain.indexOf(incumbentRegistryId);
  if (incumbentCandidate && chosenCandidate && incumbentInChain >= 0) {
    const incumbentQuality = capabilityForDimension(incumbentCandidate, dimension);
    const chosenQuality = capabilityForDimension(chosenCandidate, dimension);
    if (incumbentQuality != null && chosenQuality != null && incumbentQuality > chosenQuality) {
      const reasons = new Map((decision.candidateDiagnostics ?? []).map(d => [d.candidateKey, d.excludedReason]));
      const tier = (key: string): number => reasons.get(key) === 'unknown-quality' ? 1 : reasons.get(key) ? 2 : 0;
      const allowedTier = Math.max(1, tier(decision.chosen));
      const target = decision.fallbackChain.find((key) => {
        const candidate = candidates.find((c) => candidateKey(c) === key);
        const quality = candidate && capabilityForDimension(candidate, dimension);
        return tier(key) <= allowedTier && quality != null && quality >= incumbentQuality;
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

interface IncumbentEffort {
  model: string;
  effort: ModelThinkingLevel;
}

const effortRank = (effort: ModelThinkingLevel | undefined): number =>
  effort == null ? -1 : MODEL_THINKING_LEVELS.indexOf(effort);

/** The incumbent model and the effort its key says it served at. */
function incumbentEffortOf(incumbentRegistryId: string | undefined): IncumbentEffort | undefined {
  if (incumbentRegistryId == null) return undefined;
  const incumbent = parseCandidateKey(incumbentRegistryId);
  const effort = incumbent.effort as ModelThinkingLevel | undefined;
  if (effort == null || effort === 'off' || !MODEL_THINKING_LEVELS.includes(effort)) return undefined;
  return { model: `${incumbent.provider}/${incumbent.id}`, effort };
}

/**
 * Incumbent minimum thinking level, applied to the pool before scoring.
 * Delegation serves an entry of the incumbent model at the incumbent's
 * effort or higher, so the scorer must score the effort that will serve:
 * the quality, price, and time of a lower effort would choose an entry that
 * delegation then serves at another effort. A lower effort is dropped when a
 * row at the served effort exists. Without one, the nearest lower row takes
 * the served effort. The effort-specific axes are never estimated across
 * efforts, so that row reads them from a retained measurement at the served
 * effort, or counts them as unknown. Its other axes, price, and time stay at
 * the lower effort's values. Unlabelled rows keep their place: Pi's session
 * level serves them, and delegation raises it.
 */
function atIncumbentEffort(candidates: Candidate[], minimum: IncumbentEffort | undefined): Candidate[] {
  if (!minimum) return candidates;
  const labelled = candidates.filter((c) => c.registryId === minimum.model && c.reasoning && c.effort != null);
  const below = labelled.filter((c) => effortRank(c.effort) < effortRank(minimum.effort));
  if (below.length === 0) return candidates;
  const served = levelFrom(minimum.effort, below[0]!);
  if (served == null) return candidates;
  const hasServedRow = labelled.some((c) => c.effort === served);
  const nearest = below.reduce((a, b) => (effortRank(b.effort) > effortRank(a.effort) ? b : a));
  return candidates.flatMap((c) => {
    if (!below.includes(c)) return [c];
    if (hasServedRow || c !== nearest) return [];
    const exact = c.exactQualityByEffort?.[served];
    return [{
      ...c,
      effort: served,
      ...(c.bench ? {
        bench: {
          ...c.bench,
          effort: served,
          quality: {
            ...c.bench.quality,
            knowledge: exact?.knowledge,
            research: exact?.research,
            longContext: exact?.longContext,
            visionReasoning: exact?.visionReasoning,
          },
        },
      } : {}),
    }];
  });
}

/**
 * `key` when the policy can score the incumbent at it: a row has the key, or
 * the key names an effort above a labelled row of its model, which
 * `atIncumbentEffort` scores at that effort. Otherwise undefined.
 */
export function scoredIncumbentKey(candidates: readonly Candidate[], key: string): string | undefined {
  if (candidates.some((c) => candidateKey(c) === key)) return key;
  const minimum = incumbentEffortOf(key);
  if (!minimum) return undefined;
  return candidates.some((c) => c.registryId === minimum.model && c.reasoning && c.effort != null
    && effortRank(c.effort) < effortRank(minimum.effort))
    ? key
    : undefined;
}

/**
 * Record the incumbent minimum thinking level for delegation. It never
 * lowers effort and never changes the model or the task type, so it records
 * a reason but no DecisionCause. It is skipped on the same moves as the
 * incumbent capability minimum.
 */
function applyIncumbentEffort(
  decision: RoutingDecision,
  minimum: IncumbentEffort | undefined,
  raised: boolean,
): void {
  if (!minimum) return;
  const sameModel = (key: string): boolean => {
    const entry = parseCandidateKey(key);
    return `${entry.provider}/${entry.id}` === minimum.model;
  };
  if (!decision.fallbackChain.some(sameModel)) return;
  decision.incumbentEffort = minimum;
  const chosen = parseCandidateKey(decision.chosen).effort as ModelThinkingLevel | undefined;
  if (sameModel(decision.chosen) && (raised || effortRank(chosen) < effortRank(minimum.effort))) {
    addReasonDetail(decision, { kind: 'incumbent-effort' });
  }
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
  candidates: Candidate[],
  estimatedContextTokens: number,
  incumbentRegistryId: string | undefined,
): void {
  decision.dimension = dimension;
  // Cause names the mechanism that changed the task type; model preferences
  // and context-pressure advice belong in metadata, not a replacement cause.
  decision.cause = cause;
  const chosenCandidateForContext = candidates.find(
    (c) => candidateKey(c) === decision.chosen,
  );
  const chosenContextWindow = chosenCandidateForContext?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextUsageRatio = estimatedContextTokens / Math.max(1, chosenContextWindow);
  if (contextUsageRatio >= CONTEXT_PRESSURE_THRESHOLD) {
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
  }

  decision.switched = incumbentRegistryId != null && incumbentRegistryId !== decision.chosen;
}

// ─── Core function ───────────────────────────────────────────────────

/**
 * Resolve the routing dimension, cause, scoring, and decision metadata for
 * one provider invocation. Pure: reads only its inputs and returns a fresh
 * RoutingDecision; never reads or writes module-level state.
 */
export function resolveRoutingDecisionLegacy(input: RoutingPolicyInput): RoutingPolicyResult {
  return resolveWithPolicy(input, 'legacy');
}

/** The policy that production runs. */
export const resolveRoutingDecision = resolveRoutingDecisionLegacy;

/** The candidate policy. Only an evaluation process reaches it, through `evaluationPolicyVersion`. */
export function resolveRoutingDecisionCheapestSufficient(input: RoutingPolicyInput): RoutingPolicyResult {
  return resolveWithPolicy(input, 'cheapest-sufficient');
}

export function resolveRoutingDecisionForEvaluation(input: RoutingPolicyInput, version: PolicyVersion): RoutingPolicyResult {
  return version === 'cheapest-sufficient' ? resolveRoutingDecisionCheapestSufficient(input) : resolveRoutingDecisionLegacy(input);
}

function resolveWithPolicy(input: RoutingPolicyInput, version: PolicyVersion): RoutingPolicyResult {
  const {
    candidates,
    baseDimension,
    baseCause,
    trajectoryEscalation,
    userReasoning,
    userReasoningOverride,
    estimatedContextTokens,
    warmPrefixTokens,
    needsVision,
    incumbentRegistryId,
    sameIntentAsLast,
    config,
    handoffMinimum,
    handoffPending,
    workRelation,
  } = input;

  // The caller's base dimension and cause are the routed task type. Context
  // size never changes it: a token count cannot tell synthesis over gathered
  // material from a long session with a small question.
  const dimension: Dimension = baseDimension;
  let cause: DecisionCause = baseCause;

  const hasAnyBenchmark = candidates.some((candidate) => candidate.bench !== undefined);
  if (!hasAnyBenchmark && cause === 'heuristic') cause = 'no-data';

  // The minimums are skipped only for sanctioned moves: an applied trajectory
  // handoff owns the model (its repick excludes the source, so the floor must
  // not restore it); a handoff boundary until a model serves the new phase;
  // and a recorded move to other work at entry start. Cheap wording never counts
  // as a work change, and tool-loop invocations keep the serving model's
  // minimums even when the entry began as new work.
  const changedWork = !sameIntentAsLast &&
    (workRelation === 'new' || workRelation === 'resume' || workRelation === 'reopen' || workRelation === 'switch');
  const keepMinimums = !changedWork && handoffPending !== true;
  const minimumEffort = keepMinimums ? incumbentEffortOf(incumbentRegistryId) : undefined;
  const pool = atIncumbentEffort(candidates, minimumEffort);

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
    protocolPenalties: input.protocolPenalties,
  };
  const pickOpts: ScoreOpts = handoffMinimum != null
    ? { ...baseOpts, handoffMinimum }
    : baseOpts;
  let decision = pickBest(pool, dimension, config.dimensionWeights[dimension], pickOpts);

  // Objective trajectory friction may repick away from the source
  // model when scoring would keep it. An applied repick skips both incumbent
  // minimums, so it reads the input pool.
  const trajectory = applyTrajectoryRepick(
    decision,
    cause,
    candidates,
    dimension,
    trajectoryEscalation,
    baseOpts,
    { userReasoning, userReasoningOverride },
    version,
  );
  decision = trajectory.decision;
  cause = trajectory.cause;

  const skipIncumbentMinimums = trajectory.applied || !keepMinimums;

  // Incumbent capability minimum.
  applyIncumbentModelFloor(
    decision,
    pool,
    dimension,
    incumbentRegistryId,
    skipIncumbentMinimums,
  );

  // Incumbent minimum thinking level.
  if (!trajectory.applied) applyIncumbentEffort(decision, minimumEffort, pool !== candidates);

  // Metadata and reason suffixes.
  annotateDecision(
    decision,
    dimension,
    cause,
    pool,
    estimatedContextTokens,
    incumbentRegistryId,
  );

  if (version !== 'legacy') decision.policyVersion = version;
  return { decision, candidates: pool, trajectoryApplied: trajectory.applied };
}
