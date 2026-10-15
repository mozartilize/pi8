/**
 * Authored weight domain v1. `ThetaBase` is the simplex plus these bounds.
 * `THETA0` is the deterministic fallback and tie-break point only; it does
 * not shrink the admissible domain and is not a neutral user preference.
 * These constants were not inferred from benchmark data. A change to them
 * changes how stored v1 answers constrain the domain, so it requires an
 * explicit policy revision.
 */
import { digestOf } from '../digest.js';
import { FEATURE_COUNT, FEATURE_SCHEMA_DIGEST } from '../features/schema.js';

// [reasoning, agentic, research, input, cost, time,
//  continuity, friction, effortRecovery, modelSwitchRecovery]
export const THETA0: readonly number[] = [0.17, 0.2, 0.08, 0.05, 0.3, 0.05, 0.09, 0.04, 0.01, 0.01];

export const THETA_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 0.45], [0, 0.45], [0, 0.3], [0, 0.25],
  [0.08, 0.55], [0, 0.2], [0, 0.3], [0, 0.25],
  [0, 0.3], [0, 0.3],
];

/** Utility margin of an A/B answer. */
export const CHOICE_MARGIN = 0.005;
/** Half-width of an `equivalent` band. */
export const EQUIVALENT_TOLERANCE = 0.005;
/** Equal slack penalty of every answer when answers are jointly unrepresentable. */
export const UNIFORM_CONFLICT_SLACK_PENALTY = 1;
export { LP_RESIDUAL_TOLERANCE } from './lp.js';

export const THETA_BASE_DIGEST = digestOf({
  featureSchema: FEATURE_SCHEMA_DIGEST,
  bounds: THETA_BOUNDS,
  anchor: THETA0,
});

if (THETA0.length !== FEATURE_COUNT || THETA_BOUNDS.length !== FEATURE_COUNT) {
  throw new Error('weight domain does not match the feature schema');
}
