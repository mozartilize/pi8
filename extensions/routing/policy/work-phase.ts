import type { Dimension, ReasoningHandoffMeta } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';
import type { ContextReason, EntryResolution, ExecutorPenalties } from '../context/types.js';
import type { ContextStatus } from './context-acquisition.js';
import type { ChangeFactsState, CheckVerdicts } from './change-facts.js';
import type { GroundedArtifact } from '../context/types.js';
import type { PendingIdentity } from '../../serve/context-resolution.js';
import { parseCandidateKey } from '../score/scorer.js';
import type { BoundaryAuthorizationV1 } from './boundary-authorization.js';

/** Execution penalties of one work item, carried until an entry continues it. */
export interface PriorWork {
  workItemId: string;
  contractStrikes?: Record<string, number>;
  excludedExecutors?: string[];
}

/** Per-entry routing state: the entry's task type and its explicit handoffs. */
export interface WorkPhaseState {
  intentKey: string;
  /** Task type declared at the handoff, or the incumbent's last served task type. */
  deliverable?: Dimension;
  providerInvocation: number;
  /** Mutation calls observed in this entry; drives the `editing` status only. */
  observedMutationTools: number;
  /** Plan/review → implement handoff for this entry; never inherited. */
  contract?: ExecutionContract;
  /** Contract breaks per executor model id, kept across entries on the same work item. */
  contractStrikes?: Record<string, number>;
  /** Served keys of executor models that reached the strike limit. */
  excludedExecutors?: string[];
  /** The previous work item's penalties, applied only if this entry's handoff continues that item. */
  priorWork?: PriorWork;
  /** The one handoff reminder for this entry was already appended. */
  contractReminded?: boolean;
  /** Files the entry's tools looked at, most recent first; router-observed, never inherited. */
  readPaths?: string[];
  /** Reads with `offset` or `limit` before the entry's handoff; router-observed, never inherited. */
  partialReadCount?: number;
  /** Context → planning/review handoff for this entry; never inherited. */
  reasoningHandoff?: ReasoningHandoffMeta;
  /** Permissions for the current work item, phase and provider assignment. */
  boundaryAuthorization?: BoundaryAuthorizationV1;
  /** Facts declared at this entry's accepted handoff, and their log record; never inherited. */
  changeFacts?: ChangeFactsState;
  /** Verifier results this entry observed, before and after its handoff; never inherited. */
  checkVerdicts?: CheckVerdicts;
  /** Handoff of the entry before this one, joined to this entry's records. */
  previousHandoffId?: string;
  /** Where collecting context stands for the entry; absent until an invocation routes it. */
  contextStatus?: ContextStatus;
  /** A gathering model declared the type of its direct answer; it remains in gathering. */
  contextAnswer?: 'gather' | 'lightweight';
  /** An incumbent was serving when this entry arrived: it serves the entry, which collects no context. */
  incumbentServes?: boolean;
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

/**
 * The penalties a later entry takes over when its handoff continues this
 * entry's work item. An entry placed on no work item passes on the ones it
 * received, so a run of entries that never hand off does not drop them.
 */
export function penaltiesOf(state: WorkPhaseState): PriorWork | undefined {
  if (!state.workItemId) return state.priorWork;
  if (!state.contractStrikes && !state.excludedExecutors) return undefined;
  return {
    workItemId: state.workItemId,
    ...(state.contractStrikes ? { contractStrikes: state.contractStrikes } : {}),
    ...(state.excludedExecutors ? { excludedExecutors: state.excludedExecutors } : {}),
  };
}

/** The execution penalties that `state` holds. */
export function statePenalties(state: WorkPhaseState): ExecutorPenalties {
  return { strikes: state.contractStrikes ?? {}, excluded: state.excludedExecutors ?? [] };
}

const modelId = (key: string): string => parseCandidateKey(key).id;

/** Penalties never shrink: the higher strike count and every excluded model of either side. */
export function mergePenalties(a: ExecutorPenalties, b: ExecutorPenalties): ExecutorPenalties {
  const strikes = { ...a.strikes };
  for (const [id, count] of Object.entries(b.strikes)) strikes[id] = Math.max(strikes[id] ?? 0, count);
  const excluded = [...a.excluded];
  for (const key of b.excluded) {
    if (!excluded.some((known) => modelId(known) === modelId(key))) excluded.push(key);
  }
  return { strikes, excluded };
}

export function samePenalties(a: ExecutorPenalties, b: ExecutorPenalties): boolean {
  const ids = Object.keys(a.strikes);
  return ids.length === Object.keys(b.strikes).length && ids.every((id) => a.strikes[id] === b.strikes[id])
    && a.excluded.length === b.excluded.length && a.excluded.every((key) => b.excluded.some((other) => modelId(other) === modelId(key)));
}

/** `state` with the penalties its work item holds on the branch; the same object when it adds none. */
export function withBranchPenalties(state: WorkPhaseState, branch: ExecutorPenalties | undefined): WorkPhaseState {
  if (!branch) return state;
  const current = statePenalties(state);
  const merged = mergePenalties(current, branch);
  if (samePenalties(merged, current)) return state;
  return {
    ...state,
    ...(Object.keys(merged.strikes).length > 0 ? { contractStrikes: merged.strikes } : {}),
    ...(merged.excluded.length > 0 ? { excludedExecutors: merged.excluded } : {}),
  };
}

/** `state` with exactly the penalties its work item holds on the branch; the same object when they match. */
export function withExactBranchPenalties(state: WorkPhaseState, branch: ExecutorPenalties | undefined): WorkPhaseState {
  const current = statePenalties(state);
  const target = branch ?? { strikes: {}, excluded: [] };
  if (samePenalties(current, target)) return state;
  const { contractStrikes: _strikes, excludedExecutors: _excluded, ...rest } = state;
  return {
    ...rest,
    ...(Object.keys(target.strikes).length > 0 ? { contractStrikes: target.strikes } : {}),
    ...(target.excluded.length > 0 ? { excludedExecutors: target.excluded } : {}),
  };
}

/**
 * Take over the previous work item's penalties when the entry continues or
 * reopens that same item; nothing else crosses.
 */
export function withContinuedPenalties(
  state: WorkPhaseState,
  workItemId: string | undefined,
  relation: string,
): WorkPhaseState {
  const prior = state.priorWork;
  if (!prior || prior.workItemId !== workItemId || (relation !== 'continue' && relation !== 'reopen')) return state;
  return {
    ...state,
    ...(prior.contractStrikes ? { contractStrikes: prior.contractStrikes } : {}),
    ...(prior.excludedExecutors ? { excludedExecutors: prior.excludedExecutors } : {}),
  };
}
