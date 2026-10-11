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

export type PrepareOutcome =
  | { kind: 'ready' }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

export interface AssignmentHost {
  ledger: AssignmentLedger;
  /** Planned transitions of this turn; read only. */
  transitions(): readonly PlannedTransition[];
  recoveryClaim?(): string | undefined;
  select(plan: TurnPlan, isCurrent: () => boolean, signal: AbortSignal): Promise<SelectionResult>;
  /**
   * Pi preparation of the target's context (compaction when needed). A
   * self-caused compaction increases the context revision through the
   * ledger; the transaction keeps its target and checks again.
   */
  prepare(target: string, signal: AbortSignal): Promise<PrepareOutcome>;
}

export type RouteOutcome =
  | { kind: 'reserved'; reservation: Reservation; decision: UnifiedDecision; selections: number }
  | { kind: 'cancelled'; selections: number }
  | { kind: 'stale'; selections: number }
  | { kind: 'no-target'; decision?: UnifiedDecision; selections: number }
  | { kind: 'preparation-failed'; target: string; selections: number };

/** One assignment transaction with at most one fresh selection after a stale result. */
export async function routeAssignment(host: AssignmentHost, signal: AbortSignal, maxSelections = 2): Promise<RouteOutcome> {
  let selections = 0;
  while (selections < maxSelections) {
    if (signal.aborted) return { kind: 'cancelled', selections };
    let plan = host.ledger.plan(host.transitions(), host.recoveryClaim?.());
    selections++;
    const result = await host.select(plan, () => host.ledger.isCurrent(plan), signal);
    if (signal.aborted || result.kind === 'cancelled') return { kind: 'cancelled', selections };
    if (result.kind === 'stale' || !host.ledger.isCurrent(plan)) continue;
    if (result.solver === 'no-feasible-action' || !result.chosen) return { kind: 'no-target', decision: result, selections };
    const target = result.chosen;

    const prepared = await host.prepare(target, signal);
    if (signal.aborted || prepared.kind === 'cancelled') return { kind: 'cancelled', selections };
    if (prepared.kind === 'failed') return { kind: 'preparation-failed', target, selections };
    // A self-caused context revision keeps the target: rebase the plan on the
    // prepared context only when nothing else changed.
    if (!sameRevisions({ ...plan.revisions, context: host.ledger.revisions.context }, host.ledger.revisions)) continue;
    plan = { ...plan, revisions: { ...host.ledger.revisions } };

    const reservation = host.ledger.commitAndReserve(plan, target, signal);
    if (!reservation) {
      if (signal.aborted) return { kind: 'cancelled', selections };
      continue;
    }
    return { kind: 'reserved', reservation, decision: result, selections };
  }
  return { kind: 'stale', selections };
}
