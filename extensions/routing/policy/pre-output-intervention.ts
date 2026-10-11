/**
 * Pre-output intervention, on-demand policy: after a severe reasoning loop,
 * run the shared selector while the attempt's stream is held, then switch
 * only if the attempt is still the same and no visible output, tool call or
 * thinking-overflow commit escaped.
 *
 * The final check and the abort are one synchronous step
 * (`tryAbortAndReserveTargetIfEpochMatches`): no await between them. A user
 * cancellation ends the invocation; it never starts a recovery attempt. A
 * solver failure is not a cancellation: the current attempt continues.
 * Recording the loop as friction is the caller's evidence write; this
 * function writes no assignment state.
 */
import type { SelectionResult } from '../optimization/select.js';

export interface AttemptEpoch {
  attemptId: string;
  sessionGeneration: number;
  workBoundaryId: string;
  boundaryAuthorizationRevision: number;
  /** Increases on every consumer-visible or committed event. */
  outputRevision: number;
  profileDigest: string;
}

export interface LiveAttempt {
  /** Effective action key of the running attempt. */
  source: string;
  epoch(): AttemptEpoch;
  /** True after visible text, a tool call or a thinking-overflow commit was forwarded. */
  outputCommitted(): boolean;
  alreadyTried(key: string): boolean;
  targetReachable(key: string): boolean;
  /**
   * Atomic: when the live epoch equals `expected`, no output is committed and
   * the signal is not aborted, abort the attempt, discard its buffered
   * events and reserve `target` once. Otherwise change nothing.
   */
  tryAbortAndReserveTargetIfEpochMatches(expected: AttemptEpoch, target: string, signal: AbortSignal): { id: string } | undefined;
}

export type InterventionDisposition =
  | { kind: 'continue-current'; reason: string }
  | { kind: 'switch-before-output'; target: string; reservationId: string; revisedChain: string[] }
  | { kind: 'cancelled' };

const sameEpoch = (a: AttemptEpoch, b: AttemptEpoch): boolean =>
  a.attemptId === b.attemptId && a.sessionGeneration === b.sessionGeneration
  && a.workBoundaryId === b.workBoundaryId && a.boundaryAuthorizationRevision === b.boundaryAuthorizationRevision
  && a.outputRevision === b.outputRevision && a.profileDigest === b.profileDigest;

/**
 * Whether abandoning the current pre-output attempt is legal and useful:
 * the selector chose another action, and the choice applied the user's
 * preferences or ran with no preferences to apply. This is not a ranking.
 */
export function supportsAbandoningCurrentAttempt(source: string, decision: Extract<SelectionResult, { kind: 'decision' }>): boolean {
  return decision.chosen !== undefined && decision.chosen !== source && decision.constraintsEnforced;
}

export async function decidePreOutputIntervention(
  live: LiveAttempt,
  reachable: readonly string[],
  select: (remaining: readonly string[], isCurrent: () => boolean, signal: AbortSignal) => Promise<SelectionResult>,
  signal: AbortSignal,
): Promise<InterventionDisposition> {
  const before = live.epoch();
  if (signal.aborted) return { kind: 'cancelled' };
  if (live.outputCommitted()) return { kind: 'continue-current', reason: 'output-committed' };
  const remaining = reachable.filter((key) => key !== live.source && !live.alreadyTried(key));
  if (remaining.length === 0) return { kind: 'continue-current', reason: 'no-reachable-alternative' };

  let decision: SelectionResult;
  try {
    // The current attempt stays in the pool, so "keep it" remains a legal answer.
    decision = await select([live.source, ...remaining], () => sameEpoch(before, live.epoch()), signal);
  } catch {
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'continue-current', reason: 'optimizer-unavailable' };
  }
  if (signal.aborted || decision.kind === 'cancelled') return { kind: 'cancelled' };
  if (decision.kind === 'stale') return { kind: 'continue-current', reason: 'stale-decision' };
  if (!decision.chosen) return { kind: 'continue-current', reason: 'no-feasible-action' };
  // Checked again after the await: the solve can take up to its deadline.
  if (!sameEpoch(before, live.epoch())) return { kind: 'continue-current', reason: 'attempt-or-work-changed' };
  if (live.outputCommitted()) return { kind: 'continue-current', reason: 'output-committed-while-solving' };
  if (!live.targetReachable(decision.chosen)) return { kind: 'continue-current', reason: 'target-changed' };
  if (!decision.constraintsEnforced) return { kind: 'continue-current', reason: 'preference-domain-not-ready' };
  if (!supportsAbandoningCurrentAttempt(live.source, decision)) return { kind: 'continue-current', reason: 'switch-not-warranted' };

  const reservation = live.tryAbortAndReserveTargetIfEpochMatches(before, decision.chosen, signal);
  if (!reservation) return signal.aborted ? { kind: 'cancelled' } : { kind: 'continue-current', reason: 'stale-at-commit' };
  const revisedChain = [decision.chosen, ...decision.ranking.filter((key) => key !== decision.chosen && key !== live.source && remaining.includes(key))];
  return { kind: 'switch-before-output', target: decision.chosen, reservationId: reservation.id, revisedChain };
}
