import { describe, expect, it } from 'vitest';
import { enumerateEffectiveActions } from './actions.js';
import { usableWarmPrefix } from './cache.js';
import type { BenchmarkOutputEvidence } from './benchmark-output.js';
import { costFeature, predictCostProxy } from './spend.js';
import type { PriceSnapshot, SpendSnapshot, WarmPrefixEvidence } from './state.js';

const action = enumerateEffectiveActions({ provider: 'p', id: 'm', reasoning: false })[0]!;
const model: PriceSnapshot = { cost: { input: 10, output: 2, cacheRead: 1 }, promptCache: { short: 300 } };
const record = (tokens: number, hitProbability: number): WarmPrefixEvidence => ({
  tokens, hitProbability, observedAtMs: 1000, retention: 'short',
});
const state = (records: WarmPrefixEvidence[]): SpendSnapshot => ({
  estimatedContextTokens: 1000, nowMs: 2000, isSubagentSpawn: false, promptIdentity: 'head',
  cache: { promptIdentity: 'head', retention: 'short', warmPrefixes: new Map([[action.key, records]]) },
});
const measured = (tokensPerTask: number): BenchmarkOutputEvidence => ({ kind: 'measured', tokensPerTask, indexVersion: '4.3' });
const noOutput = measured(0);

describe('cache estimates and spend scenarios', () => {
  it.each([0.25, 1])('uses positive weight %s only for the central estimate, not for the hit and miss bounds', (probability) => {
    const snapshot = state([record(800, probability)]);
    const spend = predictCostProxy(snapshot, action, model, noOutput);
    expect(spend.tokens.cacheRead).toBe(800 * probability);
    expect(spend.centralUSD).toBeCloseTo(0.01 - 0.0072 * probability, 12);
    expect(spend.minUSD).toBeCloseTo(0.0028, 12);
    expect(spend.maxUSD).toBeCloseTo(0.01, 12);
  });

  it.each([0, -1, Number.NaN])('gives no possible hit for weight %s', (probability) => {
    const spend = predictCostProxy(state([record(800, probability)]), action, model, noOutput);
    expect(spend).toMatchObject({ tokens: { cacheRead: 0 }, cacheHitEstimate: 'none', centralUSD: 0.01, minUSD: 0.01, maxUSD: 0.01 });
  });

  it('uses the maximum central estimate and maximum possible prefix, not their sum', () => {
    // The zero-weight record is the largest; it must not set the hit bound.
    const records = [record(1000, 0), record(900, 0.2), record(400, 0.9), record(300, 1)];
    for (const ordered of [records, [...records].reverse(), [...records, records[1]!]]) {
      const spend = predictCostProxy(state(ordered), action, model, noOutput);
      expect(spend.tokens.cacheRead).toBe(360);
      expect(spend.centralUSD).toBeCloseTo(0.00676, 12);
      expect(spend.minUSD).toBeCloseTo(0.0019, 12);
      expect(spend.maxUSD).toBeCloseTo(0.01, 12);
    }
  });

  it('caps each prefix at the billed input before probability weighting', () => {
    const snapshot = { ...state([record(2000, 0.25)]), promptTokenScales: new Map([['p/m', 2]]) };
    const spend = predictCostProxy(snapshot, action, model, noOutput);
    expect(spend.tokens.cacheRead).toBe(500);
    expect(spend.centralUSD).toBeCloseTo(0.0155, 12);
    expect(spend.minUSD).toBeCloseTo(0.002, 12);
    expect(spend.maxUSD).toBeCloseTo(0.02, 12);
  });

  it.each(['expired', 'unknown'] as const)('gives no cache credit for %s retention', (kind) => {
    const snapshot = state([record(800, 1)]);
    const price = kind === 'unknown' ? { ...model, promptCache: undefined } : model;
    const aged = kind === 'expired' ? { ...snapshot, nowMs: 301000 } : snapshot;
    expect(usableWarmPrefix(aged, action, price).eligibility).toBe(kind === 'expired' ? 'expired' : 'ttl-unknown');
    expect(predictCostProxy(aged, action, price, noOutput)).toMatchObject({
      tokens: { cacheRead: 0 }, centralUSD: 0.01, minUSD: 0.01, maxUSD: 0.01,
    });
  });

  it.each([10, 20])('orders hit and miss costs when cache read costs %s per million', (cacheRead) => {
    const spend = predictCostProxy(state([record(800, 0.5)]), action, { ...model, cost: { input: 10, output: 0, cacheRead } }, noOutput);
    expect(spend.minUSD).toBeCloseTo(0.01, 12);
    expect(spend.centralUSD).toBeCloseTo(cacheRead === 10 ? 0.01 : 0.014, 12);
    expect(spend.maxUSD).toBeCloseTo(cacheRead === 10 ? 0.01 : 0.018, 12);
  });

  it('contains central cost across read prices, write prices and positive weights', () => {
    for (const cacheRead of [undefined, 0, 1, 10, 20]) {
      for (const cacheWrite of [undefined, 5, 15]) {
        for (const probability of [0.25, 1]) {
          const spend = predictCostProxy(state([record(800, probability)]), action,
            { ...model, cost: { input: 10, output: 2, cacheRead, cacheWrite } }, measured(100));
          expect(spend.minUSD).toBeLessThanOrEqual(spend.centralUSD!);
          if (cacheRead === undefined) expect(spend.maxUSD).toBeUndefined();
          else expect(spend.maxUSD).toBeGreaterThanOrEqual(spend.centralUSD!);
        }
      }
    }
  });

  it('gives no maximum cost when a hit is possible and the cache-read price is unknown', () => {
    const noRead = { ...model, cost: { input: 10, output: 2 } };
    const possible = predictCostProxy(state([record(800, 0.25)]), action, noRead, noOutput);
    expect(possible).toMatchObject({ centralUSD: 0.01, minUSD: 0.002, cacheReadPriceUnknown: true });
    expect(possible.maxUSD).toBeUndefined();
    const cost = costFeature(possible, noOutput);
    expect(cost.interval.lower).toBe(0);
    expect(cost.evidence.details).toContain('cache-read-price:unknown');
    // Without a possible hit the read price is not used, so the maximum stays known.
    const cold = predictCostProxy(state([record(800, 0)]), action, noRead, noOutput);
    expect(cold).toMatchObject({ centralUSD: 0.01, minUSD: 0.01, maxUSD: 0.01 });
    expect(cold.cacheReadPriceUnknown).toBeUndefined();
  });

  it('a missing output-token count keeps the prompt hit minimum and gives no central or maximum cost', () => {
    const missing: BenchmarkOutputEvidence = { kind: 'missing', reason: 'absent' };
    const spend = predictCostProxy(state([record(800, 0.25)]), action, model, missing);
    expect(spend.minUSD).toBeCloseTo(0.0028, 12);
    expect(spend.centralUSD).toBeUndefined();
    expect(spend.maxUSD).toBeUndefined();
    const best = 1 - Math.log10(0.0028 / 0.00001) / 6;
    const { interval } = costFeature(spend, missing);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeCloseTo(best, 12);
    expect(interval.center).toBeCloseTo(best / 2, 12);
  });
});
