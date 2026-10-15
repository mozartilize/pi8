/**
 * Decision compiler: the one owner that turns named feature vectors and the
 * authored weight policy into a numerical `DecisionProblem`. It owns feature
 * order and the tie policy; the optimizer receives numbers only.
 *
 * Tie order after the primary score: higher nonfinancial continuity, then a
 * known price before an unknown price, then lower central USD, then the
 * canonical action key.
 */
import { FEATURE_COUNT, FEATURE_INDEX, type ActionFeatureVector } from '../features/schema.js';
import type { Polytope } from './lp.js';
import type { DecisionProblem, NumericAction, NumericDomain, TieKey } from './minimax.js';
import { LP_RESIDUAL_TOLERANCE, THETA_BOUNDS } from './weights.js';

export interface SelectableAction {
  features: ActionFeatureVector;
  /** Central predicted USD of the next invocation, when the price is known. */
  centralUsd?: number;
}

const TIE_KEYS: readonly TieKey[] = Object.freeze([
  { direction: 'descending', tolerance: LP_RESIDUAL_TOLERANCE },
  { direction: 'ascending', tolerance: 1e-12 },
] as const);

export class DecisionProblemError extends Error {}

const frozenCopy = (values: readonly number[]): readonly number[] => Object.freeze([...values]);

function compileAction(action: SelectableAction): NumericAction {
  const { key, values, lower, upper } = action.features;
  for (const [name, vector] of [['values', values], ['lower', lower], ['upper', upper]] as const) {
    if (vector.length !== FEATURE_COUNT) throw new DecisionProblemError(`${key}: ${name} has ${vector.length} features, expected ${FEATURE_COUNT}`);
  }
  for (let j = 0; j < FEATURE_COUNT; j++) {
    const l = lower[j]!, c = values[j]!, u = upper[j]!;
    if (![l, c, u].every(Number.isFinite)) throw new DecisionProblemError(`${key}: feature ${j} is not finite`);
    if (!(0 <= l && l <= c && c <= u && u <= 1)) throw new DecisionProblemError(`${key}: feature ${j} interval [${l}, ${c}, ${u}] is not ordered in [0, 1]`);
  }
  if (action.centralUsd !== undefined && !Number.isFinite(action.centralUsd)) throw new DecisionProblemError(`${key}: central USD is not finite`);
  return Object.freeze({
    id: key,
    center: frozenCopy(values),
    lower: frozenCopy(lower),
    upper: frozenCopy(upper),
    ties: Object.freeze([values[FEATURE_INDEX.continuity]!, action.centralUsd]),
  });
}

/** Validate and copy the actions into one immutable numerical problem. */
export function compileDecisionProblem(actions: readonly SelectableAction[]): DecisionProblem {
  const compiled = actions.map(compileAction).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < compiled.length; i++) {
    if (compiled[i]!.id === compiled[i - 1]!.id) throw new DecisionProblemError(`duplicate action ${compiled[i]!.id}`);
  }
  return Object.freeze({
    dimension: FEATURE_COUNT,
    actions: Object.freeze(compiled),
    baseBounds: THETA_BOUNDS,
    tieKeys: TIE_KEYS,
    tolerance: LP_RESIDUAL_TOLERANCE,
  });
}

const isSimplexRow = (coeffs: readonly number[], dimension: number, lower?: number, upper?: number): boolean =>
  lower === 1 && upper === 1 && coeffs.every((value, j) => value === (j < dimension ? 1 : 0));

/**
 * Check that a domain fits the problem: theta columns first, every theta
 * bound retains or tightens the base bound, and the simplex row is present.
 * The closed-form base maximum and competitor pruning are exact only under
 * these conditions. A `base` domain is exactly the base bounds and the
 * simplex, with no other row or column.
 */
export function checkDomain(problem: DecisionProblem, domain: NumericDomain): void {
  const polytope: Polytope = domain.polytope;
  const { dimension, baseBounds, tolerance } = problem;
  if (polytope.numCols < dimension) throw new DecisionProblemError(`domain has ${polytope.numCols} columns, the problem has ${dimension} features`);
  if (polytope.colLower.length !== polytope.numCols || polytope.colUpper.length !== polytope.numCols) throw new DecisionProblemError('domain column bounds have the wrong length');
  if (polytope.rows.some((row) => row.coeffs.length !== polytope.numCols)) throw new DecisionProblemError('domain row has the wrong length');
  for (let j = 0; j < dimension; j++) {
    const lower = polytope.colLower[j];
    const upper = polytope.colUpper[j];
    const [baseLower, baseUpper] = baseBounds[j]!;
    if (lower === undefined || lower < baseLower - tolerance) throw new DecisionProblemError(`domain weight ${j} lower bound is below the base bound`);
    if (upper === undefined || upper > baseUpper + tolerance) throw new DecisionProblemError(`domain weight ${j} upper bound is above the base bound`);
  }
  if (!polytope.rows.some((row) => isSimplexRow(row.coeffs, dimension, row.lower, row.upper))) throw new DecisionProblemError('domain has no simplex row');
  if (domain.mode === 'base') {
    const exact = polytope.numCols === dimension && polytope.rows.length === 1
      && baseBounds.every(([lower, upper], j) => polytope.colLower[j] === lower && polytope.colUpper[j] === upper);
    if (!exact) throw new DecisionProblemError('base domain differs from the base bounds');
  }
}
