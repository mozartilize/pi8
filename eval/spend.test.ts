import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attemptsFromDecisionLog, dedupeAttempts, historicalCost, normalizedCost, rawUsage, readRawUsage } from './spend.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-spend-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const attempt = (id: string, candidateKey: string, served: boolean, usage: boolean, price: Record<string, number>) => ({
  kind: 'attempt-usage',
  attemptUsage: {
    usageEventId: id, provider: candidateKey.split('/')[0], modelId: candidateKey.split('/')[1]?.split(':')[0], candidateKey, served,
    ...(usage ? { usage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 } } : {}),
    usageComplete: usage, price,
  },
});

function writeLog(records: unknown[]): string {
  const path = join(dir, 'decisions.jsonl');
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n'));
  return path;
}

describe('attempt-level usage', () => {
  // The first model fails and the second serves. Each attempt keeps its own model and price.
  const log = () => writeLog([
    attempt('a1', 'alpha/big:high', false, true, { input: 10, output: 40 }),
    attempt('a2', 'beta/small:low', true, true, { input: 1, output: 4 }),
    attempt('a1', 'alpha/big:high', false, true, { input: 10, output: 40 }),
  ]);

  it('keeps the failed attempt on its own model and marks it as a fallback', () => {
    const attempts = dedupeAttempts(attemptsFromDecisionLog(log()));
    expect(attempts.map((item) => [item.provider, item.outcome, item.servedEffort])).toEqual([['alpha', 'fallback', 'high'], ['beta', 'served', 'low']]);
  });

  it('prices each attempt at its own price and re-prices all attempts with one table', () => {
    const { attempts } = readRawUsage({ decisionLogPath: log() });
    // alpha: 1M*10 + 0.1M*40 = 14. beta: 1M*1 + 0.1M*4 = 1.4.
    expect(historicalCost(attempts)).toMatchObject({ computedUsd: expect.closeTo(15.4, 9), complete: true });
    const flat = { alpha: { inputPer1M: 2, outputPer1M: 2 }, beta: { inputPer1M: 2, outputPer1M: 2 } };
    const table = { digest: 'table-1', prices: { 'alpha/big': flat.alpha, 'beta/small': flat.beta } };
    // Each attempt: 1M*2 + 0.1M*2 = 2.2.
    expect(normalizedCost(attempts, table)).toEqual({ registryPriceDigest: 'table-1', computedUsd: expect.closeTo(4.4, 9), complete: true });
  });

  it('keeps missing usage incomplete and never turns it into zero', () => {
    const path = writeLog([attempt('a1', 'alpha/big', false, false, { input: 10, output: 40 }), attempt('a2', 'beta/small', true, true, { input: 1, output: 4 })]);
    const usage = readRawUsage({ decisionLogPath: path });
    expect(usage.spendIncomplete).toBe(true);
    const view = historicalCost(usage.attempts);
    expect(view.complete).toBe(false);
    expect(view.computedUsd).toBeCloseTo(1.4, 9);
    expect(rawUsage([]).spendIncomplete).toBe(true);
  });

  it('reads a run without the router from the session', () => {
    const session = join(dir, 's.jsonl');
    writeFileSync(session, `${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } })}\n`);
    const usage = readRawUsage({ sessionPath: session });
    expect(usage).toMatchObject({ spendIncomplete: false, attempts: [{ source: 'main-agent', candidateKey: 'p/m', inputTokens: 5, providerReportedUsd: 0.1 }] });
  });
});
