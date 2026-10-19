/**
 * Execution flow: the scope of executor strikes and exclusions.
 *
 * A flow starts when `hand_off_context(ready, implement)` is accepted. A
 * second accepted implement handoff in the same entry reuses the flow, so
 * the strikes of the first attempt still count. Plan revisions and the
 * hand-back from an executor to its submitter keep the flow. A flow is never
 * persisted. It reaches the next genuine user entry only when that entry's
 * first accepted implement handoff declares `continuesFlow: true`.
 *
 * Strikes and exclusions are keyed by the canonical `provider/model`. Effort
 * is not part of the identity.
 */
import { randomUUID } from 'node:crypto';

export interface ExecutionFlowState {
  flowId: string;
  originEntryId: string;
  originBoundaryId: string;
  /** Contract strikes per canonical `provider/model`. */
  strikesByModel: Record<string, number>;
  /** Served keys of executor models that reached the strike limit. */
  excludedModels: string[];
}

export function newExecutionFlow(originEntryId: string, originBoundaryId: string): ExecutionFlowState {
  return { flowId: randomUUID(), originEntryId, originBoundaryId, strikesByModel: {}, excludedModels: [] };
}

/** A flow with a strike or an exclusion has evidence that a later entry can continue. */
export function flowHasEvidence(flow: ExecutionFlowState | undefined): flow is ExecutionFlowState {
  return flow !== undefined && (Object.keys(flow.strikesByModel).length > 0 || flow.excludedModels.length > 0);
}
