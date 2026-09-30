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

/** Per-entry routing state: the entry's final step and its explicit handoffs. */
export interface WorkPhaseState {
  intentKey: string;
  /** Task type the entry owes the user: its classification after assessment adoption. */
  deliverable?: Dimension;
  terminal: TerminalAssessment;
  terminalBand: CapabilityBand;
  providerInvocation: number;
  /** Mutation calls observed in this entry; drives the `editing` status only. */
  observedMutationTools: number;
  /** Plan/review → implement handoff for this entry; never inherited. */
  contract?: ExecutionContract;
  /** Contract breaks per executor model id, kept across entries on the same work item. */
  contractStrikes?: Record<string, number>;
  /** Served keys of executor models that reached the strike limit. */
  excludedExecutors?: string[];
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
  /**
   * The entry's plan or review needs no preparation: the item's previous
   * acquisition answered in the reasoning model's place instead of handing
   * off. Any other owed context is still owed.
   */
  contextWaived?: boolean;
  /**
   * A missed-handoff recovery entry: every phase of it is scored at its
   * deliverable, and no handoff releases a cheaper model.
   */
  recoveryMinimum?: boolean;
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

export function floorForBand(band: CapabilityBand): number | undefined {
  return FLOOR[band];
}

/** `state` with `terminal` as its final step when that one asks for more. */
export function withStrongerTerminal(state: WorkPhaseState, terminal: TerminalAssessment): WorkPhaseState {
  const requirement = terminalRequirement(terminal);
  return requirement > terminalRequirement(state.terminal)
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

/** Carry same-WorkItem penalties, never entry-local execution authority. */
export function inheritWorkContinuation(
  intentKey: string,
  prior: WorkPhaseState,
  deliverable: Dimension,
): WorkPhaseState {
  return {
    ...prior,
    intentKey,
    deliverable,
    providerInvocation: 1,
    observedMutationTools: 0,
    contract: undefined,
    contractNudged: undefined,
    readPaths: undefined,
    reasoningHandoff: undefined,
    previousHandoffId: prior.reasoningHandoff?.id,
    contextStatus: undefined,
    pendingIdentity: undefined,
    provisionalGrounding: undefined,
    contextRequests: undefined,
    contextDenials: undefined,
    deniedAtInvocation: undefined,
    clarificationDispatched: undefined,
    handoffKey: undefined,
    contextNudged: undefined,
    contextWaived: undefined,
    recoveryMinimum: undefined,
    contextClosed: undefined,
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
