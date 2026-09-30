/**
 * Bounded task-type adoption for a categorical model verdict.
 *
 * Every structural limit on downward routing lives here, so this file is the
 * complete answer to "what can a context-handoff verdict do to a dimension?".
 * Pure: no I/O, no registry, no session state.
 *
 * Downward needs a higher bar than upward because `lightweight` is not
 * marginally cheaper — it skips the capability floor, disables thinking, and
 * runs cost-dominant weights. One wrong `lightweight` removes three
 * protections at once, so the verdict must be categorical (not `unknown`)
 * and its scope bounded before it can happen, and only ever by one tier.
 * No self-reported confidence enters: a model's certainty about its own
 * answer is not calibrated evidence.
 */
import type { Dimension, TaskScope } from '../../types.js';
import { DIMENSION_STRENGTH } from '../classify/classifier-keywords.js';
import { nextStrongerDimension, STRENGTH_ORDER } from './routing-policy.js';

export { nextStrongerDimension as oneTierAbove };

/**
 * Dimensions whose work mutates or verifies. A model's verdict may never
 * make this work cheaper.
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
  /** The keyword classifier's dimension. */
  heuristic: Dimension;
  /**
   * The unbumped keyword dimension before ambiguity/length route-up, if any.
   * A categorical bounded verdict may release the ambiguity bump down to
   * this raw dimension ONLY when ambiguityBumped is true.
   */
  rawHeuristic?: Dimension;
  /** True if the heuristic was bumped upward due to low confidence or prompt length. */
  ambiguityBumped?: boolean;
  /** The context handoff's kind and scope. Absent means unavailable. */
  assessment?: { kind: Dimension | 'unknown'; scope: TaskScope };
}

export interface AdoptionResult {
  dimension: Dimension;
  /**
   * True when the verdict moved the dimension. The caller maps this to a
   * decision cause; this module never invents a cause, so an unchanged
   * dimension keeps whatever cause already owned it.
   */
  changed: boolean;
}

export function adoptAssessment(input: AdoptionInput): AdoptionResult {
  const { heuristic, assessment } = input;
  const unchanged: AdoptionResult = { dimension: heuristic, changed: false };

  // Missing, failed, or UNKNOWN: the heuristic stands.
  if (!assessment || assessment.kind === 'unknown') return unchanged;

  const verdict = assessment.kind;
  const downwardPermitted =
    assessment.scope === 'bounded' &&
    !NEVER_ROUTE_DOWN_FROM.has(heuristic);

  // Ordinary downward routing drops at most one tier from the heuristic.
  // When the keyword classifier bumped the dimension due to low confidence or prompt length,
  // a bounded categorical verdict may also release that artificial bump down to rawHeuristic.
  // A heuristic raised for any other reason must never be dropped via rawHeuristic.
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
