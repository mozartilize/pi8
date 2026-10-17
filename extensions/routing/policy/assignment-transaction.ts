/**
 * Single-use reservations of provider requests.
 *
 * - A plan records the live revisions. It writes no state.
 * - Commit creates one single-use reservation, after a check of every live
 *   revision and of the boundary authorization.
 * - Dispatch checks the reservation again before the provider attempt starts.
 *   A used, released, stale or cancelled reservation starts nothing.
 * - A change of work item, branch, session or authorization revision expires
 *   the boundary authorization.
 */
import { actorAllowedForBoundary, type BoundaryAuthorizationV1 } from './boundary-authorization.js';

export interface AssignmentRevisions {
  workItemId: string;
  branchId: string;
  session: number;
  profileDigest: string;
  authorization: number;
  /** Context revision; Pi compaction increases it. */
  context: number;
}

export interface TurnPlan {
  revisions: AssignmentRevisions;
}

export interface Reservation {
  id: string;
  target: string;
  revisions: AssignmentRevisions;
  state: 'reserved' | 'dispatched' | 'released';
}

const sameRevisions = (a: AssignmentRevisions, b: AssignmentRevisions): boolean =>
  a.workItemId === b.workItemId && a.branchId === b.branchId && a.session === b.session
  && a.profileDigest === b.profileDigest
  && a.authorization === b.authorization && a.context === b.context;

export class AssignmentLedger {
  revisions: AssignmentRevisions;
  readonly reservations = new Map<string, Reservation>();
  boundary?: BoundaryAuthorizationV1;
  private nextReservation = 0;

  constructor(revisions: AssignmentRevisions) {
    this.revisions = { ...revisions };
  }

  plan(): TurnPlan {
    return { revisions: { ...this.revisions } };
  }

  isCurrent(plan: Pick<TurnPlan, 'revisions'>): boolean {
    return sameRevisions(plan.revisions, this.revisions);
  }

  /** Record a revision change that the host caused or observed. */
  bump(patch: Partial<AssignmentRevisions>): void {
    const previous = this.revisions;
    this.revisions = { ...previous, ...patch };
    if (this.boundary && (previous.workItemId !== this.revisions.workItemId
      || previous.branchId !== this.revisions.branchId || previous.session !== this.revisions.session
      || previous.authorization !== this.revisions.authorization)) {
      this.boundary = { ...this.boundary, state: 'expired' };
    }
  }

  /** Hosts without a boundary keep their ordinary assignment behavior. */
  canAssign(target: string): boolean {
    return !this.boundary || (this.boundary.workItemId === this.revisions.workItemId
      && this.boundary.revision === this.revisions.authorization
      && actorAllowedForBoundary(this.boundary, target));
  }

  /** Atomic: check live revisions and permission, then reserve once. */
  commitAndReserve(plan: TurnPlan, target: string, signal?: AbortSignal): Reservation | undefined {
    if (signal?.aborted || !this.isCurrent(plan) || !this.canAssign(target)) return undefined;
    const reservation: Reservation = {
      id: `r${++this.nextReservation}`,
      target,
      revisions: { ...this.revisions },
      state: 'reserved',
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * Use a reservation for its provider attempt. Returns false, and the attempt
   * must not start, when the reservation is used, released, stale or cancelled.
   */
  dispatch(reservationId: string, signal?: AbortSignal): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.state !== 'reserved') return false;
    if (signal?.aborted || !sameRevisions(reservation.revisions, this.revisions) || !this.canAssign(reservation.target)) {
      reservation.state = 'released';
      return false;
    }
    reservation.state = 'dispatched';
    return true;
  }

  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation?.state === 'reserved') reservation.state = 'released';
  }
}
