import type { CapabilityBand, Dimension, HandoffRubric, ReasoningHandoffMeta, TaskScope, TerminalAssessment } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';
import type { ContextReason, EntryResolution, ExecutorPenalties } from '../context/types.js';
import type { ContextStatus } from './context-acquisition.js';
import type { ChangeFactsState, CheckVerdicts } from './change-facts.js';
import type { GroundedArtifact } from '../context/types.js';
import type { PendingIdentity } from '../../serve/context-resolution.js';
import { defaultRequirement, FRONTIER_REQUIREMENT, parseCandidateKey } from '../score/scorer.js';
import type { PolicyVersion } from './policy-version.js';
import type { BoundaryAuthorizationV1 } from './boundary-authorization.js';

const KIND_BASE = { lightweight: 0.10, gather: 0.20, implement: 0.30, review: 0.30, plan: 0.35 } as const;
const COMPLEXITY = { trivial: 0, routine: 0.25, moderate: 0.5, hard: 0.75, frontier: 1 } as const;
/** Handoff requirement each band asks for; economy asks for none. */
const BAND_REQUIREMENT = { economy: undefined, standard: 0.45, strong: 0.70, frontier: 0.85 } as const;
/** Highest rubric requirement of a settled bounded implementation handoff ({@link rubricCeiling}). */
const SETTLED_IMPLEMENT_CEILING = 0.65;

/** Execution penalties of one work item, carried until an entry continues it. */
export interface PriorWork {
  workItemId: string;
  contractStrikes?: Record<string, number>;
  excludedExecutors?: string[];
}

/** Per-entry routing state: the entry's final step and its explicit handoffs. */
export interface WorkPhaseState {
  intentKey: string;
  /** Task type declared at the handoff, or the incumbent's last served task type. */
  deliverable?: Dimension;
  /** The handoff's task shape; absent until a handoff declares it. */
  terminal?: TerminalAssessment;
  /** The legacy policy keeps the final step as a band. */
  terminalBand?: CapabilityBand;
  /** The candidate policy keeps the final step as its requirement. It never has a band. */
  terminalRequirement?: number;
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

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

export function terminalRequirement(terminal: TerminalAssessment): number {
  return clamp(
    KIND_BASE[terminal.kind] +
    0.5 * COMPLEXITY[terminal.complexity] +
    (terminal.scope === 'open-ended' ? 0.1 : 0),
  );
}

export function capabilityBandFor(requirement: number): CapabilityBand {
  if (requirement < 0.30) return 'economy';
  if (requirement < 0.50) return 'standard';
  if (requirement < 0.75) return 'strong';
  return 'frontier';
}

export function bandRequirement(band: CapabilityBand | undefined): number | undefined {
  return band == null ? undefined : BAND_REQUIREMENT[band];
}

/** A `gather` entry whose final step has at least this requirement gets the handoff reminder on its first tool result. */
export const GATHER_REMINDER_REQUIREMENT = 0.50;

/** `state` with `terminal` as its final step when that one asks for more. */
export function withStrongerTerminal(
  state: WorkPhaseState,
  terminal: TerminalAssessment,
  version: PolicyVersion = 'legacy',
): WorkPhaseState {
  const requirement = terminalRequirement(terminal);
  if (state.terminal && requirement <= terminalRequirement(state.terminal)) return state;
  return version === 'cheapest-sufficient'
    ? { ...state, terminal, terminalRequirement: requirement }
    : { ...state, terminal, terminalBand: capabilityBandFor(requirement) };
}

/**
 * What the final step adds to the minimum of a plan or review handoff, or undefined when it adds
 * nothing. The final step can only raise a minimum. Under the candidate policy the step's own
 * requirement counts, and only when it is above the default requirement of the task type: a
 * requirement below the default must not lower the default minimums.
 */
export function terminalMinimum(state: WorkPhaseState, target: Dimension, version: PolicyVersion = 'legacy'): number | undefined {
  if (version !== 'cheapest-sufficient') return bandRequirement(state.terminalBand);
  const requirement = state.terminalRequirement;
  return requirement != null && requirement > defaultRequirement(target, version) ? requirement : undefined;
}

/**
 * `minimum` when it is above the default requirement of the task type, else undefined. A handoff
 * without a difficulty rubric keeps the default minimums, so only a final step that asks for more
 * than the default may set a handoff minimum.
 */
export function aboveDefault(minimum: number | undefined, target: Dimension, version: PolicyVersion = 'legacy'): number | undefined {
  return minimum != null && minimum > defaultRequirement(target, version) ? minimum : undefined;
}

/**
 * Highest rubric requirement of a handoff. An implementation handoff with a bounded scope and
 * no open behavior, interface, or design choice (`openDecisions` at most 3) gets at most 65%:
 * a fixed model at 66% of the Intelligence reference completed 9 of 10 repository fixes of that
 * shape, so spread, verification, knowledge, coupling, and the measurements must not move such
 * a handoff to the frontier. Every other handoff gets at most the frontier requirement.
 */
export function rubricCeiling(target: Dimension, scope: TaskScope, rubric: HandoffRubric | undefined): number {
  const settled = target === 'implement' && scope === 'bounded'
    && rubric != null && 'openDecisions' in rubric && rubric.openDecisions <= 3;
  return settled ? SETTLED_IMPLEMENT_CEILING : FRONTIER_REQUIREMENT;
}

/**
 * The minimum of a plan, review, or implement declaration. Every declaration of
 * one task type gets it in the same way: the declared requirement, at most the
 * ceiling ({@link rubricCeiling}, the frontier requirement by default), raised
 * by the final step. Without a declared requirement the default minimums of
 * the task type apply, and only a final step above the default raises them.
 */
export function handoffMinimum(
  state: WorkPhaseState,
  target: Dimension,
  requirement: number | undefined,
  version: PolicyVersion = 'legacy',
  ceiling: number = FRONTIER_REQUIREMENT,
): number | undefined {
  const raised = terminalMinimum(state, target, version);
  return requirement !== undefined
    ? Math.max(Math.min(requirement, ceiling), raised ?? 0)
    : aboveDefault(raised, target, version);
}

/** True when the final step is strong enough to remind a `gather` entry of the handoff at once. */
export function strongFinalStep(state: WorkPhaseState, version: PolicyVersion = 'legacy'): boolean {
  return version === 'cheapest-sufficient'
    ? (state.terminalRequirement ?? -Infinity) >= GATHER_REMINDER_REQUIREMENT
    : state.terminalBand === 'strong' || state.terminalBand === 'frontier';
}

/**
 * What an entry leaves to a branch it is not on, after `/tree`: the task type
 * and final step, kept only as conservative minimums, with `deliverable` as
 * the task type. They establish no work identity. Strikes, excluded
 * executors, contracts, handoffs, and context-collection state belong to the
 * entries of the branch Pi left.
 */
export function carryAcrossBranch(state: WorkPhaseState, deliverable: Dimension | undefined): WorkPhaseState {
  return {
    intentKey: state.intentKey,
    ...(deliverable ? { deliverable } : {}),
    terminal: state.terminal,
    terminalBand: state.terminalBand,
    terminalRequirement: state.terminalRequirement,
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
