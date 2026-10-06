import { describe, expect, it } from 'vitest';
import type { CheckReceipt } from './change-facts.js';
import { taskOutcome } from './outcome.js';

const receipt = (over: Partial<CheckReceipt>): CheckReceipt => ({
  id: 'r1', kind: 'test', verdict: 'pass', strength: 'partial', report: 'tap',
  snapshot: { status: 'measured', scope: 'git-worktree', digest: 'd1' }, freshness: 'current', outcome: 'unverified', ...over,
});

describe('taskOutcome', () => {
  it('leaves a task unverified when only the executor\'s own checks pass', () => {
    expect(taskOutcome({ receipts: [receipt({})] })).toBe('unverified');
    expect(taskOutcome({})).toBe('unverified');
  });

  it('takes pass and fail from an independent result', () => {
    expect(taskOutcome({ independent: { source: 'hidden-oracle', verdict: 'pass' } })).toBe('verified-pass');
    expect(taskOutcome({ independent: { source: 'hidden-oracle', verdict: 'fail' }, receipts: [receipt({})] })).toBe('verified-fail');
  });

  it('does not count a result for a different artifact, a failed grader, or a provider failure', () => {
    expect(taskOutcome({ independent: { source: 'hidden-oracle', verdict: 'pass', artifactDigest: 'a' }, finalDigest: 'b' })).toBe('unverified');
    expect(taskOutcome({ independent: { source: 'hidden-oracle', verdict: 'error' } })).toBe('environment-error');
    expect(taskOutcome({ providerFailure: true })).toBe('environment-error');
  });

  it('lets an accepted check that ran on the current artifact verify it', () => {
    expect(taskOutcome({ receipts: [receipt({ strength: 'contract' })] })).toBe('verified-pass');
    expect(taskOutcome({ receipts: [receipt({ strength: 'contract', freshness: 'stale' })] })).toBe('unverified');
  });
});
