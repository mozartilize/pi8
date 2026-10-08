/**
 * Residual difficulty of a handoff: the requirement the next phase's model
 * must meet before the router hands it the work, as a share of each axis's
 * reference strength (`AXIS_REFERENCE` in scorer.ts). Every declaration of a
 * task type uses the same rubric: `hand_off_context`, `reopen_work`, and
 * `commit_execution` value implementation work on the execution rubric, and
 * planning or review on the reasoning rubric.
 *
 * The handing-off model describes the remaining work on a fixed rubric; the
 * router, not the model, turns that description into a requirement, and adds
 * the facts it measures itself (size and history of the files involved). No
 * input can make the requirement lower than its base. A rubric with no scored
 * criterion is no rubric: the default minimums of the task type apply. An
 * unscored criterion in a partly scored rubric counts as the highest level
 * the requester gave, and an unmeasured fact counts as harder, never easier.
 *
 * The weights are hand-set. Every accepted handoff logs its rubric, its
 * measurements, and its outcome, so the weights can be fitted to observed
 * results instead.
 *
 * Pure functions only: no I/O.
 */
import type {
  ExecutionRubric,
  HandoffRubric,
  HandoffTarget,
  MeasuredFeatures,
  ReasoningCriterion,
  ReasoningEvidence,
  ReasoningRubric,
  RubricCriterion,
} from '../../types.js';
import { FRONTIER_REQUIREMENT } from '../score/scorer.js';

export const RUBRIC_CRITERIA: readonly RubricCriterion[] = ['openDecisions', 'spread', 'verification', 'knowledge', 'coupling'];

/** Lowest requirement: the `economy` executor minimum. */
export const BASE_REQUIREMENT = 0.30;

/**
 * Added per `openDecisions` level. Open decisions are what a weaker executor
 * gets wrong, so this criterion dominates: level 5 (design choices remain)
 * alone exceeds the frontier requirement and keeps the submitter.
 */
const OPEN_DECISION_STEPS = [0, 0.10, 0.25, 0.42, 0.60] as const;
/** Maximum added by each other rubric criterion at level 5. */
const CRITERION_WEIGHT = 0.08;
/** Maximum added by each weighted measurement. */
const MEASURED_WEIGHT = 0.04;
/**
 * Value of a measurement that failed: the hardest, because the router cannot
 * show the fact is small, and any lower value could route a plan cheaper than
 * the same measurement would once it succeeds.
 */
const UNMEASURED = 1;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * A declared rubric, or undefined when the requester scored no criterion:
 * then the default minimums of the task type apply. Missing information
 * selects the default band. It buys evidence, not the frontier. An unscored or
 * invalid criterion in a partly scored rubric counts as the highest level the
 * requester gave, so it never lowers what was declared.
 */
function parseLevels<C extends string>(input: unknown, criteria: readonly C[]): Record<C, number> | undefined {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const valid = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;
  const scored = criteria.map((criterion) => record[criterion]).filter(valid);
  if (scored.length === 0) return undefined;
  const fill = Math.max(...scored);
  const rubric = {} as Record<C, number>;
  for (const criterion of criteria) {
    const value = record[criterion];
    rubric[criterion] = valid(value) ? value : fill;
  }
  return rubric;
}

/** A declared execution rubric, read as {@link parseLevels} reads it. */
export function parseRubric(input: unknown): ExecutionRubric | undefined {
  return parseLevels(input, RUBRIC_CRITERIA);
}

type WeightedFacts = Pick<MeasuredFeatures, 'files' | 'directories' | 'existingLines' | 'fixCommits'>;

function measuredTerms(measured: WeightedFacts): number[] {
  const known = (value: number | undefined, scale: (v: number) => number) =>
    value == null ? UNMEASURED : clamp01(scale(value));
  return [
    clamp01((measured.files - 1) / 4),
    clamp01((measured.directories - 1) / 3),
    // Up to 250 existing lines adds nothing; 4,000 or more adds the maximum.
    known(measured.existingLines, (lines) => Math.log2(Math.max(lines, 1) / 250) / 4),
    known(measured.fixCommits, (fixes) => fixes / 5),
  ];
}

/**
 * Implementation requirement, in [BASE_REQUIREMENT, 1], an executor must meet.
 * The facts are the measured targets of a plan, or the evidence of a handoff.
 * Evidence that is not applicable (no file backs the handoff) adds nothing.
 */
export function executionRequirement(rubric: ExecutionRubric, measured: MeasuredFeatures | ReasoningEvidence): number {
  const rubricTerm = OPEN_DECISION_STEPS[rubric.openDecisions - 1]! +
    RUBRIC_CRITERIA
      .filter((criterion) => criterion !== 'openDecisions')
      .reduce((sum, criterion) => sum + CRITERION_WEIGHT * (rubric[criterion] - 1) / 4, 0);
  const measuredTerm = 'applicable' in measured && !measured.applicable
    ? 0
    : measuredTerms(measured).reduce((sum, term) => sum + MEASURED_WEIGHT * term, 0);
  return Math.min(1, BASE_REQUIREMENT + rubricTerm + measuredTerm);
}

export const REASONING_CRITERIA: readonly ReasoningCriterion[] = ['alternatives', 'stakes', 'spread', 'knowledge', 'uncertainty'];

/** Lowest reasoning requirement: the cheapest thinking-capable planner clears it. */
export const REASONING_BASE_REQUIREMENT = 0.40;

/**
 * Added per `alternatives` level. Choosing between designs is what a weaker
 * planner gets wrong, so this criterion dominates. The levels sit on the price
 * steps of a dense pool: an obvious approach stays with the cheapest capable
 * models, a behaviour or interface choice (level 4) needs a mid-price one, and
 * a real design decision (level 5) reaches the frontier requirement.
 */
const ALTERNATIVE_STEPS = [0, 0.06, 0.18, 0.34, 0.46] as const;
/** Maximum added by each other reasoning criterion at level 5. */
const REASONING_CRITERION_WEIGHT = 0.08;
/** Maximum added by each weighted measurement. */
const REASONING_MEASURED_WEIGHT = 0.03;

/** A declared reasoning rubric, read as {@link parseLevels} reads it. */
export function parseReasoningRubric(input: unknown): ReasoningRubric | undefined {
  return parseLevels(input, REASONING_CRITERIA);
}

/**
 * Plan or review requirement, in [REASONING_BASE_REQUIREMENT, 1], the
 * reasoning phase needs. Evidence that is not applicable (no file backs the
 * handoff) adds nothing; applicable evidence whose measurement failed adds
 * the maximum.
 */
export function reasoningRequirement(rubric: ReasoningRubric, evidence: ReasoningEvidence): number {
  const rubricTerm = ALTERNATIVE_STEPS[rubric.alternatives - 1]! +
    REASONING_CRITERIA
      .filter((criterion) => criterion !== 'alternatives')
      .reduce((sum, criterion) => sum + REASONING_CRITERION_WEIGHT * (rubric[criterion] - 1) / 4, 0);
  const measuredTerm = evidence.applicable
    ? measuredTerms(evidence).reduce((sum, term) => sum + REASONING_MEASURED_WEIGHT * term, 0)
    : 0;
  return Math.min(1, REASONING_BASE_REQUIREMENT + rubricTerm + measuredTerm);
}

/** The requirement as a handoff minimum: never above what an ordinary plan asks. */
export function reasoningMinimum(requirement: number): number {
  return Math.min(requirement, FRONTIER_REQUIREMENT);
}

/**
 * The rubric and requirement that a handoff declares for its target: the
 * execution rubric (`remainingWork`) for an implementation, the reasoning
 * rubric (`difficulty`) for a plan or review. Both are undefined without a
 * scored criterion.
 */
export function declaredRequirement(
  target: HandoffTarget,
  params: { difficulty?: unknown; remainingWork?: unknown } | undefined,
  evidence: ReasoningEvidence,
): { rubric?: HandoffRubric; requirement?: number } {
  if (target === 'implement') {
    const rubric = parseRubric(params?.remainingWork);
    return rubric ? { rubric, requirement: executionRequirement(rubric, evidence) } : {};
  }
  const rubric = parseReasoningRubric(params?.difficulty);
  return rubric ? { rubric, requirement: reasoningRequirement(rubric, evidence) } : {};
}

export { bandForRequirement } from '../score/scorer.js';

const TEST_PATH = /(^|[/\\])(tests?|__tests__)[/\\]|\.(test|spec)\.[^/\\]+$|_test\.[^/\\]+$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
