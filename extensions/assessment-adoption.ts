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
import type { AssessmentMode, Dimension, RoutingAssessment } from './types.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';
import { nextStrongerDimension, STRENGTH_ORDER } from './routing-policy.js';

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
  /** The assessor's verdict, `A`. Absent means unavailable. */
  assessment?: RoutingAssessment;
  mode: AssessmentMode;
  /** True once depth escalation has engaged for this session. */
  latchEngaged: boolean;
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
  const { heuristic, assessment, mode, latchEngaged } = input;
  const unchanged: AdoptionResult = { dimension: heuristic, changed: false };

  // Shadow must be byte-identical to the deterministic path. The verdict is
  // recorded as a counterfactual by the caller and has no effect here.
  if (mode !== 'active') return unchanged;
  if (!assessment) return unchanged;

  const verdict = assessment.dimension;

  if (assessment.confidence === 'low') {
    // Uncertainty is monotonically non-decreasing against the heuristic:
    // a low-confidence lightweight verdict must never pull a plan down.
    const raised = stronger(heuristic, nextStrongerDimension(verdict));
    return { dimension: raised, changed: raised !== heuristic };
  }

  const downwardPermitted =
    assessment.confidence === 'high' &&
    assessment.scope === 'bounded' &&
    !NEVER_ROUTE_DOWN_FROM.has(heuristic) &&
    // While the latch is engaged the only legal refusal is the veto at the
    // transition itself, which is a refusal to escalate, not an escalation
    // in reverse.
    !latchEngaged;

  const floor = downwardPermitted ? oneTierBelow(heuristic) : heuristic;
  const adopted = stronger(floor, verdict);
  return { dimension: adopted, changed: adopted !== heuristic };
}

/**
 * The depth latch fires on a token counter, which cannot tell "synthesizing
 * over gathered material" from "long session, small question". A high-
 * confidence bounded verdict is the only evidence strong enough to refuse it,
 * and every other outcome — including unavailability — escalates as today.
 */
export function shouldVetoLatch(assessment: RoutingAssessment | undefined): boolean {
  if (!assessment) return false;
  return assessment.confidence === 'high' && assessment.scope === 'bounded';
}
