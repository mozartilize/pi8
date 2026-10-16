/**
 * Feature mapping contracts (testing plan N1, N2, N3, N5 and the cache matrix).
 * Expected values are hand calculations from the frozen mapping table; the
 * benchmark rows pass through the real adapter, matcher and store merge.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { normalize, type AARawModel } from '../../adapters/artificial-analysis.js';
import type { AASiteModel } from '../../adapters/artificial-analysis-site.js';
import { resolveRows } from '../../bench/matcher.js';
import { mergeBenchRows } from '../../bench/store.js';
import type { BenchModel } from '../../types.js';
import { estimateRow } from '../score/effort-estimate.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { enumerateEffectiveActions, overrideAction, type EffectiveAction } from './actions.js';
import { candidateFeatures } from './candidate.js';
import { evidenceGaps } from './model.js';
import { composeTaskDemand } from './task-demand.js';
import { FEATURE_INDEX, type FeatureName } from './schema.js';
import { continuityFeature } from './continuity.js';
import { recoveryFeatures } from './recovery.js';
import type { DecisionStateV1 } from './state.js';

const EPS = 1e-6;

const registryModel = (provider: string, id: string, extra: Partial<RegistryModelInfo> = {}): RegistryModelInfo => ({
  provider,
  id,
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' },
  cost: { input: 1, output: 4, cacheRead: 0.1 },
  ...extra,
});

const state = (patch: Partial<DecisionStateV1> = {}): DecisionStateV1 => ({
  phase: 'implement',
  // Provenance tests hold demand fixed to isolate benchmark uncertainty.
  difficulty: { value: 1, source: 'execution-rubric' },
  estimatedContextTokens: 10_000,
  needsVision: false,
  boundary: 'ordinary',
  friction: [],
  nowMs: 1_000_000,
  isSubagentSpawn: false,
  benchmarkIndexVersion: '4.3',
  ...patch,
});

const feature = (vector: { values: number[]; lower: number[]; upper: number[] }, name: FeatureName) => {
  const j = FEATURE_INDEX[name];
  return [vector.values[j]!, vector.lower[j]!, vector.upper[j]!];
};

const expectTriple = (actual: number[], expected: [number, number, number]) => {
  actual.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(EPS));
};

const raw = (slug: string, name: string, evaluations: AARawModel['evaluations'], extra: Partial<AARawModel> = {}): AARawModel =>
  ({ slug, name, evaluations, ...extra });

const pipeline = (rows: AARawModel[], site: AASiteModel[], registry: RegistryModelInfo[]): BenchModel[] =>
  mergeBenchRows(resolveRows(normalize(rows, site), registry, {}));

/** A benchmark row with a measured output-token count, or with none when `tokens` is undefined. */
const outputRow = (registryId: string, effort: ModelThinkingLevel | undefined, tokens: number | undefined, extra: Partial<BenchModel> = {}): BenchModel => ({
  registryId, benchSlug: `${registryId}-${effort}`, active: true, effort, source: 'aa',
  quality: { intelligence: 50 }, axisProvenance: { intelligence: 'measured' }, outputSpeedTps: 100,
  ...(tokens === undefined ? {} : { outputTokensPerTask: tokens, outputTokensProvenance: { status: 'measured' as const, indexVersion: '4.3.2' } }),
  ...extra,
});

const featuresOf = (s: DecisionStateV1, model: RegistryModelInfo, action: EffectiveAction, rows: BenchModel[]) =>
  candidateFeatures(s, model, action, rows).features;

describe('N1: supported effort coverage, scored effort = sent effort', () => {
  const model = registryModel('p', 'xmodel');
  const rows = pipeline(
    [raw('xmodel', 'X Model (high)', { artificial_analysis_intelligence_index: 62 })],
    [{ slug: 'xmodel', name: 'X Model (high)', intelligenceIndexIsEstimated: false, terminalBench40: 0.4 }],
    [model],
  );

  it('keeps every supported effort as an action, measured or not', () => {
    expect(enumerateEffectiveActions(model).map((action) => action.effort)).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('scores the measured effort exactly and unmeasured efforts with the missing interval', () => {
    const actions = enumerateEffectiveActions(model);
    const at = (effort: ModelThinkingLevel) => featuresOf(state(), model, actions.find((a) => a.effort === effort)!, rows);
    expectTriple(feature(at('high'), 'reasoningFit'), [0.6, 0.6, 0.6]);
    expectTriple(feature(at('high'), 'agenticFit'), [0, 0, 0]);
    expectTriple(feature(at('medium'), 'reasoningFit'), [0.4, 0, 0.6]);
    expectTriple(feature(at('max'), 'reasoningFit'), [0.4, 0, 0.6]);
    expectTriple(feature(at('max'), 'agenticFit'), [0.5, 0, 1]);
  });

  it('does not let an effort step-down estimate replace the missing representative', () => {
    const stepped = estimateRow('medium', rows, { intelligence: 6 })!;
    expect(stepped.quality.intelligence).toBeCloseTo(56, 9);
    expect(stepped.axisProvenance?.intelligence).toBe('effort-stepdown');
    const medium = enumerateEffectiveActions(model).find((a) => a.effort === 'medium')!;
    expectTriple(feature(featuresOf(state(), model, medium, [...rows, stepped]), 'reasoningFit'), [0.4, 0, 0.6]);
  });

  it('resolves an explicit high override to the single high action', () => {
    expect(overrideAction(model, 'high')).toMatchObject({ key: 'p/xmodel:high', effort: 'high' });
    // `xhigh` is unsupported; Pi clamps it to the nearest supported level above.
    expect(overrideAction(model, 'xhigh')?.effort).toBe('max');
  });

  it('collapses levels that Pi sends as the same provider value into one action', () => {
    const aliased = registryModel('p', 'alias', { thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: null, max: null } });
    const actions = enumerateEffectiveActions(aliased);
    expect(actions.map((a) => [a.effort, a.levels])).toEqual([['low', ['minimal', 'low']], ['high', ['medium', 'high']]]);
    expect(overrideAction(aliased, 'minimal')?.key).toBe('p/alias:low');
  });
});

describe('N2: axis provenance through the real pipeline', () => {
  // 25 rows with Terminal-Bench give the adapter a regression fit; row P has
  // no Terminal-Bench result, so its agentic coding value is a regression bridge.
  const fillers: AARawModel[] = Array.from({ length: 25 }, (_, i) =>
    raw(`filler-${i}`, `Filler ${i} (high)`, {
      artificial_analysis_intelligence_index: 30 + i,
      artificial_analysis_coding_index: 20 + i * 1.5,
      artificial_analysis_agentic_index: 25 + i * 0.8,
    }));
  const fillerSite: AASiteModel[] = fillers.map((row, i) => ({
    slug: row.slug!, name: row.name!, intelligenceIndexIsEstimated: false, terminalBench40: 0.1 + i * 0.012 + (i % 3) * 0.01,
  }));
  const P = registryModel('p', 'pmodel');
  const Q = registryModel('q', 'qmodel');
  const rows = pipeline(
    [
      ...fillers,
      raw('pmodel', 'P Model (high)', { artificial_analysis_intelligence_index: 62, artificial_analysis_coding_index: 50, artificial_analysis_agentic_index: 41 }),
      raw('qmodel', 'Q Model (high)', { artificial_analysis_intelligence_index: 62 }),
    ],
    [
      ...fillerSite,
      { slug: 'pmodel', name: 'P Model (high)', intelligenceIndexIsEstimated: false },
      { slug: 'qmodel', name: 'Q Model (high)', intelligenceIndexIsEstimated: false, terminalBench40: 0.45 },
    ],
    [P, Q],
  );
  const pRow = rows.find((row) => row.registryId === 'p/pmodel')!;
  const pHigh = enumerateEffectiveActions(P).find((a) => a.effort === 'high')!;
  const qHigh = enumerateEffectiveActions(Q).find((a) => a.effort === 'high')!;

  it('records measured Intelligence and a regression-bridge agentic value independently', () => {
    expect(pRow.quality.agenticCoding).toBeDefined();
    expect(pRow.axisProvenance).toMatchObject({ intelligence: 'measured', agenticCoding: 'regression-bridge' });
    expect(pRow.qualityEstimated).toBe(true);
  });

  it('keeps the exact Intelligence feature and ignores the regression in center and interval', () => {
    const p = featuresOf(state(), P, pHigh, rows);
    expectTriple(feature(p, 'reasoningFit'), [0.6, 0.6, 0.6]);
    expectTriple(feature(p, 'agenticFit'), [0.5, 0, 1]);
    expect(p.evidence.find((e) => e.feature === 'agenticFit')).toMatchObject({ code: 'missing', details: ['agenticCoding:regression-bridge', 'difficulty:execution-rubric:1.000', 'target:agentic:0.600', 'target-bounds:agentic:0.600:0.600'] });
    expectTriple(feature(featuresOf(state(), Q, qHigh, rows), 'agenticFit'), [0.25, 0.25, 0.25]);
  });

  it('treats a source-estimated value as a center with the full missing interval', () => {
    const estimated = pipeline(
      [raw('qmodel', 'Q Model (high)', { artificial_analysis_intelligence_index: 62 })],
      [{ slug: 'qmodel', name: 'Q Model (high)', intelligenceIndexIsEstimated: true }],
      [Q],
    );
    expectTriple(feature(featuresOf(state(), Q, qHigh, estimated), 'reasoningFit'), [0.6, 0, 0.6]);
  });

  it('gives no evidence for an ambiguous legacy row or an incompatible index version', () => {
    const legacy: BenchModel = { ...pRow, axisProvenance: undefined };
    expectTriple(feature(featuresOf(state(), P, pHigh, [legacy]), 'reasoningFit'), [0.4, 0, 0.6]);
    expectTriple(feature(featuresOf(state({ benchmarkIndexVersion: '5.0' }), P, pHigh, rows), 'reasoningFit'), [0.4, 0, 0.6]);
  });
});

describe('N2 merge: whole-row precedence', () => {
  const base = { registryId: 'm/x', active: true, effort: 'high' as const, source: 'artificial-analysis' };
  const X: BenchModel = {
    ...base, benchSlug: 'x-b', qualityEstimated: true,
    quality: { intelligence: 60, research: 0.5, agenticCoding: 30 },
    axisProvenance: { intelligence: 'measured', research: 'measured', agenticCoding: 'regression-bridge' },
  };
  const Y: BenchModel = {
    ...base, benchSlug: 'x-a',
    quality: { intelligence: 70, knowledge: 10, longContext: 0.5, visionReasoning: 0.4 },
    axisProvenance: { intelligence: 'measured', knowledge: 'source-estimated', longContext: 'effort-stepdown', visionReasoning: 'missing' },
  };

  it('keeps the row with more measured axes in either input order, regardless of the estimate flag', () => {
    expect(mergeBenchRows([X, Y])).toEqual([X]);
    expect(mergeBenchRows([Y, X])).toEqual([X]);
  });

  it('with equal measured counts, prefers more eligible axes, then the smaller source key', () => {
    const one: BenchModel = { ...base, benchSlug: 'z', quality: { intelligence: 60, knowledge: 1 }, axisProvenance: { intelligence: 'measured', knowledge: 'source-estimated' } };
    const two: BenchModel = { ...base, benchSlug: 'a', quality: { intelligence: 60, agenticCoding: 9 }, axisProvenance: { intelligence: 'measured', agenticCoding: 'regression-bridge' } };
    expect(mergeBenchRows([two, one])).toEqual([one]);
    const three: BenchModel = { ...base, benchSlug: 'a', quality: { intelligence: 61, knowledge: 2 }, axisProvenance: { intelligence: 'measured', knowledge: 'source-estimated' } };
    expect(mergeBenchRows([one, three])).toEqual([three]);
    expect(mergeBenchRows([three, one])).toEqual([three]);
  });
});

describe('required evidence per phase', () => {
  const model = registryModel('p', 'xmodel');
  const action = enumerateEffectiveActions(model).find((a) => a.effort === 'high')!;
  const full: BenchModel['axisProvenance'] = { intelligence: 'measured', agenticCoding: 'measured', research: 'measured', knowledge: 'measured', longContext: 'measured', visionReasoning: 'measured' };
  const row = (quality: BenchModel['quality'], axisProvenance: BenchModel['axisProvenance']): BenchModel[] =>
    [{ registryId: 'p/xmodel', benchSlug: 'xmodel', active: true, effort: 'high', source: 'aa', quality, axisProvenance }];
  const gaps = (rows: BenchModel[], patch: Partial<DecisionStateV1> = {}) =>
    candidateFeatures(state(patch), model, action, rows).evidenceGaps;

  it('a model with no benchmark row has a gap on every axis its phase relies on', () => {
    expect(gaps([], { phase: 'lightweight' })).toEqual([]);
    expect(gaps([], { phase: 'gather' })).toEqual(['research']);
    expect(gaps([], { phase: 'plan' })).toEqual(['intelligence']);
    expect(gaps([], { phase: 'review' })).toEqual(['intelligence']);
    expect(gaps([], { phase: 'implement' }).sort()).toEqual(['agenticCoding', 'intelligence']);
  });

  it('needs only the axes of the phase: missing vision or research does not matter for implement', () => {
    const rows = row({ intelligence: 50, agenticCoding: 30 }, { intelligence: 'measured', agenticCoding: 'measured' });
    expect(gaps(rows, { phase: 'implement' })).toEqual([]);
    expect(gaps(rows, { phase: 'gather' })).toEqual(['research']);
  });

  it('needs vision only with an image and long-context quality only from 64,000 tokens', () => {
    const rows = row({ intelligence: 50 }, { intelligence: 'measured' });
    expect(gaps(rows, { phase: 'plan' })).toEqual([]);
    expect(gaps(rows, { phase: 'plan', needsVision: true })).toEqual(['visionReasoning']);
    expect(gaps(rows, { phase: 'plan', estimatedContextTokens: 63_999 })).toEqual([]);
    expect(gaps(rows, { phase: 'plan', estimatedContextTokens: 64_000 })).toEqual(['longContext']);
  });

  it('counts measured and source-estimated values as evidence, and nothing else', () => {
    const at = (provenance: NonNullable<BenchModel['axisProvenance']>[keyof NonNullable<BenchModel['axisProvenance']>]) =>
      gaps(row({ intelligence: 50 }, { intelligence: provenance }), { phase: 'plan' });
    expect(at('measured')).toEqual([]);
    expect(at('source-estimated')).toEqual([]);
    for (const none of ['regression-bridge', 'effort-stepdown', 'missing'] as const) expect(at(none)).toEqual(['intelligence']);
    // A value without provenance (a row written before provenance existed) is not evidence.
    expect(gaps(row({ intelligence: 50 }, undefined), { phase: 'plan' })).toEqual(['intelligence']);
    // An incompatible index version voids Intelligence.
    expect(gaps(row({ intelligence: 50 }, full), { phase: 'plan', benchmarkIndexVersion: '5.0' })).toEqual(['intelligence']);
  });

  it('an unmeasured effort of a measured model has a gap: evidence is exact-effort only', () => {
    const rows = row({ intelligence: 62 }, { intelligence: 'measured' });
    const max = enumerateEffectiveActions(model).find((a) => a.effort === 'max')!;
    expect(candidateFeatures(state({ phase: 'plan' }), model, max, rows).evidenceGaps).toEqual(['intelligence']);
    expect(evidenceGaps(rows[0], composeTaskDemand(state({ phase: 'plan' })), state({ phase: 'plan' }))).toEqual([]);
  });
});

describe('N3: feature boundaries and fixed missing shares', () => {
  const model = registryModel('p', 'xmodel');
  const action = enumerateEffectiveActions(model).find((a) => a.effort === 'high')!;
  const row = (quality: BenchModel['quality'], axisProvenance: BenchModel['axisProvenance']): BenchModel[] =>
    [{ registryId: 'p/xmodel', benchSlug: 'xmodel', active: true, effort: 'high', source: 'aa', quality, axisProvenance }];

  it('keeps the missing Knowledge share instead of rescaling Research (review)', () => {
    const rows = row({ research: 0.6 }, { research: 'measured' });
    // Combined quality is [0.45, 0.575, 0.70]; target 0.65, shortfall 0.2, relevance 0.8.
    expectTriple(feature(featuresOf(state({ phase: 'review' }), model, action, rows), 'researchFit'), [0.5, 0, 0.8]);
  });

  it('makes long-context quality relevant at exactly 64,000 tokens', () => {
    const rows = row({ longContext: 0.9 }, { longContext: 'measured' });
    expectTriple(feature(featuresOf(state({ estimatedContextTokens: 63_999 }), model, action, rows), 'inputFit'), [0.5, 0.5, 0.5]);
    expectTriple(feature(featuresOf(state({ estimatedContextTokens: 64_000 }), model, action, rows), 'inputFit'), [0.9, 0.9, 0.9]);
    expectTriple(feature(featuresOf(state({ estimatedContextTokens: 64_000, needsVision: true }), model, action, rows), 'inputFit'), [0.7, 0.45, 0.95]);
  });

  it('distinguishes unknown, zero and positive open decisions', () => {
    const rows = row({ intelligence: 62 }, { intelligence: 'measured' });
    const at = (openDecisions: number | undefined) => featuresOf(state({ openDecisions }), model, action, rows);
    expectTriple(feature(at(undefined), 'reasoningFit'), [0.6, 0.6, 0.6]);
    expectTriple(feature(at(0), 'reasoningFit'), [0.6, 0.6, 0.6]);
    expectTriple(feature(at(2), 'reasoningFit'), [0.9, 0.9, 0.9]);
    const details = (vector: ReturnType<typeof at>) => vector.evidence.find((e) => e.feature === 'reasoningFit')!.details;
    expect(details(at(undefined))).toContain('openDecisions:unknown');
    expect(details(at(0))).toContain('openDecisions:0');
  });

  it('gives an unknown price the common interval, not zero dollars', () => {
    const unpriced = registryModel('p', 'xmodel', { cost: undefined });
    const result = candidateFeatures(state(), unpriced, action, []);
    expect(result.costProxy.priceKnown).toBe(false);
    expect(result.costProxy.centralUSD).toBeUndefined();
    expectTriple(feature(result.features, 'costDesirability'), [0.5, 0, 1]);
  });

  it('derives the known-price feature from the frozen log transform', () => {
    // 10,000 input at $1/M + 1,024 AA output tokens per task at $4/M = 0.014096 USD, no cache evidence.
    const usd = 10_000 / 1e6 + 1024 * 4 / 1e6;
    const expected = 1 - Math.log10(usd / 0.00001) / 6;
    const result = candidateFeatures(state(), model, action, [outputRow('p/xmodel', 'high', 1024)]);
    expect(result.costProxy.centralUSD).toBeCloseTo(usd, 12);
    expect(feature(result.features, 'costDesirability')[0]).toBeCloseTo(expected, 9);
  });
});

describe('N5: total continuity and exact recovery attribution', () => {
  const act = (registryId: string, effort: ModelThinkingLevel): EffectiveAction => ({ registryId, effort, key: `${registryId}:${effort}`, levels: [effort] });
  const actions = [act('p/X', 'low'), act('p/X', 'medium'), act('p/X', 'high'), act('p/Y', 'medium'), act('q/X', 'medium')];
  const rework = state({
    workItemId: 'W',
    boundary: 'rework',
    rework: { failed: { registryId: 'p/X', effort: 'medium' }, workItemId: 'W' },
    friction: [
      { registryId: 'p/X', effort: 'medium', workItemId: 'W', kind: 'attributed-rework' },
      { registryId: 'p/Y', effort: 'medium', workItemId: 'W2', kind: 'attributed-rework' },
    ],
  });

  it('matches the hand table at the W rework boundary', () => {
    const table = actions.map((a) => {
      const f = recoveryFeatures(rework, a);
      return [a.key, continuityFeature(rework, a).value, f.frictionAvoidance, f.effortRecoveryFit, f.modelSwitchRecoveryFit];
    });
    expect(table).toEqual([
      ['p/X:low', 0.65, 1, 0, 0],
      ['p/X:medium', 0.65, 0, 0, 0],
      ['p/X:high', 0.78, 1, 1, 0],
      ['p/Y:medium', 0.48, 1, 0, 1],
      ['q/X:medium', 0.48, 1, 0, 1],
    ]);
  });

  it('uses 0.65/0.45 at an ordinary boundary with no recovery features, and 0.50 without an incumbent', () => {
    const ordinary = state({ incumbent: { registryId: 'p/X', effort: 'medium' } });
    expect(actions.map((a) => continuityFeature(ordinary, a).value)).toEqual([0.65, 0.65, 0.65, 0.45, 0.45]);
    for (const a of actions) {
      expect(recoveryFeatures(ordinary, a)).toMatchObject({ effortRecoveryFit: 0, modelSwitchRecoveryFit: 0 });
      expect(continuityFeature(state(), a).value).toBe(0.5);
    }
  });

  it('counts friction only for the exact model, effort and work item', () => {
    const loop = state({ workItemId: 'W', friction: [{ registryId: 'p/X', effort: 'high', workItemId: 'W', kind: 'severe-reasoning-loop' }] });
    expect(actions.map((a) => recoveryFeatures(loop, a).frictionAvoidance)).toEqual([1, 1, 0.25, 1, 1]);
    const unattributed = state({ workItemId: 'W', friction: [{ registryId: 'p/X', effort: 'high', workItemId: 'W', kind: 'unattributed' }] });
    expect(recoveryFeatures(unattributed, actions[2]!).frictionAvoidance).toBe(1);
  });

  it('friction does not move to another work item, or apply without a current work item', () => {
    const event = { registryId: 'p/X', effort: 'high' as const, workItemId: 'W', kind: 'attributed-rework' as const };
    expect(recoveryFeatures(state({ workItemId: 'W2', friction: [event] }), actions[2]!).frictionAvoidance).toBe(1);
    expect(recoveryFeatures(state({ friction: [event] }), actions[2]!).frictionAvoidance).toBe(1);
    expect(recoveryFeatures(state({ workItemId: 'W', friction: [event] }), actions[2]!).frictionAvoidance).toBeLessThan(1);
  });
});

describe('cache-aware cost', () => {
  const anthropic = registryModel('a', 'claude', {
    api: 'anthropic-messages', compat: { supportsMidConvoEffort: true },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    promptCache: { short: 300, long: 3600 },
  });
  const openai = registryModel('o', 'gpt', { cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }, promptCache: { short: 300 } });
  const [aLow, aHigh] = [enumerateEffectiveActions(anthropic).find((a) => a.effort === 'low')!, enumerateEffectiveActions(anthropic).find((a) => a.effort === 'high')!];
  const oHigh = enumerateEffectiveActions(openai).find((a) => a.effort === 'high')!;
  type WarmRecord = { tokens: number; ageMs?: number; hitProbability?: number; retention?: 'short' | 'long' };
  // state().nowMs is 1_000_000; ageMs is measured back from it.
  const cache = (records: [string, WarmRecord[]][], patch: Partial<NonNullable<DecisionStateV1['cache']>> = {}): NonNullable<DecisionStateV1['cache']> => ({
    promptIdentity: 'head-1',
    incumbentKey: aHigh.key,
    warmPrefixes: new Map(records.map(([key, list]) => [key, list.map((r) => ({ tokens: r.tokens, observedAtMs: 1_000_000 - (r.ageMs ?? 0), hitProbability: r.hitProbability ?? 1, retention: r.retention ?? 'short' }))])),
    retention: 'short',
    ...patch,
  });
  const cacheState = (patch: Partial<DecisionStateV1> = {}) => state({
    estimatedContextTokens: 100_000,
    promptIdentity: 'head-1',
    cache: cache([[aHigh.key, [{ tokens: 80_000 }]], [oHigh.key, [{ tokens: 40_000 }]]]),
    ...patch,
  });
  // Each action has a measured 1,024 output tokens per task.
  const usd = (s: DecisionStateV1, model: RegistryModelInfo, action: EffectiveAction) =>
    candidateFeatures(s, model, action, [outputRow(action.registryId, action.effort, 1024)]).costProxy;
  const read = (s: DecisionStateV1, model: RegistryModelInfo, action: EffectiveAction) => usd(s, model, action).tokens.cacheRead;

  it('prices only the recorded warm prefix of the incumbent at the cache-read rate and new tokens at the write rate', () => {
    const warm = usd(cacheState(), anthropic, aHigh);
    expect(warm.tokens).toEqual({ cacheRead: 80_000, cacheWrite: 20_000, uncachedInput: 0, output: 1024 });
    expect(warm.centralUSD).toBeCloseTo(80_000 * 0.3 / 1e6 + 20_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
    const uncachedIncumbent = usd(cacheState({ cache: cache([[oHigh.key, [{ tokens: 40_000 }]]]) }), anthropic, aHigh);
    expect(uncachedIncumbent.tokens).toEqual({ cacheRead: 0, cacheWrite: 100_000, uncachedInput: 0, output: 1024 });
    const cold = usd(cacheState({ cache: undefined }), anthropic, aHigh);
    expect(cold.tokens).toEqual({ cacheRead: 0, cacheWrite: 100_000, uncachedInput: 0, output: 1024 });
    expect(cold.centralUSD).toBeCloseTo(100_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
  });

  it('bills uncached input at the input price when the registry has no write charge', () => {
    const challenger = usd(cacheState(), openai, oHigh);
    expect(challenger.tokens).toEqual({ cacheRead: 40_000, cacheWrite: 0, uncachedInput: 60_000, output: 1024 });
    expect(challenger.centralUSD).toBeCloseTo(40_000 * 0.2 / 1e6 + 60_000 * 2 / 1e6 + 1024 * 8 / 1e6, 12);
  });

  it('shares the model warm prefix across efforts only when the model keeps it', () => {
    expect(usd(cacheState(), anthropic, aLow).tokens).toEqual({ cacheRead: 80_000, cacheWrite: 20_000, uncachedInput: 0, output: 1024 });
    // Even when another model is the incumbent, an effort-sharing model reuses the warm prefix of its own sibling effort.
    const challengerShared = cacheState({ cache: cache([[aHigh.key, [{ tokens: 60_000 }]], [oHigh.key, [{ tokens: 80_000 }]]], { incumbentKey: oHigh.key }) });
    expect(usd(challengerShared, anthropic, aLow).tokens).toEqual({ cacheRead: 60_000, cacheWrite: 40_000, uncachedInput: 0, output: 1024 });
    const noSharing = registryModel('a', 'claude', { cost: anthropic.cost, promptCache: anthropic.promptCache });
    expect(read(cacheState(), noSharing, aLow)).toBe(0);
  });

  it('a sibling effort reuses the largest prefix that is still inside the lifetime, not a larger expired one', () => {
    const s = cacheState({ cache: cache([[aLow.key, [{ tokens: 40_000, ageMs: 60_000 }]], [aHigh.key, [{ tokens: 80_000, ageMs: 300_000 }]]]) });
    expect(read(s, anthropic, aHigh)).toBe(40_000);
    expect(read(s, anthropic, aLow)).toBe(40_000);
  });

  it('measures age from each record against the lifetime the candidate model declares', () => {
    const longLived = registryModel('b', 'long', { cost: openai.cost, promptCache: { short: 3600 } });
    const bHigh = enumerateEffectiveActions(longLived).find((a) => a.effort === 'high')!;
    const s = cacheState({ cache: cache([[oHigh.key, [{ tokens: 40_000, ageMs: 600_000 }]], [bHigh.key, [{ tokens: 40_000, ageMs: 600_000 }]]]) });
    expect(read(s, openai, oHigh)).toBe(0);
    expect(usd(s, openai, oHigh).cacheEligibility).toBe('expired');
    expect(read(s, longLived, bHigh)).toBe(40_000);
    // The lifetime bound is exclusive.
    expect(read(cacheState({ nowMs: 1_000_000 + 299_999 }), anthropic, aHigh)).toBe(80_000);
    expect(read(cacheState({ nowMs: 1_000_000 + 300_000 }), anthropic, aHigh)).toBe(0);
  });

  it('uses the lifetime of the tier that wrote each record, not the tier of the current request', () => {
    const halfHourOld = (written: 'short' | 'long', current: 'short' | 'long') =>
      cacheState({ cache: cache([[aHigh.key, [{ tokens: 80_000, ageMs: 1_800_000, retention: written }]]], { retention: current }) });
    expect(read(halfHourOld('long', 'long'), anthropic, aHigh)).toBe(80_000);
    expect(read(halfHourOld('long', 'short'), anthropic, aHigh)).toBe(80_000);
    expect(read(halfHourOld('short', 'short'), anthropic, aHigh)).toBe(0);
    const shortWrittenLongRequested = usd(halfHourOld('short', 'long'), anthropic, aHigh);
    expect(shortWrittenLongRequested.tokens.cacheRead).toBe(0);
    expect(shortWrittenLongRequested.cacheEligibility).toBe('expired');
  });

  it('a request at retention none reads no cache and bills every prompt token as input', () => {
    const none = usd(cacheState({ cache: cache([[aHigh.key, [{ tokens: 80_000 }]]], { retention: 'none' }) }), anthropic, aHigh);
    expect(none.tokens).toEqual({ cacheRead: 0, cacheWrite: 0, uncachedInput: 100_000, output: 1024 });
    expect(none.cacheEligibility).toBe('retention-none');
    expect(none.centralUSD).toBeCloseTo(100_000 * 3 / 1e6 + 1024 * 15 / 1e6, 12);
    expect(none.maxUSD).toBeCloseTo(100_000 * 3 / 1e6 + 1024 * 15 / 1e6, 12);
  });

  it('bills a long cache write at twice the input price only for a model that writes long entries', () => {
    const longCold = cacheState({ cache: cache([], { retention: 'long' }) });
    const anthropicLong = usd(longCold, anthropic, aHigh);
    expect(anthropicLong.tokens).toEqual({ cacheRead: 0, cacheWrite: 100_000, uncachedInput: 0, output: 1024 });
    expect(anthropicLong.centralUSD).toBeCloseTo(100_000 * 2 * 3 / 1e6 + 1024 * 15 / 1e6, 12);
    // Without a long lifetime the provider writes a short entry at the write price.
    const shortOnly = registryModel('a', 'claude', { api: 'anthropic-messages', cost: anthropic.cost, promptCache: { short: 300 } });
    expect(usd(longCold, shortOnly, aHigh).centralUSD).toBeCloseTo(100_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
    // A model without a write charge bills uncached input at the input price.
    const openaiLong = usd(longCold, openai, oHigh);
    expect(openaiLong.tokens).toEqual({ cacheRead: 0, cacheWrite: 0, uncachedInput: 100_000, output: 1024 });
    expect(openaiLong.centralUSD).toBeCloseTo(100_000 * 2 / 1e6 + 1024 * 8 / 1e6, 12);
    // The short tier keeps the write price.
    expect(usd(cacheState({ cache: undefined }), anthropic, aHigh).centralUSD).toBeCloseTo(100_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
  });

  it('gives no credit when the model declares no lifetime for the tier, even with a cache-read price', () => {
    const unknownLifetime = registryModel('o', 'gpt', { cost: openai.cost });
    const spend = usd(cacheState(), unknownLifetime, oHigh);
    expect(spend.tokens.cacheRead).toBe(0);
    expect(spend.cacheEligibility).toBe('ttl-unknown');
    expect(read(cacheState({ cache: cache([[oHigh.key, [{ tokens: 40_000, retention: 'long' }]]], { retention: 'long' }) }), openai, oHigh)).toBe(0);
    const evidence = candidateFeatures(cacheState(), unknownLifetime, oHigh, []).features.evidence.find((e) => e.feature === 'costDesirability')!;
    expect(evidence.details).toContain('cache-eligibility:ttl-unknown');
  });

  it('credits another session prefix at its hit probability only inside the lifetime', () => {
    const shared = (ageMs: number, retention: 'short' | 'long') => cacheState({ cache: cache([[aHigh.key, [
      { tokens: 2_000, ageMs: 600_000, hitProbability: 0.3, retention },
      { tokens: 10_000, ageMs, hitProbability: 0.3, retention },
    ]]]) });
    expect(read(shared(1_200_000, 'short'), anthropic, aHigh)).toBe(0);
    expect(read(shared(1_200_000, 'long'), anthropic, aHigh)).toBeCloseTo(3_000, 9);
  });

  it('gives no cache credit on a prompt-identity mismatch or to a spawned subagent', () => {
    expect(usd(cacheState({ promptIdentity: 'head-2' }), anthropic, aHigh).cacheEligibility).toBe('prompt-mismatch');
    expect(read(cacheState({ promptIdentity: 'head-2' }), anthropic, aHigh)).toBe(0);
    expect(read(cacheState({ isSubagentSpawn: true }), anthropic, aHigh)).toBe(0);
  });

  it('bills the prompt and its warm prefix in the tokens of the action model', () => {
    const scaled = cacheState({ promptTokenScales: new Map([['a/claude', 1.8]]) });
    const cold = usd({ ...scaled, cache: undefined }, anthropic, aHigh);
    expect(cold.tokens).toEqual({ cacheRead: 0, cacheWrite: 180_000, uncachedInput: 0, output: 1024 });
    expect(cold.centralUSD).toBeCloseTo(180_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
    expect(usd(scaled, anthropic, aHigh).tokens).toEqual({ cacheRead: 144_000, cacheWrite: 36_000, uncachedInput: 0, output: 1024 });
    // A model without a scale bills the estimate; its warm entry keeps estimate units.
    expect(usd(scaled, openai, oHigh).tokens).toEqual({ cacheRead: 40_000, cacheWrite: 0, uncachedInput: 60_000, output: 1024 });
    const openaiScaled = cacheState({ promptTokenScales: new Map([['o/gpt', 1.5]]) });
    expect(usd(openaiScaled, openai, oHigh).tokens).toEqual({ cacheRead: 60_000, cacheWrite: 0, uncachedInput: 90_000, output: 1024 });
  });

  it('prices the whole request at the highest tier that its billed prompt tokens exceed', () => {
    // The highest exceeded threshold wins, not the first one listed.
    const tiered = registryModel('a', 'claude', { ...anthropic, cost: { ...anthropic.cost, tiers: [
      { inputTokensAbove: 50_000, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      { inputTokensAbove: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
    ] } });
    // 100,000 prompt tokens: the 50k tier applies to the cache read, the write and the output.
    expect(usd(cacheState(), tiered, aHigh).centralUSD).toBeCloseTo(80_000 * 0.4 / 1e6 + 20_000 * 5 / 1e6 + 1024 * 20 / 1e6, 12);
    // The threshold is exclusive.
    const atThreshold = cacheState({ estimatedContextTokens: 50_000, cache: undefined });
    expect(usd(atThreshold, tiered, aHigh).centralUSD).toBeCloseTo(50_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
    // The tier is chosen on the tokens the model bills, after its prompt token scale.
    const scaled = cacheState({ cache: undefined, promptTokenScales: new Map([['a/claude', 2.5]]) });
    expect(usd(scaled, tiered, aHigh).centralUSD).toBeCloseTo(250_000 * 7.5 / 1e6 + 1024 * 22.5 / 1e6, 12);
    // A long write costs twice the tier input price.
    const long = cacheState({ cache: cache([], { retention: 'long' }) });
    expect(usd(long, tiered, aHigh).centralUSD).toBeCloseTo(100_000 * 2 * 4 / 1e6 + 1024 * 20 / 1e6, 12);
  });

  it('gives no cache credit and no maximum cost when a hit is possible without a cache-read price', () => {
    const noRead = registryModel('o', 'gpt', { cost: { input: 2, output: 8 }, promptCache: { short: 300 } });
    const spend = usd(cacheState(), noRead, oHigh);
    // Central: no cache credit. Minimum: free cached tokens. Maximum: unknown,
    // because a read can cost more than a miss.
    expect(spend.centralUSD).toBeCloseTo(100_000 * 2 / 1e6 + 1024 * 8 / 1e6, 12);
    expect(spend.minUSD).toBeCloseTo(60_000 * 2 / 1e6 + 1024 * 8 / 1e6, 12);
    expect(spend.maxUSD).toBeUndefined();
    expect(spend.cacheReadPriceUnknown).toBe(true);
  });
});

describe('benchmark output: raw AA output tokens per task in cost and time', () => {
  // 10,000 prompt tokens at $1/M with no cache evidence and no write charge: prompt cost $0.01.
  const model = registryModel('p', 'xmodel');
  const benchRow = (effort: ModelThinkingLevel, tokens: number | undefined, extra: Partial<BenchModel> = {}): BenchModel =>
    outputRow('p/xmodel', effort, tokens, extra);
  const at = (effort: ModelThinkingLevel, rows: BenchModel[], s: DecisionStateV1 = state(), m: RegistryModelInfo = model) =>
    candidateFeatures(s, m, enumerateEffectiveActions(m).find((a) => a.effort === effort)!, rows);
  const detail = (result: ReturnType<typeof at>, name: FeatureName) =>
    result.features.evidence.find((e) => e.feature === name)!.details!.find((d) => d.startsWith('output-tokens:'));
  const costOf = (usd: number) => 1 - Math.log10(usd / 0.00001) / 6;
  const timeOf = (seconds: number) => Math.max(0, 1 - Math.log(1 + seconds / 60) / Math.log(61));

  it('uses the measured tokens per task unscaled for output cost and output time', () => {
    // 600 and 1,000,000 are outside any reference clamp; 0 has no overhead in time.
    for (const tokens of [0, 600, 15_000, 197_430, 1_000_000]) {
      const result = at('high', [benchRow('high', tokens)]);
      const usd = 0.01 + tokens * 4 / 1e6;
      expect(result.costProxy.tokens.output).toBe(tokens);
      expect(result.costProxy.centralUSD).toBeCloseTo(usd, 12);
      expectTriple(feature(result.features, 'costDesirability'), [costOf(usd), costOf(usd), costOf(usd)]);
      const time = timeOf(tokens / 100);
      expectTriple(feature(result.features, 'timeDesirability'), [time, time, time]);
      expect(detail(result, 'costDesirability')).toBe('output-tokens:measured');
      expect(detail(result, 'timeDesirability')).toBe('output-tokens:measured');
    }
  });

  it('a positive output price with no token count gives only a lower cost bound', () => {
    const result = at('high', [benchRow('high', undefined)]);
    expect(result.costProxy).toMatchObject({ priceKnown: true, minUSD: 0.01 });
    expect(result.costProxy.centralUSD).toBeUndefined();
    expect(result.costProxy.maxUSD).toBeUndefined();
    expect(result.costProxy.tokens.output).toBeUndefined();
    expectTriple(feature(result.features, 'costDesirability'), [costOf(0.01) / 2, 0, costOf(0.01)]);
    expectTriple(feature(result.features, 'timeDesirability'), [0.5, 0, 1]);
    const time = result.features.evidence.find((e) => e.feature === 'timeDesirability')!;
    expect(time).toMatchObject({ code: 'missing', details: ['output-tokens:absent', 'speed:known'] });
    // The missing interval contains every measured value, so it gives no advantage.
    for (const tokens of [0, 30_000, 10_000_000]) {
      const measured = at('high', [benchRow('high', tokens)]).features;
      for (const name of ['costDesirability', 'timeDesirability'] as const) {
        const [, lower, upper] = feature(measured, name);
        expect(feature(result.features, name)[1]).toBeLessThanOrEqual(lower!);
        expect(feature(result.features, name)[2]).toBeGreaterThanOrEqual(upper!);
      }
    }
  });

  it('a zero output price makes the token count irrelevant to cost', () => {
    const free = registryModel('p', 'xmodel', { cost: { input: 1, output: 0, cacheRead: 0.1 } });
    const measured = at('high', [benchRow('high', 197_430)], state(), free);
    const missing = at('high', [benchRow('high', undefined)], state(), free);
    for (const result of [measured, missing]) {
      expect(result.costProxy).toMatchObject({ centralUSD: 0.01, minUSD: 0.01, maxUSD: 0.01 });
      expectTriple(feature(result.features, 'costDesirability'), [costOf(0.01), costOf(0.01), costOf(0.01)]);
    }
  });

  it('does not borrow an observation from another effort or another model', () => {
    const rows = [benchRow('low', 3_000), benchRow('max', 150_000), benchRow('high', 150_000, { registryId: 'q/other', benchSlug: 'other' })];
    expect(at('high', rows).costProxy.tokens.output).toBeUndefined();
    expect(detail(at('high', rows), 'costDesirability')).toBe('output-tokens:no-row');
    expect(detail(at('high', [benchRow('high', 150_000, { active: false })]), 'costDesirability')).toBe('output-tokens:no-row');
  });

  it('records the reason for each unusable observation and uses no token count', () => {
    const cases: [BenchModel, DecisionStateV1, string][] = [
      [benchRow('high', undefined), state(), 'absent'],
      [benchRow('high', 50_000, { outputTokensProvenance: { status: 'source-estimated', indexVersion: '4.3.2' } }), state(), 'source-estimated'],
      [benchRow('high', 50_000, { outputTokensProvenance: { status: 'unknown-effort', indexVersion: '4.3.2' } }), state(), 'unknown-effort'],
      [benchRow('high', undefined, { outputTokensProvenance: { status: 'conflict', indexVersion: '4.3.2' } }), state(), 'conflict'],
      [benchRow('high', undefined, { outputTokensProvenance: { status: 'invalid' } }), state(), 'invalid'],
      [benchRow('high', -5, { outputTokensProvenance: { status: 'measured', indexVersion: '4.3.2' } }), state(), 'invalid'],
      [benchRow('high', 50_000, { outputTokensProvenance: { status: 'measured' } }), state(), 'version-unknown'],
      [benchRow('high', 50_000), state({ benchmarkIndexVersion: undefined }), 'version-unknown'],
      [benchRow('high', 50_000, { outputTokensProvenance: { status: 'measured', indexVersion: '4.4.0' } }), state(), 'version-incompatible'],
      [benchRow('high', 50_000), state({ benchmarkIndexVersion: '5.0' }), 'version-incompatible'],
    ];
    for (const [row, s, reason] of cases) {
      const result = at('high', [row], s);
      expect(detail(result, 'costDesirability'), reason).toBe(`output-tokens:${reason}`);
      expect(detail(result, 'timeDesirability'), reason).toBe(`output-tokens:${reason}`);
      expect(result.costProxy.centralUSD, reason).toBeUndefined();
      expect(result.costProxy.tokens.output, reason).toBeUndefined();
    }
  });

  it('prices output at the registry output price, never the benchmark price or cost per task', () => {
    const benchPriced = at('high', [benchRow('high', 90_000, { costPerTask: 50, priceOutputPer1M: 0.01 })]);
    expect(benchPriced.costProxy.centralUSD).toBeCloseTo(0.01 + 90_000 * 4 / 1e6, 12);
    const pricier = registryModel('p', 'xmodel', { cost: { input: 1, output: 40, cacheRead: 0.1 } });
    const repriced = at('high', [benchRow('high', 90_000)], state(), pricier);
    expect(repriced.costProxy.centralUSD).toBeCloseTo(0.01 + 90_000 * 40 / 1e6, 12);
    expect(feature(repriced.features, 'timeDesirability')).toEqual(feature(at('high', [benchRow('high', 90_000)]).features, 'timeDesirability'));
  });

  it('output speed changes time only', () => {
    const fast = at('high', [benchRow('high', 90_000, { outputSpeedTps: 400 })]);
    const slow = at('high', [benchRow('high', 90_000)]);
    expect(fast.costProxy).toEqual(slow.costProxy);
    expect(feature(fast.features, 'timeDesirability')[0]).toBeCloseTo(timeOf(90_000 / 400), 12);
  });

  it('estimates missing speed from the active efforts of the same registry model only', () => {
    const own = benchRow('medium', 12_000, { outputSpeedTps: undefined });
    const siblings = [
      benchRow('low', 100, { outputSpeedTps: 50 }),
      benchRow('high', 900_000, { outputSpeedTps: 200 }),
      benchRow('off', 80, { outputSpeedTps: 80 }),
    ];
    const noise = [
      benchRow('max', 10, { outputSpeedTps: 1, active: false }),
      benchRow('low', 10, { outputSpeedTps: 1_000, registryId: 'q/xmodel' }),
      benchRow('high', 10, { outputSpeedTps: 1, registryId: 'p/xmodel-v2' }),
      ...[0, -1, NaN, Infinity].map((outputSpeedTps) => benchRow('xhigh', 10, { outputSpeedTps })),
    ];
    const lower = timeOf(240); // 12,000 / 50, using only the served effort's tokens.
    const upper = timeOf(60); // 12,000 / 200.
    for (const rows of [[own, ...siblings], [own, ...siblings, ...noise]]) {
      const result = at('medium', rows);
      expectTriple(feature(result.features, 'timeDesirability'), [(lower + upper) / 2, lower, upper]);
      expect(result.features.evidence.find((e) => e.feature === 'timeDesirability')?.code).toBe('speed-other-effort');
      expect(result.costProxy.tokens.output).toBe(12_000);
      expect(result.costProxy).toEqual(at('medium', [own]).costProxy);
    }
    const measured = at('medium', [{ ...own, outputSpeedTps: 100 }, ...siblings]);
    expectTriple(feature(measured.features, 'timeDesirability'), [timeOf(120), timeOf(120), timeOf(120)]);
    expect(measured.features.evidence.find((e) => e.feature === 'timeDesirability')?.code).toBe('speed-known');
  });

  it('keeps unknown time without usable speed or the served effort token count', () => {
    const own = benchRow('medium', 12_000, { outputSpeedTps: undefined });
    const sibling = benchRow('low', 300, { outputSpeedTps: 200 });
    for (const rows of [
      [own],
      [own, { ...sibling, active: false }],
      [own, { ...sibling, registryId: 'q/xmodel' }],
      [own, { ...sibling, outputSpeedTps: 0 }],
      [benchRow('medium', undefined, { outputSpeedTps: undefined }), sibling],
      [sibling],
    ]) expectTriple(feature(at('medium', rows).features, 'timeDesirability'), [0.5, 0, 1]);

    // One available speed gives a point estimate, but not a measured-speed claim.
    const single = at('medium', [own, sibling]);
    expectTriple(feature(single.features, 'timeDesirability'), [timeOf(60), timeOf(60), timeOf(60)]);
    expect(single.features.evidence.find((e) => e.feature === 'timeDesirability')?.code).toBe('speed-other-effort');
  });

  it('the features of an action do not depend on the other rows of the pool', () => {
    const own = [benchRow('high', 30_000)];
    const extreme = outputRow('q/frontier', 'high', 10_000_000, {
      quality: { intelligence: 100, agenticCoding: 100, research: 1 },
      axisProvenance: { intelligence: 'measured', agenticCoding: 'measured', research: 'measured' }, outputSpeedTps: 1,
    });
    const terse = outputRow('q/terse', 'high', 1, { quality: { intelligence: 1 }, outputSpeedTps: 100_000 });
    const alone = at('high', own).features;
    for (const pool of [[...own, extreme], [terse, ...own, extreme]]) {
      const shared = at('high', pool).features;
      expect([shared.values, shared.lower, shared.upper]).toEqual([alone.values, alone.lower, alone.upper]);
    }
  });
});

describe('task difficulty', () => {
  const model = registryModel('p', 'xmodel');
  const action = enumerateEffectiveActions(model).find((a) => a.effort === 'high')!;
  const rows: BenchModel[] = [{
    registryId: 'p/xmodel', benchSlug: 'xmodel', active: true, effort: 'high', source: 'aa',
    quality: { intelligence: 62, agenticCoding: 40, research: 0.8 },
    axisProvenance: { intelligence: 'measured', agenticCoding: 'measured', research: 'measured' },
    outputSpeedTps: 100,
  }];
  const at = (value?: number, phase: DecisionStateV1['phase'] = 'implement') =>
    featuresOf(state({ phase, difficulty: value === undefined ? undefined : { value, source: 'execution-rubric' } }), model, action, rows);
  const unknown = at();

  it('unknown demand spans easy through hard targets without claiming a measurement', () => {
    expect(unknown.values).toEqual(at(0.5).values);
    expectTriple(feature(unknown, 'reasoningFit'), [0.6, 0.6, 0.6]);
    expectTriple(feature(unknown, 'agenticFit'), [1, 0, 1]);
    expect(unknown.evidence.find((e) => e.feature === 'reasoningFit')!.details).toContain('difficulty:unknown');
  });

  it('D = 0 awards full fit for meeting the easy targets', () => {
    expectTriple(feature(at(0), 'reasoningFit'), [0.6, 0.6, 0.6]);
    expectTriple(feature(at(0), 'agenticFit'), [1, 1, 1]);
  });

  it('higher demand cannot improve the same capability fit or change economics', () => {
    let previous = at(0);
    for (const value of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const next = at(value);
      for (const name of ['reasoningFit', 'agenticFit', 'researchFit'] as const) {
        expect(feature(next, name)[0]).toBeLessThanOrEqual(feature(previous, name)[0] + EPS);
      }
      for (const name of ['costDesirability', 'timeDesirability'] as const) {
        expect(feature(next, name)).toEqual(feature(previous, name));
      }
      previous = next;
    }
  });

  it('uses each axis demand, not the maximum summary, for its target', () => {
    const mixed = featuresOf(state({ difficulty: {
      value: 1, source: 'execution-rubric', axes: { reasoning: 1, agentic: 0, research: 0.5 },
    } }), model, action, rows);
    expect(feature(mixed, 'reasoningFit')).toEqual(feature(at(1), 'reasoningFit'));
    expect(feature(mixed, 'agenticFit')).toEqual(feature(at(0), 'agenticFit'));
    expect(mixed.evidence.find((e) => e.feature === 'researchFit')!.details).toContain('target:research:0.450');
  });

  it('crosses quality and demand bounds instead of treating demand as a point', () => {
    const s = state({ phase: 'gather', difficulty: {
      value: 0.5, source: 'declared-complexity', axes: { reasoning: 0.5, agentic: 0, research: 0.25 },
      bounds: { reasoning: { lower: 0.25, upper: 0.75 }, agentic: { lower: 0, upper: 0 }, research: { lower: 0.125, upper: 0.375 } },
    } });
    const measured = [{ ...rows[0]!, quality: { intelligence: 40, research: 0.4, knowledge: -20 },
      axisProvenance: { intelligence: 'measured', research: 'measured', knowledge: 'measured' } as const }];
    const vector = featuresOf(s, model, action, measured);
    // Reasoning targets [0.2875, 0.375, 0.4625], quality 0.4, relevance 0.4.
    expectTriple(feature(vector, 'reasoningFit'), [0.4, 7 / 30, 0.4]);
    // Combined research quality 0.4 meets even the upper target 0.4.
    expectTriple(feature(vector, 'researchFit'), [1, 1, 1]);
    const estimated = [{ ...measured[0]!, axisProvenance: { ...measured[0]!.axisProvenance, intelligence: 'source-estimated' as const } }];
    expectTriple(feature(featuresOf(s, model, action, estimated), 'reasoningFit'), [0.4, 0, 0.4]);
  });

  it('keeps every interval ordered, the unknown price included', () => {
    const unpriced = registryModel('p', 'xmodel', { cost: undefined });
    for (const value of [0, 0.5, 1]) {
      const vector = candidateFeatures(state({ difficulty: { value, source: 'reasoning-rubric' } }), unpriced, action, rows).features;
      vector.values.forEach((center, j) => {
        expect(vector.lower[j]!).toBeLessThanOrEqual(center + EPS);
        expect(center).toBeLessThanOrEqual(vector.upper[j]! + EPS);
      });
    }
  });

  it('records the difficulty and its source in the evidence', () => {
    const details = at(0.5).evidence.find((e) => e.feature === 'reasoningFit')!.details;
    expect(details).toContain('difficulty:execution-rubric:0.500');
  });
});
