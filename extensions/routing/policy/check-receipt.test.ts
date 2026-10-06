import { describe, expect, it } from 'vitest';
import type { CheckReceipt } from './change-facts.js';
import { addReceipt, buildReceipt, parseCheckReport, receiptStrength, staleReceipts } from './check-receipt.js';

const snapshot = { status: 'measured', scope: 'git-worktree', digest: 'abc', files: 3 } as const;

describe('check receipts', () => {
  it('reads the counts of a node:test and a vitest summary', () => {
    expect(parseCheckReport('ℹ tests 12\nℹ pass 11\nℹ fail 1\nℹ skipped 0\n')).toMatchObject({ report: 'tap', tests: 12, passed: 11, failed: 1 });
    expect(parseCheckReport(' Tests  1 failed | 1524 passed | 1 skipped (1526)\n'))
      .toMatchObject({ report: 'vitest', tests: 1526, passed: 1524, failed: 1, skipped: 1 });
    expect(parseCheckReport('done').report).toBe('unknown');
  });

  it('gives an executor-run check partial strength and a run without tests none', () => {
    expect(receiptStrength('test', { report: 'tap', tests: 5, passed: 5, skipped: 0 })).toBe('partial');
    expect(receiptStrength('test', { report: 'tap', tests: 0 })).toBe('none');
    expect(receiptStrength('test', { report: 'vitest', tests: 3, skipped: 3 })).toBe('none');
    expect(receiptStrength('typecheck', { report: 'unknown' })).toBe('partial');
  });

  it('binds a receipt to the workspace and makes it stale after a later change', () => {
    const receipt = buildReceipt({ id: 'r1', kind: 'test', verdict: 'pass', output: 'ℹ tests 2\nℹ pass 2\n', snapshot });
    expect(receipt).toMatchObject({ strength: 'partial', freshness: 'current', outcome: 'unverified', snapshot: { digest: 'abc' } });
    const verdicts = addReceipt({ runsAfterHandoff: 0 }, receipt);
    const stale = staleReceipts(verdicts);
    expect((stale.receipts as CheckReceipt[])[0]!.freshness).toBe('stale');
  });
});
