/**
 * Receipts of observed verifier runs. A receipt records what ran, what it
 * reported, and which workspace version it ran against. It never records the
 * command, a path, or a test name. A receipt shows that a check ran; it does
 * not show that the check covers the request.
 */
import type { CheckReceipt, CheckStrength, CheckVerdict, CheckVerdicts, WorkspaceSnapshot } from './change-facts.js';

/** The run summary is at the end of the output; only that part is read. */
const SUMMARY_WINDOW = 20_000;
/** Receipts kept for one entry. */
const MAX_RECEIPTS = 8;

type Counts = Pick<CheckReceipt, 'report' | 'tests' | 'passed' | 'failed' | 'skipped' | 'cancelled'>;

const TAP_LINE = /^\s*(?:ℹ|#)\s*(tests|pass|fail|skipped|cancelled)\s+(\d+)\s*$/gim;
const VITEST_LINE = /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/im;

/** Read the counts of a node:test (TAP) or vitest summary. */
export function parseCheckReport(output: string): Counts {
  const text = output.slice(-SUMMARY_WINDOW);
  const tap: Record<string, number> = {};
  for (const match of text.matchAll(TAP_LINE)) tap[match[1]!.toLowerCase()] = Number(match[2]);
  if (tap.tests !== undefined) {
    return {
      report: 'tap',
      tests: tap.tests,
      ...(tap.pass !== undefined ? { passed: tap.pass } : {}),
      ...(tap.fail !== undefined ? { failed: tap.fail } : {}),
      ...(tap.skipped !== undefined ? { skipped: tap.skipped } : {}),
      ...(tap.cancelled !== undefined ? { cancelled: tap.cancelled } : {}),
    };
  }
  const vitest = VITEST_LINE.exec(text);
  if (vitest) {
    const part = (word: string): number | undefined => {
      const found = new RegExp(`(\\d+)\\s+${word}\\b`).exec(vitest[1]!);
      return found ? Number(found[1]) : undefined;
    };
    const passed = part('passed');
    const failed = part('failed');
    const skipped = part('skipped');
    return {
      report: 'vitest',
      tests: Number(vitest[2]),
      ...(passed !== undefined ? { passed } : {}),
      ...(failed !== undefined ? { failed } : {}),
      ...(skipped !== undefined ? { skipped } : {}),
    };
  }
  return { report: output.length > SUMMARY_WINDOW ? 'truncated' : 'unknown' };
}

/**
 * Strength of an observed run. A test run that executed nothing, or only
 * skipped tests, has none. Every other run is partial: the router cannot show
 * that a check covers the request, so it never reports `contract`.
 */
export function receiptStrength(kind: CheckReceipt['kind'], counts: Counts): CheckStrength {
  if (kind !== 'test' || counts.tests === undefined) return 'partial';
  const ran = counts.tests - (counts.skipped ?? 0) - (counts.cancelled ?? 0);
  return ran > 0 ? 'partial' : 'none';
}

export function buildReceipt(input: {
  id: string;
  kind: CheckReceipt['kind'];
  verdict: CheckVerdict;
  output: string;
  snapshot: WorkspaceSnapshot;
}): CheckReceipt {
  const counts = parseCheckReport(input.output);
  return {
    id: input.id,
    kind: input.kind,
    verdict: input.verdict,
    strength: receiptStrength(input.kind, counts),
    ...counts,
    snapshot: input.snapshot,
    freshness: input.snapshot.digest ? 'current' : 'unknown',
    outcome: 'unverified',
  };
}

/** Add a receipt, keeping the most recent ones. */
export function addReceipt(verdicts: CheckVerdicts, receipt: CheckReceipt): CheckVerdicts {
  return { ...verdicts, receipts: [...(verdicts.receipts ?? []), receipt].slice(-MAX_RECEIPTS) };
}

/** A later change to the workspace invalidates every earlier receipt. */
export function staleReceipts(verdicts: CheckVerdicts): CheckVerdicts {
  if (!verdicts.receipts?.some((receipt) => receipt.freshness === 'current')) return verdicts;
  return {
    ...verdicts,
    receipts: verdicts.receipts.map((receipt) => receipt.freshness === 'current' ? { ...receipt, freshness: 'stale' } : receipt),
  };
}
