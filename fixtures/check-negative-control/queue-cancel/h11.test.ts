import { describe, expect, it } from 'vitest';
import { taskOutcome } from '../../../extensions/routing/policy/outcome.js';
import { cancelFreesSlotCheck, weakCancelCheck } from './checks.mjs';
import { JobQueue as Correct } from './correct-queue.mjs';
import { JobQueue as Faulty } from './faulty-queue.mjs';

// The queue H11 negative control: a self-written check passes a faulty
// implementation, and only the independent assertion fails it.
const ran = (check: (queue: unknown) => Promise<void>, queue: unknown) => check(queue).then(() => 'pass', () => 'fail');

describe('queue H11 negative control', () => {
  it('passes the weak check and fails the independent check for the faulty queue', async () => {
    expect(await ran(weakCancelCheck, Faulty)).toBe('pass');
    expect(await ran(cancelFreesSlotCheck, Faulty)).toBe('fail');
  });

  it('passes both checks for the correct queue', async () => {
    expect(await ran(weakCancelCheck, Correct)).toBe('pass');
    expect(await ran(cancelFreesSlotCheck, Correct)).toBe('pass');
  });

  it('labels the faulty queue unverified after its own check and verified-fail after the independent one', () => {
    expect(taskOutcome({})).toBe('unverified');
    expect(taskOutcome({ independent: { source: 'hidden-oracle', verdict: 'fail' } })).toBe('verified-fail');
  });
});
