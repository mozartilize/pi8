/**
 * Fail-open, invocation-bounded mutation gate.
 *
 * Once multi-work routing has engaged an inspect phase (rule: an inspect-tier
 * candidate serves the turn), a mutation call (`edit`/`write`) that arrives
 * before the served candidate is known to clear the terminal capability floor
 * is blocked exactly once per provider invocation. A later invocation (the
 * model retried after the block, or a stronger routing owner took over)
 * always escapes the gate — this is a bounded handoff, not a hard veto: the
 * router does not have a way to guarantee a stronger model exists, so it
 * degrades to "let it through" rather than stalling the turn forever.
 *
 * Pure state transitions only: no I/O, no registry/session access. `state`
 * is never mutated in place — every branch returns a fresh object (or the
 * same reference untouched) so callers can commit atomically.
 */
import type { ServedCapabilityMeta } from './types.js';
import type { ServedInfo } from './ui.js';
import type { WorkPhaseState } from './work-phase.js';

const MUTATION_TOOLS = new Set(['edit', 'write']);

export interface MutationCallInput {
  toolName: string;
  toolCallId: string;
  state: WorkPhaseState | undefined;
  served: ServedInfo | undefined;
}

export interface MutationCallMetadata {
  clearance: boolean | 'unknown';
  capabilityDegraded?: boolean;
  mutationGateEscaped?: boolean;
}

export interface MutationCallDecision {
  block: boolean;
  reason?: string;
  nextState?: WorkPhaseState;
  metadata?: MutationCallMetadata;
}

function withPendingId(state: WorkPhaseState, toolCallId: string, patch: Partial<WorkPhaseState> = {}): WorkPhaseState {
  const pendingMutationToolCallIds = new Set(state.pendingMutationToolCallIds);
  pendingMutationToolCallIds.add(toolCallId);
  return {
    ...state,
    phase: 'mutate',
    observedMutationTools: state.observedMutationTools + 1,
    pendingMutationToolCallIds,
    ...patch,
  };
}

export function evaluateMutationCall(input: MutationCallInput): MutationCallDecision {
  const { toolName, toolCallId, state, served } = input;

  if (!MUTATION_TOOLS.has(toolName)) return { block: false };
  if (!state) return { block: false };

  // Not engaged, or already past the gate this invocation: track the call for
  // result correlation, but the capability gate never applies.
  if (!state.multiWorkEngaged || state.phase === 'mutate') {
    return { block: false, nextState: withPendingId(state, toolCallId) };
  }

  const capability: ServedCapabilityMeta | undefined = served?.capability;

  // Missing or incoherent served-capability evidence must never stall a
  // turn — fail open, advance to mutate, and record genuine uncertainty
  // rather than a measured clearance.
  if (!served || !capability) {
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, { phaseReason: 'gate-fail-open' }),
      metadata: { clearance: 'unknown' },
    };
  }

  const clearance = capability.candidate.clearsTerminalFloor;

  // Terminal-clearing or genuinely unknown quality both proceed without a
  // gate: unknown capability is allowed to mutate but earns no promotion
  // credit (rule 3), and cleared capability has nothing left to wait for.
  if (clearance === true || clearance === 'unknown') {
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, { phaseReason: 'terminal-cleared' }),
      metadata: { clearance },
    };
  }

  // No candidate in the scoring set ever cleared the terminal floor —
  // blocking would wait forever for a capability that does not exist.
  if (!capability.terminalCapableInScoringSet) {
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, { phaseReason: 'gate-no-candidate' }),
      metadata: { clearance: false, capabilityDegraded: true },
    };
  }

  const invocation = capability.providerInvocation;

  // A prior invocation was already blocked and this is a later one (a retry,
  // or a stronger routing owner took over): the bounded escape fires
  // exactly once per block, regardless of this invocation's own clearance.
  if (state.mutationGateTriggered && state.gateBlockedInvocation !== invocation) {
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, { phaseReason: 'gate-escape' }),
      metadata: { clearance: false, capabilityDegraded: true, mutationGateEscaped: true },
    };
  }

  // Same invocation already blocked: every sibling call gets the same
  // intentional block, without incrementing the block counter again.
  if (state.gateBlockedInvocation === invocation) {
    return {
      block: true,
      reason: 'mutation blocked pending stronger capability for this invocation',
      nextState: state,
      metadata: { clearance: false },
    };
  }

  // First block for this invocation.
  return {
    block: true,
    reason: 'mutation blocked pending stronger capability for this invocation',
    nextState: {
      ...state,
      gateBlockedInvocation: invocation,
      mutationGateTriggered: true,
      mutationGateBlocks: state.mutationGateBlocks + 1,
    },
    metadata: { clearance: false },
  };
}

export interface MutationResultInput {
  state: WorkPhaseState;
  toolCallId: string;
  isError: boolean;
}

/** Correlates a mutation tool result back to its pending call, if any. */
export function recordMutationResult(input: MutationResultInput): WorkPhaseState {
  const { state, toolCallId, isError } = input;
  if (!state.pendingMutationToolCallIds.has(toolCallId)) return state;
  const pendingMutationToolCallIds = new Set(state.pendingMutationToolCallIds);
  pendingMutationToolCallIds.delete(toolCallId);
  return {
    ...state,
    pendingMutationToolCallIds,
    mutationCompleted: isError === false ? true : state.mutationCompleted,
  };
}
