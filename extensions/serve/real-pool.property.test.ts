import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { BenchModel, Candidate } from '../types.js';
import { effortDropsPerStep } from '../routing/score/effort-estimate.js';
import {
  candidateKey,
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
  indexVersion: string;
  registryDigest: string;
  benchmarkDigest: string;
};
const drops = effortDropsPerStep(fixture.benchmarks);
const rowsByModel = new Map<string, BenchModel[]>();
for (const row of fixture.benchmarks) rowsByModel.set(row.registryId, [...(rowsByModel.get(row.registryId) ?? []), row]);
const registryById = new Map(fixture.registry.map((m) => [`${m.provider}/${m.id}`, m]));
const candidates: Candidate[] = fixture.registry.flatMap((m) =>
  expandModelCandidates(m, rowsByModel.get(`${m.provider}/${m.id}`) ?? [], drops));
const measured = new Set(fixture.benchmarks.map((row) => `${row.registryId}:${row.effort ?? ''}`));

// What each provider sends, stated here rather than read from the router so
// the test does not repeat a router mistake. Pi lists the levels a model
// supports. claude-bridge sends no effort for `off`, so Claude Code thinks at
// its default effort and never runs the mode an off row measures.
const sendsLevel = (model: RegistryModelInfo, level: string): boolean => {
  if (!model.reasoning) return level === 'off';
  if (level === 'off' && model.provider === 'claude-bridge') return false;
  return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]).includes(level as never);
};

describe('real candidate pool', () => {
  it('records both frozen halves and benchmark provenance', () => {
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(digest(fixture.registry)).toBe(fixture.registryDigest);
    expect(digest(fixture.benchmarks)).toBe(fixture.benchmarkDigest);
    expect(fixture.indexVersion).toBeTruthy();
    expect(fixture.benchmarks.filter((row) => row.active && !row.axisProvenance)).toEqual([]);
  });

  it('contains only public registry metadata, not credentials or endpoint settings', () => {
    const allowed = new Set(['provider', 'id', 'api', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'cost', 'thinkingLevelMap', 'promptCache', 'compat']);
    expect(fixture.registry.flatMap((model) => Object.keys(model).filter((key) => !allowed.has(key)))).toEqual([]);
    expect(fixture.registry.flatMap((model) => Object.keys(model.compat ?? {}).filter((key) => key !== 'supportsMidConvoEffort'))).toEqual([]);
  });

  it('keeps the prompt-cache lifetimes that warm-prefix credit reads', () => {
    // Without them every warm prefix in the frozen pool is `ttl-unknown`.
    expect(fixture.registry.some((model) => model.promptCache !== undefined)).toBe(true);
  });

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
