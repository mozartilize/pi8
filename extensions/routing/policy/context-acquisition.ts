/**
 * Collecting context: the preparation phase before an entry's deliverable.
 *
 * An entry owes context when no work item can be chosen for it yet, when its
 * plan or review needs preparation, when its request rests on a referenced
 * file not read as it is now, or when its work item left an obligation open.
 * It starts as
 * collecting context, routed as `gather` (a missed-handoff recovery entry is
 * routed at its deliverable instead). Until `hand_off_context` is accepted,
 * tools may collect evidence. Recognized mutations are refused. The model hands off with
 * outcome `ready` and its findings, or `needs-user` and its question; the
 * router, not the model, decides the next phase and its minimum. A ready
 * boundary to a plan or review releases the incumbent minimums once: the
 * first invocation that serves the new phase owns it.
 *
 * The request and denial limits are resource guards, not calibrated quality
 * thresholds: they bound how long a model that cannot hand off may run.
 *
 * Pure state transitions only: no I/O, no registry or session access.
 */
import { dirname } from 'node:path';
import type { DecisionCause, Dimension, ReasoningEvidence, ReasoningHandoffMeta } from '../../types.js';
import { CONTEXT_DELIVERABLES } from '../context/resolve.js';
import type { ContextReason } from '../context/types.js';
import { handoffBoundaryId, type WorkPhaseState } from './work-phase.js';
import { newExecutionFlow } from './execution-flow.js';
import { EXECUTION_CONTRACT_TOOL } from './execution-contract.js';
import { isMutationCall } from './mutation-detector.js';

export const CONTEXT_HANDOFF_TOOL = 'hand_off_context';

/** Most files a handoff is measured on; every weighted fact saturates well below it. */
export const MAX_EVIDENCE_PATHS = 20;

/** Evidence of a handoff that no file backs: its reasoning rests on the conversation. */
export const CONVERSATION_EVIDENCE: ReasoningEvidence = { applicable: false, files: 0, directories: 0 };

/** Acquisition provider requests, fallbacks included, before the entry must ask the user. */
export const ACQUISITION_REQUEST_LIMIT = 32;

/** Handoffs rejected for missing context and refused mutating calls, one per provider invocation, before the entry must ask the user. */
export const ACQUISITION_DENIAL_LIMIT = 2;

/**
 * Readers permitted while an accepted boundary waits for the next model.
 * This list does not restrict tools while collecting context.
 */
export const ACQUISITION_READ_TOOLS: readonly string[] = [
  'read', 'grep', 'find', 'ls', 'fffind', 'ffgrep',
  'tilth_read', 'tilth_search', 'tilth_list', 'tilth_grok',
];
/** The host question tool, when one is installed. */
export const QUESTION_TOOL = 'ask_user_question';

export type ContextStatus =
  /** Owed context is being gathered before implementation. */
  | 'triage'
  /** Acquisition ended without a ready handoff: the entry may only ask the user. */
  | 'clarification-only'
  /** A ready handoff is accepted; no qualifying model has served the next phase yet. */
  | 'ready-pending'
  /** A qualifying model served the next phase. */
  | 'served';

/**
 * What the entry owes before its deliverable, fixed when it resolved. A plan
 * or review always needs preparation unless a missed-handoff recovery waived
 * it; context the request owes and the router found missing is owed whatever
 * the deliverable, so a waiver never skips a file or an open obligation.
 */
export function owedContext(state: WorkPhaseState | undefined): ContextReason[] {
  const deliverable = state?.deliverable;
  if (!state || !deliverable) return [];
  const reasons: ContextReason[] = [];
  if (state.pendingIdentity) reasons.push('identity-unresolved');
  if (deliverable === 'plan' || deliverable === 'review') reasons.push('reasoning-prep');
  if (CONTEXT_DELIVERABLES.has(deliverable) && state.contextSatisfied === false) {
    reasons.push(...(state.contextReasons ?? []));
  }
  return reasons;
}

/** Whether the entry owes collecting context before its deliverable. */
export function contextOwed(state: WorkPhaseState | undefined): boolean {
  return owedContext(state).length > 0;
}

/** The entry is in the restricted phase: its tools are limited until a model serves the next one. */
export function acquisitionRestricted(state: WorkPhaseState | undefined): boolean {
  const status = state?.status;
  return status === 'triage' || status === 'clarification-only' || status === 'ready-pending';
}

/**
 * Collecting context blocks recognized mutations and execution starts.
 * shortcut: opaque runners and third-party tools can hide writes; use a host
 * sandbox when enforced read-only execution is required.
 */
export function acquisitionAllows(status: ContextStatus | undefined, toolName: string, input?: unknown): boolean {
  if (status === 'clarification-only') return false;
  if (status === 'triage') {
    return toolName !== EXECUTION_CONTRACT_TOOL && !isMutationCall(toolName, input);
  }
  return ACQUISITION_READ_TOOLS.includes(toolName)
    || toolName === QUESTION_TOOL
    || toolName === CONTEXT_HANDOFF_TOOL;
}

/**
 * Count one refusal: a handoff rejected for missing context or a refused mutating call. Several
 * refusals in one provider invocation (a batch) count once. Reaching the
 * limit ends collecting context: the entry may then only ask the user. A ready
 * boundary is not revoked, and its refusals are not counted.
 */
export function countDenial(state: WorkPhaseState): WorkPhaseState {
  if (state.status !== 'triage' || state.deniedAtInvocation === state.providerInvocation) return state;
  const contextDenials = (state.contextDenials ?? 0) + 1;
  return {
    ...state,
    contextDenials,
    deniedAtInvocation: state.providerInvocation,
    ...(contextDenials >= ACQUISITION_DENIAL_LIMIT ? { status: 'clarification-only' as const } : {}),
  };
}

export interface EntryPhase {
  dimension: Dimension;
  /** Present when the phase, not the classification, sets the task type. */
  cause?: Extract<DecisionCause, 'investigation' | 'investigation-handoff'>;
}

/**
 * The entry's routed phase. A pinned model serves every phase: a pin chooses
 * the model, never which context the request owes. A recovery entry acquires
 * at its deliverable, so a model trusted with the deliverable does it.
 */
export function entryPhase(state: WorkPhaseState | undefined, base: Dimension): EntryPhase {
  if (state?.reasoningHandoff) return { dimension: state.reasoningHandoff.target, cause: 'investigation-handoff' };
  if (state?.status === 'ready-pending' || state?.status === 'served') {
    return { dimension: state.deliverable ?? base, cause: 'investigation-handoff' };
  }
  return { dimension: 'gather', cause: 'investigation' };
}

/**
 * Record an accepted ready handoff; the boundary stays pending until a model
 * serves it. `reasoning` is present for a plan, review, implementation, or
 * investigation target and carries its minimum. The router scores any other target at the
 * entry's deliverable with ordinary scoring.
 *
 * The handoff starts a new routing boundary, named from the accepted
 * payload. An implement handoff starts the entry's execution flow, or keeps
 * the flow that the entry already has.
 */
export function acceptContextHandoff(
  state: WorkPhaseState,
  accepted: {
    deliverable: Dimension;
    key: string;
    reasoning?: Omit<ReasoningHandoffMeta, 'id' | 'pending' | 'owner'>;
    /** Routing epoch of the session; the entry's own epoch when absent. */
    routingEpoch?: number;
  },
): WorkPhaseState {
  if (state.status === 'ready-pending' || state.status === 'served' || state.reasoningHandoff) return state;
  const entryId = state.sourceEntryId ?? state.intentKey;
  const boundaryId = handoffBoundaryId(entryId, accepted.routingEpoch ?? state.routingEpoch ?? 0, accepted.key);
  const executionFlow = accepted.deliverable === 'implement'
    ? state.executionFlow ?? newExecutionFlow(entryId, boundaryId)
    : state.executionFlow;
  return {
    ...state,
    deliverable: accepted.deliverable,
    status: 'ready-pending',
    handoffKey: accepted.key,
    boundaryId,
    ...(executionFlow ? { executionFlow } : {}),
    ...(accepted.reasoning ? { reasoningHandoff: { ...accepted.reasoning, id: state.intentKey, pending: true } } : {}),
  };
}

/** The first qualifying invocation that served the next phase owns it. */
export function serveContextHandoff(state: WorkPhaseState, owner: string): WorkPhaseState {
  if (state.status !== 'ready-pending') return state;
  const handoff = state.reasoningHandoff;
  return {
    ...state,
    status: 'served',
    ...(handoff?.pending ? { reasoningHandoff: { ...handoff, pending: false, owner } } : {}),
  };
}

/** Remember a path the acquisition read, most recent first. */
export function noteContextRead(state: WorkPhaseState, path: string): WorkPhaseState {
  if (state.reasoningHandoff || state.status === 'ready-pending' || state.status === 'served') return state;
  const readPaths = [path, ...(state.readPaths ?? []).filter((p) => p !== path)].slice(0, MAX_EVIDENCE_PATHS);
  return { ...state, readPaths };
}

/** Count a read of part of a file, until the entry's handoff. It has no effect on routing. */
export function notePartialRead(state: WorkPhaseState): WorkPhaseState {
  if (state.reasoningHandoff || state.status === 'ready-pending' || state.status === 'served') return state;
  return { ...state, partialReadCount: (state.partialReadCount ?? 0) + 1 };
}

/**
 * Files a handoff is measured on: the declared files first, then the most
 * recently read ones, deduplicated. Reads count even when the model declares
 * none, so leaving `files` empty cannot switch measurement off.
 */
export function evidencePaths(declared: readonly string[], readPaths: readonly string[] = []): string[] {
  return [...new Set([...declared, ...readPaths])].slice(0, MAX_EVIDENCE_PATHS);
}

/** Router-counted shape of an evidence set; I/O facts are added by the caller. */
export function evidenceShape(paths: readonly string[]): Pick<ReasoningEvidence, 'applicable' | 'files' | 'directories'> {
  return {
    applicable: paths.length > 0,
    files: paths.length,
    directories: new Set(paths.map((path) => dirname(path))).size,
  };
}
