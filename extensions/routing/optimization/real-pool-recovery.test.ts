/**
 * Recovery on the frozen real pool (`fixtures/real-pool.json`). Contracts,
 * not winners:
 * - Friction applies to the exact failed action only: another effort of the
 *   same model and another model at the same effort keep full friction
 *   avoidance.
 * - The friction penalty makes the exact failed action worse than it is
 *   without that friction event, so pre-output recovery keeps the failed
 *   action reachable but ranked lower.
 * - At a rework boundary a higher effort of the failed model is an effort
 *   recovery, a lower or equal effort is no recovery, and another model is a
 *   model switch.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BenchModel } from '../../types.js';
import { effortRank, enumerateEffectiveActions } from '../features/actions.js';
import type { DecisionStateV1 } from '../features/state.js';
import { validatePreferences } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { WorkerLpAdapter } from './lp.js';
import { DomainCache, selectByRegret, type SelectionCandidate, type UnifiedDecision } from './select.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/real-pool.json'), 'utf8')) as {
  indexVersion: string; registry: RegistryModelInfo[]; benchmarks: BenchModel[];
};
const NOW = 10_000_000;
const TOLERANCE = 1e-6;

const pool: SelectionCandidate[] = fixture.registry
  .filter((model) => model.provider !== 'cursor')
  .flatMap((model) => enumerateEffectiveActions(model).map((action) => ({ model, action })));

const byModel = new Map<string, SelectionCandidate['action'][]>();
for (const c of pool) if (c.action.effort) byModel.set(c.action.registryId, [...(byModel.get(c.action.registryId) ?? []), c.action]);

/**
 * The failed action is the best-ranked ordinary action whose model has a
 * lower and a higher effort: the realistic case is a loop of the action the
 * router chose. A low-ranked action has saturated regret, and friction
 * cannot show in it.
 */
let failed: { lower: SelectionCandidate['action']; source: SelectionCandidate['action']; higher: SelectionCandidate['action'] };
let source: { registryId: string; effort: NonNullable<SelectionCandidate['action']['effort']> };
let otherAtSameEffort: SelectionCandidate['action'];

const reworkState = (withFriction: boolean): DecisionStateV1 => ({
  phase: 'implement', workItemId: 'W', estimatedContextTokens: 50_000, needsVision: false,
  boundary: 'rework', rework: { failed: source, workItemId: 'W' },
  friction: withFriction ? [{ ...source, workItemId: 'W', kind: 'severe-reasoning-loop' }] : [],
  nowMs: NOW, benchmarkIndexVersion: fixture.indexVersion,
});

const lp = new WorkerLpAdapter();
const domains = new DomainCache(lp);
const preferences = validatePreferences({ version: 1 });
afterAll(() => lp.close());
beforeAll(async () => {
  await domains.compile({ version: 1 });
  const ordinary = await select({ phase: 'implement', estimatedContextTokens: 50_000, needsVision: false, boundary: 'ordinary',
    friction: [], nowMs: NOW, benchmarkIndexVersion: fixture.indexVersion });
  for (const key of ordinary.ranking) {
    const action = pool.find((c) => c.action.key === key)!.action;
    const siblings = byModel.get(action.registryId) ?? [];
    const lower = siblings.find((a) => effortRank(a.effort) < effortRank(action.effort));
    const higher = siblings.find((a) => effortRank(a.effort) > effortRank(action.effort));
    const other = pool.find((c) => c.action.registryId !== action.registryId && c.action.effort === action.effort)?.action;
    if (!action.effort || !lower || !higher || !other) continue;
    failed = { lower, source: action, higher };
    source = { registryId: action.registryId, effort: action.effort };
    otherAtSameEffort = other;
    break;
  }
});

const select = async (state: DecisionStateV1): Promise<UnifiedDecision> => {
  const result = await selectByRegret(state, pool, fixture.benchmarks, preferences, { lp, domains }, {
    expectedProfileDigest: preferences.digest, decisionDeadlineMs: 60_000,
  }) as UnifiedDecision;
  expect(result.solver).toBe('exact');
  return result;
};
const feature = (result: UnifiedDecision, key: string, name: string): number => {
  const action = result.actions.find((a) => a.features.key === key)!;
  return action.features.values[['reasoningFit', 'agenticFit', 'researchFit', 'inputFit', 'costDesirability',
    'timeDesirability', 'continuity', 'frictionAvoidance', 'effortRecoveryFit', 'modelSwitchRecoveryFit'].indexOf(name)]!;
};

describe('real-pool pre-output recovery', () => {
  it('the pool has a model with lower, failed, and higher efforts, and another model at the failed effort', () => {
    expect(effortRank(failed.lower.effort)).toBeLessThan(effortRank(failed.source.effort));
    expect(effortRank(failed.higher.effort)).toBeGreaterThan(effortRank(failed.source.effort));
    expect(otherAtSameEffort).toBeDefined();
  });

  it('penalizes only the exact failed action, and ranks it lower than without the friction event', async () => {
    const plain = await select(reworkState(false));
    const loop = await select(reworkState(true));
    expect(feature(loop, failed.source.key, 'frictionAvoidance')).toBe(0.25);
    for (const key of [failed.lower.key, failed.higher.key, otherAtSameEffort.key]) {
      expect(feature(loop, key, 'frictionAvoidance'), key).toBe(1);
    }
    expect(feature(plain, failed.source.key, 'frictionAvoidance')).toBe(1);
    expect(loop.maxRegret!.get(failed.source.key)!).toBeGreaterThan(plain.maxRegret!.get(failed.source.key)! + TOLERANCE);
    expect(loop.ranking.indexOf(failed.source.key)).toBeGreaterThanOrEqual(plain.ranking.indexOf(failed.source.key));
    // The failed action stays a legal, ranked action.
    expect(loop.ranking).toContain(failed.source.key);
  });

  it('distinguishes a higher effort of the failed model from a model switch', async () => {
    const result = await select(reworkState(true));
    expect([feature(result, failed.higher.key, 'effortRecoveryFit'), feature(result, failed.higher.key, 'modelSwitchRecoveryFit')]).toEqual([1, 0]);
    expect([feature(result, failed.lower.key, 'effortRecoveryFit'), feature(result, failed.lower.key, 'modelSwitchRecoveryFit')]).toEqual([0, 0]);
    expect([feature(result, failed.source.key, 'effortRecoveryFit'), feature(result, failed.source.key, 'modelSwitchRecoveryFit')]).toEqual([0, 0]);
    expect([feature(result, otherAtSameEffort.key, 'effortRecoveryFit'), feature(result, otherAtSameEffort.key, 'modelSwitchRecoveryFit')]).toEqual([0, 1]);
  });
});
