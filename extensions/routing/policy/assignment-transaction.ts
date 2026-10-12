/**
 * Transactional assignment: plan -> select -> prepare -> commit/reserve -> dispatch.
 *
 * - Planning reads state only. It writes no phase, `lastDecision`, ownership
 *   or recovery state.
 * - Commit applies the deferred selection transitions once and creates one
 *   single-use reservation, after a check of every live revision.
 * - Dispatch checks the reservation again. Recovery eligibility is consumed,
 *   and its note is attached, only when the recovery provider attempt
 *   starts. A started attempt that fails does not restore eligibility.
 * - Boundary ownership and contract release settle only from an actual-serve
 *   receipt (boundary-authorization.ts), never from commit or reservation.
 * - Failed preparation excludes every target with the same input budget at
 *   the same context revision. The remaining ranking uses the current context
 *   without another selection. A new context checks the ranking again.
 * - Each summary request is a paid model call, so one invocation permits at
 *   most MAX_COMPACTION_ATTEMPTS. After that limit, only targets that already
 *   fit can be prepared.
 * - Cancellation wins over staleness and starts no retry and no fallback.
 *   A stale result may use one fresh selection within the original budget.
 *
 * `AssignmentLedger` holds the assignment state of one session. Hosts wrap
 * their persisted state behind it; tests drive it directly.
 */
import type { UnifiedDecision, SelectionResult } from '../optimization/select.js';
import { settleBoundary, type ActualServeReceipt, type BoundaryAuthorizationV1 } from './boundary-authorization.js';

export interface AssignmentRevisions {
  workItemId: string;
  branchId: string;
  session: number;
  profile: number;
  profileDigest: string;
  authorization: number;
  /** Context revision; Pi compaction increases it. */
  context: number;
}

/** A selection-dependent write, applied only at commit. */
export interface PlannedTransition {
  kind: 'enter-phase' | 'record-decision';
  value: string;
}

export interface TurnPlan {
  revisions: AssignmentRevisions;
  pendingTransitions: readonly PlannedTransition[];
  /** Recovery claim this plan may use; read only. */
  recoveryClaimId?: string;
}

export interface Reservation {
  id: string;
  target: string;
  revisions: AssignmentRevisions;
  recoveryClaimId?: string;
  state: 'reserved' | 'dispatched' | 'released';
}

export interface DispatchReceipt {
  reservationId: string;
  target: string;
  /** Present once, on the dispatch that consumed a recovery claim. */
  recoveryNote?: string;
}

export type RecoveryState = 'eligible' | 'consumed';

const sameRevisions = (a: AssignmentRevisions, b: AssignmentRevisions): boolean =>
  a.workItemId === b.workItemId && a.branchId === b.branchId && a.session === b.session
  && a.profile === b.profile && a.profileDigest === b.profileDigest
  && a.authorization === b.authorization && a.context === b.context;

export class AssignmentLedger {
  revisions: AssignmentRevisions;
  /** Committed assignment writes, in order. */
  readonly applied: PlannedTransition[] = [];
  readonly recovery = new Map<string, RecoveryState>();
  readonly reservations = new Map<string, Reservation>();
  boundary?: BoundaryAuthorizationV1;
  /** Contract release waits for an actual serve. */
  releasePending = false;
  private nextReservation = 0;

  constructor(revisions: AssignmentRevisions) {
    this.revisions = { ...revisions };
  }

  plan(pendingTransitions: readonly PlannedTransition[], recoveryClaimId?: string): TurnPlan {
    return { revisions: { ...this.revisions }, pendingTransitions: [...pendingTransitions], ...(recoveryClaimId ? { recoveryClaimId } : {}) };
  }

  isCurrent(plan: Pick<TurnPlan, 'revisions'>): boolean {
    return sameRevisions(plan.revisions, this.revisions);
  }

  /** Record a revision change that the host caused or observed. */
  bump(patch: Partial<AssignmentRevisions>): void {
    this.revisions = { ...this.revisions, ...patch };
  }

  /** Atomic: check live revisions, apply deferred transitions once, reserve once. */
  commitAndReserve(plan: TurnPlan, target: string, signal?: AbortSignal): Reservation | undefined {
    if (signal?.aborted || !this.isCurrent(plan)) return undefined;
    if (plan.recoveryClaimId && this.recovery.get(plan.recoveryClaimId) !== 'eligible') return undefined;
    this.applied.push(...plan.pendingTransitions);
    const reservation: Reservation = {
      id: `r${++this.nextReservation}`,
      target,
      revisions: { ...this.revisions },
      ...(plan.recoveryClaimId ? { recoveryClaimId: plan.recoveryClaimId } : {}),
      state: 'reserved',
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * Start the provider attempt of a reservation. Returns undefined, and starts
   * nothing, when the reservation is used, released, stale or cancelled.
   * `start` runs synchronously after the claim is consumed.
   */
  dispatch(reservationId: string, start: (receipt: DispatchReceipt) => void, signal?: AbortSignal): DispatchReceipt | undefined {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.state !== 'reserved') return undefined;
    if (signal?.aborted || !sameRevisions(reservation.revisions, this.revisions)) {
      reservation.state = 'released';
      return undefined;
    }
    let recoveryNote: string | undefined;
    if (reservation.recoveryClaimId) {
      if (this.recovery.get(reservation.recoveryClaimId) !== 'eligible') {
        reservation.state = 'released';
        return undefined;
      }
      this.recovery.set(reservation.recoveryClaimId, 'consumed');
      recoveryNote = `recovery:${reservation.recoveryClaimId}`;
    }
    reservation.state = 'dispatched';
    const receipt: DispatchReceipt = { reservationId, target: reservation.target, ...(recoveryNote ? { recoveryNote } : {}) };
    start(receipt);
    return receipt;
  }

  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation?.state === 'reserved') reservation.state = 'released';
  }

  /** Settle ownership from an actual-serve receipt; nothing else settles it. */
  settle(receipt: ActualServeReceipt): boolean {
    if (!this.boundary) return false;
    const next = settleBoundary(this.boundary, receipt);
    if (next === this.boundary) return false;
    this.boundary = next;
    this.releasePending = false;
    return true;
  }
}

// ─── Orchestration ───────────────────────────────────────────────────

/** The selected target and one fallback can each request one summary. */
export const MAX_COMPACTION_ATTEMPTS = 2;

export interface PrepareRequest {
  /** False after the compaction attempt limit. The host must not start a summary request. */
  allowCompaction: boolean;
}

export type PrepareOutcome = {
  kind: 'ready' | 'failed' | 'cancelled';
  /** True when the host started a summary request, whatever its result. */
  compactionAttempted?: boolean;
};

/** Counts for the decision log; no target names or messages. */
export interface PreparationRecord {
  attempts: number;
  failures: number;
  /** Failures from an exception in the host, not from a preparation result. */
  errors: number;
  compactionAttempts: number;
}

export interface AssignmentHost {
  ledger: AssignmentLedger;
  /** Planned transitions of this turn; read only. */
  transitions(): readonly PlannedTransition[];
  recoveryClaim?(): string | undefined;
  select(plan: TurnPlan, isCurrent: () => boolean, signal: AbortSignal): Promise<SelectionResult>;
  /**
   * Pi preparation of the target's context (compaction when needed). A
   * self-caused compaction increases the context revision through the
   * ledger; the transaction keeps its target and checks again. Check the
   * current prompt against each target's resolved input budget. Return ready
   * only after the prepared request fits. Persisted compaction remains
   * available to the next target.
   */
  prepare(target: string, signal: AbortSignal, request: PrepareRequest): Promise<PrepareOutcome>;
  /**
   * Resolved input budget of a target. Targets with the same budget have the
   * same preparation result for one context. Undefined compares by target.
   */
  inputBudget?(target: string): number | undefined;
}

export type RouteOutcome = { selections: number; preparation: PreparationRecord } & (
  | {
    kind: 'reserved';
    /** The prepared action. `decision.chosen` names the selection, which can differ. */
    target: string;
    reservation: Reservation;
    decision: UnifiedDecision;
  }
  | { kind: 'cancelled' }
  | { kind: 'stale' }
  | { kind: 'no-target'; decision?: UnifiedDecision }
  | { kind: 'preparation-failed'; target: string }
);

type RouteOutcomeBody = RouteOutcome extends infer O
  ? O extends unknown ? Omit<O, 'selections' | 'preparation'> : never
  : never;

/** One assignment transaction with at most one fresh selection after a stale result. */
export async function routeAssignment(host: AssignmentHost, signal: AbortSignal, maxSelections = 2): Promise<RouteOutcome> {
  let selections = 0;
  const preparation: PreparationRecord = { attempts: 0, failures: 0, errors: 0, compactionAttempts: 0 };
  // `${context revision}:${input budget}` of each failed preparation.
  const failed = new Set<string>();
  const failureKey = (target: string): string =>
    `${host.ledger.revisions.context}:${host.inputBudget?.(target) ?? target}`;
  let lastFailedTarget: string | undefined;
  const done = (outcome: RouteOutcomeBody): RouteOutcome =>
    ({ ...outcome, selections, preparation: { ...preparation } }) as RouteOutcome;

  selectionLoop: while (selections < maxSelections) {
    if (signal.aborted) return done({ kind: 'cancelled' });
    let plan = host.ledger.plan(host.transitions(), host.recoveryClaim?.());
    selections++;
    const result = await host.select(plan, () => host.ledger.isCurrent(plan), signal);
    if (signal.aborted || result.kind === 'cancelled') return done({ kind: 'cancelled' });
    if (result.kind === 'stale' || !host.ledger.isCurrent(plan)) continue;
    if (result.solver === 'no-feasible-action' || !result.chosen) return done({ kind: 'no-target', decision: result });
    const targets = [...new Set([result.chosen, ...result.ranking])];

    rankingLoop: for (;;) {
      for (const target of targets) {
        if (failed.has(failureKey(target))) continue;
        if (signal.aborted) return done({ kind: 'cancelled' });
        const allowCompaction = preparation.compactionAttempts < MAX_COMPACTION_ATTEMPTS;
        const contextBefore = host.ledger.revisions.context;
        preparation.attempts++;
        let prepared: PrepareOutcome;
        try {
          prepared = await host.prepare(target, signal, { allowCompaction });
        } catch {
          preparation.errors++;
          // The host can have started a summary request before the exception.
          prepared = { kind: 'failed', compactionAttempted: allowCompaction };
        }
        const compacted = prepared.compactionAttempted === true;
        if (compacted) preparation.compactionAttempts++;
        if (signal.aborted || prepared.kind === 'cancelled') return done({ kind: 'cancelled' });
        if (prepared.kind === 'failed') {
          failed.add(failureKey(target));
          preparation.failures++;
          lastFailedTarget = target;
        }
        // Persisted compaction belongs to the invocation, including when its
        // prompt did not fit this target. External revisions require selection.
        if (!sameRevisions({ ...plan.revisions, context: host.ledger.revisions.context }, host.ledger.revisions)) continue selectionLoop;
        plan = { ...plan, revisions: { ...host.ledger.revisions } };
        if (prepared.kind === 'failed') {
          // A compacted context can make an earlier, preferred target fit.
          // Restarts need a compaction attempt, so the attempt limit stops them.
          if (compacted && host.ledger.revisions.context !== contextBefore) continue rankingLoop;
          continue;
        }

        const reservation = host.ledger.commitAndReserve(plan, target, signal);
        if (!reservation) {
          if (signal.aborted) return done({ kind: 'cancelled' });
          continue selectionLoop;
        }
        return done({ kind: 'reserved', target, reservation, decision: result });
      }
      break;
    }
    return done({ kind: 'preparation-failed', target: lastFailedTarget ?? result.chosen });
  }
  return done({ kind: 'stale' });
}
