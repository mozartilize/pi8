/**
 * H3 adapter contracts of the on-demand pre-output intervention: a switch
 * happens only when no output escaped during the solve; cancellation never
 * becomes a recovery; the abort is atomic with the final check. A
 * controlled no-output case proves the adapter does switch.
 */
import { describe, expect, it } from 'vitest';

import type { SelectionResult, UnifiedDecision } from '../optimization/select.js';
import { decidePreOutputIntervention, type AttemptEpoch, type LiveAttempt } from './pre-output-intervention.js';

class FakeAttempt implements LiveAttempt {
  readonly source = 'a/A:high';
  epochValue: AttemptEpoch = {
    attemptId: 'att1', sessionGeneration: 1, routingEpoch: 1, routingBoundaryId: 'bd', boundaryAuthorizationRevision: 3, outputRevision: 0, profileDigest: 'd1',
  };
  committed = false;
  aborted = false;
  /** Events the consumer saw. Buffered events of an aborted attempt never reach it. */
  readonly forwarded: string[] = [];
  buffered: string[] = [];
  removed = new Set<string>();

  epoch() { return { ...this.epochValue }; }
  outputCommitted() { return this.committed; }
  alreadyTried() { return false; }
  targetReachable(key: string) { return !this.removed.has(key); }

  /** The consumer reads one buffered event: visible output commits. */
  forwardNext() {
    const event = this.buffered.shift();
    if (!event) return;
    this.forwarded.push(event);
    this.committed = true;
    this.epochValue = { ...this.epochValue, outputRevision: this.epochValue.outputRevision + 1 };
  }

  tryAbortAndReserveTargetIfEpochMatches(expected: AttemptEpoch, target: string, signal: AbortSignal) {
    const live = this.epochValue;
    if (signal.aborted || this.committed || JSON.stringify(live) !== JSON.stringify(expected)) return undefined;
    this.aborted = true;
    this.buffered = [];
    return { id: `reserve:${target}` };
  }
}

const decision = (chosen: string, patch: Partial<UnifiedDecision> = {}): SelectionResult => ({
  kind: 'decision', solver: 'exact', domainStatus: 'ready', constraintsEnforced: true,
  chosen, ranking: [chosen, 'a/A:high', 'c/C:high'], profileDigest: 'd1', featureSchemaDigest: 'f', actions: [], insufficientEvidence: [], ...patch,
});

const reachable = ['a/A:high', 'b/B:high', 'c/C:high'];

describe('decidePreOutputIntervention', () => {
  it('switches before output when nothing escaped, discarding the buffered done of A', async () => {
    const live = new FakeAttempt();
    live.buffered = ['A-visible', 'A-done'];
    const result = await decidePreOutputIntervention(live, reachable, async () => decision('b/B:high'), new AbortController().signal);
    expect(result).toEqual({ kind: 'switch-before-output', target: 'b/B:high', reservationId: 'reserve:b/B:high', revisedChain: ['b/B:high', 'c/C:high'] });
    expect(live.aborted).toBe(true);
    expect(live.forwarded).toEqual([]);
    expect(live.buffered).toEqual([]);
  });

  it('keeps the current attempt when output was forwarded during the solve', async () => {
    const live = new FakeAttempt();
    live.buffered = ['A-visible', 'A-done'];
    const result = await decidePreOutputIntervention(live, reachable, async () => {
      live.forwardNext();
      return decision('b/B:high');
    }, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'continue-current' });
    expect(live.aborted).toBe(false);
    expect(live.forwarded).toEqual(['A-visible']);
  });

  it('queued but unconsumed output does not block the switch', async () => {
    const live = new FakeAttempt();
    const result = await decidePreOutputIntervention(live, reachable, async () => {
      live.buffered.push('A-visible-queued');
      return decision('b/B:high');
    }, new AbortController().signal);
    expect(result.kind).toBe('switch-before-output');
    expect(live.forwarded).toEqual([]);
  });

  it('user cancellation during the solve is cancelled, never a recovery, even if the selector returned a target', async () => {
    const live = new FakeAttempt();
    const controller = new AbortController();
    const result = await decidePreOutputIntervention(live, reachable, async () => {
      controller.abort();
      return decision('b/B:high');
    }, controller.signal);
    expect(result).toEqual({ kind: 'cancelled' });
    expect(live.aborted).toBe(false);
  });

  it('a solver failure continues the current attempt', async () => {
    const live = new FakeAttempt();
    const result = await decidePreOutputIntervention(live, reachable, async () => { throw new Error('solver'); }, new AbortController().signal);
    expect(result).toEqual({ kind: 'continue-current', reason: 'optimizer-unavailable' });
  });

  it.each([
    ['attempt or boundary changed', (live: FakeAttempt) => { live.epochValue = { ...live.epochValue, boundaryAuthorizationRevision: 4 }; }, 'attempt-or-work-changed'],
    ['routing epoch changed', (live: FakeAttempt) => { live.epochValue = { ...live.epochValue, routingEpoch: 2 }; }, 'attempt-or-work-changed'],
    ['routing boundary changed', (live: FakeAttempt) => { live.epochValue = { ...live.epochValue, routingBoundaryId: 'bd2' }; }, 'attempt-or-work-changed'],
    ['target removed', (live: FakeAttempt) => { live.removed.add('b/B:high'); }, 'target-changed'],
  ] as const)('does not switch when the %s during the solve', async (_, change, reason) => {
    const live = new FakeAttempt();
    const result = await decidePreOutputIntervention(live, reachable, async () => {
      change(live);
      return decision('b/B:high');
    }, new AbortController().signal);
    expect(result).toEqual({ kind: 'continue-current', reason });
    expect(live.aborted).toBe(false);
  });

  it('does not switch on an unenforced preference fallback or when the selector keeps the current action', async () => {
    const live = new FakeAttempt();
    expect(await decidePreOutputIntervention(live, reachable,
      async () => decision('b/B:high', { solver: 'fallback-central', constraintsEnforced: false }), new AbortController().signal))
      .toEqual({ kind: 'continue-current', reason: 'preference-domain-not-ready' });
    expect(await decidePreOutputIntervention(live, reachable, async () => decision('a/A:high'), new AbortController().signal))
      .toEqual({ kind: 'continue-current', reason: 'switch-not-warranted' });
  });

  it('passes the current attempt to the selector so keeping it is a legal answer', async () => {
    const live = new FakeAttempt();
    let pool: readonly string[] = [];
    await decidePreOutputIntervention(live, reachable, async (remaining) => { pool = remaining; return decision('a/A:high'); }, new AbortController().signal);
    expect(pool).toEqual(['a/A:high', 'b/B:high', 'c/C:high']);
  });
});
