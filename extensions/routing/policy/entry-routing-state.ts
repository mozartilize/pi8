import { createHash } from 'node:crypto';
import type { Dimension, ReasoningHandoffMeta, RoutingScopeMeta } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';
import type { ContextStatus } from './context-acquisition.js';
import type { ChangeFactsState, CheckVerdicts } from './change-facts.js';
import type { BoundaryAuthorizationV1 } from './boundary-authorization.js';
import type { ExecutionFlowState } from './execution-flow.js';
import type { EntryEvidenceState } from '../../serve/entry-evidence.js';

/** Stable boundary id of an entry's triage. */
export function triageBoundaryId(sourceEntryId: string, routingEpoch: number): string {
  return `triage:${sourceEntryId}:${routingEpoch}`;
}

/**
 * Boundary id of an accepted ready handoff. The same accepted payload again
 * gives the same id; a different payload gives a different one.
 */
export function handoffBoundaryId(sourceEntryId: string, routingEpoch: number, handoffKey: string): string {
  const digest = createHash('sha256').update(handoffKey).digest('hex').slice(0, 16);
  return `handoff:${sourceEntryId}:${routingEpoch}:${digest}`;
}

/** Per-entry routing state: the entry's task type and its explicit handoffs. */
export interface EntryRoutingState {
  intentKey: string;
  /** Session entry id of the genuine user entry; the intent key when Pi gives none. */
  sourceEntryId?: string;
  /** Routing epoch when the entry started; an entry of another epoch has no authority. */
  routingEpoch?: number;
  /** Routing boundary of the entry: its triage, or its latest accepted ready handoff. */
  boundaryId?: string;
  /** Task type declared at the handoff; new entries start as gather. */
  deliverable?: Dimension;
  providerInvocation: number;
  /** Mutation calls observed in this entry; drives the `editing` status only. */
  observedMutationTools: number;
  /** Plan/review → implement handoff for this entry; never inherited. */
  contract?: ExecutionContract;
  /** Strike and exclusion scope of this entry's implementation; never persisted. */
  executionFlow?: ExecutionFlowState;
  /** The entry's flow has been transferred or discarded at settlement. */
  flowClosed?: boolean;
  /** Source observations and coverage belong only to this entry. */
  evidence?: EntryEvidenceState;
  sourceEvidencePending?: boolean;
  sourceSettleAttempts?: number;
  /** The one handoff reminder for this entry was already appended. */
  contractReminded?: boolean;
  /** Files the entry's tools looked at, most recent first; router-observed, never inherited. */
  readPaths?: string[];
  /** Reads with `offset` or `limit` before the entry's handoff; router-observed, never inherited. */
  partialReadCount?: number;
  /** Context → planning/review handoff for this entry; never inherited. */
  reasoningHandoff?: ReasoningHandoffMeta;
  /** Permissions for the current routing boundary, task type and provider assignment. */
  boundaryAuthorization?: BoundaryAuthorizationV1;
  /** Facts declared at this entry's accepted handoff, and their log record; never inherited. */
  changeFacts?: ChangeFactsState;
  /** Verifier results this entry observed, before and after its handoff; never inherited. */
  checkVerdicts?: CheckVerdicts;
  /** Acquisition and boundary status of this entry. */
  status?: ContextStatus;
  /** Collect provider requests so far, fallback attempts included. */
  contextRequests?: number;
  /** Rejected handoffs and refused calls, counted once per provider invocation. */
  contextDenials?: number;
  /** Provider invocation whose refusal was last counted. */
  deniedAtInvocation?: number;
  /** The entry's one clarification request was dispatched. */
  clarificationDispatched?: boolean;
  /** The model handed the request back to the user; other paths to clarification-only are refusals or the budget. */
  contextNeedsUser?: boolean;
  /** Normalized payload of the accepted handoff; the same payload again is idempotent. */
  handoffKey?: string;
  /** The one acquisition reminder for this entry was already appended. */
  contextReminded?: boolean;
  /** The entry's acquisition outcome was logged. */
  contextClosed?: boolean;
  /** This entry already got its one settle reminder to call hand_off_context. */
  contextSettleReminded?: boolean;
  /** The outcome of this entry's settle reminders was logged. */
  settleOutcomeLogged?: boolean;
}

/** Diagnostic scope only. This value does not grant routing or mutation authority. */
export function entryRoutingScope(state: EntryRoutingState | undefined): RoutingScopeMeta | undefined {
  if (!state?.boundaryId) return undefined;
  const authorization = state.boundaryAuthorization;
  return {
    entryId: state.sourceEntryId ?? state.intentKey,
    boundaryId: state.boundaryId,
    ...(authorization?.boundaryId === state.boundaryId ? {
      assignmentId: authorization.assignmentId, authorizationRevision: authorization.revision,
    } : {}),
    ...(state.executionFlow ? { flowId: state.executionFlow.flowId } : {}),
  };
}

export function nextProviderInvocation(state: EntryRoutingState): EntryRoutingState {
  return { ...state, providerInvocation: state.providerInvocation + 1 };
}
