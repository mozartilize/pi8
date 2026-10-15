import { partitionDecisionProblem, type SelectableAction } from '../routing/optimization/compile.js';
import type { DecisionProblem } from '../routing/optimization/minimax.js';

/** Numerical problem of test actions that are all valid; an invalid action fails the test. */
export function validProblem(actions: readonly SelectableAction[]): DecisionProblem {
  const { problem, invalid } = partitionDecisionProblem(actions);
  if (invalid.length > 0) throw new Error(`invalid test actions: ${invalid.map((entry) => entry.reason).join('; ')}`);
  return problem;
}
