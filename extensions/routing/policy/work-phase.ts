import type { CapabilityBand, TerminalAssessment } from '../../types.js';
import type { ExecutionContract } from './execution-contract.js';

const KIND_BASE = { lightweight: 0.10, gather: 0.20, implement: 0.30, review: 0.30, plan: 0.35 } as const;
const COMPLEXITY = { trivial: 0, routine: 0.25, moderate: 0.5, hard: 0.75, frontier: 1 } as const;
const FLOOR = { economy: undefined, standard: 0.45, strong: 0.70, frontier: 0.85 } as const;

/** Per-entry routing state: the entry's final step and its explicit handoffs. */
export interface WorkPhaseState {
  intentKey: string;
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
  /** The investigation handed this entry to planning; never inherited. */
  planningRequested?: boolean;
  /** The one planning reminder for this investigation was already appended. */
  investigationNudged?: boolean;
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
): WorkPhaseState {
  return {
    ...prior,
    intentKey,
    providerInvocation: 1,
    observedMutationTools: 0,
    contract: undefined,
    contractNudged: undefined,
    planningRequested: undefined,
    investigationNudged: undefined,
  };
}
