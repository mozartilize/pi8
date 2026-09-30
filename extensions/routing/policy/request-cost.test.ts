import { describe, it, expect } from 'vitest';
import type { Usage } from '@earendil-works/pi-ai';
import { expectedRequestCost, observedRequestCost, requestBilled } from './request-cost.js';
import type { Candidate } from '../../types.js';

const candidate = (
  id: string,
  intelligence?: number,
  extra: Record<string, unknown> = {},
): Candidate =>
  ({
    registryId: id,
    provider: id.split('/')[0],
    id: id.split('/')[1],
    available: true,
    cost: { input: 1, output: 3 },
    bench: intelligence == null ? undefined : { quality: { intelligence }, ...extra },
  }) as Candidate;

function usage(input: number, output: number, extra: Partial<Usage> & { costTotal?: number } = {}): Usage {
  const { costTotal, ...rest } = extra;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    ...(costTotal == null ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal } }),
    ...rest,
  } as Usage;
}

describe('expectedRequestCost', () => {
  it('prices a request at the candidate registry rates', () => {
    expect(expectedRequestCost(candidate('test/a', 90), { input: 1_000, output: 80 }))
      .toBeCloseTo((1_000 * 1 + 80 * 3) / 1_000_000, 12);
  });

  it('uses complete benchmark pricing when registry pricing is absent', () => {
    const benchmarkPriced = candidate('test/benchmark-priced', 90, { priceInputPer1M: 2, priceOutputPer1M: 10 });
    benchmarkPriced.cost = undefined;
    expect(expectedRequestCost(benchmarkPriced, { input: 1_000, output: 80 }))
      .toBeCloseTo((1_000 * 2 + 80 * 10) / 1_000_000, 12);
  });

  it('does not treat zero-filled custom pricing as free, nor price an invalid shape', () => {
    const custom = candidate('test/custom', undefined);
    custom.cost = { input: 0, output: 0 };
    expect(expectedRequestCost(custom, { input: 1_000, output: 80 })).toBeUndefined();
    expect(expectedRequestCost(candidate('test/known', 90), { input: -1, output: 80 })).toBeUndefined();
  });

  it('keeps provider-specific free pricing authoritative over benchmark rates', () => {
    const freeVariant = candidate('test/free-variant', 90, { priceInputPer1M: 2, priceOutputPer1M: 10 });
    freeVariant.cost = { input: 0, output: 0 };
    expect(expectedRequestCost(freeVariant, { input: 1_000, output: 80 })).toBe(0);
  });
});

describe('observedRequestCost', () => {
  it('prices settled usage at candidate rates when the provider reports no cost', () => {
    expect(observedRequestCost(candidate('test/a', 90), usage(120, 30))).toBeCloseTo(120 / 1e6 + (30 * 3) / 1e6, 10);
  });

  it('uses the provider reported total when registry pricing is authoritative', () => {
    expect(observedRequestCost(candidate('test/a', 90), usage(120, 30, { costTotal: 0.123 }))).toBe(0.123);
  });

  it('uses benchmark pricing, and ignores a reported total, when registry pricing is absent', () => {
    const benchmarkPriced = candidate('test/a', 90, { priceInputPer1M: 2, priceOutputPer1M: 10 });
    benchmarkPriced.cost = undefined;
    expect(observedRequestCost(benchmarkPriced, usage(120, 30, { costTotal: 0.123 })))
      .toBeCloseTo((120 * 2 + 30 * 10) / 1e6, 10);
  });

  it('prices cache reads and writes only at authoritative registry cache rates', () => {
    const cached = candidate('test/a', 90);
    cached.cost = { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1.25 };
    expect(observedRequestCost(cached, usage(100, 10, { cacheRead: 1_000, cacheWrite: 200 })))
      .toBeCloseTo((100 * 1 + 10 * 3 + 1_000 * 0.1 + 200 * 1.25) / 1e6, 10);
  });

  it('leaves an unpriced request unknown and ignores malformed counts', () => {
    const custom = candidate('test/custom', undefined);
    custom.cost = { input: 0, output: 0 };
    expect(observedRequestCost(custom, usage(120, 30))).toBeUndefined();
    expect(observedRequestCost(undefined, usage(120, 30))).toBeUndefined();
    expect(observedRequestCost(candidate('test/a', 90), usage(-5, Number.NaN))).toBe(0);
  });
});

describe('requestBilled', () => {
  it('marks providers that bill per request by registry id', () => {
    expect(requestBilled('github-copilot/gpt-5.4')).toBe(true);
    expect(requestBilled('opencode-go/glm-5.2')).toBe(false);
  });
});
