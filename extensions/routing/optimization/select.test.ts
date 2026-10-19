/**
 * Selector contracts: regret direction and self-pair exclusion against an
 * independent oracle, artifact identity validation against an adversarial
 * domain lookup, a correct label on every result path, and one comparison
 * pool in which capability shortfall and evidence gaps are diagnostics only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BenchModel } from '../../types.js';
import { greedyBoxSimplexMax, oracleSolve } from '../../test-support/lp-oracle.js';
import { enumerateEffectiveActions } from '../features/actions.js';
import { FEATURE_INDEX, type ActionFeatureVector } from '../features/schema.js';
import { capabilityFeatures } from '../features/model.js';
import { composeTaskDemand } from '../features/task-demand.js';
import type { DecisionStateV1 } from '../features/state.js';
import { preferenceProfileDigest, validatePreferences, type UserRoutingPreferencesV1 } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { compileDomainArtifact, thetaBaseDomain, type DomainArtifact, type WeightDomain } from './domain.js';
import { WorkerLpAdapter, type LPAdapter, type LpRequest, type LpResult, type LpRunControls, type Polytope } from './lp.js';
import { validProblem } from '../../test-support/decision-problem.js';
import type { SelectableAction } from './compile.js';
import { centralChoice, solveMinimaxRegret, type NumericDomain } from './minimax.js';
import { DomainCache, selectByRegret, type SelectionCandidate, type SelectorPorts, type UnifiedDecision } from './select.js';
import { THETA0, THETA_BOUNDS } from './weights.js';

const solveActions = (actions: readonly SelectableAction[], domain: NumericDomain, lp: LPAdapter, controls?: LpRunControls) =>
  solveMinimaxRegret(validProblem(actions), domain, lp, controls);

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
    const result = await solveActions([{ features: P }, { features: Q }], thetaBaseDomain(), lp);
    const expected = { P: oraclePR(P, Q), Q: oraclePR(Q, P) };
    expect(result.maxRegret.get('P')).toBeCloseTo(expected.P, 7);
    expect(result.maxRegret.get('Q')).toBeCloseTo(expected.Q, 7);
    expect(result.chosen).toBe(expected.P < expected.Q ? 'P' : 'Q');
    // Hand check of direction: Q's optimistic reasoning (0.9 vs P's 0.6) drives P's regret.
    expect(expected.P).toBeGreaterThan(0);
  });

  it('excludes self-pairs: a single uncertain action has zero regret', async () => {
    const result = await solveActions([{ features: Q }], thetaBaseDomain(), lp);
    expect(result.maxRegret.get('Q')).toBe(0);
  });

  it('does not depend on pool order', async () => {
    const R = exactVector('R', common.map((v, j) => (j === 1 ? 0.7 : v)));
    const forward = await solveActions([{ features: P }, { features: Q }, { features: R }], thetaBaseDomain(), lp);
    const backward = await solveActions([{ features: R }, { features: Q }, { features: P }], thetaBaseDomain(), lp);
    expect(backward.ranking).toEqual(forward.ranking);
    expect([...backward.maxRegret]).toEqual(expect.arrayContaining([...forward.maxRegret]));
  });

  it('breaks exact regret ties by continuity, then known USD, then key', async () => {
    const same = exactVector('b', common);
    const higherContinuity = exactVector('c', common.map((v, j) => (j === 6 ? 0.6 : v)));
    // Equal features except continuity: c dominates, so it has zero regret.
    expect((await solveActions([{ features: same }, { features: higherContinuity }], thetaBaseDomain(), lp)).chosen).toBe('c');
    const twin = exactVector('a', common);
    const cheaper = await solveActions([{ features: twin, centralUsd: 0.2 }, { features: same, centralUsd: 0.1 }], thetaBaseDomain(), lp);
    expect(cheaper.chosen).toBe('b');
    const unpriced = await solveActions([{ features: twin }, { features: same }], thetaBaseDomain(), lp);
    expect(unpriced.chosen).toBe('a');
  });
});

describe('demand bounds in exact regret', () => {
  it('uses the bounds, not just the center, and preserves the whole ranking', async () => {
    const actions = (lower: number, upper: number) => [
      { key: 'cheap', quality: 45, cost: 0.55 }, { key: 'strong', quality: 55, cost: 0.5 },
    ].map(({ key, quality, cost }) => {
      const s: DecisionStateV1 = {
        phase: 'gather', estimatedContextTokens: 0, needsVision: false, boundary: 'ordinary', friction: [],
        nowMs: 0, benchmarkIndexVersion: '4.3',
        difficulty: { value: 0.5, source: 'declared-complexity',
          bounds: { reasoning: { lower, upper }, agentic: { lower, upper }, research: { lower, upper } } },
      };
      const row: BenchModel = {
        registryId: key, benchSlug: key, active: true, source: 'test',
        quality: { intelligence: quality, research: 1, knowledge: 100 },
        axisProvenance: { intelligence: 'measured', research: 'measured', knowledge: 'measured' },
      };
      const features = { key, values: new Array(10).fill(0), lower: new Array(10).fill(0), upper: new Array(10).fill(0), evidence: [] };
      for (const { name, interval } of capabilityFeatures(row, composeTaskDemand(s), s)) {
        const j = FEATURE_INDEX[name];
        features.values[j] = interval.center;
        features.lower[j] = interval.lower;
        features.upper[j] = interval.upper;
      }
      features.values[4] = features.lower[4] = features.upper[4] = cost;
      return { features };
    });
    const narrow = actions(0.375, 0.625);
    const wide = actions(0, 1);
    expect(narrow.map((a) => a.features.values)).toEqual(wide.map((a) => a.features.values));
    const bounded = await solveActions(narrow, thetaBaseDomain(), lp);
    const unknown = await solveActions(wide, thetaBaseDomain(), lp);
    // Both meet the bounded target, so cheaper has zero regret. At demand 1,
    // cheap loses 4/15 reasoning fit; the adversary uses weights 0.45 and 0.08.
    expect(bounded.ranking).toEqual(['cheap', 'strong']);
    expect(bounded.maxRegret.get('cheap')).toBe(0);
    expect(unknown.ranking).toEqual(['strong', 'cheap']);
    expect(unknown.maxRegret.get('cheap')).toBeCloseTo(0.45 * 4 / 15 - 0.08 * 0.05, 9);
    expect(unknown.maxRegret.get('strong')).toBeCloseTo(0.55 * 0.05, 9);
  });
});

describe('analytic solver fixtures: preferences, not capability priority, order actions', () => {
  // Feature order: reasoning, agentic, research, input, cost, time, continuity, friction, effortRecovery, modelSwitchRecovery.
  const COST_ORIENTED = [0.05, 0.20, 0.10, 0, 0.55, 0.10, 0, 0, 0, 0];
  const CAPABILITY_ORIENTED = [0.45, 0.20, 0.17, 0, 0.08, 0.10, 0, 0, 0, 0];
  const pointDomain = (theta: readonly number[]): WeightDomain => {
    const polytope: Polytope = { numCols: 10, colLower: [...theta], colUpper: [...theta], rows: [{ coeffs: new Array(10).fill(1), lower: 1, upper: 1 }] };
    return { mode: 'hard', polytope, constraints: [], totalSlack: 0 };
  };
  const vector = (key: string, reasoning: number, cost: number) =>
    exactVector(key, [reasoning, 0, 0, 0, cost, 0, 0, 0, 0, 0]);

  it('uses point domains that sum to one inside ThetaBase', () => {
    for (const theta of [COST_ORIENTED, CAPABILITY_ORIENTED]) {
      expect(theta.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
      theta.forEach((value, j) => {
        expect(value).toBeGreaterThanOrEqual(THETA_BOUNDS[j]![0]);
        expect(value).toBeLessThanOrEqual(THETA_BOUNDS[j]![1]);
      });
    }
  });

  it('reverses the winner when only the preference point changes', async () => {
    // A: reasoning 1.0, cost 0.2. B: reasoning 0.9, cost 0.3.
    // U(A) - U(B) = 0.05 * 0.1 - 0.55 * 0.1 = -0.05 (cost-oriented), 0.45 * 0.1 - 0.08 * 0.1 = +0.037 (capability-oriented).
    const actions = [{ features: vector('A', 1.0, 0.2) }, { features: vector('B', 0.9, 0.3) }];
    const cost = await solveActions(actions, pointDomain(COST_ORIENTED), lp);
    expect(cost.chosen).toBe('B');
    expect(cost.maxRegret.get('B')).toBeCloseTo(0, 9);
    expect(cost.maxRegret.get('A')).toBeCloseTo(0.05, 9);
    const capability = await solveActions(actions, pointDomain(CAPABILITY_ORIENTED), lp);
    expect(capability.chosen).toBe('A');
    expect(capability.maxRegret.get('A')).toBeCloseTo(0, 9);
    expect(capability.maxRegret.get('B')).toBeCloseTo(0.037, 9);
  });

  it('a reasoning advantage of 1e-6 cannot outweigh a cost desirability gap of 1/3 anywhere in ThetaBase', async () => {
    // Cost desirability is logarithmic over six decades: $1 gives 1/6 and $0.01 gives 1/2.
    // The cheaper action gains at least 0.08 / 3 from cost and loses at most 0.45e-6 on reasoning.
    const strong = vector('strong', 0.6 + 1e-6, 1 / 6);
    const cheaper = vector('cheaper', 0.6, 1 / 2);
    const result = await solveActions([{ features: strong }, { features: cheaper }], thetaBaseDomain(), lp);
    expect(result.chosen).toBe('cheaper');
    expect(result.maxRegret.get('cheaper')).toBe(0);
    expect(result.maxRegret.get('strong')).toBeCloseTo(0.55 / 3, 9);
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
  // The shortfall fixtures require a known hard target, independent of demand uncertainty.
  difficulty: { value: 1, source: 'execution-rubric' },
  friction: [], nowMs: 0, benchmarkIndexVersion: '4.3',
};

/** Both candidates meet these targets, so solver-path tests compare two actions with zero shortfall. */
const solverState: DecisionStateV1 = { ...decisionState, difficulty: { value: 0, source: 'execution-rubric' } };

const snapshot = (profile: UserRoutingPreferencesV1) => validatePreferences(profile);
const OPERATOR: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};
const OTHER: UserRoutingPreferencesV1 = { version: 1, settledImplementation: 'higher_coding_capability' };

const portsWith = (lookup: (identity: string) => DomainArtifact | undefined, adapter: LPAdapter = lp): SelectorPorts =>
  ({ lp: adapter, domains: { lookup } });

/** Ports whose domain lookup serves the compiled OPERATOR artifact; the solver is `adapter`. */
let operatorArtifact: DomainArtifact;
beforeAll(async () => { operatorArtifact = await compileDomainArtifact(OPERATOR, lp); });
const readyPorts = (adapter: LPAdapter = lp): SelectorPorts => portsWith((identity) => (identity === operatorArtifact.identity ? operatorArtifact : undefined), adapter);

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

describe('assignment permission snapshots before feature evaluation', () => {
  it('compares only the authorized actions, with an exact regret among them', async () => {
    const empty = validatePreferences({ version: 1 });
    const result = await selectByRegret({ ...decisionState, phase: 'implement' }, candidates, rows, empty, portsWith(() => undefined), {
      allowedActors: ['s/strong:high'], expectedProfileDigest: empty.digest, decisionDeadlineMs: 5_000,
    }) as UnifiedDecision;
    expect(result.chosen).toBe('s/strong:high');
    expect(result.ranking).toEqual(['s/strong:high']);
    expect(result.actions.map((action) => action.action.key)).toEqual(['s/strong:high']);
    expect(result.maxRegret!.get('s/strong:high')).toBe(0);
  });

  it('keeps unauthorized actions out of a central fallback and its diagnostics', async () => {
    const preferences = snapshot(OPERATOR);
    const result = await selectByRegret(decisionState, candidates, rows, preferences, portsWith(() => undefined), {
      allowedActors: ['s/strong:high'], expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000,
    }) as UnifiedDecision;
    expect(result.solver).toBe('fallback-central');
    expect(result.ranking).toEqual(['s/strong:high']);
    expect(result.actions.map((action) => action.action.key)).toEqual(['s/strong:high']);
    expect(result.insufficientEvidence).toEqual([]);
  });

  it('an empty permission list means no feasible action, not unrestricted permission', async () => {
    const preferences = validatePreferences({ version: 1 });
    const result = await selectByRegret(decisionState, candidates, rows, preferences, portsWith(() => undefined), {
      allowedActors: [], expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000,
    });
    expect(result).toMatchObject({ solver: 'no-feasible-action', ranking: [], actions: [] });
    expect((result as UnifiedDecision).chosen).toBeUndefined();
  });
});

describe('selectByRegret result paths', () => {
  it('runs exact regret on ThetaBase for an empty profile', async () => {
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(profile), portsWith(() => undefined),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000 });
      expect(result).toMatchObject({ kind: 'decision', solver: 'exact', domainStatus: 'ready', constraintsEnforced: true, domainMode: 'base' });
      if (result.kind !== 'decision') throw new Error('unreachable');
      expect(new Set(result.ranking)).toEqual(new Set(['c/cheap:high', 's/strong:high']));
  });

  it('uses no LP for a profile without constraints: the closed form is exact', async () => {
    const profile = { version: 1 } as UserRoutingPreferencesV1;
    const noLp: LPAdapter = { solve: async () => { throw new Error('LP must not run'); }, close: async () => {} };
    const result = await selectByRegret(solverState, candidates, rows, snapshot(profile), portsWith(() => undefined, noLp),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 0 });
    expect(result).toMatchObject({ kind: 'decision', solver: 'exact', constraintsEnforced: true });
    const viaLp = await solveActions(candidates.map((c) => ({ features: (result as UnifiedDecision).actions.find((a) => a.action.key === c.action.key)!.features })), { ...thetaBaseDomain(), mode: 'hard' }, lp);
    expect(viaLp.chosen).toBe((result as UnifiedDecision).chosen);
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
    const artifact = await cache.compile(OPERATOR);
    const result = await selectByRegret(decisionState, candidates, rows, snapshot(OPERATOR), { lp, domains: cache },
      { expectedProfileDigest: preferenceProfileDigest(OPERATOR), decisionDeadlineMs: 5_000 });
    expect(result).toMatchObject({
      kind: 'decision', solver: 'exact', constraintsEnforced: true,
      domainMode: artifact!.domain.mode,
    });
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
    const profile = OPERATOR;
    let current = true;
    const gated = new GatedLp();
    const pending = selectByRegret(solverState, candidates, rows, snapshot(profile), readyPorts(gated),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000, isSnapshotCurrent: () => current });
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = false;
    gated.open();
    expect(await pending).toEqual({ kind: 'stale' });

    const controller = new AbortController();
    const gated2 = new GatedLp();
    let current2 = true;
    const both = selectByRegret(solverState, candidates, rows, snapshot(profile), readyPorts(gated2),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000, isSnapshotCurrent: () => current2, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    current2 = false;
    controller.abort();
    gated2.open();
    expect(await both).toEqual({ kind: 'cancelled' });
  });

  it('labels each solver failure as a fallback with the current representative, and cancellation as cancelled', async () => {
    const profile = OPERATOR;
    const run = (adapter: LPAdapter, extra: { decisionDeadlineMs?: number; pairCap?: number } = {}) =>
      selectByRegret(solverState, candidates, rows, snapshot(profile), readyPorts(adapter),
        { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: extra.decisionDeadlineMs ?? 5_000, pairCap: extra.pairCap });
    expect(await run(lp, { decisionDeadlineMs: 0 })).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'timeout', constraintsEnforced: true, theta: operatorArtifact.thetaRepresentative });
    expect(await run(lp, { pairCap: 1 })).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'spike-pair-cap' });
    const broken: LPAdapter = { solve: async () => { throw new Error('wasm missing'); }, close: async () => {} };
    expect(await run(broken)).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'no-solver' });
    const wrong: LPAdapter = { solve: async (request) => request.objectives.map(() => ({ status: 'optimal' as const, objective: 99, x: new Array(10).fill(0.1) })), close: async () => {} };
    expect(await run(wrong)).toMatchObject({ solver: 'fallback-central', solverFallbackReason: 'numerical' });
    const controller = new AbortController();
    controller.abort();
    expect(await selectByRegret(decisionState, candidates, rows, snapshot(profile), readyPorts(),
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
    const run = (phase: DecisionStateV1['phase']) => selectByRegret({ ...decisionState, phase }, pq, pqRows, snapshot(profile), portsWith(() => undefined, broken),
      { expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 5_000 });
    // Plan relies on Intelligence only, so both models are compared; agentic relevance is 0.25.
    const result = await run('plan');
    if (result.kind !== 'decision') throw new Error('expected a decision');
    // The empty profile needs no LP, so the closed form answers exactly.
    expect(result.solver).toBe('exact');
    const pAgentic = result.actions.find((a) => a.action.registryId === 'p/pmodel')!.features.values[1];
    expect(pAgentic).toBeCloseTo(0.5 * 0.25, 12);
    expect(result.chosen).toBe('p/pmodel:high');
    // Implement relies on Terminal-Bench: a regression value is no evidence. P keeps the
    // missing interval on that axis and still competes with an exact regret.
    const implement = await run('implement');
    if (implement.kind !== 'decision') throw new Error('expected a decision');
    expect(implement.solver).toBe('exact');
    expect(implement.insufficientEvidence).toEqual(['p/pmodel:high']);
    const pImplement = implement.actions.find((a) => a.action.registryId === 'p/pmodel')!.features;
    expect([pImplement.lower[1], pImplement.upper[1]]).toEqual([0, 1]);
    expect([...implement.maxRegret!.keys()].sort()).toEqual(['p/pmodel:high', 'q/qmodel:high']);
  });
});

/** Max regret of each action against the others, from the independent tableau oracle over `domain`. */
function oracleRegrets(actions: readonly ActionFeatureVector[], domain: WeightDomain): Map<string, number> {
  return new Map(actions.map((a) => [a.key, Math.max(0, ...actions.filter((b) => b !== a).map((b) => {
    const objective = new Array<number>(domain.polytope.numCols).fill(0);
    b.upper.forEach((upper, j) => { objective[j] = upper - a.lower[j]!; });
    return oracleSolve(domain.polytope, objective, 'max').value!;
  }))]));
}

/** Central ranking by `theta . values`, computed without the production helper. */
const centralOrder = (actions: readonly ActionFeatureVector[], theta: readonly number[]): string[] =>
  actions.map((a) => ({ key: a.key, utility: a.values.reduce((sum, value, j) => sum + value * theta[j]!, 0) }))
    .sort((a, b) => b.utility - a.utility).map((a) => a.key);

const COST_PROFILE: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'lower_cost',
  handoffWarmCache: 'keep_warm_incumbent', researchTasks: 'lower_cost', afterRework: 'increase_effort',
};
const CAPABILITY_PROFILE: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'higher_coding_capability', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};
const BROKEN_LP: LPAdapter = { solve: async () => { throw new Error('no solver'); }, close: async () => {} };
const pick = (models: RegistryModelInfo[]): SelectionCandidate[] => models.map((m) => ({ model: m, action: enumerateEffectiveActions(m)[0]! }));

describe('missing evidence is an uncertainty interval, not a ranking tail', () => {
  // A strong and expensive, B moderate and cheaper, U has no benchmark row and
  // is cheapest. U has free output, so its cost is known without an
  // output-token count; A and B have no count and only a lower cost bound.
  const A = model('a', 'strong', { input: 5, output: 25, cacheRead: 0.5 });
  const B = model('b', 'middle', { input: 0.2, output: 0.8, cacheRead: 0.02 });
  const U = model('u', 'unmeasured', { input: 0.01, output: 0, cacheRead: 0.001 });
  const guardRows = [benchRow('a/strong', 70, 55), benchRow('b/middle', 55, 50)];
  const empty = { version: 1 } as UserRoutingPreferencesV1;
  let costArtifact: DomainArtifact;
  beforeAll(async () => { costArtifact = await compileDomainArtifact(COST_PROFILE, lp); });
  const costRun = (models: RegistryModelInfo[], bench: BenchModel[], adapter: LPAdapter = lp, ready = true) => {
    const prefs = snapshot(COST_PROFILE);
    return selectByRegret(decisionState, pick(models), bench, prefs, portsWith(() => (ready ? costArtifact : undefined), adapter),
      { expectedProfileDigest: prefs.digest, decisionDeadlineMs: 5_000 });
  };

  it('a cheap unmeasured model wins under a cost-oriented domain, with an exact regret against the whole pool', async () => {
    const result = await costRun([A, B, U], guardRows);
    if (result.kind !== 'decision') throw new Error('expected a decision');
    expect(result.solver).toBe('exact');
    expect(result.chosen).toBe('u/unmeasured:high');
    expect(result.insufficientEvidence).toEqual(['u/unmeasured:high']);
    const expected = oracleRegrets(result.actions.map((a) => a.features), costArtifact.domain);
    expect(result.maxRegret!.size).toBe(3);
    for (const [key, value] of expected) expect(result.maxRegret!.get(key)!).toBeCloseTo(value, 6);
    expect(Math.min(...expected.values())).toBeCloseTo(expected.get('u/unmeasured:high')!, 9);
  });

  it.each(['solver-failure', 'domain-not-ready'] as const)('central fallback ranks the unmeasured model by its utility, not last (%s)', async (path) => {
    const result = await costRun([A, B, U], guardRows, path === 'solver-failure' ? BROKEN_LP : lp, path === 'solver-failure');
    if (result.kind !== 'decision') throw new Error('expected a decision');
    expect(result.solver).toBe('fallback-central');
    const expected = centralOrder(result.actions.map((a) => a.features), result.theta!);
    expect(result.ranking).toEqual(expected);
    expect(expected[0]).toBe('u/unmeasured:high');
  });

  it('missing and source-estimated quality with equal bounds have equal exact regret', async () => {
    const missing: BenchModel = { ...benchRow('u/unmeasured', 50, 0), quality: { intelligence: 50 }, axisProvenance: { intelligence: 'measured' } };
    const estimated: BenchModel = { ...benchRow('u/unmeasured', 50, 45), axisProvenance: { intelligence: 'measured', agenticCoding: 'source-estimated' } };
    const prefs = snapshot(empty);
    const run = (row: BenchModel) => selectByRegret(decisionState, pick([A, B, U]), [...guardRows, row], prefs, portsWith(() => undefined),
      { expectedProfileDigest: prefs.digest, decisionDeadlineMs: 5_000 });
    const [withMissing, withEstimated] = await Promise.all([run(missing), run(estimated)]);
    if (withMissing.kind !== 'decision' || withEstimated.kind !== 'decision') throw new Error('expected decisions');
    const bounds = (result: UnifiedDecision) => result.actions.find((a) => a.action.registryId === 'u/unmeasured')!.features;
    expect(bounds(withMissing).lower).toEqual(bounds(withEstimated).lower);
    expect(bounds(withMissing).upper).toEqual(bounds(withEstimated).upper);
    expect(withMissing.insufficientEvidence).toEqual(['u/unmeasured:high']);
    expect(withEstimated.insufficientEvidence).toEqual([]);
    expect(withMissing.maxRegret!.size).toBe(3);
    for (const [key, value] of withEstimated.maxRegret!) expect(withMissing.maxRegret!.get(key)!).toBeCloseTo(value, 9);
  });

  it('reports every action as lacking evidence when no model has it, and compares them all', async () => {
    const prefs = snapshot(empty);
    const result = await selectByRegret(decisionState, pick([U, model('v', 'also-unmeasured', { input: 1, output: 2 })]), guardRows, prefs, portsWith(() => undefined),
      { expectedProfileDigest: prefs.digest, decisionDeadlineMs: 5_000 });
    if (result.kind !== 'decision') throw new Error('expected a decision');
    expect(result.insufficientEvidence).toEqual(['u/unmeasured:high', 'v/also-unmeasured:high']);
    expect(result.maxRegret!.size).toBe(2);
    expect(result.chosen).toBeDefined();
  });

  it('counts every pool action against the spike pair cap', async () => {
    const prefs = snapshot(empty);
    const result = await selectByRegret(decisionState, pick([A, B, U]), guardRows, prefs, portsWith(() => undefined),
      { expectedProfileDigest: prefs.digest, decisionDeadlineMs: 5_000, pairCap: 2 });
    // Three actions make 6 ordered pairs: above the cap of 2.
    expect(result).toMatchObject({ kind: 'decision', solver: 'fallback-central', solverFallbackReason: 'spike-pair-cap' });
  });
});

describe('capability shortfall is a diagnostic, not a priority', () => {
  const free = { ...cheap, cost: { input: 0, output: 0 } };
  const pool = pick([free, strong]);
  const prefs = snapshot(COST_PROFILE);
  let costArtifact: DomainArtifact;
  let capabilityArtifact: DomainArtifact;
  beforeAll(async () => {
    costArtifact = await compileDomainArtifact(COST_PROFILE, lp);
    capabilityArtifact = await compileDomainArtifact(CAPABILITY_PROFILE, lp);
  });
  type Path = 'exact' | 'domain-not-ready' | 'pair-cap' | 'solver-failure';
  const run = (bench: BenchModel[], path: Path = 'exact') =>
    selectByRegret(decisionState, pool, bench, prefs,
      portsWith(() => (path === 'domain-not-ready' ? undefined : costArtifact), path === 'solver-failure' ? BROKEN_LP : lp),
      { expectedProfileDigest: prefs.digest, decisionDeadlineMs: 5_000, ...(path === 'pair-cap' ? { pairCap: 0 } : {}) });

  it.each(['exact', 'domain-not-ready', 'pair-cap', 'solver-failure'] as const)('a free model just below the reasoning target beats a costlier model that meets it (%s)', async (path) => {
    const result = await run([benchRow('c/cheap', 54.99, 65), benchRow('s/strong', 55, 60)], path);
    if (result.kind !== 'decision') throw new Error('expected decision');
    expect(result.solver).toBe(path === 'exact' ? 'exact' : 'fallback-central');
    expect(result.actions.find((a) => a.action.registryId === 's/strong')!.capabilityShortfall).toBeCloseTo(0);
    expect(result.actions.find((a) => a.action.registryId === 'c/cheap')!.capabilityShortfall).toBeGreaterThan(0);
    const features = result.actions.map((a) => a.features);
    if (path === 'exact') {
      const expected = oracleRegrets(features, costArtifact.domain);
      for (const [key, value] of expected) expect(result.maxRegret!.get(key)!).toBeCloseTo(value, 6);
    } else {
      expect(result.ranking).toEqual(centralOrder(features, result.theta!));
    }
    expect(result.ranking).toEqual(['c/cheap:high', 's/strong:high']);
  });

  it('prefers lower cost when both actions meet every relevant target', async () => {
    const result = await run([benchRow('c/cheap', 55, 60), benchRow('s/strong', 80, 90)]);
    expect(result).toMatchObject({ chosen: 'c/cheap:high', ranking: ['c/cheap:high', 's/strong:high'] });
  });

  it('two measured actions whose fits both clip to zero are ordered by their other features, with pool regret', async () => {
    const empty = snapshot({ version: 1 });
    const result = await selectByRegret(decisionState, pool, [benchRow('c/cheap', 60, 0), benchRow('s/strong', 60, 20)], empty, portsWith(() => undefined),
      { expectedProfileDigest: empty.digest, decisionDeadlineMs: 5_000 });
    if (result.kind !== 'decision') throw new Error('expected decision');
    const byKey = new Map(result.actions.map((a) => [a.action.key, a]));
    expect(byKey.get('c/cheap:high')!.capabilityShortfall).toBeCloseTo(3);
    expect(byKey.get('s/strong:high')!.capabilityShortfall).toBeCloseTo(2);
    expect(byKey.get('c/cheap:high')!.features.values[1]).toBe(0);
    expect(byKey.get('s/strong:high')!.features.values[1]).toBe(0);
    const [c, s] = [byKey.get('c/cheap:high')!.features, byKey.get('s/strong:high')!.features];
    const pr = (a: ActionFeatureVector, b: ActionFeatureVector) => Math.max(0, greedyBoxSimplexMax(b.upper.map((u, j) => u - a.lower[j]!), THETA_BOUNDS));
    expect(result.maxRegret!.get('c/cheap:high')).toBeCloseTo(pr(c, s), 9);
    expect(result.maxRegret!.get('s/strong:high')).toBeCloseTo(pr(s, c), 9);
    expect(pr(s, c)).toBeGreaterThan(pr(c, s));
    expect(result.chosen).toBe('c/cheap:high');
  });

  it('a change only in a clipped shortfall changes no feature, ranking or regret', async () => {
    // Terminal-Bench 0 and 30 both miss the highest agentic target by more than the fit scale.
    const [low, high] = await Promise.all([0, 30].map((terminalBench) => run([benchRow('c/cheap', 60, terminalBench), benchRow('s/strong', 60, 20)])));
    if (low!.kind !== 'decision' || high!.kind !== 'decision') throw new Error('expected decisions');
    const shortfall = (result: UnifiedDecision) => result.actions.find((a) => a.action.key === 'c/cheap:high')!.capabilityShortfall;
    expect(shortfall(low!)).toBeGreaterThan(2);
    expect(shortfall(high!)).toBeLessThan(2);
    expect(high!.actions.map((a) => a.features)).toEqual(low!.actions.map((a) => a.features));
    expect(high!.ranking).toEqual(low!.ranking);
    expect([...high!.maxRegret!]).toEqual([...low!.maxRegret!]);
  });

  it('the preference domain reverses the order of a cheaper model with a reasoning shortfall', async () => {
    const bench = [benchRow('c/cheap', 45, 55), benchRow('s/strong', 70, 55)];
    const pair = pick([cheap, strong]);
    const select = (profile: UserRoutingPreferencesV1, artifact: DomainArtifact) => {
      const preferences = snapshot(profile);
      return selectByRegret(decisionState, pair, bench, preferences, portsWith(() => artifact),
        { expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000 });
    };
    const cost = await select(COST_PROFILE, costArtifact);
    const capability = await select(CAPABILITY_PROFILE, capabilityArtifact);
    if (cost.kind !== 'decision' || capability.kind !== 'decision') throw new Error('expected decisions');
    expect(cost.actions.find((a) => a.action.key === 'c/cheap:high')!.capabilityShortfall)
      .toBeGreaterThan(cost.actions.find((a) => a.action.key === 's/strong:high')!.capabilityShortfall);
    expect([cost.solver, capability.solver]).toEqual(['exact', 'exact']);
    expect(cost.chosen).toBe('c/cheap:high');
    expect(capability.chosen).toBe('s/strong:high');
  });

  it('keeps uncertain quality uncertain without narrowing its interval', async () => {
    const estimated = { ...benchRow('c/cheap', 60, 0), axisProvenance: { intelligence: 'measured', agenticCoding: 'source-estimated' } } as BenchModel;
    const result = await run([estimated, benchRow('s/strong', 60, 20)]);
    expect(result).toMatchObject({ chosen: 'c/cheap:high', insufficientEvidence: [] });
    if (result.kind !== 'decision') throw new Error('expected decision');
    const uncertain = result.actions.find((a) => a.action.registryId === 'c/cheap')!;
    expect(uncertain.capabilityShortfall).toBe(0);
    expect([uncertain.features.lower[1], uncertain.features.upper[1]]).toEqual([0, 1]);
  });

  it('a wider interval never lowers the action\'s own regret', async () => {
    const measured = benchRow('c/cheap', 60, 40);
    const estimated = { ...measured, axisProvenance: { intelligence: 'measured', agenticCoding: 'source-estimated' } } as BenchModel;
    const [narrow, wide] = await Promise.all([measured, estimated].map((row) => run([row, benchRow('s/strong', 60, 20)])));
    if (narrow!.kind !== 'decision' || wide!.kind !== 'decision') throw new Error('expected decisions');
    const own = (result: UnifiedDecision) => result.maxRegret!.get('c/cheap:high')!;
    expect(own(wide!)).toBeGreaterThanOrEqual(own(narrow!) - 1e-9);
  });
});

describe('spike pair cap discontinuity (synthetic, CPU only)', () => {
  it('labels 65 actions as capped fallback while 64 actions run exact', async () => {
    const vectors = Array.from({ length: 65 }, (_, i) => exactVector(`a${String(i).padStart(2, '0')}`,
      [0.3 + (i % 7) * 0.05, 0.2 + (i % 5) * 0.1, 0.5, 0.5, 0.9 - (i % 9) * 0.07, 0.5, 0.5, 1, 0, 0]));
    // The 65th action is dominated by every other action.
    vectors[64] = exactVector('z-irrelevant', [0, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, 0]);
    const actions = vectors.map((features) => ({ features }));
    const exact = await solveActions(actions.slice(0, 64), thetaBaseDomain(), lp);
    const withIrrelevant = await solveActions(actions, thetaBaseDomain(), lp);
    // Exact regret is unchanged by a dominated action.
    expect(withIrrelevant.chosen).toBe(exact.chosen);
    // Under the spike cap the 65-action pool would take the central path instead.
    const capped = centralChoice(validProblem(actions), THETA0);
    expect(64 * 63).toBeLessThanOrEqual(4096);
    expect(65 * 64).toBeGreaterThan(4096);
    expect(typeof capped.chosen).toBe('string');
  }, 30_000);
});

describe('invalid actions are rejected and invalid domains use fallback', () => {
  const run = (pool: readonly SelectionCandidate[], ports: SelectorPorts, profile: UserRoutingPreferencesV1 = OPERATOR) => {
    const preferences = snapshot(profile);
    return selectByRegret(solverState, pool, rows, preferences, ports, {
      expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000,
    }) as Promise<UnifiedDecision>;
  };

  it('rejects duplicated actions and solves the remaining actions exactly', async () => {
    const result = await run([...candidates, candidates[0]!], readyPorts());
    expect(result.solver).toBe('exact');
    expect(result.invalidActions).toEqual(['c/cheap:high']);
    expect(result.ranking).toEqual(['s/strong:high']);
    expect([...result.maxRegret!.keys()]).toEqual(['s/strong:high']);
  });

  it.each(['exact', 'domain-not-ready', 'solver-failure', 'pair-cap'] as const)(
    'keeps malformed numerical actions out of the dispatch ranking (%s)', async (path) => {
      const invalid = pick([model('bad', 'invalid', { input: 1, output: 2 })])[0]!;
      const state = { ...solverState, promptTokenScales: new Map([['bad/invalid', NaN]]) };
      const preferences = snapshot(OPERATOR);
      const ports = path === 'domain-not-ready' ? portsWith(() => undefined)
        : readyPorts(path === 'solver-failure' ? BROKEN_LP : lp);
      const result = await selectByRegret(state, [...candidates, invalid], rows, preferences, ports, {
        expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000,
        ...(path === 'pair-cap' ? { pairCap: 0 } : {}),
      });
      if (result.kind !== 'decision') throw new Error('expected a decision');
      expect(result.solver).toBe(path === 'exact' ? 'exact' : 'fallback-central');
      expect(result.invalidActions).toEqual([invalid.action.key]);
      expect([...result.ranking].sort()).toEqual(candidates.map((candidate) => candidate.action.key).sort());
      expect(result.ranking).toContain(result.chosen);
      if (path === 'exact') expect([...result.maxRegret!.keys()].sort()).toEqual([...result.ranking].sort());
    },
  );

  it.each(['duplicates', 'non-finite'] as const)('returns no feasible action when all inputs are invalid (%s)', async (kind) => {
    const preferences = snapshot(OPERATOR);
    const state = kind === 'duplicates' ? solverState
      : { ...solverState, promptTokenScales: new Map(candidates.map((candidate) => [candidate.action.registryId, NaN])) };
    const result = await selectByRegret(state, kind === 'duplicates' ? [...candidates, ...candidates] : candidates,
      rows, preferences, readyPorts(), { expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000 });
    if (result.kind !== 'decision') throw new Error('expected a decision');
    expect(result.solver).toBe('no-feasible-action');
    expect(result.solverFallbackReason).toBe('invalid-features');
    expect(result.constraintsEnforced).toBe(false);
    expect(result.invalidActions).toEqual(['c/cheap:high', 's/strong:high']);
    expect(result.ranking).toEqual([]);
    expect(result.chosen).toBeUndefined();
    expect(result.theta).toBeUndefined();
  });

  it('a stored domain outside the base bounds is not applied, on the exact and the pair-cap paths', async () => {
    const polytope = operatorArtifact.domain.polytope;
    const widened: DomainArtifact = {
      ...operatorArtifact,
      domain: { ...operatorArtifact.domain, polytope: { ...polytope, colUpper: polytope.colUpper.map((u) => u! + 0.5) } } as WeightDomain,
    };
    const ports = portsWith((identity) => (identity === widened.identity ? widened : undefined));
    const preferences = snapshot(OPERATOR);
    for (const pairCap of [undefined, 1]) {
      const result = await selectByRegret(solverState, candidates, rows, preferences, ports, {
        expectedProfileDigest: preferences.digest, decisionDeadlineMs: 5_000, ...(pairCap ? { pairCap } : {}),
      }) as UnifiedDecision;
      expect(result.solver, String(pairCap)).toBe('fallback-central');
      expect(result.solverFallbackReason).toBe('domain-error');
      expect(result.domainStatus).toBe('domain-error');
      expect(result.constraintsEnforced).toBe(false);
      expect(result.theta).toEqual(THETA0);
      expect(result.compiledDomainIdentity).toBeUndefined();
      expect(result.ranking.sort()).toEqual(candidates.map((c) => c.action.key).sort());
    }
  });
});
