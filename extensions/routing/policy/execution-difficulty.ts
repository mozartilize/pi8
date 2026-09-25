/**
 * Residual difficulty of a handoff: the task-axis ratio the next phase's
 * model must reach before the router hands it the work. An execution
 * contract values its remaining implementation; an investigation handoff
 * values the planning or review it leaves.
 *
 * The handing-off model describes the remaining work on a fixed rubric; the
 * router, not the model, turns that description into a requirement, and adds
 * the facts it measures itself (size and history of the files involved). No
 * input can make the requirement lower than its base, and an unscored or
 * unmeasured input counts as harder, never easier.
 *
 * The weights are hand-set. Every accepted handoff logs its rubric, its
 * measurements, and its outcome, so the weights can be fitted to observed
 * results instead.
 *
 * Pure functions only: no I/O.
 */
import type {
  CapabilityBand,
  ExecutionRubric,
  MeasuredFeatures,
  ReasoningCriterion,
  ReasoningEvidence,
  ReasoningRubric,
  RubricCriterion,
} from '../../types.js';
import { FRONTIER_QUALITY_RATIO } from '../score/scorer.js';

export const RUBRIC_CRITERIA: readonly RubricCriterion[] = ['openDecisions', 'spread', 'verification', 'knowledge', 'coupling'];

/** Lowest requirement: the `economy` executor minimum. */
export const BASE_REQUIREMENT = 0.30;

/**
 * Added per `openDecisions` level. Open decisions are what a weaker executor
 * gets wrong, so this criterion dominates: level 5 (design choices remain)
 * alone exceeds the frontier ratio and keeps the submitter.
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

function parseLevels<C extends string>(input: unknown, criteria: readonly C[]): Record<C, number> {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rubric = {} as Record<C, number>;
  for (const criterion of criteria) {
    const level = record[criterion];
    rubric[criterion] = typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 5 ? level : 5;
  }
  return rubric;
}

/** Levels outside 1–5 or non-integers count as the hardest level. */
export function parseRubric(input: unknown): ExecutionRubric {
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

/** Implement-axis ratio, in [BASE_REQUIREMENT, 1], an executor must reach. */
export function executionRequirement(rubric: ExecutionRubric, measured: MeasuredFeatures): number {
  const rubricTerm = OPEN_DECISION_STEPS[rubric.openDecisions - 1]! +
    RUBRIC_CRITERIA
      .filter((criterion) => criterion !== 'openDecisions')
      .reduce((sum, criterion) => sum + CRITERION_WEIGHT * (rubric[criterion] - 1) / 4, 0);
  const measuredTerm = measuredTerms(measured).reduce((sum, term) => sum + MEASURED_WEIGHT * term, 0);
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
 * a real design decision (level 5) reaches the frontier ratio.
 */
const ALTERNATIVE_STEPS = [0, 0.06, 0.18, 0.34, 0.46] as const;
/** Maximum added by each other reasoning criterion at level 5. */
const REASONING_CRITERION_WEIGHT = 0.08;
/** Maximum added by each weighted measurement. */
const REASONING_MEASURED_WEIGHT = 0.03;

/** Levels outside 1–5 or non-integers count as the hardest level. */
export function parseReasoningRubric(input: unknown): ReasoningRubric {
  return parseLevels(input, REASONING_CRITERIA);
}

/**
 * Plan- or review-axis ratio, in [REASONING_BASE_REQUIREMENT, 1], the
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

/** The requirement as a tier-0 ratio: never above what an ordinary plan asks. */
export function reasoningMinimum(requirement: number): number {
  return Math.min(requirement, FRONTIER_QUALITY_RATIO);
}

/** Band whose executor minimum covers `requirement`; `frontier` keeps the submitter. */
export function bandForRequirement(requirement: number): CapabilityBand {
  if (requirement < 0.45) return 'economy';
  if (requirement < 0.70) return 'standard';
  if (requirement < 0.85) return 'strong';
  return 'frontier';
}

const TEST_PATH = /(^|[/\\])(tests?|__tests__)[/\\]|\.(test|spec)\.[^/\\]+$|_test\.[^/\\]+$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
