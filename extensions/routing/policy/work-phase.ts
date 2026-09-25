import type { CapabilityBand, Dimension, ReasoningHandoffMeta, TerminalAssessment } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';
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
  /** Contract breaks per executor model id, kept across thin continuations. */
  contractStrikes?: Record<string, number>;
  /** Served keys of executor models that reached the strike limit. */
  excludedExecutors?: string[];
  /** The one handoff reminder for this entry was already appended. */
  contractNudged?: boolean;
  /** Paths the entry read with native `read`, most recent first; router-observed, never inherited. */
  readPaths?: string[];
  /** Investigation → planning/review handoff for this entry; never inherited. */
  reasoningHandoff?: ReasoningHandoffMeta;
  /** Handoff of the entry before this one, joined to this entry's records. */
  previousHandoffId?: string;
  /** The one investigation reminder for this entry was already appended. */
  investigationNudged?: boolean;
  /** An invocation of this entry was routed as its investigation. */
  investigated?: boolean;
  /** The entry's investigation outcome (`no-handoff` or `phase-end`) was logged. */
  investigationClosed?: boolean;
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

export function nextProviderInvocation(state: WorkPhaseState): WorkPhaseState {
  return { ...state, providerInvocation: state.providerInvocation + 1 };
}

export function inheritThinContinuation(
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
    investigationNudged: undefined,
    investigated: undefined,
    investigationClosed: undefined,
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
