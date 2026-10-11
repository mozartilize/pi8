/**
 * The pruned solver returns the same decision and the same top-action regrets
 * as an unpruned reference that solves one LP per ordered pair. The
 * reference uses the same HiGHS adapter, so only the pruning logic differs.
 */
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import { greedyBoxSimplexMax } from '../../test-support/lp-oracle.js';
import type { ActionFeatureVector } from '../features/schema.js';
import type { UserRoutingPreferencesV1 } from '../preferences/schema.js';
import { compileDomainArtifact, thetaBaseDomain, type WeightDomain } from './domain.js';
import { WorkerLpAdapter } from './lp.js';
import { baseDomainMax, pairObjective, solveMinimaxRegret, type SelectableAction } from './regret.js';
import { THETA_BOUNDS } from './weights.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

/** One LP per ordered pair, no pruning, no closed form. */
async function reference(actions: readonly SelectableAction[], domain: WeightDomain) {
  const maxRegret = new Map<string, number>(actions.map((a) => [a.features.key, 0]));
  for (const a of actions) {
    const others = actions.filter((b) => b !== a);
    if (others.length === 0) continue;
    const objectives = others.map((b) => pairObjective(a.features, b.features, domain.polytope.numCols));
    const results = await lp.solve({ polytope: domain.polytope, objectives, sense: 'max' });
    for (const r of results) expect(r.status).toBe('optimal');
    maxRegret.set(a.features.key, Math.max(0, ...results.map((r) => r.objective!)));
  }
  return maxRegret;
}

// Thousandths: the features are rounded values, and subnormal doubles are not feature values.
/**
 * Every regret equals the reference, and the ranking is in reference regret
 * order: no later action has a smaller reference regret than an earlier one.
 */
function expectSameRanking(result: Awaited<ReturnType<typeof solveMinimaxRegret>>, expected: ReadonlyMap<string, number>) {
  expect(result.ranking).toHaveLength(expected.size);
  for (const [key, value] of expected) expect(result.maxRegret.get(key)!).toBeCloseTo(value, 6);
  for (let i = 1; i < result.ranking.length; i++) {
    expect(expected.get(result.ranking[i - 1]!)!).toBeLessThanOrEqual(expected.get(result.ranking[i]!)! + 1e-6);
  }
}

const unit = fc.integer({ min: 0, max: 1000 }).map((v) => v / 1000);
const vector = fc.array(unit, { minLength: 10, maxLength: 10 });
const action = (i: number) => fc.tuple(vector, vector).map(([x, y]): SelectableAction => {
  const lower = x.map((v, j) => Math.min(v, y[j]!));
  const upper = x.map((v, j) => Math.max(v, y[j]!));
  const features: ActionFeatureVector = { key: `a${String(i).padStart(3, '0')}`, values: lower.map((v, j) => (v + upper[j]!) / 2), lower, upper, evidence: [] };
  return { features };
});
// Features clustered around one center, so competitor bounds differ by less than a few hundredths.
const clustered = (i: number) => fc.tuple(vector, fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 10, maxLength: 10 }), fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 10, maxLength: 10 }))
  .map(([center, down, up]): SelectableAction => {
    const base = center.map((v) => Math.min(0.9, Math.max(0.1, v)));
    const lower = base.map((v, j) => v - down[j]! / 1000);
    const upper = base.map((v, j) => v + up[j]! / 1000);
    return { features: { key: `k${String(i).padStart(3, '0')}`, values: base, lower, upper, evidence: [] } };
  });
const clusteredPool = (min = 4, max = 12) => fc.integer({ min, max }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => clustered(i)))
  .map((list) => { const c = list[0]!.features.values; return list.map((a, i) => ({ features: { ...a.features, values: a.features.values.map((_, j) => c[j]!), lower: c.map((v, j) => v - (a.features.values[j]! - a.features.lower[j]!)), upper: c.map((v, j) => v + (a.features.upper[j]! - a.features.values[j]!)), key: `k${String(i).padStart(3, '0')}` } })); }));

const pool = fc.integer({ min: 2, max: 14 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => action(i))));

const OPERATOR: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};
const CONFLICTING: UserRoutingPreferencesV1 = { version: 1, openDesignDecisions: 'lower_cost', handoffWarmCache: 'switch_for_capability', settledImplementation: 'higher_coding_capability', researchTasks: 'lower_cost' };

describe('baseDomainMax', () => {
  it('equals the independent greedy oracle', () => {
    fc.assert(fc.property(fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 10, maxLength: 10 }), (c) => {
      expect(baseDomainMax(c)).toBeCloseTo(greedyBoxSimplexMax(c, THETA_BOUNDS), 12);
    }));
  });
});

describe('pruned solver equals the unpruned reference', () => {
  it('ThetaBase: same regrets and winner without any LP', async () => {
    const base = thetaBaseDomain();
    await fc.assert(fc.asyncProperty(pool, async (actions) => {
      const result = await solveMinimaxRegret(actions, base, lp);
      const expected = await reference(actions, base);
      expect(result.lpSolves).toBe(0);
      expectSameRanking(result, expected);
    }), { numRuns: 30 });
  });

  it.each([['hard', OPERATOR], ['min-slack', CONFLICTING]] as const)('%s domain: same regrets and whole ranking, fewer LPs', async (mode, profile) => {
    const artifact = await compileDomainArtifact(profile, lp);
    expect(artifact.domain.mode).toBe(mode);
    await fc.assert(fc.asyncProperty(pool, async (actions) => {
      const result = await solveMinimaxRegret(actions, artifact.domain, lp);
      expectSameRanking(result, await reference(actions, artifact.domain));
      expect(result.lpSolves).toBeLessThanOrEqual(actions.length * (actions.length - 1));
    }), { numRuns: 25 });
  });

  it('clustered pools: bounds close together still give the whole ranking', async () => {
    const artifact = await compileDomainArtifact(OPERATOR, lp);
    await fc.assert(fc.asyncProperty(clusteredPool(), async (actions) => {
      const result = await solveMinimaxRegret(actions, artifact.domain, lp);
      expectSameRanking(result, await reference(actions, artifact.domain));
    }), { numRuns: 300 });
  }, 120_000);

  it('pools larger than one LP chunk: the whole ranking is in regret order', async () => {
    const artifact = await compileDomainArtifact(OPERATOR, lp);
    await fc.assert(fc.asyncProperty(clusteredPool(24, 40), async (actions) => {
      const result = await solveMinimaxRegret(actions, artifact.domain, lp);
      expectSameRanking(result, await reference(actions, artifact.domain));
    }), { numRuns: 25 });
  }, 120_000);

  it('cuts LP work on a large pool and keeps every action in the ranking', async () => {
    const artifact = await compileDomainArtifact(OPERATOR, lp);
    const actions = fc.sample(fc.tuple(...Array.from({ length: 60 }, (_, i) => action(i))), 1)[0]!;
    const result = await solveMinimaxRegret(actions, artifact.domain, lp);
    expect(result.ranking).toHaveLength(60);
    expect(new Set(result.ranking).size).toBe(60);
    expect(result.lpSolves).toBeLessThan(60 * 59 * 0.5);
    expectSameRanking(result, await reference(actions, artifact.domain));
  }, 60_000);

  it('does not let an upper-dominated competitor be the only dominator of itself via the action being scored', async () => {
    // c dominates b, and a == c: b must still count as a's competitor.
    const mk = (key: string, v: number[]): SelectableAction => ({ features: { key, values: v, lower: v.map((x) => x * 0.5), upper: v, evidence: [] } });
    const c = mk('c', [0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5, 1, 0, 0]);
    const b = mk('b', [0.8, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5, 1, 0, 0]);
    const artifact = await compileDomainArtifact(OPERATOR, lp);
    const result = await solveMinimaxRegret([c, b], artifact.domain, lp);
    const expected = await reference([c, b], artifact.domain);
    expect(result.maxRegret.get('c')!).toBeCloseTo(expected.get('c')!, 7);
    expect(result.maxRegret.get('b')!).toBeCloseTo(expected.get('b')!, 7);
  });
});
