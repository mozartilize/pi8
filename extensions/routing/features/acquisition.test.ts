import { describe, expect, it } from 'vitest';
import type { BenchModel } from '../../types.js';
import { registryModel } from '../../test-support/router-fixtures.js';
import { enumerateEffectiveActions } from './actions.js';
import { candidateFeatures } from './candidate.js';
import { FEATURE_INDEX } from './schema.js';
import type { DecisionStateV1 } from './state.js';

const model = registryModel('test/collector', { reasoning: false });
const action = enumerateEffectiveActions(model)[0]!;
const state: DecisionStateV1 & { contextAcquisition: boolean } = {
  phase: 'gather', contextAcquisition: true, estimatedContextTokens: 8_000,
  needsVision: false, boundary: 'ordinary', friction: [], nowMs: 0,
  benchmarkIndexVersion: '4.3',
};
const row: BenchModel = {
  registryId: action.registryId, benchSlug: 'collector', active: true, source: 'aa', effort: action.effort,
  quality: { intelligence: 19, research: 0, knowledge: -100, agenticCoding: 0 },
  axisProvenance: { intelligence: 'measured', research: 'measured', knowledge: 'measured', agenticCoding: 'measured' },
};
const at = (s = state, r = row) => candidateFeatures(s, model, action, [r]);
const research = (result: ReturnType<typeof at>) => {
  const i = FEATURE_INDEX.researchFit;
  return [result.features.values[i], result.features.lower[i], result.features.upper[i]];
};

describe('capabilities while collecting context', () => {
  it('uses target 0.20 without declaring unknown difficulty easy or changing reasoning relevance', () => {
    const result = at();
    expect(result.capabilityShortfall).toBeCloseTo(1 / 15);
    expect(result.features.values[FEATURE_INDEX.reasoningFit]).toBeCloseTo(0.4 * 14 / 15);
    const evidence = result.features.evidence.find((e) => e.feature === 'reasoningFit')!;
    expect(evidence.details).toContain('target:reasoning:0.200');
    expect(evidence.details).toContain('difficulty:unknown');
    expect(at({ ...state, openDecisions: 2 }).features.values[FEATURE_INDEX.reasoningFit]).toBeCloseTo(0.9 * 14 / 15);
    expect(at(state, { ...row, quality: { ...row.quality, intelligence: 20 } }).capabilityShortfall).toBe(0);
  });

  it('makes research and knowledge irrelevant to fit and capability shortfall', () => {
    for (const quality of [{ research: 0, knowledge: -100 }, { research: 1, knowledge: 100 }, { research: undefined, knowledge: undefined }]) {
      const result = at(state, { ...row, quality: { ...row.quality, intelligence: 20, ...quality } });
      expect(result.capabilityShortfall).toBe(0);
      expect(research(result)).toEqual([0.5, 0.5, 0.5]);
      expect(result.features.evidence.find((e) => e.feature === 'researchFit')?.code).toBe('not-relevant');
      expect(result.evidenceGaps).toEqual([]);
    }
  });

  it('requires exact-effort Intelligence evidence and retains uncertainty intervals', () => {
    const missing = at(state, { ...row, quality: { research: 1, knowledge: 100 } });
    expect(missing.evidenceGaps).toEqual(['intelligence']);
    expect(missing.features.lower[FEATURE_INDEX.reasoningFit]).toBe(0);
    expect(missing.features.upper[FEATURE_INDEX.reasoningFit]).toBe(0.4);
    expect(missing.capabilityShortfall).toBe(0);
    const estimated = at(state, { ...row, axisProvenance: { intelligence: 'source-estimated' } });
    expect(estimated.evidenceGaps).toEqual([]);
    expect(estimated.features.lower[0]).toBe(0);
    expect(estimated.features.upper[0]).toBe(0.4);
    expect(at(state, { ...row, effort: 'high' }).evidenceGaps).toEqual(['intelligence']);
    expect(at({ ...state, benchmarkIndexVersion: '99.0' }).evidenceGaps).toEqual(['intelligence']);
  });

  it('keeps image and long-context evidence requirements at the same boundary', () => {
    expect(at({ ...state, estimatedContextTokens: 63_999 }).evidenceGaps).toEqual([]);
    expect(at({ ...state, estimatedContextTokens: 64_000, needsVision: true }).evidenceGaps).toEqual(['visionReasoning', 'longContext']);
  });

  it.each(['plan', 'review', 'implement'] as const)('ignores the collecting-context mark in %s', (phase) => {
    for (const value of [undefined, 0, 0.65, 1]) {
      const s = { ...state, phase, ...(value === undefined ? {} : { difficulty: { value, source: 'reasoning-rubric' as const } }) };
      expect(at(s)).toEqual(at({ ...s, contextAcquisition: false }));
    }
  });

  it('uses gather-deliverable targets and research evidence without the mark', () => {
    const result = at({ ...state, contextAcquisition: false });
    // Research quality zero misses even the easiest target (0.25) by 1.25 shortfall units.
    expect(result.capabilityShortfall).toBeCloseTo(1.25);
    expect(research(result)).toEqual([0, 0, 0]);
    expect(result.features.evidence.find((e) => e.feature === 'reasoningFit')?.details).toContain('target-bounds:reasoning:0.200:0.550');
    expect(at({ ...state, contextAcquisition: false }, { ...row, quality: { intelligence: 20 } }).evidenceGaps).toEqual(['research']);
  });
});
