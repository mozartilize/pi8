/**
 * Weight-domain contracts: empty profile = exact ThetaBase; jointly
 * representable answers are hard constraints; otherwise uniform minimum
 * slack. Expected feasibility comes from the independent tableau oracle and
 * from scenario vectors restated in this file.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { oracleSolve } from '../../test-support/lp-oracle.js';
import { CORE_PREFERENCE_KEYS, type PreferenceKey, type UserRoutingPreferencesV1 } from '../preferences/schema.js';
import { SCENARIO_OPTIONS } from '../preferences/schema.js';
import {
  artifactMatches,
  compileDomainArtifact,
  compileWeightDomain,
  domainIdentity,
  thetaBaseArtifact,
  thetaBasePolytope,
} from './domain.js';
import { WorkerLpAdapter, pointProblem, type Polytope } from './lp.js';
import { validProblem } from '../../test-support/decision-problem.js';
import type { SelectableAction } from './compile.js';
import { solveMinimaxRegret, type NumericDomain } from './minimax.js';
import type { LPAdapter, LpRunControls } from './lp.js';
import { THETA0 } from './weights.js';
import { preferenceProfileDigest } from '../preferences/schema.js';

const solveActions = (actions: readonly SelectableAction[], domain: NumericDomain, lp: LPAdapter, controls?: LpRunControls) =>
  solveMinimaxRegret(validProblem(actions), domain, lp, controls);

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

/** Scenario vectors restated for an independent oracle. */
const VECTORS: Record<PreferenceKey, { A: number[]; B: number[] }> = {
  settledImplementation: { A: [0.45, 0.52, 0.3, 0.55, 0.35915, 0.6, 0.55, 1, 0, 0], B: [0.45, 0.62, 0.3, 0.55, 0.333333, 0.6, 0.55, 1, 0, 0] },
  openDesignDecisions: { A: [0.55, 0.45, 0.3, 0.55, 0.383505, 0.6, 0.6, 1, 0, 0], B: [0.74, 0.45, 0.3, 0.55, 0.333333, 0.6, 0.6, 1, 0, 0] },
  handoffWarmCache: { A: [0.56, 0.45, 0.4, 0.55, 0.399657, 0.6, 0.65, 1, 0, 0], B: [0.8, 0.45, 0.4, 0.55, 0.303985, 0.6, 0.45, 1, 0, 0] },
  researchTasks: { A: [0.55, 0.62, 0.4, 0.55, 0.370308, 0.6, 0.55, 1, 0, 0], B: [0.55, 0.44, 0.75, 0.55, 0.320136, 0.6, 0.55, 1, 0, 0] },
  afterRework: { A: [0.6, 0.6, 0.3, 0.55, 0.333333, 0.6, 0.78, 1, 1, 0], B: [0.6, 0.6, 0.3, 0.55, 0.333333, 0.6, 0.48, 1, 0, 1] },
};
const BOUNDS: Array<[number, number]> = [[0, 0.45], [0, 0.45], [0, 0.3], [0, 0.25], [0.08, 0.55], [0, 0.2], [0, 0.3], [0, 0.25], [0, 0.3], [0, 0.3]];

/** Hard-constraint polytope written independently of domain.ts. */
function oracleHardPolytope(answers: Partial<Record<PreferenceKey, 'A' | 'B' | 'E'>>): Polytope {
  const rows: Polytope['rows'][number][] = [{ coeffs: new Array(10).fill(1), lower: 1, upper: 1 }];
  for (const [key, answer] of Object.entries(answers) as Array<[PreferenceKey, 'A' | 'B' | 'E']>) {
    const delta = VECTORS[key].A.map((value, j) => value - VECTORS[key].B[j]!);
    if (answer === 'A') rows.push({ coeffs: delta, lower: 0.005 });
    if (answer === 'B') rows.push({ coeffs: delta.map((v) => -v), lower: 0.005 });
    if (answer === 'E') rows.push({ coeffs: delta, lower: -0.005, upper: 0.005 });
  }
  return { numCols: 10, colLower: BOUNDS.map(([l]) => l), colUpper: BOUNDS.map(([, u]) => u), rows };
}

const toProfile = (answers: Partial<Record<PreferenceKey, 'A' | 'B' | 'E'>>): UserRoutingPreferencesV1 => {
  const profile: Record<string, unknown> = { version: 1 };
  for (const [key, answer] of Object.entries(answers) as Array<[PreferenceKey, 'A' | 'B' | 'E']>) {
    profile[key] = answer === 'E' ? 'equivalent' : SCENARIO_OPTIONS[key][answer];
  }
  return profile as unknown as UserRoutingPreferencesV1;
};

const OPERATOR_PROFILE: UserRoutingPreferencesV1 = {
  version: 1,
  settledImplementation: 'lower_cost',
  openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability',
  researchTasks: 'higher_research_capability',
  afterRework: 'switch_model',
};

const scenarioActions = (key: PreferenceKey) => (['A', 'B'] as const).map((option) => ({
  features: {
    key: `${key}:${option}`,
    values: VECTORS[key][option],
    lower: VECTORS[key][option],
    upper: VECTORS[key][option],
    evidence: [],
  },
}));

describe('compileWeightDomain', () => {
  it('uses exact ThetaBase for an empty or non-substantive profile', async () => {
    for (const profile of [{ version: 1 }, { version: 1, researchTasks: 'skip', afterRework: 'unsure' }] as UserRoutingPreferencesV1[]) {
      const domain = await compileWeightDomain(profile, lp);
      expect(domain.mode).toBe('base');
      expect(domain.polytope).toEqual(thetaBasePolytope());
    }
  });

  it("applies this operator's five answers as hard constraints, as the independent oracle finds them jointly feasible", async () => {
    const oracle = oracleSolve(oracleHardPolytope({
      settledImplementation: 'A', openDesignDecisions: 'B', handoffWarmCache: 'B', researchTasks: 'B', afterRework: 'B',
    }), new Array(10).fill(0));
    expect(oracle.status).toBe('optimal');
    const domain = await compileWeightDomain(OPERATOR_PROFILE, lp);
    expect(domain.mode).toBe('hard');
    expect(domain.totalSlack).toBe(0);
  });

  it('classifies all 243 complete A/B/equivalent profiles as the oracle does (162 hard, 81 softened)', async () => {
    let hard = 0;
    let softened = 0;
    const answers: Array<'A' | 'B' | 'E'> = ['A', 'B', 'E'];
    for (let code = 0; code < 243; code++) {
      const profileAnswers: Partial<Record<PreferenceKey, 'A' | 'B' | 'E'>> = {};
      CORE_PREFERENCE_KEYS.forEach((key, i) => { profileAnswers[key] = answers[Math.floor(code / 3 ** i) % 3]!; });
      const oracleFeasible = oracleSolve(oracleHardPolytope(profileAnswers), new Array(10).fill(0)).status === 'optimal';
      const domain = await compileWeightDomain(toProfile(profileAnswers), lp);
      expect(domain.mode).toBe(oracleFeasible ? 'hard' : 'min-slack');
      if (oracleFeasible) hard++;
      else softened++;
    }
    expect({ hard, softened }).toEqual({ hard: 162, softened: 81 });
  }, 60_000);

  it('enters minimum-slack mode with per-answer slack ranges when answers cannot be represented together', async () => {
    // The first two-answer profile that the independent oracle finds infeasible.
    const keys = CORE_PREFERENCE_KEYS;
    let conflicting: Partial<Record<PreferenceKey, 'A' | 'B' | 'E'>> | undefined;
    search: for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        for (const a of ['A', 'B', 'E'] as const) {
          for (const b of ['A', 'B', 'E'] as const) {
            const candidate = { [keys[i]!]: a, [keys[j]!]: b };
            if (oracleSolve(oracleHardPolytope(candidate), new Array(10).fill(0)).status === 'infeasible') {
              conflicting = candidate;
              break search;
            }
          }
        }
      }
    }
    expect(conflicting).toBeDefined();
    const domain = await compileWeightDomain(toProfile(conflicting!), lp);
    expect(domain.mode).toBe('min-slack');
    expect(domain.totalSlack).toBeGreaterThan(0);
    expect(domain.slackRanges!.map((range) => range.key)).toEqual(CORE_PREFERENCE_KEYS.filter((key) => key in conflicting!));
    // Every domain point is within the minimum total slack plus the domain
    // tolerance (1e-7) and the point-verification residual (1e-7).
    const point = (await compileDomainArtifact(toProfile(conflicting!), lp)).representativePoint;
    expect(point.slice(10).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(domain.totalSlack + 2e-7);
    for (const range of domain.slackRanges!) expect(range.max).toBeGreaterThanOrEqual(range.min);
  });
});

describe('single-answer expressibility', () => {
  it.each(CORE_PREFERENCE_KEYS)('%s: each direction selects its own option with zero regret on the frozen pair', async (key) => {
    for (const direction of ['A', 'B'] as const) {
      const artifact = await compileDomainArtifact(toProfile({ [key]: direction }), lp);
      const result = await solveActions(scenarioActions(key), artifact.domain, lp);
      expect(result.chosen).toBe(`${key}:${direction}`);
      expect(result.maxRegret.get(`${key}:${direction}`)).toBeLessThanOrEqual(1e-7);
      expect(result.maxRegret.get(`${key}:${direction === 'A' ? 'B' : 'A'}`)).toBeGreaterThan(1e-4);
    }
  });
});

describe('domain artifacts', () => {
  it('keeps the representative in its domain and at THETA0 when THETA0 is admissible', async () => {
    const base = thetaBaseArtifact({ version: 1 });
    expect([...base.thetaRepresentative]).toEqual(THETA0);
    const compiled = await compileDomainArtifact(OPERATOR_PROFILE, lp);
    expect(pointProblem(compiled.domain.polytope, compiled.representativePoint)).toBeUndefined();
    expect(compiled.thetaRepresentative.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 7);
    const again = await compileDomainArtifact(OPERATOR_PROFILE, lp);
    expect(again.thetaRepresentative).toEqual(compiled.thetaRepresentative);
  });

  it('matches only the exact profile identity and digest', async () => {
    const compiled = await compileDomainArtifact(OPERATOR_PROFILE, lp);
    const digest = preferenceProfileDigest(OPERATOR_PROFILE);
    expect(artifactMatches(compiled, OPERATOR_PROFILE, digest)).toBe(true);
    const edited: UserRoutingPreferencesV1 = { ...OPERATOR_PROFILE, afterRework: 'increase_effort' };
    expect(domainIdentity(edited)).not.toBe(compiled.identity);
    expect(artifactMatches(compiled, edited, preferenceProfileDigest(edited))).toBe(false);
    expect(artifactMatches(compiled, OPERATOR_PROFILE, preferenceProfileDigest(edited))).toBe(false);
  });
});
