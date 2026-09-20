/**
 * Fail-open, invocation-bounded mutation gate.
 *
 * Once multi-work routing has engaged an inspect phase (rule: an inspect-tier
 * candidate serves the turn), a mutation call (`edit`/`write`, or a Bash call
 * the classifier recognized as a high-confidence write) that arrives before
 * the served candidate is known to clear the terminal capability floor is
 * blocked exactly once per provider invocation. The block itself advances the
 * phase to `mutate`, so the next invocation scores against the terminal floor
 * instead of the inspect floor — that transition is the whole point of the
 * gate. Siblings of the blocked invocation still get the same block, because
 * the served capability cannot change until the provider is invoked again. A
 * later invocation always escapes: the router cannot guarantee a stronger
 * model exists, so it degrades to "let it through" rather than stalling the
 * turn forever.
 *
 * A possible/opaque Bash detection is observability-only: the classifier could
 * not prove a write, so the call proceeds without state change and the enum
 * metadata is logged.
 *
 * Pure state transitions only: no I/O, no registry/session access. `state`
 * is never mutated in place — every branch returns a fresh object (or the
 * same reference untouched) so callers can commit atomically.
 */
import type { MutationDetection, MutationSignal, MutationSurface } from './mutation-detector.js';
import type { ServedCapabilityMeta } from '../../types.js';
import type { ServedInfo } from '../../host/ui.js';
import type { WorkPhaseState } from './work-phase.js';

const MUTATION_TOOLS = new Set(['edit', 'write']);
const BLOCK_REASON = 'mutation blocked pending stronger capability for this invocation';

export interface MutationCallInput {
  toolName: string;
  toolCallId: string;
  state: WorkPhaseState | undefined;
  served: ServedInfo | undefined;
  /** Classifier output for non-native tools; native `edit`/`write` need none. */
  detection?: MutationDetection;
}

export interface MutationCallMetadata {
  clearance: boolean | 'unknown';
  capabilityDegraded?: boolean;
  mutationGateEscaped?: boolean;
  mutationSurface?: MutationSurface;
  mutationSignal?: MutationSignal;
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
  const { toolName, toolCallId, state, served, detection } = input;

  const nativeMutation = MUTATION_TOOLS.has(toolName);
  const shellMutation = toolName === 'bash' && detection?.confidence === 'high';

  // A possible/opaque shell mutation is observability-only: the classifier
  // could not prove a write, so the call is allowed, leaves work-phase state
  // untouched, and surfaces the enum metadata for the signal log.
  if (toolName === 'bash' && detection?.confidence === 'possible') {
    return {
      block: false,
      metadata: {
        clearance: 'unknown',
        mutationSurface: detection.surface,
        mutationSignal: detection.signal,
      },
    };
  }

  if (!nativeMutation && !shellMutation) return { block: false };
  if (!state) return { block: false };

  const surface: MutationSurface | undefined = nativeMutation ? 'native' : detection?.surface;
  const signal: MutationSignal | undefined = nativeMutation
    ? toolName === 'edit'
      ? 'native-edit'
      : 'native-write'
    : detection?.signal;
  const meta = (
    clearance: boolean | 'unknown',
    extra: Partial<MutationCallMetadata> = {},
  ): MutationCallMetadata => ({ clearance, mutationSurface: surface, mutationSignal: signal, ...extra });

  const capability: ServedCapabilityMeta | undefined = served?.capability;

  // The gate already fired for this intent. Siblings of the blocked
  // invocation repeat the block (nothing about the served capability can have
  // changed yet); anything later passes exactly once, whether because a
  // terminal owner took over or because the escape has to fire.
  if (state.mutationGateTriggered) {
    const invocation = capability?.providerInvocation;
    if (invocation !== undefined && state.gateBlockedInvocation === invocation) {
      return { block: true, reason: BLOCK_REASON, nextState: state, metadata: meta(false) };
    }
    const clearance = capability?.candidate.clearsTerminalFloor ?? 'unknown';
    const cleared = clearance === true;
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, {
        phaseReason: cleared ? 'terminal-cleared' : 'gate-escape',
      }),
      metadata: cleared
        ? meta(clearance)
        : meta(clearance, { capabilityDegraded: true, mutationGateEscaped: true }),
    };
  }

  // Not engaged, or already past the gate: track the call for result
  // correlation, but the capability gate never applies.
  if (!state.multiWorkEngaged || state.phase === 'mutate') {
    return { block: false, nextState: withPendingId(state, toolCallId) };
  }

  // Missing or incoherent served-capability evidence must never stall a
  // turn — fail open, advance to mutate, and record genuine uncertainty
  // rather than a measured clearance.
  if (!served || !capability) {
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, { phaseReason: 'gate-fail-open' }),
      metadata: meta('unknown'),
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
      metadata: meta(clearance),
    };
  }

  // No candidate in the scoring set ever cleared the terminal floor —
  // blocking would wait forever for a capability that does not exist.
  if (!capability.terminalCapableInScoringSet) {
    return {
      block: false,
      nextState: withPendingId(state, toolCallId, { phaseReason: 'gate-no-candidate' }),
      metadata: meta(false, { capabilityDegraded: true }),
    };
  }

  // First block. Advancing to `mutate` is the handoff: the next invocation
  // scores against the terminal floor rather than the inspect floor.
  return {
    block: true,
    reason: BLOCK_REASON,
    nextState: {
      ...state,
      phase: 'mutate',
      phaseReason: 'gate-handoff',
      gateBlockedInvocation: capability.providerInvocation,
      mutationGateTriggered: true,
      mutationGateBlocks: state.mutationGateBlocks + 1,
    },
    metadata: meta(false),
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
