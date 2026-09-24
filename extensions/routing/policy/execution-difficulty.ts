/**
 * Residual difficulty of an execution contract: the implement-axis ratio an
 * executor must reach before the router hands it the plan.
 *
 * The submitting model describes the remaining work on a fixed rubric; the
 * router, not the model, turns that description into a requirement, and adds
 * the facts it measures itself (plan size, target size, target history). No
 * input can make the requirement lower than its base, and an unscored or
 * unmeasured input counts as harder, never easier.
 *
 * The weights are hand-set. Every accepted contract logs its rubric, its
 * measurements, and its outcome, so the weights can be fitted to observed
 * results instead.
 *
 * Pure functions only: no I/O.
 */
import type { CapabilityBand, ExecutionRubric, MeasuredFeatures, RubricCriterion } from '../../types.js';

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
/** Value of a measurement that failed: halfway, so failure never cheapens. */
const UNMEASURED = 0.5;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Levels outside 1–5 or non-integers count as the hardest level. */
export function parseRubric(input: unknown): ExecutionRubric {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rubric = {} as ExecutionRubric;
  for (const criterion of RUBRIC_CRITERIA) {
    const level = record[criterion];
    rubric[criterion] = typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 5 ? level : 5;
  }
  return rubric;
}

function measuredTerms(measured: MeasuredFeatures): number[] {
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
