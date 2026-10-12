/**
 * Task difficulty on the frozen real pool (`fixtures/real-pool.json`). The
 * tests pin properties that hold for any realistic pool, never which model
 * wins: a harder task never selects an action that measures weaker on the
 * phase's main axis, and unknown difficulty sits between the two ends.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { BenchModel, Dimension, ProvenanceAxis } from '../../types.js';
import { enumerateEffectiveActions } from '../features/actions.js';
import { rowAtServedEffort } from '../features/model.js';
import type { DecisionStateV1, TaskDifficulty } from '../features/state.js';
import { validatePreferences } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { WorkerLpAdapter } from './lp.js';
import { DomainCache, selectByRegret, type UnifiedDecision } from './select.js';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/real-pool.json'), 'utf8')) as {
  registry: RegistryModelInfo[]; benchmarks: BenchModel[]; indexVersion: string;
};
const pool = fixture.registry
  .filter((model) => model.provider !== 'cursor')
  .flatMap((model) => enumerateEffectiveActions(model).map((action) => ({ model, action })));
const MAIN_AXIS: Partial<Record<Dimension, ProvenanceAxis>> = { plan: 'intelligence', review: 'intelligence', implement: 'agenticCoding' };
const lp = new WorkerLpAdapter();
const ports = { lp, domains: new DomainCache(lp) };
const empty = validatePreferences(undefined);

async function chosenQuality(phase: Dimension, difficulty: TaskDifficulty | undefined): Promise<number> {
  const state: DecisionStateV1 = {
    phase, estimatedContextTokens: 30_000, needsVision: false, boundary: 'ordinary', friction: [],
    nowMs: 0, isSubagentSpawn: false, benchmarkIndexVersion: fixture.indexVersion, ...(difficulty ? { difficulty } : {}),
  };
  const result = await selectByRegret(state, pool, fixture.benchmarks, empty, ports, { expectedProfileDigest: empty.digest, decisionDeadlineMs: 60_000 });
  const decision = result as UnifiedDecision;
  expect(decision.solver).toBe('exact');
  const chosen = pool.find((candidate) => candidate.action.key === decision.chosen)!;
  return rowAtServedEffort(fixture.benchmarks, chosen.action)!.quality[MAIN_AXIS[phase]!]!;
}

describe('task difficulty on the real pool', () => {
  it.each(['plan', 'review', 'implement'] as const)('%s: easy <= unknown <= hard on the main axis of the choice', async (phase) => {
    const source = phase === 'implement' ? 'execution-rubric' : 'reasoning-rubric';
    const easy = await chosenQuality(phase, { value: 0, source });
    const unknown = await chosenQuality(phase, undefined);
    const hard = await chosenQuality(phase, { value: 1, source });
    expect(easy).toBeLessThanOrEqual(unknown);
    expect(unknown).toBeLessThanOrEqual(hard);
    // The range is real: the hard choice measures stronger than the easy one.
    expect(hard).toBeGreaterThan(easy);
  }, 120_000);
});
