import type { CapabilityBand, Dimension, ReasoningHandoffMeta, TerminalAssessment } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';
import type { ContextReason, EntryResolution } from '../context/types.js';
import type { ContextStatus } from './context-acquisition.js';
import type { GroundedArtifact } from '../context/types.js';
import type { PendingIdentity } from '../../serve/context-resolution.js';
import { MODEL_THINKING_LEVELS, parseCandidateKey } from '../score/scorer.js';

const KIND_BASE = { lightweight: 0.10, gather: 0.20, implement: 0.30, review: 0.30, plan: 0.35 } as const;
const COMPLEXITY = { trivial: 0, routine: 0.25, moderate: 0.5, hard: 0.75, frontier: 1 } as const;
const FLOOR = { economy: undefined, standard: 0.45, strong: 0.70, frontier: 0.85 } as const;

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
  terminalBand?: CapabilityBand;
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
  contractNudged?: boolean;
  /** Files the entry's tools looked at, most recent first; router-observed, never inherited. */
  readPaths?: string[];
  /** Context → planning/review handoff for this entry; never inherited. */
  reasoningHandoff?: ReasoningHandoffMeta;
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
  /** Normalized payload of the accepted handoff; the same payload again is idempotent. */
  handoffKey?: string;
  /** The one acquisition reminder for this entry was already appended. */
  contextNudged?: boolean;
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
  firstLook?: { workItemId: string };
  /** The entry completed its work item; no change runs for the rest of the entry until a reopen. */
  completion?: { workItemId: string; status: 'done' | 'superseded' };
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

export function floorForBand(band: CapabilityBand | undefined): number | undefined {
  return band == null ? undefined : FLOOR[band];
}

/** `state` with `terminal` as its final step when that one asks for more. */
export function withStrongerTerminal(state: WorkPhaseState, terminal: TerminalAssessment): WorkPhaseState {
  const requirement = terminalRequirement(terminal);
  return !state.terminal || requirement > terminalRequirement(state.terminal)
    ? { ...state, terminal, terminalBand: capabilityBandFor(requirement) }
    : state;
}

/**
 * What an entry leaves to a branch it is not on, after `/tree`: the task type
 * and final step, kept only as conservative minimums, with `deliverable` as
 * the task type. They establish no work identity. Strikes, excluded
 * executors, contracts, handoffs, and investigation state belong to the
 * entries of the branch Pi left.
 */
export function carryAcrossBranch(state: WorkPhaseState, deliverable: Dimension | undefined): WorkPhaseState {
  return {
    intentKey: state.intentKey,
    ...(deliverable ? { deliverable } : {}),
    terminal: state.terminal,
    terminalBand: state.terminalBand,
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

/**
 * Chain candidates that clear a phase boundary's minimum: those the scorer
 * left in the first capability tier. A candidate kept only as a fallback —
 * below the minimum, or of unknown quality — may serve an invocation, but it
 * does not satisfy the boundary.
 */
export function boundaryQualifiers(decision: {
  fallbackChain: readonly string[];
  candidateDiagnostics?: ReadonlyArray<{ candidateKey: string; excludedReason?: string }>;
}): string[] {
  const excluded = new Set((decision.candidateDiagnostics ?? [])
    .filter((diagnostic) => diagnostic.excludedReason != null && diagnostic.excludedReason !== 'promoted')
    .map((diagnostic) => diagnostic.candidateKey));
  return decision.fallbackChain.filter((key) => !excluded.has(key));
}

/**
 * Whether the served key is one of `qualifiers`. Serving raises a candidate's
 * effort to the task type's effort minimum, never lowers it, so the same model
 * at a higher effort than a qualifying key also qualifies.
 */
export function servesBoundary(served: string, qualifiers: readonly string[]): boolean {
  const s = parseCandidateKey(served);
  const rank = (effort: string | undefined) => (effort == null ? -1 : MODEL_THINKING_LEVELS.indexOf(effort as never));
  return qualifiers.some((key) => {
    const q = parseCandidateKey(key);
    return q.provider === s.provider && q.id === s.id && (q.effort == null || rank(s.effort) >= rank(q.effort));
  });
}
