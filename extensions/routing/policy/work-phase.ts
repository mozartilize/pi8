import { createHash } from 'node:crypto';
import type { Dimension, ReasoningHandoffMeta } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';
import type { ContextReason, EntryResolution } from '../context/types.js';
import type { ContextStatus } from './context-acquisition.js';
import type { ChangeFactsState, CheckVerdicts } from './change-facts.js';
import type { GroundedArtifact } from '../context/types.js';
import type { PendingIdentity } from '../../serve/context-resolution.js';
import type { BoundaryAuthorizationV1 } from './boundary-authorization.js';
import type { ExecutionFlowState } from './execution-flow.js';

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
export interface WorkPhaseState {
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
  /** Handoff of the entry before this one, joined to this entry's records. */
  previousHandoffId?: string;
  /** Where collecting context stands for the entry; absent until an invocation routes it. */
  status?: ContextStatus;
  /** Bounded choice set while this entry's work identity is not yet known. */
  pendingIdentity?: PendingIdentity;
  /** Complete reads made before work identity was chosen; entry-local and never inherited. */
  provisionalGrounding?: GroundedArtifact[];
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
  /** The entry's work-context resolution; set once per entry. */
  contextResolution?: EntryResolution;
  /** Work item the entry resolved to, when it resolved to one. */
  workItemId?: string;
  /** Context the entry's request owes; fixed when it resolved. */
  contextReasons?: ContextReason[];
  /** Router-checked when the entry resolved; fixed for the rest of the entry. */
  contextSatisfied?: boolean;
  /**
   * The model of this completed work item serves the entry first. It may
   * answer about the completed work, but changes nothing until it reopens
   * the item or hands off; either boundary clears this. Entry-local.
   */
  priorCompletion?: { workItemId: string };
  /** The entry completed its work item; no change runs for the rest of the entry until a reopen. */
  completion?: { workItemId: string; status: 'done' | 'superseded' };
  /** This entry already got its one settle reminder to call hand_off_context. */
  contextSettleReminded?: boolean;
  /** This entry already got its one settle reminder to call complete_work. */
  completionSettleReminded?: boolean;
  /** The outcome of this entry's settle reminders was logged. */
  settleOutcomeLogged?: boolean;
}

/**
 * What an entry leaves to a branch it is not on, after `/tree`: `deliverable`
 * as the task type. It establishes no work identity. Strikes, excluded
 * executors, contracts, handoffs, and context-collection state belong to the
 * entries of the branch Pi left.
 */
export function carryAcrossBranch(state: WorkPhaseState, deliverable: Dimension | undefined): WorkPhaseState {
  return {
    intentKey: state.intentKey,
    ...(deliverable ? { deliverable } : {}),
    providerInvocation: state.providerInvocation,
    observedMutationTools: 0,
  };
}

export function nextProviderInvocation(state: WorkPhaseState): WorkPhaseState {
  return { ...state, providerInvocation: state.providerInvocation + 1 };
}
