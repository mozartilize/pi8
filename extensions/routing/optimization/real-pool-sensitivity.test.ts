/**
 * Evidence sensitivity on the frozen real pool. Each case removes or adds one
 * piece of evidence for the actions of one model and compares exact max
 * regret before and after, under the base domain and an operator domain.
 *
 * Contracts, not winners:
 * - Missing evidence (output tokens, price, output speed) widens intervals
 *   only, so it never lowers an affected action's max regret.
 * - A live warm prefix lowers the prompt cost only, so it never raises the incumbent's
 *   max regret.
 * - Every authorized action stays in the ranking in every case.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BenchModel } from '../../types.js';
import { enumerateEffectiveActions } from '../features/actions.js';
import type { DecisionStateV1 } from '../features/state.js';
import { validatePreferences, type UserRoutingPreferencesV1 } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { WorkerLpAdapter } from './lp.js';
import { DomainCache, selectByRegret, type SelectionCandidate, type UnifiedDecision } from './select.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/real-pool.json'), 'utf8')) as {
  indexVersion: string; registry: RegistryModelInfo[]; benchmarks: BenchModel[];
};

const OPERATOR: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};
const PROFILES: readonly [string, UserRoutingPreferencesV1][] = [['base', { version: 1 }], ['operator', OPERATOR]];
/** The regret comparison is exact up to the LP residual tolerance. */
const TOLERANCE = 1e-6;
const NOW = 10_000_000;

const pool = (registry: readonly RegistryModelInfo[]): SelectionCandidate[] => registry
  .filter((model) => model.provider !== 'cursor')
  .flatMap((model) => enumerateEffectiveActions(model).map((action) => ({ model, action })));

const state = (patch: Partial<DecisionStateV1> = {}): DecisionStateV1 => ({
  phase: 'implement', estimatedContextTokens: 100_000, needsVision: false, boundary: 'ordinary', friction: [],
  nowMs: NOW, isSubagentSpawn: false, benchmarkIndexVersion: fixture.indexVersion, ...patch,
});

const lp = new WorkerLpAdapter();
const domains = new DomainCache(lp);
afterAll(() => lp.close());
beforeAll(async () => {
  for (const [, profile] of PROFILES) await domains.compile(profile);
});

async function maxRegret(
  profile: UserRoutingPreferencesV1, s: DecisionStateV1, registry: readonly RegistryModelInfo[], rows: readonly BenchModel[],
): Promise<UnifiedDecision> {
  const preferences = validatePreferences(profile);
  const candidates = pool(registry);
  const result = await selectByRegret(s, candidates, rows, preferences, { lp, domains }, {
    expectedProfileDigest: preferences.digest, decisionDeadlineMs: 60_000,
  }) as UnifiedDecision;
  expect(result.solver).toBe('exact');
  expect([...result.ranking].sort()).toEqual(candidates.map((c) => c.action.key).sort());
  return result;
}

const keysOf = (registryId: string): string[] => pool(fixture.registry).filter((c) => c.action.registryId === registryId).map((c) => c.action.key);

/** A model with a price, output speed and exact-effort output-token observations for several efforts. */
const measured = fixture.registry.find((model) => {
  const id = `${model.provider}/${model.id}`;
  const rows = fixture.benchmarks.filter((row) => row.registryId === id && row.outputTokensProvenance?.status === 'measured');
  return (model.cost?.input ?? 0) > 0 && rows.length >= 2 && rows.every((row) => row.outputSpeedTps !== undefined);
})!;
const measuredId = `${measured.provider}/${measured.id}`;

function expectNotLower(before: UnifiedDecision, after: UnifiedDecision, keys: readonly string[]) {
  for (const key of keys) expect(after.maxRegret!.get(key)!, key).toBeGreaterThanOrEqual(before.maxRegret!.get(key)! - TOLERANCE);
}

describe.each(PROFILES)('real-pool evidence sensitivity (%s domain)', (_label, profile) => {
  it('the pool has a fully measured model to perturb', () => {
    expect(measured).toBeDefined();
  });

  it('missing output-token evidence never lowers the max regret of the affected actions', async () => {
    const before = await maxRegret(profile, state(), fixture.registry, fixture.benchmarks);
    const rows = fixture.benchmarks.map((row) => (row.registryId === measuredId
      ? { ...row, outputTokensPerTask: undefined, outputTokensProvenance: undefined } : row));
    expectNotLower(before, await maxRegret(profile, state(), fixture.registry, rows), keysOf(measuredId));
  });

  it('an unknown price never lowers the max regret of the affected actions', async () => {
    const before = await maxRegret(profile, state(), fixture.registry, fixture.benchmarks);
    const registry = fixture.registry.map((model) => (model === measured ? { ...model, cost: undefined } : model));
    expectNotLower(before, await maxRegret(profile, state(), registry, fixture.benchmarks), keysOf(measuredId));
  });

  it('an unknown output speed never lowers the max regret of the affected actions', async () => {
    const before = await maxRegret(profile, state(), fixture.registry, fixture.benchmarks);
    const rows = fixture.benchmarks.map((row) => (row.registryId === measuredId ? { ...row, outputSpeedTps: undefined } : row));
    expectNotLower(before, await maxRegret(profile, state(), fixture.registry, rows), keysOf(measuredId));
  });

  it('when no action has output-token evidence, every action stays ranked and none uses a measured count', async () => {
    const rows = fixture.benchmarks.map((row) => ({ ...row, outputTokensPerTask: undefined, outputTokensProvenance: undefined }));
    const result = await maxRegret(profile, state(), fixture.registry, rows);
    const details = result.actions.flatMap((a) => a.features.evidence)
      .filter((e) => e.feature === 'costDesirability' || e.feature === 'timeDesirability')
      .flatMap((e) => e.details ?? []).filter((d) => d.startsWith('output-tokens:'));
    expect(details.length).toBeGreaterThan(0);
    expect(details).not.toContain('output-tokens:measured');
    expect(result.actions.every((a) => a.costProxy.tokens.output === undefined)).toBe(true);
  });

  it('a live warm prefix never raises the max regret of the incumbent', async () => {
    const cached = fixture.registry.find((model) => model.promptCache?.short !== undefined && (model.cost?.cacheRead ?? 0) > 0)!;
    expect(cached).toBeDefined();
    const incumbent = pool([cached]).find((c) => c.action.effort === 'high') ?? pool([cached])[0]!;
    const served = { registryId: incumbent.action.registryId, effort: incumbent.action.effort };
    const cold = state({ incumbent: served });
    const warm = state({
      incumbent: served,
      promptIdentity: 'head',
      cache: {
        promptIdentity: 'head', incumbentKey: incumbent.action.key, retention: 'short',
        warmPrefixes: new Map([[incumbent.action.key, [{ tokens: 80_000, observedAtMs: NOW - 1_000, hitProbability: 1, retention: 'short' }]]]),
      },
    });
    const before = await maxRegret(profile, cold, fixture.registry, fixture.benchmarks);
    const after = await maxRegret(profile, warm, fixture.registry, fixture.benchmarks);
    expect(after.maxRegret!.get(incumbent.action.key)!).toBeLessThanOrEqual(before.maxRegret!.get(incumbent.action.key)! + TOLERANCE);
    const credited = after.actions.find((a) => a.features.key === incumbent.action.key)!;
    expect(credited.costProxy.cacheEligibility).toBe('eligible');
  });
});
