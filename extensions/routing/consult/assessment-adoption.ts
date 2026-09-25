/**
 * Adoption semantics for a router-agent assessment.
 *
 * Every structural limit on downward routing lives here, so this file is the
 * complete answer to "what can the assessment do to a dimension?". Pure: no
 * I/O, no registry, no session state.
 *
 * Downward needs a higher bar than upward because `lightweight` is not
 * marginally cheaper — it skips the capability floor, disables thinking, and
 * runs cost-dominant weights. One wrong `lightweight` removes three
 * protections at once, so two independent fields must agree before it can
 * happen, and only ever by one tier.
 */
import type { Dimension, RoutingAssessment } from '../../types.js';
import { DIMENSION_STRENGTH } from '../classify/classifier-keywords.js';
import { nextStrongerDimension, STRENGTH_ORDER } from '../policy/routing-policy.js';

export { nextStrongerDimension as oneTierAbove };

/**
 * Dimensions whose work mutates or verifies. A model's self-report may never
 * make this work cheaper, at any confidence, in any profile.
 */
const NEVER_ROUTE_DOWN_FROM: ReadonlySet<Dimension> = new Set<Dimension>([
  'implement',
  'review',
]);

export function oneTierBelow(dimension: Dimension): Dimension {
  const prev = Math.max(DIMENSION_STRENGTH[dimension] - 1, 0);
  return STRENGTH_ORDER[prev]!;
}

function stronger(a: Dimension, b: Dimension): Dimension {
  return DIMENSION_STRENGTH[a] >= DIMENSION_STRENGTH[b] ? a : b;
}

export interface AdoptionInput {
  /** The keyword classifier's dimension, `H` in the spec. */
  heuristic: Dimension;
  /**
   * The unbumped keyword dimension before ambiguity/length route-up, if any.
   * A high-confidence bounded assessment may release the ambiguity bump down
   * to this raw floor ONLY when ambiguityBumped is true.
   */
  rawHeuristic?: Dimension;
  /** True if the heuristic was bumped upward due to low confidence or prompt length. */
  ambiguityBumped?: boolean;
  /** The assessor's verdict, `A`. Absent means unavailable. */
  assessment?: RoutingAssessment;
}

export interface AdoptionResult {
  dimension: Dimension;
  /**
   * True when the assessment moved the dimension. The caller maps this to
   * cause `router-consult`; this module never invents a cause, so an
   * unchanged dimension keeps whatever cause already owned it (including
   * `continuation-context`).
   */
  changed: boolean;
}

export function adoptAssessment(input: AdoptionInput): AdoptionResult {
  const { heuristic, assessment } = input;
  const unchanged: AdoptionResult = { dimension: heuristic, changed: false };

  if (!assessment) return unchanged;

  const verdict = assessment.kind;

  if (assessment.confidence === 'low') {
    // Uncertainty is monotonically non-decreasing against the heuristic:
    // a low-confidence lightweight verdict must never pull a plan down.
    const raised = stronger(heuristic, nextStrongerDimension(verdict));
    return { dimension: raised, changed: raised !== heuristic };
  }

  const downwardPermitted =
    assessment.confidence === 'high' &&
    assessment.scope === 'bounded' &&
    !NEVER_ROUTE_DOWN_FROM.has(heuristic);

  // Ordinary downward routing drops at most one tier from the heuristic.
  // When the keyword classifier bumped the dimension due to low confidence or prompt length,
  // a high-confidence bounded assessment may also release that artificial bump down to rawHeuristic.
  // Unrelated promotions (such as embedding classifier promotions) must never be dropped via rawHeuristic.
  let floor = downwardPermitted ? oneTierBelow(heuristic) : heuristic;
  if (
    downwardPermitted &&
    input.ambiguityBumped &&
    input.rawHeuristic &&
    DIMENSION_STRENGTH[input.rawHeuristic] < DIMENSION_STRENGTH[floor]
  ) {
    floor = input.rawHeuristic;
  }
  const adopted = stronger(floor, verdict);
  return { dimension: adopted, changed: adopted !== heuristic };
}
