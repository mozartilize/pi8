import { describe, expect, it } from 'vitest';
import { pickBest } from './scorer.js';
import { candidate, benchRow } from '../../test-support/router-fixtures.js';
import type { Candidate } from '../../types.js';

function model(id: string, quality: NonNullable<Candidate['bench']>['quality'] = { intelligence: 30 }): Candidate {
  return candidate(id, { bench: { ...benchRow(id), quality } });
}

describe('request-shape capability and speed', () => {
  it.each([
    [{ estimatedContextTokens: 64_000 }, 'longContext', 'below-longContext-minimum'],
    [{ estimatedContextTokens: 1_000, needsVision: true }, 'visionReasoning', 'below-visionReasoning-minimum'],
  ] as const)('keeps measured weakness behind unknown and measured suitability: %s', (opts, axis, reason) => {
    const good = model('p/good', { intelligence: 30, [axis]: 0.30 });
    const weak = model('p/weak', { intelligence: 100, [axis]: 0.29 });
    const unknown = model('p/unknown', { intelligence: 100 });
    const decision = pickBest([weak, unknown, good], 'gather', undefined, opts);
    expect(decision.fallbackChain).toEqual(['p/good', 'p/unknown', 'p/weak']);
    expect(decision.candidateDiagnostics).toContainEqual({ candidateKey: 'p/weak', excludedReason: reason });
  });

  it('does not apply long-context or visual correctness minimums to a short text request', () => {
    const high = model('p/high', { intelligence: 60, longContext: 0, visionReasoning: 0 });
    expect(pickBest([high], 'gather', undefined, { estimatedContextTokens: 63_999 }).candidateDiagnostics).toBeUndefined();
  });

  it('compares measured time per task instead of token throughput when coverage is complete', () => {
    const slow = model('p/slow'); slow.bench!.timePerTaskSeconds = 100; slow.bench!.outputSpeedTps = 100;
    const fast = model('p/fast'); fast.bench!.timePerTaskSeconds = 10; fast.bench!.outputSpeedTps = 1;
    expect(pickBest([slow, fast], 'gather', { quality: 0, cost: 0, speed: 1 }).chosen).toBe('p/fast');
    expect(pickBest([slow, fast], 'gather', { quality: 0, cost: 0, speed: 0 }).chosen).toBe('p/fast');
    delete slow.bench!.timePerTaskSeconds;
    expect(pickBest([slow, fast], 'gather', { quality: 0, cost: 0, speed: 1 }).chosen).toBe('p/slow');
  });

  it('does not let a weaker fallback erase time-per-task coverage for the preferred tier', () => {
    const fast = model('p/fast'); fast.bench!.timePerTaskSeconds = 10;
    const slow = model('p/slow'); slow.bench!.timePerTaskSeconds = 100;
    const weak = model('p/weak', { intelligence: 19 });
    expect(pickBest([weak, slow, fast], 'gather', { quality: 0, cost: 0, speed: 1 }).chosen).toBe('p/fast');
  });
});

describe('warm candidate credit', () => {
  it('credits a recently served non-incumbent using its own published cache prices', () => {
    const a = model('p/a'); a.cost = { input: 0.00002, output: 0.00002, cacheRead: 0 };
    const b = model('p/b'); b.cost = { input: 0.00001, output: 0.00001, cacheRead: 0 };
    const weights = { quality: 0, cost: 0, speed: 0 };
    const opts = { estimatedContextTokens: 10_000, switchMargin: 0.15, warmPrefixTokens: new Map([['p/b', 5_000]]) };
    expect(pickBest([a, b], 'gather', weights, opts).chosen).toBe('p/b');
    expect(pickBest([a, b], 'gather', weights, { ...opts, isSubagentSpawn: true }).chosen).toBe('p/a');
    delete b.cost.cacheRead;
    expect(pickBest([a, b], 'gather', weights, opts).chosen).toBe('p/a');
  });

  it('keeps a warm measured-weak candidate behind every eligible one', () => {
    const weak = model('p/weak', { intelligence: 19 }); weak.cost = { input: 1, output: 1, cacheRead: 0 };
    const good = model('p/good');
    expect(pickBest([weak, good], 'gather', undefined, {
      estimatedContextTokens: 100, warmPrefixTokens: new Map([['p/weak', 100]]),
    }).chosen).toBe('p/good');
  });
});

describe('compliance preferences', () => {
  it('explains a penalty that changes selection without crossing a capability tier', () => {
    const a = model('p/a'), b = model('p/b');
    const weights = { quality: 0, cost: 0, speed: 0 };
    const result = pickBest([a, b], 'gather', weights, {
      estimatedContextTokens: 100, protocolPenalties: new Map([['a', 0.15]]),
    });
    expect(result.chosen).toBe('p/b');
    expect(result.reason).toContain('protocol penalty 0.150 on p/a: changed preference');
    const weak = model('p/weak', { intelligence: 19 });
    expect(pickBest([a, weak], 'gather', weights, {
      estimatedContextTokens: 100, protocolPenalties: new Map([['a', 100]]),
    }).fallbackChain).toEqual(['p/a', 'p/weak']);
  });
});
