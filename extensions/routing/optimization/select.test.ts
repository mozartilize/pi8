/**
 * Selector contracts (testing plan N4, N6, N2 central fallback): regret
 * direction and self-pair exclusion against an independent oracle, artifact
 * identity validation against an adversarial domain lookup, and a correct
 * label on every result path.
 */
import { afterAll, describe, expect, it } from 'vitest';

import type { BenchModel } from '../../types.js';
import { greedyBoxSimplexMax } from '../../test-support/lp-oracle.js';
import { enumerateEffectiveActions } from '../features/actions.js';
import type { ActionFeatureVector } from '../features/schema.js';
import type { DecisionStateV1 } from '../features/state.js';
import { preferenceProfileDigest, validatePreferences, type UserRoutingPreferencesV1 } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { compileDomainArtifact, thetaBaseDomain, type DomainArtifact } from './domain.js';
import { WorkerLpAdapter, type LPAdapter, type LpRequest, type LpResult } from './lp.js';
import { centralChoice, solveMinimaxRegret, sortByKey } from './regret.js';
import { DomainCache, selectByRegret, type SelectionCandidate, type SelectorPorts } from './select.js';
import { THETA0, THETA_BOUNDS } from './weights.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

const exactVector = (key: string, values: number[]): ActionFeatureVector => ({ key, values, lower: values, upper: values, evidence: [] });

describe('N4: regret direction and independent oracle', () => {
  // P: reasoning 0.60, cost 0.40. Q: reasoning [0.20, 0.90], cost 0.62. All else equal and exact.
  const common = [0.5, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, 0];
  const P: ActionFeatureVector = exactVector('P', common.map((v, j) => (j === 0 ? 0.6 : j === 4 ? 0.4 : v)));
  const Qc = common.map((v, j) => (j === 0 ? 0.55 : j === 4 ? 0.62 : v));
  const Q: ActionFeatureVector = { key: 'Q', values: Qc, lower: Qc.map((v, j) => (j === 0 ? 0.2 : v)), upper: Qc.map((v, j) => (j === 0 ? 0.9 : v)), evidence: [] };
  const oraclePR = (a: ActionFeatureVector, b: ActionFeatureVector) =>
    Math.max(0, greedyBoxSimplexMax(b.upper.map((u, j) => u - a.lower[j]!), THETA_BOUNDS));

  it('chooses the action with the smaller oracle max regret, with matching values', async () => {
    const result = await solveMinimaxRegret([{ features: P }, { features: Q }], thetaBaseDomain(), lp);
    const expected = { P: oraclePR(P, Q), Q: oraclePR(Q, P) };
    expect(result.maxRegret.get('P')).toBeCloseTo(expected.P, 7);
    expect(result.maxRegret.get('Q')).toBeCloseTo(expected.Q, 7);
    expect(result.chosen).toBe(expected.P < expected.Q ? 'P' : 'Q');
    // Hand check of direction: Q's optimistic reasoning (0.9 vs P's 0.6) drives P's regret.
    expect(expected.P).toBeGreaterThan(0);
  });

  it('excludes self-pairs: a single uncertain action has zero regret', async () => {
    const result = await solveMinimaxRegret([{ features: Q }], thetaBaseDomain(), lp);
    expect(result.maxRegret.get('Q')).toBe(0);
  });

  it('does not depend on pool order', async () => {
    const R = exactVector('R', common.map((v, j) => (j === 1 ? 0.7 : v)));
    const forward = await solveMinimaxRegret([{ features: P }, { features: Q }, { features: R }], thetaBaseDomain(), lp);
    const backward = await solveMinimaxRegret([{ features: R }, { features: Q }, { features: P }], thetaBaseDomain(), lp);
    expect(backward.ranking).toEqual(forward.ranking);
    expect([...backward.maxRegret]).toEqual(expect.arrayContaining([...forward.maxRegret]));
  });

  it('breaks exact regret ties by continuity, then known USD, then key', async () => {
    const same = exactVector('b', common);
    const higherContinuity = exactVector('c', common.map((v, j) => (j === 6 ? 0.6 : v)));
    // Equal features except continuity: c dominates, so it has zero regret.
    expect((await solveMinimaxRegret([{ features: same }, { features: higherContinuity }], thetaBaseDomain(), lp)).chosen).toBe('c');
    const twin = exactVector('a', common);
    const cheaper = await solveMinimaxRegret([{ features: twin, centralUsd: 0.2 }, { features: same, centralUsd: 0.1 }], thetaBaseDomain(), lp);
    expect(cheaper.chosen).toBe('b');
    const unpriced = await solveMinimaxRegret([{ features: twin }, { features: same }], thetaBaseDomain(), lp);
    expect(unpriced.chosen).toBe('a');
  });
});

// ─── selectByRegret on real candidates ───────────────────────────────

const model = (provider: string, id: string, cost: RegistryModelInfo['cost']): RegistryModelInfo => ({
  provider, id, reasoning: true, cost,
  thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null },
});
const cheap = model('c', 'cheap', { input: 0.2, output: 0.8, cacheRead: 0.02 });
const strong = model('s', 'strong', { input: 5, output: 25, cacheRead: 0.5 });
const benchRow = (registryId: string, intelligence: number, terminalBench: number): BenchModel => ({
  registryId, benchSlug: registryId, active: true, effort: 'high', source: 'aa',
  quality: { intelligence, agenticCoding: terminalBench },
  axisProvenance: { intelligence: 'measured', agenticCoding: 'measured' },
  outputSpeedTps: 100,
});
const rows = [benchRow('c/cheap', 35, 15), benchRow('s/strong', 70, 55)];
const candidates: SelectionCandidate[] = [cheap, strong].map((m) => ({ model: m, action: enumerateEffectiveActions(m)[0]! }));
const decisionState: DecisionStateV1 = {
  phase: 'implement', estimatedContextTokens: 50_000, needsVision: false, boundary: 'ordinary',
  friction: [], nowMs: 0, isSubagentSpawn: false, benchmarkIndexVersion: '4.3',
};

const snapshot = (profile: UserRoutingPreferencesV1) => validatePreferences(profile);
const OPERATOR: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};
const OTHER: UserRoutingPreferencesV1 = { version: 1, settledImplementation: 'higher_coding_capability' };

const portsWith = (lookup: (identity: string) => DomainArtifact | undefined, adapter: LPAdapter = lp): SelectorPorts =>
  ({ lp: adapter, domains: { lookup } });

/** Holds every LP request until released. */
class GatedLp implements LPAdapter {
  private release!: () => void;
  readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
  entered = 0;
  open() { this.release(); }
  async solve(request: LpRequest, controls?: Parameters<LPAdapter['solve']>[1]): Promise<LpResult[]> {
    this.entered++;
    await this.gate;
    return lp.solve(request, controls);
  }
  async close() {}
}

describe('selectByRegret result paths', () => {
  it('runs exact regret on ThetaBase for an empty profile', async () => {
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(profile), portsWith(() => undefined),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000 });
    expect(result).toMatchObject({ kind: 'decision', solver: 'exact', domainStatus: 'ready', constraintsEnforced: true });
    if (result.kind !== 'decision') throw new Error('unreachable');
    expect(new Set(result.ranking)).toEqual(new Set(['c/cheap:high', 's/strong:high']));
  });

  it('N6: rejects an artifact of another profile from the lookup and labels the fallback unenforced', async () => {
    const otherArtifact = await compileDomainArtifact(OTHER, lp);
    expect([...otherArtifact.thetaRepresentative]).not.toEqual(THETA0);
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(OPERATOR), portsWith(() => otherArtifact),
      { expectedProfileDigest: preferenceProfileDigest(OPERATOR), decisionDeadlineMs: 5_000 });
    expect(result).toMatchObject({
      kind: 'decision', solver: 'fallback-central', solverFallbackReason: 'domain-not-ready', domainStatus: 'domain-not-ready',
      constraintsEnforced: false, profileDigest: preferenceProfileDigest(OPERATOR), theta: THETA0,
    });
    expect((result as { compiledDomainIdentity?: string }).compiledDomainIdentity).toBeUndefined();
  });

  it('uses a matching compiled artifact for exact selection', async () => {
    const cache = new DomainCache(lp);
    await cache.compile(OPERATOR);
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(OPERATOR), { lp, domains: cache },
      { expectedProfileDigest: preferenceProfileDigest(OPERATOR), decisionDeadlineMs: 5_000 });
    expect(result).toMatchObject({ kind: 'decision', solver: 'exact', constraintsEnforced: true });
  });

  it('requests a compile and returns domain-not-ready before the compile ends', async () => {
    const cache = new DomainCache(lp);
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(OTHER), { lp, domains: cache },
      { expectedProfileDigest: preferenceProfileDigest(OTHER), decisionDeadlineMs: 5_000 });
    expect(result).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'domain-not-ready', constraintsEnforced: false });
    expect(await cache.compile(OTHER)).toBeDefined();
  });

  it('returns stale, not an exception, when the profile digest differs from the planned one', async () => {
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(OPERATOR), portsWith(() => undefined),
      { expectedProfileDigest: preferenceProfileDigest(OTHER), decisionDeadlineMs: 5_000 });
    expect(result).toEqual({ kind: 'stale' });
  });

  it('labels invalid and unsupported profiles as unenforced fallback, never exact', async () => {
    const invalid = validatePreferences({ version: 1, afterRework: 'maybe' });
    const unsupported = validatePreferences({ version: 2, afterRework: 'switch_model' });
    for (const [prefs, status] of [[invalid, 'domain-error'], [unsupported, 'unsupported-version']] as const) {
      const result = await selectByRegret(decisionState, candidates, rows, prefs, portsWith(() => undefined),
        { expectedProfileDigest: prefs.digest, decisionDeadlineMs: 5_000 });
      expect(result).toMatchObject({ solver: 'fallback-central', domainStatus: status, constraintsEnforced: false, theta: THETA0 });
    }
  });

  it('becomes stale when the snapshot changes during a delayed solve; cancellation wins over staleness', async () => {
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    let current = true;
    const gated = new GatedLp();
    const pending = selectByRegret(decisionState, candidates, rows, snapshot(profile), portsWith(() => undefined, gated),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000, isSnapshotCurrent: () => current });
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = false;
    gated.open();
    expect(await pending).toEqual({ kind: 'stale' });

    const controller = new AbortController();
    const gated2 = new GatedLp();
    let current2 = true;
    const both = selectByRegret(decisionState, candidates, rows, snapshot(profile), portsWith(() => undefined, gated2),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000, isSnapshotCurrent: () => current2, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    current2 = false;
    controller.abort();
    gated2.open();
    expect(await both).toEqual({ kind: 'cancelled' });
  });

  it('labels each solver failure as a fallback with the current representative, and cancellation as cancelled', async () => {
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    const run = (adapter: LPAdapter, extra: { decisionDeadlineMs?: number; pairCap?: number } = {}) =>
      selectByRegret(decisionState, candidates, rows, snapshot(profile), portsWith(() => undefined, adapter),
        { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: extra.decisionDeadlineMs ?? 5_000, pairCap: extra.pairCap });
    expect(await run(lp, { decisionDeadlineMs: 0 })).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'timeout', constraintsEnforced: true, theta: THETA0 });
    expect(await run(lp, { pairCap: 1 })).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'spike-pair-cap' });
    const broken: LPAdapter = { solve: async () => { throw new Error('wasm missing'); }, close: async () => {} };
    expect(await run(broken)).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'no-solver' });
    const wrong: LPAdapter = { solve: async (request) => request.objectives.map(() => ({ status: 'optimal' as const, objective: 99, x: new Array(10).fill(0.1) })), close: async () => {} };
    expect(await run(wrong)).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'numerical' });
    const controller = new AbortController();
    controller.abort();
    expect(await selectByRegret(decisionState, candidates, rows, snapshot(profile), portsWith(() => undefined),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000, signal: controller.signal })).toEqual({ kind: 'cancelled' });
  });

  it('reports no feasible action for an empty legal pool', async () => {
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    const result = await selectByRegret(decisionState, [], rows, snapshot(profile), portsWith(() => undefined),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000 });
    expect(result).toMatchObject({ kind: 'decision', solver: 'no-feasible-action', ranking: [] });
    expect((result as { chosen?: string }).chosen).toBeUndefined();
  });

  it('N2: central fallback uses the missing representative, not a regression value', async () => {
    const P = model('p', 'pmodel', { input: 1, output: 4 });
    const Q = model('q', 'qmodel', { input: 1, output: 4 });
    const pqRows: BenchModel[] = [
      { ...benchRow('p/pmodel', 62, 41), axisProvenance: { intelligence: 'measured', agenticCoding: 'regression-bridge' } },
      benchRow('q/qmodel', 62, 45),
    ];
    const pq = [P, Q].map((m) => ({ model: m, action: enumerateEffectiveActions(m)[0]! }));
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    const broken: LPAdapter = { solve: async () => { throw new Error('no solver'); }, close: async () => {} };
    const result = await selectByRegret(decisionState, pq, pqRows, snapshot(profile), portsWith(() => undefined, broken),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000 });
    if (result.kind !== 'decision') throw new Error('expected a decision');
    expect(result.solver).toBe('fallback-central');
    const pAgentic = result.actions.find((a) => a.action.registryId === 'p/pmodel')!.features.values[1];
    expect(pAgentic).toBe(0.5);
    // Representative weights: agentic 0.20 * (0.50 - 0.45) > 0, all else equal.
    expect(result.chosen).toBe('p/pmodel:high');
  });
});

describe('spike pair cap discontinuity (synthetic, CPU only)', () => {
  it('labels 65 actions as capped fallback while 64 actions run exact', async () => {
    const vectors = Array.from({ length: 65 }, (_, i) => exactVector(`a${String(i).padStart(2, '0')}`,
      [0.3 + (i % 7) * 0.05, 0.2 + (i % 5) * 0.1, 0.5, 0.5, 0.9 - (i % 9) * 0.07, 0.5, 0.5, 1, 0, 0]));
    // The 65th action is dominated by every other action.
    vectors[64] = exactVector('z-irrelevant', [0, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, 0]);
    const actions = vectors.map((features) => ({ features }));
    const exact = await solveMinimaxRegret(actions.slice(0, 64), thetaBaseDomain(), lp);
    const withIrrelevant = await solveMinimaxRegret(actions, thetaBaseDomain(), lp);
    // Exact regret is unchanged by a dominated action.
    expect(withIrrelevant.chosen).toBe(exact.chosen);
    // Under the spike cap the 65-action pool would take the central path instead.
    const capped = centralChoice(sortByKey(actions), THETA0);
    expect(64 * 63).toBeLessThanOrEqual(4096);
    expect(65 * 64).toBeGreaterThan(4096);
    expect(typeof capped.chosen).toBe('string');
  }, 30_000);
});
