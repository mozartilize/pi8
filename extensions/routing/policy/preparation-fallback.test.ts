import { describe, expect, it } from 'vitest';
import type { UnifiedDecision } from '../optimization/select.js';
import {
  AssignmentLedger, MAX_COMPACTION_ATTEMPTS, routeAssignment,
  type AssignmentHost, type PrepareOutcome, type PrepareRequest,
} from './assignment-transaction.js';

const decision = (ranking: string[]): UnifiedDecision => ({
  kind: 'decision', solver: 'exact', domainStatus: 'ready', constraintsEnforced: true,
  chosen: ranking[0], ranking, profileDigest: 'd1', featureSchemaDigest: 'f',
  actions: [], insufficientEvidence: [], allInsufficient: false,
});

interface ProbeOptions {
  promptTokens?: number;
  budgets?: Record<string, number>;
  ranking?: string[];
  /** Summary request numbers (1-based) that fail. */
  failedSummaries?: (summary: number) => boolean;
  /** Prompt size after a successful compaction. */
  compactTo?: number;
}

/**
 * A controlled host. A target fits when the prompt is within its budget. A
 * target that does not fit starts a summary request when compaction is
 * allowed. A successful summary persists a smaller context.
 */
function makeHost(options: ProbeOptions = {}) {
  const ledger = new AssignmentLedger({
    workItemId: 'W', branchId: 'b1', session: 1, profile: 1,
    profileDigest: 'd1', authorization: 1, context: 1,
  });
  const budgets = options.budgets ?? { B: 272_000, C: 512_000 };
  const state = { promptTokens: options.promptTokens ?? 400_000, summaries: 0, compactions: 0, selections: 0 };
  const attempts: { target: string; allowCompaction: boolean }[] = [];
  let hook: (target: string) => PrepareOutcome | undefined = () => undefined;
  let selected = decision(options.ranking ?? ['B', 'C']);
  const host: AssignmentHost = {
    ledger,
    transitions: () => [{ kind: 'record-decision', value: 'selected' }],
    select: async () => { state.selections++; return selected; },
    inputBudget: (target) => budgets[target],
    prepare: async (target, _signal, request: PrepareRequest) => {
      attempts.push({ target, allowCompaction: request.allowCompaction });
      const hooked = hook(target);
      if (hooked) return hooked;
      if (state.promptTokens <= budgets[target]!) return { kind: 'ready' };
      if (!request.allowCompaction) return { kind: 'failed' };
      state.summaries++;
      if (options.failedSummaries?.(state.summaries)) return { kind: 'failed', compactionAttempted: true };
      state.compactions++;
      state.promptTokens = options.compactTo ?? 20_000;
      ledger.bump({ context: ledger.revisions.context + 1 });
      return { kind: state.promptTokens <= budgets[target]! ? 'ready' : 'failed', compactionAttempted: true };
    },
  };
  return {
    host, ledger, state,
    targets: () => attempts.map((attempt) => attempt.target),
    attempts,
    setHook: (next: typeof hook) => { hook = next; },
    setRanking: (ranking: string[]) => { selected = decision(ranking); },
  };
}

const signal = () => new AbortController().signal;

describe('preparation fallback from one selection', () => {
  it.each([512_000, 200_000])('B summary failure checks C against its %i-token budget', async (cBudget) => {
    const probe = makeHost({ budgets: { B: 272_000, C: cBudget }, failedSummaries: (n) => n === 1 });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'C', reservation: { target: 'C' }, selections: 1 });
    expect(probe.targets()).toEqual(['B', 'C']);
    expect(probe.state.summaries).toBe(cBudget === 512_000 ? 1 : 2);
    expect(probe.state.compactions).toBe(cBudget === 512_000 ? 0 : 1);
    expect(outcome.preparation).toEqual({
      attempts: 2, failures: 1, errors: 0, compactionAttempts: cBudget === 512_000 ? 1 : 2,
    });
    expect(probe.ledger.applied).toHaveLength(1);
    expect(probe.ledger.reservations.size).toBe(1);
    if (outcome.kind !== 'reserved') throw new Error('No prepared reservation');
    // The selection evidence names B; only the target names the prepared action.
    expect(outcome.decision.chosen).toBe('B');
    const served: string[] = [];
    probe.ledger.dispatch(outcome.reservation.id, (receipt) => served.push(receipt.target));
    expect(served).toEqual(['C']);
  });

  it('successful B compaction keeps B and does not prepare C', async () => {
    const probe = makeHost();
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'B', selections: 1 });
    expect(probe.targets()).toEqual(['B']);
    expect(probe.state.compactions).toBe(1);
  });

  it('C uses persisted context when the compacted prompt still exceeds B', async () => {
    const probe = makeHost({ compactTo: 300_000 });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'C', reservation: { revisions: { context: 2 } }, selections: 1 });
    expect(probe.targets()).toEqual(['B', 'C']);
    expect(probe.state.compactions).toBe(1);
  });

  it('a compaction for C that makes the preferred B fit serves B', async () => {
    const probe = makeHost({ budgets: { B: 272_000, C: 200_000 }, failedSummaries: (n) => n === 1, compactTo: 250_000 });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'B', selections: 1 });
    expect(probe.targets()).toEqual(['B', 'C', 'B']);
    expect(outcome.preparation).toMatchObject({ attempts: 3, failures: 2, compactionAttempts: 2 });
  });

  it('effort variants with the same budget start one summary request', async () => {
    const probe = makeHost({
      ranking: ['B:high', 'B:medium', 'B:low', 'C'],
      budgets: { 'B:high': 272_000, 'B:medium': 272_000, 'B:low': 272_000, C: 200_000 },
      failedSummaries: () => true,
    });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'preparation-failed', target: 'C' });
    expect(probe.targets()).toEqual(['B:high', 'C']);
    expect(probe.state.summaries).toBe(2);
  });

  it('the attempt limit stops summaries but still serves a target that fits', async () => {
    const probe = makeHost({
      ranking: ['B', 'C', 'D', 'E'],
      budgets: { B: 272_000, C: 200_000, D: 150_000, E: 600_000 },
      failedSummaries: () => true,
    });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'E' });
    expect(probe.state.summaries).toBe(MAX_COMPACTION_ATTEMPTS);
    expect(probe.attempts).toEqual([
      { target: 'B', allowCompaction: true },
      { target: 'C', allowCompaction: true },
      { target: 'D', allowCompaction: false },
      { target: 'E', allowCompaction: false },
    ]);
    expect(outcome.preparation).toEqual({ attempts: 4, failures: 3, errors: 0, compactionAttempts: 2 });
  });

  it('compactions that never fit any target end after the attempt limit', async () => {
    const probe = makeHost({ budgets: { B: 272_000, C: 250_000 }, compactTo: 300_000 });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'preparation-failed', selections: 1 });
    expect(probe.state.summaries).toBe(MAX_COMPACTION_ATTEMPTS);
    expect(probe.attempts.filter((attempt) => attempt.allowCompaction)).toHaveLength(MAX_COMPACTION_ATTEMPTS);
    expect(probe.ledger.applied).toEqual([]);
    expect(probe.ledger.reservations.size).toBe(0);
  });

  it('all preparation failures make no assignment write or reservation', async () => {
    const probe = makeHost({ budgets: { B: 272_000, C: 200_000 }, failedSummaries: () => true });
    expect(await routeAssignment(probe.host, signal())).toMatchObject({ kind: 'preparation-failed', target: 'C', selections: 1 });
    expect(probe.targets()).toEqual(['B', 'C']);
    expect(probe.ledger.applied).toEqual([]);
    expect(probe.ledger.reservations.size).toBe(0);
  });

  it('a preparation exception counts as an error and a compaction attempt', async () => {
    const probe = makeHost();
    probe.setHook((target) => { if (target === 'B') throw new Error('Summary failed'); return undefined; });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'C' });
    expect(outcome.preparation).toEqual({ attempts: 2, failures: 1, errors: 1, compactionAttempts: 1 });
  });

  it.each(['cancelled', 'failed', 'throw'] as const)('cancellation wins over a %s preparation outcome and starts no C', async (kind) => {
    const probe = makeHost();
    const controller = new AbortController();
    probe.setHook(() => {
      controller.abort();
      if (kind === 'throw') throw new Error('Cancelled summary');
      return { kind };
    });
    expect(await routeAssignment(probe.host, controller.signal)).toMatchObject({ kind: 'cancelled', selections: 1 });
    expect(probe.targets()).toEqual(['B']);
    expect(probe.ledger.applied).toEqual([]);
    expect(probe.ledger.reservations.size).toBe(0);
  });

  it('the one stale replan uses the compacted context and the preferred target', async () => {
    const probe = makeHost({ budgets: { B: 272_000, C: 200_000 }, failedSummaries: (n) => n === 1 });
    let changed = false;
    probe.setHook((target) => {
      if (target === 'C' && !changed) {
        changed = true;
        probe.ledger.bump({ profile: 2, profileDigest: 'd2' });
      }
      return undefined;
    });
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'B', reservation: { revisions: { profile: 2 } }, selections: 2 });
    expect(probe.targets()).toEqual(['B', 'C', 'B']);
    expect(probe.state.compactions).toBe(1);
    expect(probe.ledger.applied).toHaveLength(1);
    expect(probe.ledger.reservations.size).toBe(1);
  });

  it('a failed budget stays excluded through the replan when the context is unchanged', async () => {
    const probe = makeHost({ failedSummaries: () => true });
    probe.setHook((target) => {
      if (target === 'B' && probe.state.selections === 1) probe.ledger.bump({ profile: 2, profileDigest: 'd2' });
      return undefined;
    });
    expect(await routeAssignment(probe.host, signal())).toMatchObject({ kind: 'reserved', target: 'C', selections: 2 });
    expect(probe.targets()).toEqual(['B', 'C']);
    expect(probe.state.summaries).toBe(1);
  });

  it('duplicate ranking entries cannot repeat a failed preparation', async () => {
    const probe = makeHost({ budgets: { B: 272_000, C: 200_000 }, failedSummaries: () => true });
    probe.setRanking(['B', 'B', 'C', 'C']);
    expect(await routeAssignment(probe.host, signal())).toMatchObject({ kind: 'preparation-failed', target: 'C' });
    expect(probe.targets()).toEqual(['B', 'C']);
  });

  it('failed preparation does not consume a recovery claim; the C dispatch consumes it once', async () => {
    const probe = makeHost({ failedSummaries: (n) => n === 1 });
    probe.ledger.recovery.set('claim', 'eligible');
    probe.host.recoveryClaim = () => 'claim';
    const outcome = await routeAssignment(probe.host, signal());
    expect(outcome).toMatchObject({ kind: 'reserved', target: 'C' });
    expect(probe.ledger.recovery.get('claim')).toBe('eligible');
    if (outcome.kind !== 'reserved') throw new Error('No prepared reservation');
    const started: string[] = [];
    expect(probe.ledger.dispatch(outcome.reservation.id, (receipt) => started.push(receipt.target))).toMatchObject({ target: 'C', recoveryNote: 'recovery:claim' });
    expect(probe.ledger.dispatch(outcome.reservation.id, () => started.push('duplicate'))).toBeUndefined();
    expect(started).toEqual(['C']);
    expect(probe.ledger.recovery.get('claim')).toBe('consumed');
  });
});
