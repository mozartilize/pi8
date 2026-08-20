import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { pickBest, scoreCandidate, logCostUtilities, candidateKey } from './scorer.js';
import { candidate, benchRow } from './test-support/router-fixtures.js';
import { DEFAULT_DIMENSION_WEIGHTS } from './constants.js';
import type { BenchModel, Candidate, Dimension, ScoreWeights } from './types.js';

/**
 * Property tests for the scorer's weighted ranking. The scorer is a
 * deterministic function of its inputs, which is exactly the shape where
 * randomized invariant checks catch bugs example tests miss. Each property
 * below pins an invariant that must hold for every input, not one fixture.
 */

const DIMENSIONS: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
const dimensionArb = fc.constantFrom(...DIMENSIONS);

/**
 * A price/cost field spanning the full pathological space the scorer must
 * survive: absent, zero, negative, NaN, ±Infinity, and ordinary values. The
 * cost path is the scorer's explicit robustness contract — every price
 * projection guards with `isNonNegativeFinite` — so all of these must flow
 * through without ever producing NaN/Infinity in a score.
 */
const weirdNum = fc.oneof(
  fc.constant<number | undefined>(undefined),
  fc.constant(0),
  fc.constant(-1),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
);

/**
 * A quality/speed axis value. The scorer's stated numeric domain here is
 * "absent, zero, negative" plus finite values; it also survives ±Infinity
 * (clamped to the [0,1] projection endpoints). NaN is deliberately excluded:
 * benchmark adapters never emit a NaN index, and `clamp(NaN)` is NaN, so
 * fuzzing it would assert a robustness the projection was never built to give.
 */
const qualityNum = fc.oneof(
  fc.constant<number | undefined>(undefined),
  fc.constant(0),
  fc.constant(-1),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
);

const weightsArb: fc.Arbitrary<ScoreWeights> = fc.record({
  quality: fc.double({ min: 0, max: 1, noNaN: true }),
  cost: fc.double({ min: 0, max: 1, noNaN: true }),
  speed: fc.double({ min: 0, max: 1, noNaN: true }),
});

/** A candidate whose every measurable field is drawn from the weird space. */
function weirdCandidateArb(index: number): fc.Arbitrary<Candidate> {
  return fc
    .record({
      hasBench: fc.boolean(),
      intelligence: qualityNum,
      coding: qualityNum,
      agenticCoding: qualityNum,
      knowledge: qualityNum,
      priceIn: weirdNum,
      priceOut: weirdNum,
      costPerTask: weirdNum,
      speed: qualityNum,
      costInput: weirdNum,
      costOutput: weirdNum,
      cacheRead: weirdNum,
      cacheWrite: weirdNum,
      contextWindow: fc.oneof(fc.constant<number | undefined>(undefined), fc.integer({ min: 0, max: 2_000_000 })),
      vision: fc.boolean(),
      reasoning: fc.boolean(),
    })
    .map((r) => {
      const id = `p${index}/m${index}`;
      const bench: BenchModel | undefined = r.hasBench
        ? benchRow(id, {
            quality: {
              intelligence: r.intelligence,
              coding: r.coding,
              agenticCoding: r.agenticCoding,
              knowledge: r.knowledge,
            },
            priceInputPer1M: r.priceIn,
            priceOutputPer1M: r.priceOut,
            costPerTask: r.costPerTask,
            outputSpeedTps: r.speed,
          })
        : undefined;
      return candidate(id, {
        bench,
        cost: { input: r.costInput, output: r.costOutput, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite },
        contextWindow: r.contextWindow,
        vision: r.vision,
        reasoning: r.reasoning,
      });
    });
}

const weirdSetArb = fc
  .integer({ min: 1, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => weirdCandidateArb(i))));

const optsArb = fc.record({
  estimatedContextTokens: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 4_000_000 })),
  needsVision: fc.boolean(),
  incumbentRegistryId: fc.oneof(fc.constant<string | undefined>(undefined), fc.constant('p0/m0')),
  switchMargin: fc.oneof(fc.constant<number | undefined>(undefined), fc.double({ min: 0, max: 1, noNaN: true })),
  staticPrefixTokens: fc.oneof(fc.constant<number | undefined>(undefined), fc.integer({ min: 0, max: 4_000_000 })),
});

// ─── Invariant 4: no NaN/Infinity for any price/quality combination ─────

describe('scorer property — numeric safety', () => {
  it('never produces NaN/Infinity in any score component or the decision', () => {
    fc.assert(
      fc.property(weirdSetArb, dimensionArb, weightsArb, optsArb, (cands, dim, weights, opts) => {
        for (const c of cands) {
          const s = scoreCandidate(c, dim, weights, opts);
          for (const v of [s.score, s.qualityComponent, s.costComponent, s.speedComponent]) {
            expect(Number.isFinite(v)).toBe(true);
          }
        }
        const decision = pickBest([...cands], dim, weights, opts);
        // A NaN score serializes into the reason string as "NaN"/"Infinity".
        expect(decision.reason).not.toMatch(/NaN|Infinity/);
        const keys = new Set(cands.map(candidateKey));
        // The context/vision guards may legitimately drop candidates, so the
        // chain is a subset of the input keys — never a superset, never
        // duplicated, always non-empty, and always led by the chosen key.
        expect(new Set(decision.fallbackChain).size).toBe(decision.fallbackChain.length);
        expect(decision.fallbackChain.length).toBeGreaterThan(0);
        for (const key of decision.fallbackChain) expect(keys.has(key)).toBe(true);
        expect(keys.has(decision.chosen)).toBe(true);
        expect(decision.chosen).toBe(decision.fallbackChain[0]);
      }),
      { numRuns: 500 },
    );
  });
});

// ─── Invariant 5: logCostUtilities is monotonically decreasing in cost ──

describe('logCostUtilities property', () => {
  const validCost = (c: number | undefined): c is number => c != null && Number.isFinite(c) && c >= 0;

  it('maps every valid cost to a finite [0,1] utility and undefined otherwise', () => {
    fc.assert(
      fc.property(fc.array(weirdNum, { maxLength: 12 }), (costs) => {
        const u = logCostUtilities(costs);
        expect(u.length).toBe(costs.length);
        costs.forEach((c, i) => {
          if (validCost(c)) {
            expect(u[i]).not.toBeUndefined();
            expect(Number.isFinite(u[i]!)).toBe(true);
            expect(u[i]!).toBeGreaterThanOrEqual(0);
            expect(u[i]!).toBeLessThanOrEqual(1);
          } else {
            expect(u[i]).toBeUndefined();
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it('assigns a cheaper cost a utility no lower than a dearer one', () => {
    fc.assert(
      fc.property(fc.array(weirdNum, { maxLength: 12 }), (costs) => {
        const u = logCostUtilities(costs);
        for (let i = 0; i < costs.length; i++) {
          for (let j = 0; j < costs.length; j++) {
            const ci = costs[i];
            const cj = costs[j];
            if (validCost(ci) && validCost(cj) && ci < cj) {
              expect(u[i]!).toBeGreaterThanOrEqual(u[j]! - 1e-9);
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ─── Invariant 1: strictly cheaper at equal quality never ranks lower ───

/**
 * A "nice" candidate arbitrary: positive prices/quality, no non-finite noise.
 * Quality floors at 30 so the strictly-worse fixture (quality 5) is genuinely
 * dominated on every axis for the invariant-3 property.
 */
function niceCandidateArb(index: number): fc.Arbitrary<Candidate> {
  return fc
    .record({
      intelligence: fc.double({ min: 30, max: 100, noNaN: true }),
      coding: fc.double({ min: 30, max: 100, noNaN: true }),
      agenticCoding: fc.double({ min: 30, max: 100, noNaN: true }),
      price: fc.double({ min: 0.1, max: 100, noNaN: true }),
      speed: fc.double({ min: 1, max: 200, noNaN: true }),
    })
    .map((r) => {
      const id = `other${index}/m${index}`;
      return candidate(id, {
        bench: benchRow(id, {
          quality: { intelligence: r.intelligence, coding: r.coding, agenticCoding: r.agenticCoding },
          priceInputPer1M: r.price,
          priceOutputPer1M: r.price,
          outputSpeedTps: r.speed,
        }),
        cost: { input: r.price * 1e-6, output: r.price * 1e-6, cacheRead: 0, cacheWrite: 0 },
      });
    });
}

describe('scorer property — cost dominance at equal quality', () => {
  it('ranks a strictly cheaper equal-quality candidate no lower than its dearer twin', () => {
    const qualityArb = fc.record({
      intelligence: fc.double({ min: 1, max: 100, noNaN: true }),
      coding: fc.double({ min: 1, max: 100, noNaN: true }),
      agenticCoding: fc.double({ min: 1, max: 100, noNaN: true }),
    });
    fc.assert(
      fc.property(
        dimensionArb,
        qualityArb,
        fc.double({ min: 1, max: 100, noNaN: true }),
        fc.array(fc.nat({ max: 3 }).chain((i) => niceCandidateArb(i)), { maxLength: 4 }),
        (dim, quality, dearPrice, others) => {
          const cheapPrice = dearPrice / 4;
          const dear = candidate('pair/dear', {
            bench: benchRow('pair/dear', {
              quality,
              priceInputPer1M: dearPrice,
              priceOutputPer1M: dearPrice,
              outputSpeedTps: 50,
            }),
            cost: { input: dearPrice * 1e-6, output: dearPrice * 1e-6, cacheRead: 0, cacheWrite: 0 },
          });
          const cheap = candidate('pair/cheap', {
            bench: benchRow('pair/cheap', {
              quality,
              priceInputPer1M: cheapPrice,
              priceOutputPer1M: cheapPrice,
              outputSpeedTps: 50,
            }),
            cost: { input: cheapPrice * 1e-6, output: cheapPrice * 1e-6, cacheRead: 0, cacheWrite: 0 },
          });
          // Default dimension weights all carry cost > 0, so the strict price
          // advantage is a real signal here. Equal quality guarantees the pair
          // shares a tier, so the cheaper one can only win or tie the ordering.
          const decision = pickBest([dear, cheap, ...others], dim, DEFAULT_DIMENSION_WEIGHTS[dim], {
            estimatedContextTokens: 0,
          });
          const cheapIdx = decision.fallbackChain.indexOf('pair/cheap');
          const dearIdx = decision.fallbackChain.indexOf('pair/dear');
          expect(cheapIdx).toBeLessThanOrEqual(dearIdx);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ─── Invariant 2: tier dominance — tier 0 precedes tier 1 unconditionally ──

describe('scorer property — tier dominance', () => {
  it('places a known frontier candidate ahead of every unknown-quality peer', () => {
    fc.assert(
      fc.property(
        dimensionArb,
        weightsArb,
        fc.double({ min: 0.1, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 200, noNaN: true }),
        fc.integer({ min: 1, max: 5 }),
        (dim, weights, knownPrice, knownSpeed, unknownCount) => {
          // Sole bench-bearing candidate ⇒ it defines the frontier maximum ⇒
          // taskRatio 1 ⇒ tier 0. Peers without a bench are unknown ⇒ tier 1.
          const known = candidate('known/frontier', {
            bench: benchRow('known/frontier', {
              quality: { intelligence: 90, coding: 90, agenticCoding: 90 },
              priceInputPer1M: knownPrice,
              priceOutputPer1M: knownPrice,
              outputSpeedTps: knownSpeed,
            }),
            cost: { input: knownPrice * 1e-6, output: knownPrice * 1e-6, cacheRead: 0, cacheWrite: 0 },
          });
          // Make the unknowns as attractive as possible on price+speed so only
          // the tier gate — not the weighted score — can explain the ordering.
          const unknowns = Array.from({ length: unknownCount }, (_, i) =>
            candidate(`unknown${i}/m${i}`, {
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }),
          );
          const decision = pickBest([...unknowns, known], dim, weights, { estimatedContextTokens: 0 });
          const knownIdx = decision.fallbackChain.indexOf('known/frontier');
          for (let i = 0; i < unknownCount; i++) {
            expect(knownIdx).toBeLessThan(decision.fallbackChain.indexOf(`unknown${i}/m${i}`));
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ─── Invariant 3: a strictly-worse candidate never wins ─────────────────

/**
 * NOTE: the stronger phrasing "adding a strictly-worse candidate never changes
 * the winner" does NOT hold for this scorer, and asserting it would be a false
 * invariant. Cost utilities are normalized set-relative (`logCostUtilities`
 * rescales by the log-span of the tier's costs), so a very expensive addition
 * widens the span, compresses the cost advantage between the existing
 * candidates, and can flip the winner between two *originals* whose ranking
 * hinged on cost. The `it` below the property pins that documented behavior.
 *
 * The invariant that DOES hold — and the one worth asserting — is that the
 * dominated addition never becomes the winner itself.
 */
describe('scorer property — strictly-worse candidate', () => {
  it('never lets a candidate dominated on quality, price, and speed win', () => {
    fc.assert(
      fc.property(
        dimensionArb,
        fc.array(fc.nat({ max: 3 }).chain((i) => niceCandidateArb(i)), { minLength: 1, maxLength: 4 }),
        (dim, base) => {
          // niceCandidateArb floors quality at 30, so quality 5 + max price +
          // zero speed is strictly worse than every base candidate on every axis.
          const worst = candidate('zzz/worst', {
            bench: benchRow('zzz/worst', {
              quality: { intelligence: 5, coding: 5, agenticCoding: 5 },
              priceInputPer1M: 1e6,
              priceOutputPer1M: 1e6,
              outputSpeedTps: 0,
            }),
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          });
          const decision = pickBest([...base, worst], dim, DEFAULT_DIMENSION_WEIGHTS[dim], {
            estimatedContextTokens: 0,
          });
          expect(decision.chosen).not.toBe('zzz/worst');
          expect(decision.fallbackChain[0]).not.toBe('zzz/worst');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('documents that set-relative cost normalization can move the winner among originals', () => {
    // A (top quality, just-above-cheapest) vs B (near-top quality, cheapest):
    // with only {A,B}, B's cost advantage wins on `implement`. Adding a
    // strictly-worse, extremely expensive C widens the cost log-span, lifts A's
    // cost utility toward B's, and A overtakes. This pins the real behavior so a
    // future move to rank-based cost normalization is a conscious change.
    const A = candidate('t/a', {
      bench: benchRow('t/a', {
        quality: { intelligence: 100, coding: 100, agenticCoding: 100 },
        priceInputPer1M: 1.1,
        priceOutputPer1M: 1.1,
      }),
      cost: { input: 1.1e-6, output: 1.1e-6, cacheRead: 0, cacheWrite: 0 },
    });
    const B = candidate('t/b', {
      bench: benchRow('t/b', {
        quality: { intelligence: 94, coding: 94, agenticCoding: 94 },
        priceInputPer1M: 1,
        priceOutputPer1M: 1,
      }),
      cost: { input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0 },
    });
    const C = candidate('t/c', {
      bench: benchRow('t/c', {
        quality: { intelligence: 88, coding: 88, agenticCoding: 88 },
        priceInputPer1M: 1e6,
        priceOutputPer1M: 1e6,
      }),
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(pickBest([A, B], 'implement').chosen).toBe('t/b');
    expect(pickBest([A, B, C], 'implement').chosen).toBe('t/a');
  });
});
