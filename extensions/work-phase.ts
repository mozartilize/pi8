import type {
  CapabilityBand,
  Dimension,
  MultiWorkScoringPolicy,
  TerminalAssessment,
  WorkPhase,
} from './types.js';

const KIND_BASE = { lightweight: 0.10, gather: 0.20, implement: 0.30, review: 0.30, plan: 0.35 } as const;
const COMPLEXITY = { trivial: 0, routine: 0.25, moderate: 0.5, hard: 0.75, frontier: 1 } as const;
const BAND_ORDER: CapabilityBand[] = ['economy', 'standard', 'strong', 'frontier'];
const FLOOR = { economy: undefined, standard: 0.45, strong: 0.70, frontier: 0.85 } as const;

export interface InitialPhasePolicy {
  resolvedDimension: Dimension;
  capabilityRepickActive: boolean;
}

export interface InitialPhaseDecision {
  phase: WorkPhase;
  phaseReason: string;
  multiWorkEngaged: boolean;
}

export interface WorkPhaseState {
  intentKey: string;
  terminal: TerminalAssessment;
  terminalRequirement: number;
  terminalBand: CapabilityBand;
  phase: WorkPhase;
  phaseReason: string;
  multiWorkEngaged: boolean;
  providerInvocation: number;
  gateBlockedInvocation?: number;
  mutationGateBlocks: number;
  mutationGateTriggered: boolean;
  mutationCompleted: boolean;
  pendingMutationToolCallIds: Set<string>;
  observedReadTools: number;
  observedMutationTools: number;
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

export function deriveInitialPhase(
  terminal: TerminalAssessment,
  terminalBand: CapabilityBand,
  policy: InitialPhasePolicy,
): InitialPhaseDecision {
  if (terminal.kind === 'lightweight') return { phase: 'answer', phaseReason: 'terminal-lightweight', multiWorkEngaged: false };
  if (terminal.kind === 'gather') return { phase: 'inspect', phaseReason: 'terminal-gather', multiWorkEngaged: false };
  if (terminal.kind === 'plan' || terminal.kind === 'review') return { phase: 'reason', phaseReason: `terminal-${terminal.kind}`, multiWorkEngaged: false };
  const eligible = terminal.compound && terminal.discountEligible && terminal.confidence !== 'low' &&
    BAND_ORDER.indexOf(terminalBand) >= BAND_ORDER.indexOf('strong') &&
    policy.resolvedDimension === 'implement' && !policy.capabilityRepickActive;
  return eligible
    ? { phase: 'inspect', phaseReason: 'explicit-compound-inspect', multiWorkEngaged: true }
    : { phase: 'mutate', phaseReason: 'terminal-implement', multiWorkEngaged: false };
}

export function advanceForRoutingOwner(
  state: WorkPhaseState,
  resolvedDimension: Dimension,
  capabilityRepickActive: boolean,
): WorkPhaseState {
  const mustAdvance = state.multiWorkEngaged && state.phase === 'inspect' &&
    (resolvedDimension !== 'implement' || capabilityRepickActive);
  return mustAdvance
    ? { ...state, phase: 'mutate', phaseReason: 'stronger-routing-owner' }
    : { ...state, pendingMutationToolCallIds: new Set(state.pendingMutationToolCallIds) };
}

export function scoringPolicyForState(
  state: WorkPhaseState,
  resolvedDimension: Dimension,
  capabilityRepickActive: boolean,
): MultiWorkScoringPolicy | undefined {
  if (!state.multiWorkEngaged || resolvedDimension !== 'implement' || capabilityRepickActive) return undefined;
  const terminalFloor = floorForBand(state.terminalBand);
  if (terminalFloor == null) return undefined;
  const index = BAND_ORDER.indexOf(state.terminalBand);
  const inspectBand = BAND_ORDER[Math.max(0, index - 1)]!;
  const inspectFloor = state.phase === 'inspect'
    ? (floorForBand(inspectBand) ?? terminalFloor)
    : terminalFloor;
  return {
    terminal: state.terminal,
    terminalRequirement: state.terminalRequirement,
    terminalBand: state.terminalBand,
    phase: state.phase,
    phaseReason: state.phaseReason,
    terminalFloor,
    inspectFloor,
    providerInvocation: state.providerInvocation,
  };
}

export function nextProviderInvocation(state: WorkPhaseState): WorkPhaseState {
  return {
    ...state,
    providerInvocation: state.providerInvocation + 1,
    pendingMutationToolCallIds: new Set(state.pendingMutationToolCallIds),
  };
}

export function inheritThinContinuation(
  intentKey: string,
  prior: WorkPhaseState,
): WorkPhaseState {
  return {
    ...prior,
    intentKey,
    providerInvocation: 1,
    gateBlockedInvocation: undefined,
    mutationGateBlocks: 0,
    mutationGateTriggered: false,
    mutationCompleted: false,
    pendingMutationToolCallIds: new Set(),
    observedReadTools: 0,
    observedMutationTools: 0,
  };
}
