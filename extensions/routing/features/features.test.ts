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
import { FEATURE_INDEX, type FeatureName } from './schema.js';
import { sessionFeatures } from './session.js';
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
    expect(evidenceGaps(rows[0], state({ phase: 'plan' }))).toEqual([]);
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
    expect(result.spend.priceKnown).toBe(false);
    expect(result.spend.centralUSD).toBeUndefined();
    expectTriple(feature(result.features, 'costDesirability'), [0.5, 0, 1]);
  });

  it('derives the known-price feature from the frozen log transform', () => {
    // 10,000 input at $1/M + 1,024 output at $4/M = 0.014096 USD, no cache evidence.
    const usd = 10_000 / 1e6 + 1024 * 4 / 1e6;
    const expected = 1 - Math.log10(usd / 0.00001) / 6;
    const result = candidateFeatures(state(), model, action, []);
    expect(result.spend.centralUSD).toBeCloseTo(usd, 12);
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
      const f = sessionFeatures(rework, a);
      return [a.key, f.continuity, f.frictionAvoidance, f.effortRecoveryFit, f.modelSwitchRecoveryFit];
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
    expect(actions.map((a) => sessionFeatures(ordinary, a).continuity)).toEqual([0.65, 0.65, 0.65, 0.45, 0.45]);
    for (const a of actions) {
      expect(sessionFeatures(ordinary, a)).toMatchObject({ effortRecoveryFit: 0, modelSwitchRecoveryFit: 0 });
      expect(sessionFeatures(state(), a).continuity).toBe(0.5);
    }
  });

  it('counts friction only for the exact model, effort and work item', () => {
    const loop = state({ workItemId: 'W', friction: [{ registryId: 'p/X', effort: 'high', workItemId: 'W', kind: 'severe-reasoning-loop' }] });
    expect(actions.map((a) => sessionFeatures(loop, a).frictionAvoidance)).toEqual([1, 1, 0.25, 1, 1]);
    const unattributed = state({ workItemId: 'W', friction: [{ registryId: 'p/X', effort: 'high', workItemId: 'W', kind: 'unattributed' }] });
    expect(sessionFeatures(unattributed, actions[2]!).frictionAvoidance).toBe(1);
  });
});

describe('cache-aware cost', () => {
  const anthropic = registryModel('a', 'claude', {
    api: 'anthropic-messages', compat: { supportsMidConvoEffort: true },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  const openai = registryModel('o', 'gpt', { cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 } });
  const [aLow, aHigh] = [enumerateEffectiveActions(anthropic).find((a) => a.effort === 'low')!, enumerateEffectiveActions(anthropic).find((a) => a.effort === 'high')!];
  const oHigh = enumerateEffectiveActions(openai).find((a) => a.effort === 'high')!;
  const cacheState = (patch: Partial<DecisionStateV1> = {}) => state({
    estimatedContextTokens: 100_000,
    promptIdentity: 'head-1',
    cache: {
      observedAtMs: 1_000_000,
      promptIdentity: 'head-1',
      incumbentKey: aHigh.key,
      warmPrefixTokens: new Map([[aHigh.key, 80_000], [oHigh.key, 40_000]]),
      ttlMs: 300_000,
      source: 'session',
    },
    ...patch,
  });
  const usd = (s: DecisionStateV1, model: RegistryModelInfo, action: EffectiveAction) => candidateFeatures(s, model, action, []).spend;

  it('prices only the recorded warm prefix of the incumbent at the cache-read rate and new tokens at the write rate', () => {
    const warm = usd(cacheState(), anthropic, aHigh);
    expect(warm.tokens).toEqual({ cacheRead: 80_000, cacheWrite: 20_000, uncachedInput: 0, output: 1024 });
    expect(warm.centralUSD).toBeCloseTo(80_000 * 0.3 / 1e6 + 20_000 * 3.75 / 1e6 + 1024 * 15 / 1e6, 12);
    const uncachedIncumbent = usd(cacheState({
      cache: { observedAtMs: 1_000_000, promptIdentity: 'head-1', incumbentKey: aHigh.key, warmPrefixTokens: new Map([[oHigh.key, 40_000]]), ttlMs: 300_000, source: 'session' },
    }), anthropic, aHigh);
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
    const challengerShared = cacheState({
      cache: {
        observedAtMs: 1_000_000,
        promptIdentity: 'head-1',
        incumbentKey: oHigh.key,
        warmPrefixTokens: new Map([[aHigh.key, 60_000], [oHigh.key, 80_000]]),
        ttlMs: 300_000,
        source: 'session',
      },
    });
    expect(usd(challengerShared, anthropic, aLow).tokens).toEqual({ cacheRead: 60_000, cacheWrite: 40_000, uncachedInput: 0, output: 1024 });
    const noSharing = registryModel('a', 'claude', { cost: anthropic.cost });
    expect(usd(cacheState(), noSharing, aLow).tokens.cacheRead).toBe(0);
  });

  it('gives no cache credit after TTL expiry, on a prompt-identity mismatch, or to a spawned subagent', () => {
    expect(usd(cacheState({ nowMs: 1_000_000 + 300_001 }), anthropic, aHigh).tokens.cacheRead).toBe(0);
    expect(usd(cacheState({ promptIdentity: 'head-2' }), anthropic, aHigh).tokens.cacheRead).toBe(0);
    expect(usd(cacheState({ isSubagentSpawn: true }), anthropic, aHigh).tokens.cacheRead).toBe(0);
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

  it('widens only the lower cost bound when the cache-read price is missing', () => {
    const noRead = registryModel('o', 'gpt', { cost: { input: 2, output: 8 } });
    const spend = usd(cacheState(), noRead, oHigh);
    // Central: no cache credit. Minimum: free cached tokens. Maximum: all input missed.
    // No benchmark row: output uses the unknown demand envelope [0.05, 12].
    expect(spend.centralUSD).toBeCloseTo(100_000 * 2 / 1e6 + 1024 * 8 / 1e6, 12);
    expect(spend.minUSD).toBeCloseTo(60_000 * 2 / 1e6 + 512 * 0.05 * 8 / 1e6, 12);
    expect(spend.maxUSD).toBeCloseTo(100_000 * 2 / 1e6 + 4096 * 12 * 8 / 1e6, 12);
  });
});

describe('output demand scales with AA output-equivalent tokens per task', () => {
  const model = registryModel('p', 'xmodel');
  const actionAt = (effort: ModelThinkingLevel) => enumerateEffectiveActions(model).find((a) => a.effort === effort)!;
  // At $4/M output, $0.40 per task is 100,000 tokens: demand scale 1.
  const benchRow = (effort: ModelThinkingLevel, costPerTask: number | undefined, registryId = 'p/xmodel'): BenchModel => ({
    registryId, benchSlug: `${registryId}-${effort}`, active: true, effort, source: 'aa',
    quality: { intelligence: 50 }, axisProvenance: { intelligence: 'measured' }, outputSpeedTps: 100,
    priceOutputPer1M: 4, costPerTask,
  });
  const rows = [benchRow('low', 0.4), benchRow('high', 1.6), benchRow('max', 4.8)];
  const at = (effort: ModelThinkingLevel, rowsIn: BenchModel[] = rows, m: RegistryModelInfo = model) =>
    candidateFeatures(state(), m, enumerateEffectiveActions(m).find((a) => a.effort === effort) ?? actionAt(effort), rowsIn);
  const demandCode = (result: ReturnType<typeof at>, name: FeatureName) =>
    result.features.evidence.find((e) => e.feature === name)!.details!.find((d) => d.startsWith('demand:'));

  it('multiplies output tokens by tokens per task over the reference', () => {
    // 10,000 input at $1/M; output 1,024 x scale at $4/M. low: 1, high: 4, max: 12.
    expect(at('low').spend.tokens.output).toBeCloseTo(1024, 9);
    expect(at('high').spend.tokens.output).toBeCloseTo(4096, 9);
    expect(at('max').spend.centralUSD).toBeCloseTo(10_000 / 1e6 + 1024 * 12 * 4 / 1e6, 12);
    expect(at('max').spend.minUSD).toBeCloseTo(10_000 / 1e6 + 512 * 12 * 4 / 1e6, 12);
    expect(at('max').spend.maxUSD).toBeCloseTo(10_000 / 1e6 + 4096 * 12 * 4 / 1e6, 12);
    expect(demandCode(at('max'), 'costDesirability')).toBe('demand:measured');
  });

  it('a higher measured effort of the same model is never cheaper or faster', () => {
    const cost = (e: ModelThinkingLevel) => feature(at(e).features, 'costDesirability')[0];
    const time = (e: ModelThinkingLevel) => feature(at(e).features, 'timeDesirability')[0];
    expect(cost('low')).toBeGreaterThan(cost('high'));
    expect(cost('high')).toBeGreaterThan(cost('max'));
    expect(time('low')).toBeGreaterThan(time('high'));
    expect(time('high')).toBeGreaterThan(time('max'));
  });

  it('compares models on one scale: a model that writes more is costlier at its lowest effort too', () => {
    const terse = registryModel('t', 'terse');
    const verbose = registryModel('v', 'verbose');
    const terseRows = [benchRow('low', 0.2, 't/terse'), benchRow('high', 0.8, 't/terse')];
    const verboseRows = [benchRow('low', 2, 'v/verbose')];
    const terseHigh = at('high', terseRows, terse);
    const verboseLow = at('low', verboseRows, verbose);
    expect(verboseLow.spend.tokens.output).toBeGreaterThan(terseHigh.spend.tokens.output);
    expect(feature(verboseLow.features, 'costDesirability')[0]).toBeLessThan(feature(terseHigh.features, 'costDesirability')[0]);
  });

  it('an unmeasured effort takes the scale of the nearest measured effort above it', () => {
    expect(at('medium').spend.tokens.output).toBeCloseTo(4096, 9);
    expect(demandCode(at('medium'), 'costDesirability')).toBe('demand:nearest');
  });

  it('an unmeasured effort above every measured effort takes the largest measured scale', () => {
    const partial = [benchRow('low', 0.4), benchRow('medium', 2.4), benchRow('high', 1.6)];
    expect(at('max', partial).spend.tokens.output).toBeCloseTo(1024 * 6, 9);
  });

  it('a model with no measured cost per task gets the wide unknown envelope, not an advantage', () => {
    const unmeasured = [benchRow('low', undefined), { ...benchRow('max', 4.8), priceOutputPer1M: undefined }];
    const spend = at('max', unmeasured).spend;
    expect(spend.tokens.output).toBe(1024);
    expect(spend.minUSD).toBeCloseTo(10_000 / 1e6 + 512 * 0.05 * 4 / 1e6, 12);
    expect(spend.maxUSD).toBeCloseTo(10_000 / 1e6 + 4096 * 12 * 4 / 1e6, 12);
    expect(demandCode(at('max', unmeasured), 'costDesirability')).toBe('demand:unknown');
    const time = feature(at('max', unmeasured).features, 'timeDesirability');
    const measuredTime = feature(at('low').features, 'timeDesirability');
    expect(time[0]).toBeCloseTo(measuredTime[0], 12);
    expect(time[1]).toBeLessThan(measuredTime[1]);
    expect(time[2]).toBeGreaterThan(measuredTime[2]);
  });

  it('cost rows of another model or an inactive row do not set the scale', () => {
    const noise = [
      { ...benchRow('max', 0.04), registryId: 'q/other' },
      { ...benchRow('max', 0.04), active: false },
      benchRow('high', 1.6), benchRow('max', 4.8),
    ];
    expect(at('max', noise).spend.tokens.output).toBeCloseTo(1024 * 12, 9);
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
