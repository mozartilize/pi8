/**
 * Reservation contracts of the assignment ledger. The oracle is an explicit
 * state trace: planned -> reserved -> dispatched or released.
 */
import { describe, expect, it } from 'vitest';

import { AssignmentLedger, type AssignmentRevisions } from './assignment-transaction.js';
import { settleBoundary, type BoundaryAuthorizationV1 } from './boundary-authorization.js';

const REVISIONS: AssignmentRevisions = {
  workItemId: 'W', branchId: 'b1', session: 1, profileDigest: 'd1', authorization: 3, context: 1,
};

describe('single-use reservation and final dispatch check', () => {
  it('rejects a second dispatch of the same reservation', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    const reservation = ledger.commitAndReserve(ledger.plan(), 'B')!;
    expect(ledger.dispatch(reservation.id)).toBe(true);
    expect(ledger.dispatch(reservation.id)).toBe(false);
  });

  it.each([
    ['authorization', { authorization: 4 }],
    ['profile', { profileDigest: 'd2' }],
    ['work branch', { branchId: 'b2' }],
    ['context', { context: 2 }],
  ] as const)('starts no provider call when the %s revision changes between reservation and dispatch', (_, patch) => {
    const ledger = new AssignmentLedger(REVISIONS);
    const reservation = ledger.commitAndReserve(ledger.plan(), 'B')!;
    ledger.bump(patch);
    expect(ledger.dispatch(reservation.id)).toBe(false);
    expect(ledger.reservations.get(reservation.id)!.state).toBe('released');
  });

  it('commit against a captured but outdated plan fails', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    const plan = ledger.plan();
    ledger.bump({ authorization: 4 });
    expect(ledger.commitAndReserve(plan, 'B')).toBeUndefined();
    expect(ledger.reservations.size).toBe(0);
  });

  it('commit then cancellation before dispatch keeps ownership pending', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.boundary = auth();
    const reservation = ledger.commitAndReserve(ledger.plan(), 'b/B:high')!;
    const controller = new AbortController();
    controller.abort();
    expect(ledger.dispatch(reservation.id, controller.signal)).toBe(false);
    expect(ledger.boundary.state).toBe('pending');
  });
});

const auth = (patch: Partial<BoundaryAuthorizationV1> = {}): BoundaryAuthorizationV1 => ({
  boundaryId: 'bd', workItemId: 'W', phase: 'implement', assignmentId: 'as1', revision: 3,
  allowedActors: ['a/A:high', 'b/B:high'], state: 'pending', ...patch,
});

describe('settlement needs a current actual-serve receipt from an authorized actor', () => {
  const receipt = (actualServed: string, patch: Partial<Parameters<typeof settleBoundary>[1] & object> = {}) =>
    ({ boundaryId: 'bd', workItemId: 'W', phase: 'implement' as const, assignmentId: 'as1', revision: 3, actualServed, answered: true, ...patch });

  it('an authorized fallback that actually serves settles; an answerless attempt does not', () => {
    expect(settleBoundary(auth(), receipt('a/A:high', { answered: false })).state).toBe('pending');
    expect(settleBoundary(auth(), receipt('b/B:high')).state).toBe('served');
  });

  it('an unauthorized actor, a higher effort of an authorized model or a stale receipt leaves ownership pending', () => {
    expect(settleBoundary(auth(), receipt('c/C:high')).state).toBe('pending');
    expect(settleBoundary(auth(), receipt('a/A:max')).state).toBe('pending');
    expect(settleBoundary(auth(), receipt('a/A:high', { revision: 2 })).state).toBe('pending');
    expect(settleBoundary(auth(), receipt('a/A:high', { assignmentId: 'old' })).state).toBe('pending');
  });

  it('an excluded executor cannot settle', () => {
    expect(settleBoundary(auth({ excludedModels: ['a/A'] }), receipt('a/A:high')).state).toBe('pending');
  });

  it('rejects a receipt from another work item or phase', () => {
    expect(settleBoundary(auth(), receipt('a/A:high', { workItemId: 'other' })).state).toBe('pending');
    expect(settleBoundary(auth(), receipt('a/A:high', { phase: 'review' })).state).toBe('pending');
  });

  it('rejects an unauthorized reservation', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.boundary = auth();
    expect(ledger.commitAndReserve(ledger.plan(), 'c/C:high')).toBeUndefined();
    expect(ledger.reservations.size).toBe(0);
  });

  it('checks permission again before dispatch', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.boundary = auth();
    const reservation = ledger.commitAndReserve(ledger.plan(), 'a/A:high')!;
    ledger.boundary = auth({ excludedModels: ['a/A'] });
    expect(ledger.dispatch(reservation.id)).toBe(false);
    expect(reservation.state).toBe('released');
  });

  it.each([
    { workItemId: 'other' }, { branchId: 'other' }, { session: 2 }, { authorization: 4 },
  ])('expires the boundary when the scope changes: %j', (patch) => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.boundary = auth();
    ledger.bump(patch);
    expect(ledger.boundary.state).toBe('expired');
    expect(ledger.canAssign('a/A:high')).toBe(false);
  });
});
