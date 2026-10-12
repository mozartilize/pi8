/**
 * Transaction contracts against a controlled host (testing plan H1, H2, H4,
 * and the H6 revision rules). The oracle is an explicit state trace:
 * observed -> eligible -> planned -> reserved -> dispatched/consumed.
 */
import { describe, expect, it } from 'vitest';

import type { SelectionResult, UnifiedDecision } from '../optimization/select.js';
import {
  AssignmentLedger,
  routeAssignment,
  type AssignmentHost,
  type AssignmentRevisions,
  type PrepareOutcome,
  type TurnPlan,
} from './assignment-transaction.js';
import { authorizedFallbacks, settleBoundary, type BoundaryAuthorizationV1 } from './boundary-authorization.js';

const REVISIONS: AssignmentRevisions = {
  workItemId: 'W', branchId: 'b1', session: 1, profile: 1, profileDigest: 'd1', authorization: 3, context: 1,
};

const decision = (chosen: string, ranking = [chosen]): UnifiedDecision => ({
  kind: 'decision', solver: 'exact', domainStatus: 'ready', constraintsEnforced: true, chosen, ranking,
  profileDigest: 'd1', featureSchemaDigest: 'f', actions: [], insufficientEvidence: [], allInsufficient: false,
});

interface Deferred { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

class FakeHost implements AssignmentHost {
  readonly ledger = new AssignmentLedger(REVISIONS);
  selections: TurnPlan[] = [];
  compactions = 0;
  /** Prompt tokens of the current context; compaction makes it fit. */
  promptTokens = 100_000;
  claim?: string;
  choices: string[] = ['B'];
  beforeSelectReturns?: (call: number) => Promise<void> | void;
  prepareHook?: (target: string) => Promise<PrepareOutcome | void> | PrepareOutcome | void;
  windows: Record<string, number> = { A: 1_000_000, B: 272_000 };

  transitions() { return [{ kind: 'enter-phase' as const, value: 'implement' }, { kind: 'record-decision' as const, value: 'd' }]; }
  recoveryClaim() { return this.claim; }

  async select(plan: TurnPlan, isCurrent: () => boolean, signal: AbortSignal): Promise<SelectionResult> {
    this.selections.push(plan);
    await this.beforeSelectReturns?.(this.selections.length);
    if (signal.aborted) return { kind: 'cancelled' };
    if (!isCurrent()) return { kind: 'stale' };
    return decision(this.choices[Math.min(this.selections.length - 1, this.choices.length - 1)]!);
  }

  async prepare(target: string, signal: AbortSignal): Promise<PrepareOutcome> {
    const hooked = await this.prepareHook?.(target);
    if (hooked) return hooked;
    if (signal.aborted) return { kind: 'cancelled' };
    if (this.promptTokens <= this.windows[target]!) return { kind: 'ready' };
    this.compactions++;
    this.promptTokens = 20_000;
    this.ledger.bump({ context: this.ledger.revisions.context + 1 });
    return { kind: 'ready', compactionAttempted: true };
  }
}

describe('H1: recovery and observations across a stale replan', () => {
  it('writes nothing before commit, retries once after a revision change, and consumes the claim only at dispatch', async () => {
    const host = new FakeHost();
    host.claim = 'rework-1';
    host.ledger.recovery.set('rework-1', 'eligible');
    const gate = deferred();
    host.beforeSelectReturns = async (call) => {
      if (call !== 1) return;
      // Assignment writes are deferred while the first selection is in flight.
      expect(host.ledger.applied).toEqual([]);
      expect(host.ledger.recovery.get('rework-1')).toBe('eligible');
      host.ledger.bump({ profile: 2, profileDigest: 'd2' });
      await gate.promise;
    };
    host.promptTokens = 10_000;
    const pending = routeAssignment(host, new AbortController().signal);
    gate.resolve();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'reserved', selections: 2 });
    if (outcome.kind !== 'reserved') throw new Error('unreachable');
    expect(host.ledger.applied).toHaveLength(2);
    // Reservation does not consume eligibility.
    expect(host.ledger.recovery.get('rework-1')).toBe('eligible');
    const starts: string[] = [];
    const receipt = host.ledger.dispatch(outcome.reservation.id, (r) => starts.push(r.target));
    expect(receipt).toMatchObject({ target: 'B', recoveryNote: 'recovery:rework-1' });
    expect(host.ledger.recovery.get('rework-1')).toBe('consumed');
    expect(starts).toEqual(['B']);
  });

  it('allows at most two selections and makes no write when every snapshot goes stale', async () => {
    const host = new FakeHost();
    host.beforeSelectReturns = () => host.ledger.bump({ session: host.ledger.revisions.session + 1 });
    expect(await routeAssignment(host, new AbortController().signal)).toMatchObject({ kind: 'stale', selections: 2 });
    expect(host.ledger.applied).toEqual([]);
    expect(host.ledger.reservations.size).toBe(0);
  });

  it('cancellation during selection or preparation consumes nothing and starts no retry', async () => {
    for (const where of ['select', 'prepare'] as const) {
      const host = new FakeHost();
      host.claim = 'c';
      host.ledger.recovery.set('c', 'eligible');
      const controller = new AbortController();
      if (where === 'select') host.beforeSelectReturns = () => controller.abort();
      else host.prepareHook = () => { controller.abort(); };
      expect(await routeAssignment(host, controller.signal)).toMatchObject({ kind: 'cancelled', selections: 1 });
      expect(host.ledger.recovery.get('c')).toBe('eligible');
      expect(host.ledger.applied).toEqual([]);
      expect(host.compactions).toBe(0);
    }
  });

  it('a started recovery attempt that fails keeps the claim consumed; two reservations cannot both dispatch it', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.recovery.set('c', 'eligible');
    const first = ledger.commitAndReserve(ledger.plan([], 'c'), 'B')!;
    const second = ledger.commitAndReserve(ledger.plan([], 'c'), 'C')!;
    expect(ledger.dispatch(first.id, () => { /* the provider attempt starts, then fails */ })).toBeDefined();
    expect(ledger.recovery.get('c')).toBe('consumed');
    const started: string[] = [];
    expect(ledger.dispatch(second.id, (r) => started.push(r.target))).toBeUndefined();
    expect(started).toEqual([]);
  });

  it('a non-recovery dispatch does not consume another claim', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.recovery.set('c', 'eligible');
    const plain = ledger.commitAndReserve(ledger.plan([]), 'B')!;
    expect(ledger.dispatch(plain.id, () => {})?.recoveryNote).toBeUndefined();
    expect(ledger.recovery.get('c')).toBe('eligible');
  });
});

describe('H2: single-use reservation and final dispatch check', () => {
  it('applies deferred transitions once and rejects a second dispatch of the same reservation', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    const plan = ledger.plan([{ kind: 'record-decision', value: 'x' }]);
    const reservation = ledger.commitAndReserve(plan, 'B')!;
    expect(ledger.applied).toEqual([{ kind: 'record-decision', value: 'x' }]);
    let starts = 0;
    expect(ledger.dispatch(reservation.id, () => starts++)).toBeDefined();
    expect(ledger.dispatch(reservation.id, () => starts++)).toBeUndefined();
    expect(starts).toBe(1);
  });

  it.each([
    ['authorization', { authorization: 4 }],
    ['profile', { profile: 2 }],
    ['work branch', { branchId: 'b2' }],
    ['context', { context: 2 }],
  ] as const)('starts no provider call when the %s revision changes between reservation and dispatch', (_, patch) => {
    const ledger = new AssignmentLedger(REVISIONS);
    const reservation = ledger.commitAndReserve(ledger.plan([]), 'B')!;
    ledger.bump(patch);
    let starts = 0;
    expect(ledger.dispatch(reservation.id, () => starts++)).toBeUndefined();
    expect(starts).toBe(0);
    expect(ledger.reservations.get(reservation.id)!.state).toBe('released');
  });

  it('commit against a captured but outdated plan fails', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    const plan = ledger.plan([{ kind: 'enter-phase', value: 'implement' }]);
    ledger.bump({ authorization: 4 });
    expect(ledger.commitAndReserve(plan, 'B')).toBeUndefined();
    expect(ledger.applied).toEqual([]);
  });

  it('commit then cancellation before dispatch keeps ownership pending and release pending', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.boundary = auth();
    ledger.releasePending = true;
    const reservation = ledger.commitAndReserve(ledger.plan([]), 'B:high')!;
    const controller = new AbortController();
    controller.abort();
    expect(ledger.dispatch(reservation.id, () => {}, controller.signal)).toBeUndefined();
    expect(ledger.boundary.state).toBe('pending');
    expect(ledger.releasePending).toBe(true);
  });
});

const auth = (patch: Partial<BoundaryAuthorizationV1> = {}): BoundaryAuthorizationV1 => ({
  boundaryId: 'bd', workItemId: 'W', phase: 'implement', assignmentId: 'as1', revision: 3,
  allowedActors: ['a/A:high', 'b/B:high'], state: 'pending', ...patch,
});

describe('H4: settlement needs a current actual-serve receipt from an authorized actor', () => {
  const receipt = (actualServed: string, patch: Partial<Parameters<typeof settleBoundary>[1] & object> = {}) =>
    ({ boundaryId: 'bd', assignmentId: 'as1', revision: 3, actualServed, answered: true, ...patch });

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

  it('an excluded executor cannot return through fallback, and chain order grants nothing', () => {
    const excluded = auth({ excludedModels: ['a/A'] });
    expect(authorizedFallbacks(excluded, ['c/C:high', 'a/A:high', 'b/B:high'])).toEqual(['b/B:high']);
    expect(settleBoundary(excluded, receipt('a/A:high')).state).toBe('pending');
  });

  it('only the ledger settle path releases the contract', () => {
    const ledger = new AssignmentLedger(REVISIONS);
    ledger.boundary = auth();
    ledger.releasePending = true;
    const reservation = ledger.commitAndReserve(ledger.plan([]), 'a/A:high')!;
    ledger.dispatch(reservation.id, () => {});
    expect(ledger.releasePending).toBe(true);
    expect(ledger.settle(receipt('a/A:high'))).toBe(true);
    expect(ledger.releasePending).toBe(false);
  });
});

describe('H6 revision rules: 1M incumbent to a 272k target', () => {
  it('a fitting prompt dispatches without compaction', async () => {
    const host = new FakeHost();
    host.promptTokens = 200_000;
    expect(await routeAssignment(host, new AbortController().signal)).toMatchObject({ kind: 'reserved', selections: 1 });
    expect(host.compactions).toBe(0);
  });

  it('a compactable oversized prompt: one selection, one compaction, target kept', async () => {
    const host = new FakeHost();
    host.promptTokens = 400_000;
    const outcome = await routeAssignment(host, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'reserved', selections: 1 });
    expect(host.compactions).toBe(1);
    expect(host.promptTokens).toBeLessThanOrEqual(host.windows.B!);
    if (outcome.kind === 'reserved') expect(outcome.reservation.target).toBe('B');
  });

  it('an external profile change during preparation uses one fresh selection on the prepared context, no second compaction', async () => {
    const host = new FakeHost();
    host.promptTokens = 400_000;
    let calls = 0;
    host.prepareHook = () => {
      if (calls++ === 0) host.ledger.bump({ profile: 2, profileDigest: 'd2' });
    };
    const outcome = await routeAssignment(host, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'reserved', selections: 2 });
    expect(host.compactions).toBe(1);
  });

  it('failed preparation sends nothing and makes no assignment write', async () => {
    const host = new FakeHost();
    host.prepareHook = () => ({ kind: 'failed' });
    expect(await routeAssignment(host, new AbortController().signal)).toMatchObject({ kind: 'preparation-failed', target: 'B', selections: 1 });
    expect(host.ledger.applied).toEqual([]);
    expect(host.ledger.reservations.size).toBe(0);
  });
});
