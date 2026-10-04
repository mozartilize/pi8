import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { BenchModel, Candidate, Dimension } from '../types.js';
import { DEFAULT_DIMENSION_WEIGHTS } from '../constants.js';
import { effortDropsPerStep } from '../routing/score/effort-estimate.js';
import {
  candidateKey,
  pickBest,
  servedEffort,
  type RegistryModelInfo,
} from '../routing/score/scorer.js';
import { expandModelCandidates } from './provider.js';

// A frozen copy of real input: benchmark rows from one sync and the matching
// pi-ai catalog entries. Hand-written fixtures repeat the author's
// assumptions; this data does not. The tests pin properties that must hold
// for any realistic pool, never which model wins.
const fixture = JSON.parse(readFileSync(join(__dirname, '../../fixtures/real-pool.json'), 'utf8')) as {
  registry: RegistryModelInfo[];
  benchmarks: BenchModel[];
};
const drops = effortDropsPerStep(fixture.benchmarks);
const rowsByModel = new Map<string, BenchModel[]>();
for (const row of fixture.benchmarks) rowsByModel.set(row.registryId, [...(rowsByModel.get(row.registryId) ?? []), row]);
const registryById = new Map(fixture.registry.map((m) => [`${m.provider}/${m.id}`, m]));
const candidates: Candidate[] = fixture.registry.flatMap((m) =>
  expandModelCandidates(m, rowsByModel.get(`${m.provider}/${m.id}`) ?? [], drops));
const measured = new Set(fixture.benchmarks.map((row) => `${row.registryId}:${row.effort ?? ''}`));
const DIMENSIONS: Dimension[] = ['gather', 'plan', 'review', 'implement'];

// What each provider sends, stated here rather than read from the router so
// the test does not repeat a router mistake. Pi lists the levels a model
// supports. claude-bridge sends no effort for `off`, so Claude Code thinks at
// its default effort and never runs the mode an off row measures.
const sendsLevel = (model: RegistryModelInfo, level: string): boolean => {
  if (!model.reasoning) return level === 'off';
  if (level === 'off' && model.provider === 'claude-bridge') return false;
  return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]).includes(level as never);
};
const decisions = DIMENSIONS.map((dimension) => ({
  dimension,
  decision: pickBest(candidates, dimension, DEFAULT_DIMENSION_WEIGHTS[dimension], { estimatedContextTokens: 20_000 }),
}));

describe('real candidate pool', () => {
  it('has a candidate for every catalog model', () => {
    const models = new Set(candidates.map((c) => c.registryId));
    expect([...registryById.keys()].filter((id) => !models.has(id))).toEqual([]);
  });

  it('emits only efforts the provider sends as that effort', () => {
    const wrong = candidates.filter((c) => {
      if (c.effort == null) return false;
      return !sendsLevel(registryById.get(c.registryId)!, c.effort);
    });
    expect(wrong.map(candidateKey)).toEqual([]);
  });

  it('never estimates minimal', () => {
    const estimated = candidates.filter((c) => c.effort === 'minimal' && !measured.has(`${c.registryId}:minimal`));
    expect(estimated.map(candidateKey)).toEqual([]);
  });

  it('serves every labelled candidate at the effort it was scored at', () => {
    const moved = candidates.filter((c) => c.effort != null && c.reasoning && servedEffort(c) !== c.effort);
    expect(moved.map(candidateKey)).toEqual([]);
  });

  it('gives estimated rows no per-task cost or time', () => {
    const estimated = candidates.filter((c) => c.effort != null && !measured.has(`${c.registryId}:${c.effort}`));
    expect(estimated.length).toBeGreaterThan(0);
    expect(estimated.filter((c) => c.bench?.costPerTask != null || c.bench?.timePerTaskSeconds != null).map(candidateKey))
      .toEqual([]);
  });
});

describe('real pool decisions', () => {
  it.each(DIMENSIONS)('%s chooses a candidate that meets every minimum', (dimension) => {
    const { decision } = decisions.find((d) => d.dimension === dimension)!;
    const reason = decision.candidateDiagnostics?.find((d) => d.candidateKey === decision.chosen)?.excludedReason;
    expect(reason).toBeUndefined();
  });

  it.each(DIMENSIONS)('%s compares cost per task, since most of the pool carries it', (dimension) => {
    expect(decisions.find((d) => d.dimension === dimension)!.decision.reason).toContain('[cost per task]');
  });

  it('does not choose the highest effort of the chosen model for every task type', () => {
    // On a $/1M scale every effort of a model costs the same, so the highest
    // effort always wins. Per-task cost and time tell efforts apart.
    const highest = decisions.map(({ decision }) => {
      const chosen = candidates.find((c) => candidateKey(c) === decision.chosen)!;
      const efforts = candidates.filter((c) => c.registryId === chosen.registryId && c.effort != null).map((c) => c.effort!);
      const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      return chosen.effort === efforts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).at(-1);
    });
    expect(highest.every(Boolean)).toBe(false);
  });
});
