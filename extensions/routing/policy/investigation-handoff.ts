/**
 * Investigation → planning handoff: the `gather` counterpart of the
 * execution contract.
 *
 * A `gather` entry is scored for reading and summarizing: intelligence axis,
 * low thinking, and economic promotion. When its findings show that files
 * must change, the serving model calls `request_planning`, and from the next
 * invocation the entry routes as `plan`: a planning model decides the change,
 * makes it, or hands fully decided work to an executor through
 * `commit_execution`. The move is up-only, so it needs no contract; it stays
 * for the rest of the entry, including when a broken plan hands back to its
 * submitter.
 *
 * Pure state transitions only: no I/O, no registry or session access.
 */
import type { Dimension } from '../../types.js';
import type { WorkPhaseState } from './work-phase.js';

export const INVESTIGATION_HANDOFF_TOOL = 'request_planning';

/** Hand the rest of the entry to planning. */
export function acceptInvestigationHandoff(state: WorkPhaseState): WorkPhaseState {
  return state.planningRequested ? state : { ...state, planningRequested: true };
}

/** The entry's task type once its investigation handed off to planning. */
export function investigationDimension(state: WorkPhaseState | undefined, base: Dimension): Dimension {
  return state?.planningRequested && base === 'gather' ? 'plan' : base;
}
