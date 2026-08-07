import { describe, it, expect } from 'vitest';
import type { Dimension } from './types.js';
import {
  DIMENSIONS,
  confusionMatrix,
  costWeightedError,
  evaluateLanguage,
  macroF1,
  compareClassifiers,
  UNDER_ROUTE_WEIGHT,
  OVER_ROUTE_WEIGHT,
  type LabeledPrompt,
} from './classifier-metrics.js';

// ─── Hand-built fixture ───────────────────────────────────────────────
// 10 rows, 2 languages, every dimension exercised at least once per
// language. `predictMap` reproduces a fixed (imperfect) classifier:
//   correct on all en rows and on 3/5 vi rows;
//   vi "giải thích kiến trúc" (gold gather) → plan (over-route by 3);
//   vi "đánh giá chất lượng code" (gold review) → gather (under-route by 2).
// Expected values below are hand-computed from one-vs-rest math.

const CORPUS: LabeledPrompt[] = [
  { prompt: 'hello there', lang: 'en', goldDimension: 'lightweight' },
  { prompt: 'what is the capital of France', lang: 'en', goldDimension: 'gather' },
  { prompt: 'write a function that sorts', lang: 'en', goldDimension: 'implement' },
  { prompt: 'design an API architecture', lang: 'en', goldDimension: 'plan' },
  { prompt: 'review this pull request', lang: 'en', goldDimension: 'review' },
  { prompt: 'chào bạn', lang: 'vi', goldDimension: 'lightweight' },
  { prompt: 'giải thích kiến trúc', lang: 'vi', goldDimension: 'gather' },
  { prompt: 'viết code giúp tôi', lang: 'vi', goldDimension: 'implement' },
  { prompt: 'thiết kế kiến trúc hệ thống', lang: 'vi', goldDimension: 'plan' },
  { prompt: 'đánh giá chất lượng code', lang: 'vi', goldDimension: 'review' },
];

const predictMap: Record<string, Dimension> = {
  'hello there': 'lightweight',
  'what is the capital of France': 'gather',
  'write a function that sorts': 'implement',
  'design an API architecture': 'plan',
  'review this pull request': 'review',
  'chào bạn': 'lightweight',
  'giải thích kiến trúc': 'plan', // wrong: over-route from gather
  'viết code giúp tôi': 'implement',
  'thiết kế kiến trúc hệ thống': 'plan',
  'đánh giá chất lượng code': 'gather', // wrong: under-route from review
};

const predict = (prompt: string) => predictMap[prompt] as Dimension | undefined;
const perfect = (prompt: string) => {
  const row = CORPUS.find((r) => r.prompt === prompt);
  return row?.goldDimension;
};

describe('classifier metrics', () => {
  it('confusion matrix counts gold rows × predicted columns exactly', () => {
    const m = confusionMatrix(CORPUS, predict);
    expect(m.lightweight).toEqual({ lightweight: 2, gather: 0, plan: 0, implement: 0, review: 0 });
    expect(m.gather).toEqual({ lightweight: 0, gather: 1, plan: 1, implement: 0, review: 0 });
    expect(m.plan).toEqual({ lightweight: 0, gather: 0, plan: 2, implement: 0, review: 0 });
    expect(m.implement).toEqual({ lightweight: 0, gather: 0, plan: 0, implement: 2, review: 0 });
    expect(m.review).toEqual({ lightweight: 0, gather: 1, plan: 0, implement: 0, review: 1 });
  });

  it('per-language macro-F1 matches hand-computed one-vs-rest math', () => {
    const en = evaluateLanguage(CORPUS, 'en', predict);
    // All 5 en rows correct → every dimension P=R=1.
    expect(en.macroF1).toBe(1);
    expect(en.agreement).toBe(1);
    expect(en.costWeightedError).toBe(0);

    const vi = evaluateLanguage(CORPUS, 'vi', predict);
    // vi per-dimension F1: lightweight 1, gather 0, plan 0.666..., implement 1, review 0.
    expect(vi.perDimension.lightweight.f1).toBe(1);
    expect(vi.perDimension.gather.f1).toBe(0);
    expect(vi.perDimension.plan.f1).toBeCloseTo(2 / 3, 6);
    expect(vi.perDimension.implement.f1).toBe(1);
    expect(vi.perDimension.review.f1).toBe(0);
    expect(vi.macroF1).toBeCloseTo((1 + 0 + 2 / 3 + 1 + 0) / 5, 6);
    expect(vi.agreement).toBe(3 / 5);
    // costs: row "giải thích" over-route 3 steps × OVER(1) = 3; row "đánh giá"
    // under-route 2 steps × UNDER(2) = 4; total 7 / 5 rows.
    expect(vi.costWeightedError).toBeCloseTo(7 / 5, 6);
  });

  it('overall macro-F1 averages the per-language macro-F1s', () => {
    const en = evaluateLanguage(CORPUS, 'en', predict).macroF1;
    const vi = evaluateLanguage(CORPUS, 'vi', predict).macroF1;
    expect(macroF1(CORPUS, predict)).toBeCloseTo((en + vi) / 2, 6);
    expect(macroF1(CORPUS, predict)).toBeCloseTo((1 + (1 + 0 + 2 / 3 + 1 + 0) / 5) / 2, 6);
  });

  it('cost-weighted error encodes under-route as costlier than over-route', () => {
    const under = CORPUS.filter((row) => row.prompt === 'đánh giá chất lượng code');
    const over = CORPUS.filter((row) => row.prompt === 'giải thích kiến trúc');
    // under: review(3) → gather(1), Δ=2 × UNDER(2) = 4
    expect(costWeightedError(under, predict)).toBe(2 * UNDER_ROUTE_WEIGHT);
    // over: gather(1) → plan(4), Δ=3 × OVER(1) = 3
    expect(costWeightedError(over, predict)).toBe(3 * OVER_ROUTE_WEIGHT);
    // Same number of steps (3 vs 3 across the pair) but under-route dominates.
    expect(costWeightedError(under, predict)).toBeGreaterThan(costWeightedError(over, predict));
    // The weights are asymmetric by construction.
    expect(UNDER_ROUTE_WEIGHT).toBeGreaterThan(OVER_ROUTE_WEIGHT);
  });

  it('an abstaining predictor is scored as the worst under-route (R3 direction)', () => {
    const abstain = () => undefined;
    const rows = CORPUS.filter((row) => row.goldDimension === 'implement');
    // implement strength 2 → routed to nothing = 2 × UNDER(2) = 4 per row.
    expect(costWeightedError(rows, abstain)).toBe(2 * UNDER_ROUTE_WEIGHT);
    // and it can never beat (score better than) the correct prediction.
    expect(costWeightedError(rows, abstain)).toBeGreaterThan(costWeightedError(rows, perfect));
  });

  it('a perfect predictor scores 1.0 macro-F1, 1.0 agreement, 0 cost', () => {
    const report = compareClassifiers(CORPUS, { gold: perfect })[
      'gold'
    ];
    expect(report.macroF1).toBe(1);
    expect(report.agreement).toBe(1);
    expect(report.costWeightedError).toBe(0);
  });

  it('compareClassifiers runs every predictor over the same corpus apples-to-apples', () => {
    const reports = compareClassifiers(CORPUS, {
      perfect,
      flawed: predict,
    });
    expect(Object.keys(reports).sort()).toEqual(['flawed', 'perfect']);
    for (const name of ['perfect', 'flawed']) {
      expect(Object.keys(reports[name].perLanguage).sort()).toEqual(['en', 'vi']);
    }
    expect(reports.perfect.agreement).toBe(1);
    expect(reports.flawed.agreement).toBe(0.8);
    expect(reports.flawed.macroF1).toBeCloseTo((1 + (1 + 0 + 2 / 3 + 1 + 0) / 5) / 2, 6);
    expect(reports.flawed.costWeightedError).toBeCloseTo(7 / 10, 6);
    // Every language report carries all five dimensions.
    expect(Object.keys(reports.flawed.perLanguage.en.perDimension).sort()).toEqual(
      [...DIMENSIONS].sort(),
    );
  });
});
