/**
 * Declared handoff rubrics. Every declaration of a task type uses the same
 * rubric: `hand_off_context` and `commit_execution` value
 * implementation work on the execution rubric, and planning or review on the
 * reasoning rubric.
 *
 * A rubric with no scored criterion is no rubric: selection uses declared
 * complexity bounds, or the unknown demand interval. An unscored criterion in
 * a partly scored rubric counts as the highest level the requester gave.
 *
 * Pure functions only: no I/O.
 */
import type {
  ExecutionRubric,
  HandoffRubric,
  HandoffTarget,
  ReasoningCriterion,
  ReasoningRubric,
  RubricCriterion,
} from '../../types.js';

export const RUBRIC_CRITERIA: readonly RubricCriterion[] = ['openDecisions', 'spread', 'verification', 'knowledge', 'coupling'];

/**
 * A declared rubric, or undefined when the requester scored no criterion:
 * then selection uses declared complexity bounds, or the unknown demand
 * interval. An unscored or
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

export const REASONING_CRITERIA: readonly ReasoningCriterion[] = ['alternatives', 'stakes', 'spread', 'knowledge', 'uncertainty'];

/** A declared reasoning rubric, read as {@link parseLevels} reads it. */
export function parseReasoningRubric(input: unknown): ReasoningRubric | undefined {
  return parseLevels(input, REASONING_CRITERIA);
}

/**
 * The rubric that a handoff declares for its target: the execution rubric
 * (`remainingWork`) for an implementation, the reasoning rubric
 * (`difficulty`) for a plan, review, or investigation. Undefined without a
 * scored criterion.
 */
export function declaredRubric(
  target: HandoffTarget,
  params: { difficulty?: unknown; remainingWork?: unknown } | undefined,
): HandoffRubric | undefined {
  return target === 'implement' ? parseRubric(params?.remainingWork) : parseReasoningRubric(params?.difficulty);
}

const TEST_PATH = /(^|[/\\])(tests?|__tests__)[/\\]|\.(test|spec)\.[^/\\]+$|_test\.[^/\\]+$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
