import { describe, it, expect } from 'vitest';
import {
  pickBest,
  pickEscalation,
  buildCandidate,
  blendedPricePer1M,
  logCostUtilities,
  buildRouterThinkingLevelMap,
  chooseThinkingLevel,
  clampEffortToFloor,
  levelFrom,
  resolveThinkingLevel,
  relativeQualities,
  findSourceCandidate,
  isStrictlyStrongerCandidate,
  servedEffort,
  type RegistryModelInfo,
} from './scorer.js';
import { DEFAULT_DIMENSION_WEIGHTS } from '../../constants.js';
import { benchRow, candidate, registryModel } from '../../test-support/router-fixtures.js';
import type { Candidate, MultiWorkScoringPolicy } from '../../types.js';

const cheapModel = candidate('test/cheap', {
  bench: {
    registryId: 'test/cheap',
    benchSlug: 'cheap',
    active: true,
    quality: { intelligence: 65, coding: 60 },
    priceInputPer1M: 0.5,
    priceOutputPer1M: 2.0,
    outputSpeedTps: 50,
    source: 'aa',
  },
  cost: { input: 0.0000005, output: 0.000002, cacheRead: 0.00000005, cacheWrite: 0.000000375 },
});

const midModel = candidate('test/mid', {
  bench: {
    registryId: 'test/mid',
    benchSlug: 'mid',
    active: true,
    quality: { intelligence: 80, coding: 82 },
    priceInputPer1M: 3.0,
    priceOutputPer1M: 15.0,
    outputSpeedTps: 80,
    source: 'aa',
  },
  cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
});

const expensiveModel = candidate('test/expensive', {
  bench: {
    registryId: 'test/expensive',
    benchSlug: 'expensive',
    active: true,
    quality: { intelligence: 90, coding: 88, },
    priceInputPer1M: 15.0,
    priceOutputPer1M: 75.0,
    outputSpeedTps: 40,
    source: 'aa',
  },
  cost: { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
});

const allCandidates = [cheapModel, midModel, expensiveModel];

describe('scorer — effort-variant diagnostics (regression)', () => {
  it('records candidate diagnostics under the candidate key, not the bare registryId', () => {
    // Two effort variants of one model: the low-effort row is far below the
    // frontier and must be gated with its key visible in the diagnostics.
    const frontier = candidate('test/frontier', {
      bench: benchRow('test/frontier', {
        quality: { intelligence: 90 },
        priceInputPer1M: 10,
        priceOutputPer1M: 50,
      }),
      reasoning: true,
      effort: 'max',
    });
    const low = candidate('test/model', {
      bench: benchRow('test/model', {
        effort: 'low',
        benchSlug: 'model-low',
        quality: { intelligence: 20 },
        priceInputPer1M: 0.1,
        priceOutputPer1M: 0.1,
      }),
      reasoning: true,
      effort: 'low',
    });
    const max = candidate('test/model', {
      bench: benchRow('test/model', {
        effort: 'max',
        benchSlug: 'model-max',
        quality: { intelligence: 85 },
        priceInputPer1M: 5,
        priceOutputPer1M: 20,
      }),
      reasoning: true,
      effort: 'max',
    });
    const decision = pickBest([frontier, low, max], 'gather');
    const diag = decision.candidateDiagnostics ?? [];
    const lowDiag = diag.find((d) => d.candidateKey === 'test/model:low');
    expect(lowDiag?.excludedReason).toBe('below-task-floor');
    // The bare registryId must not appear as a diagnostic key.
    expect(diag.some((d) => d.candidateKey === 'test/model')).toBe(false);
  });

  it('keys relative qualities per effort variant so variants do not collide', () => {
    const a = candidate('test/m', {
      bench: benchRow('test/m', { effort: 'low', quality: { intelligence: 40 } }),
      effort: 'low',
    });
    const b = candidate('test/m', {
      bench: benchRow('test/m', { effort: 'max', quality: { intelligence: 80 } }),
      effort: 'max',
    });
    const rel = relativeQualities([a, b], 'gather');
    expect(rel.get('test/m:low')?.taskRatio).toBeCloseTo(0.5, 5);
    expect(rel.get('test/m:max')?.taskRatio).toBeCloseTo(1, 5);
    expect(rel.size).toBe(2);
  });
});

describe('scorer — cost basis (cost-per-task vs blended $/1M)', () => {
  it('falls back to blended $/1M for the whole set when coverage is mixed', () => {
    const withTask = candidate('test/a', {
      bench: benchRow('test/a', {
        quality: { intelligence: 80 },
        priceInputPer1M: 0.5,
        priceOutputPer1M: 2,
        costPerTask: 5.0,
      }),
      cost: { input: 0.5, output: 2 },
    });
    const withoutTask = candidate('test/b', {
      bench: benchRow('test/b', {
        quality: { intelligence: 80 },
        priceInputPer1M: 10,
        priceOutputPer1M: 40,
        // no costPerTask — forces the mixed-coverage fallback
      }),
      cost: { input: 10, output: 40 },
    });
    const decision = pickBest([withTask, withoutTask], 'gather');
    expect(decision.reason).toContain('[cost per 1M tokens]');
    // Per-1M basis: A is ~20x cheaper, so A wins despite A being 50x more
    // expensive per task.
    expect(decision.chosen).toBe('test/a');
  });

  it('uses costPerTask when every candidate carries one, reordering the set', () => {
    // A: cheap per-1M (1.625 blended), expensive per task (5.0)
    const a = candidate('test/a', {
      bench: benchRow('test/a', {
        quality: { intelligence: 80 },
        priceInputPer1M: 0.5,
        priceOutputPer1M: 2,
        costPerTask: 5.0,
      }),
      cost: { input: 0.5, output: 2 },
    });
    // B: expensive per-1M (32.5 blended), cheap per task (0.1)
    const b = candidate('test/b', {
      bench: benchRow('test/b', {
        quality: { intelligence: 80 },
        priceInputPer1M: 10,
        priceOutputPer1M: 40,
        costPerTask: 0.1,
      }),
      cost: { input: 10, output: 40 },
    });
    const decision = pickBest([a, b], 'gather');
    expect(decision.reason).toContain('[cost per task]');
    expect(decision.chosen).toBe('test/b');

    // Same set with one costPerTask removed: mixed coverage degrades to
    // per-1M and the winner flips back to A.
    const bMixed = { ...b, bench: { ...b.bench!, costPerTask: undefined } };
    const mixed = pickBest([a, bMixed], 'gather');
    expect(mixed.reason).toContain('[cost per 1M tokens]');
    expect(mixed.chosen).toBe('test/a');
  });

  it('treats negative task and partial benchmark costs as unknown', () => {
    const negativeTask = candidate('test/negative-task', {
      bench: benchRow('test/negative-task', {
        quality: { intelligence: 80 },
        costPerTask: -1,
      }),
      cost: { input: 10, output: 10 },
    });
    const valid = candidate('test/valid', {
      bench: benchRow('test/valid', {
        quality: { intelligence: 80 },
        costPerTask: 0.5,
      }),
      cost: { input: 1, output: 1 },
    });
    const taskDecision = pickBest([negativeTask, valid], 'gather');
    expect(taskDecision.reason).toContain('[cost per 1M tokens]');
    expect(taskDecision.chosen).toBe(valid.registryId);

    const negativePartial = candidate('test/negative-partial', {
      bench: benchRow('test/negative-partial', {
        quality: { intelligence: 80 },
        priceInputPer1M: -10,
        priceOutputPer1M: undefined,
      }),
      cost: undefined,
    });
    const partialDecision = pickBest([negativePartial, valid], 'gather');
    expect(partialDecision.chosen).toBe(valid.registryId);
  });

  it('never mixes the two scales inside one request-local ratio', () => {
    // Three candidates: two with costPerTask, one without. The mixed one must
    // drag the WHOLE set to per-1M (G3 rule applied to price), never a
    // per-candidate scale.
    const a = candidate('test/a', {
      bench: benchRow('test/a', { quality: { intelligence: 80 }, costPerTask: 1 }),
      cost: { input: 1, output: 1 },
    });
    const b = candidate('test/b', {
      bench: benchRow('test/b', { quality: { intelligence: 80 }, costPerTask: 100 }),
      cost: { input: 1, output: 1 },
    });
    const c = candidate('test/c', {
      bench: benchRow('test/c', { quality: { intelligence: 80 } }),
      cost: { input: 100, output: 100 },
    });
    const decision = pickBest([a, b, c], 'gather');
    expect(decision.reason).toContain('[cost per 1M tokens]');
    // Under per-1M, a and b tie on cost (same blended price) and quality; the
    // canonical-key tie-break decides. Both a and b must beat c.
    expect(decision.chosen).toBe('test/a');
  });

  it('a non-competing candidate missing costPerTask does not blind the tier-0 pool to task-basis pricing', () => {
    // Same base model at two efforts, both with real per-task costs (max
    // effort burns more thinking tokens -> higher costPerTask), same $/1M
    // rate (effort does not change the price-per-token). A third, distinctly
    // lower-quality candidate lacks costPerTask entirely and never clears the
    // quality floor, so it can never win — it must not force the winning
    // pair down to an effort-blind per-1M comparison.
    const medium = candidate('test/a', {
      bench: benchRow('test/a', {
        effort: 'medium',
        quality: { intelligence: 80 },
        priceInputPer1M: 1,
        priceOutputPer1M: 3,
        costPerTask: 1.0,
      }),
      cost: { input: 1, output: 3 },
      effort: 'medium',
    });
    const max = candidate('test/a', {
      bench: benchRow('test/a', {
        effort: 'max',
        quality: { intelligence: 82 },
        priceInputPer1M: 1,
        priceOutputPer1M: 3,
        costPerTask: 8.0,
      }),
      cost: { input: 1, output: 3 },
      effort: 'max',
    });
    const weak = candidate('test/b', {
      bench: benchRow('test/b', { quality: { intelligence: 20 } }),
      cost: { input: 0.1, output: 0.1 },
    });
    const decision = pickBest([medium, max, weak], 'gather');
    expect(decision.reason).toContain('[cost per task]');
    expect(decision.chosen).toBe('test/a:medium');
  });
});

describe('scorer', () => {
  // One table pins the exact default-policy picks for representative tasks.
  // Ordering/eligibility contracts live in the relational describes below;
  // deterministic complete-chain behavior is established by the routing-policy
  // determinism test (reversed tied input yields the same chain).
  describe('default policy snapshot', () => {
    it.each([
      ['lightweight', 'test/cheap'],
      ['gather', 'test/cheap'],
      // Both mid and expensive clear plan's capability floor. Cost is
      // normalized only within that comparable tier, where mid's large price
      // advantage outweighs the modest quality gap.
      ['plan', 'test/mid'],
      ['implement', 'test/mid'],
      ['review', 'test/mid'],
    ] as const)('picks %s with default weights', (dimension, expected) => {
      const decision = pickBest(allCandidates, dimension, undefined, {
        estimatedContextTokens: 500,
      });
      expect(decision.chosen).toBe(expected);
      expect(decision.fallbackChain[0]).toBe(expected);
    });
  });

  describe('pickBest contracts', () => {
    it('routes up when all candidates lack quality data', () => {
      const noData = candidate('test/no-data-1', {
        bench: undefined,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      const alsoNoData = candidate('test/no-data-2', {
        bench: { quality: {} } as never,
        cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
      });
      const decision = pickBest([noData, alsoNoData], 'plan', undefined, {
        estimatedContextTokens: 2000,
      });
      expect(decision.chosen).toBeDefined();
      expect(decision.routedUp).toBe(true);
    });

    it('does not pick weak models for review', () => {
      const decision = pickBest(allCandidates, 'review', undefined, {
        estimatedContextTokens: 1000,
      });
      expect(decision.chosen).not.toBe('test/cheap');
    });

    it('excludes small-context models with long-context guard', () => {
      const smallModel = candidate('test/small', {
        contextWindow: 8000,
        bench: {
          registryId: 'test/small',
          benchSlug: 'small',
          active: true,
          quality: { intelligence: 95, coding: 95, },
          priceInputPer1M: 1.0,
          priceOutputPer1M: 5.0,
          source: 'aa',
        },
        cost: { input: 0.000001, output: 0.000005, cacheRead: 0, cacheWrite: 0 },
      });
      const candidates = [smallModel, expensiveModel];
      const decision = pickBest(candidates, 'plan', undefined, {
        estimatedContextTokens: 8000, // small's window is 8000, 8000 * 1.2 = 9600 > 8000
      });
      // small model excluded by guard; expensiveModel wins
      expect(decision.chosen).toBe('test/expensive');
    });

    it('keeps largest window when guard empties the set', () => {
      const tiny1 = candidate('test/tiny1', { contextWindow: 4000 });
      const tiny2 = candidate('test/tiny2', { contextWindow: 5000 });
      const decision = pickBest([tiny1, tiny2], 'lightweight', undefined, {
        estimatedContextTokens: 10000, // all excluded
      });
      expect(decision.chosen).toBe('test/tiny2');
    });

    it('prefers incumbent when switching penalty applies', () => {
      const decision = pickBest(allCandidates, 'lightweight', undefined, {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/mid',
        switchMargin: 0.5,
      });
      // On large context, switch penalty keeps us on mid (the incumbent)
      expect(decision.chosen).toBe('test/mid');
    });

    it('caps the incumbent switch bonus with switchMargin', () => {
      const decision = pickBest(allCandidates, 'lightweight', undefined, {
        estimatedContextTokens: 200000,
        incumbentRegistryId: 'test/expensive',
        switchMargin: 0,
      });
      expect(decision.chosen).toBe('test/cheap');
    });

    it('does not penalize switch on subagent spawn', () => {
      const decision = pickBest(allCandidates, 'lightweight', undefined, {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/expensive',
        isSubagentSpawn: true,
      });
      // Subagent spawn — no cache to lose
      expect(decision.chosen).toBe('test/cheap');
    });

    function effortChangeFixture(overrides: Partial<Candidate> = {}) {
      const incumbentLow = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'low', benchSlug: 'model-low',
          quality: { intelligence: 50, coding: 50 },
          priceInputPer1M: 8, priceOutputPer1M: 40,
        }),
        reasoning: true, effort: 'low',
        cost: { input: 0.000008, output: 0.00004 },
      });
      const sameModelHigh = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'high', benchSlug: 'model-high',
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 3, priceOutputPer1M: 15,
        }),
        reasoning: true, effort: 'high',
        cost: { input: 0.000003, output: 0.000015 },
        ...overrides,
      });
      const rival = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 2.9, priceOutputPer1M: 14.9,
        }),
        cost: { input: 0.0000029, output: 0.0000149 },
      });
      return {
        cands: [incumbentLow, sameModelHigh, rival],
        opts: { estimatedContextTokens: 80000, incumbentRegistryId: 'test/model:low', switchMargin: 0.15 },
      };
    }

    it('credits a same-model effort change only for the prefix its own cache still holds', () => {
      // Where effort is part of the cache key, a cold effort level shares no
      // cache with the incumbent: it is priced like any other switch.
      const { cands, opts } = effortChangeFixture();
      expect(pickBest(cands, 'lightweight', undefined, opts).chosen).toBe('test/rival');
      // A level that served recently still holds its prefix and keeps the stickiness.
      const warm = { ...opts, warmPrefixTokens: new Map([['test/model:high', 60000]]) };
      expect(pickBest(cands, 'lightweight', undefined, warm).chosen).toBe('test/model:high');
      // A warm cache of the incumbent's own level does not carry over to another level.
      const other = { ...opts, warmPrefixTokens: new Map([['test/model:low', 60000]]) };
      expect(pickBest(cands, 'lightweight', undefined, other).chosen).toBe('test/rival');
    });

    it('credits an effort change in full where effort shares the model\'s cache', () => {
      const { cands, opts } = effortChangeFixture({ effortSharesCache: true });
      expect(pickBest(cands, 'lightweight', undefined, opts).chosen).toBe('test/model:high');
    });

    it('prices the effort-change credit by the INCUMBENT\'s own cache discount, not the destination candidate\'s', () => {
      // The credit values cache that is actually preserved by staying on the
      // incumbent's provider/model — it is the incumbent's own cacheWrite/
      // cacheRead spread that determines how much is at stake, not the
      // pricing published on whichever effort variant is being switched to.
      // Here the incumbent's cacheRead sits nearly at its cacheWrite price
      // (this provider barely discounts a cache hit at all), so the credit
      // must shrink to nothing even with a large warm prefix, and the
      // marginally cheaper rival wins despite sharing the same model.
      const incumbentLow = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'low', benchSlug: 'model-low',
          quality: { intelligence: 50, coding: 50 },
          priceInputPer1M: 8, priceOutputPer1M: 40,
        }),
        reasoning: true, effort: 'low',
        // cacheRead exactly equal to cacheWrite: this provider offers no
        // real caching discount at all, so the priced credit must be exactly
        // zero (not a fallback to the flat unpriced rate).
        cost: { input: 0.000008, output: 0.00004, cacheRead: 0.000008, cacheWrite: 0.000008 },
      });
      const sameModelHigh = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'high', benchSlug: 'model-high',
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 3, priceOutputPer1M: 15,
        }),
        reasoning: true, effort: 'high',
        // A steep cache discount here must NOT matter: this is the target of
        // the switch, not the cache actually being preserved.
        cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
      });
      const rival = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 2.9, priceOutputPer1M: 14.9,
        }),
        cost: { input: 0.0000029, output: 0.0000149 },
      });
      const cands = [incumbentLow, sameModelHigh, rival];
      const opts = {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/model:low',
        switchMargin: 0.15,
        warmPrefixTokens: new Map([['test/model:high', 60000], ['test/rival', 60000]]),
      };
      expect(pickBest(cands, 'lightweight', undefined, opts).chosen).toBe('test/rival');
    });

    it('prices a full model change on the entire context, never just the message tokens', () => {
      // A different provider/model shares no cache with the incumbent: it gets
      // zero switch credit even when its own cache is warm, distinct from a
      // same-model effort change onto a warm level. Both incumbentLow and rival share the same steep cache
      // discount so any difference in outcome is attributable only to the
      // switch mechanism, not to underlying price/quality gaps.
      const incumbentLow = candidate('test/model', {
        bench: benchRow('test/model', {
          quality: { intelligence: 60, coding: 60 },
          priceInputPer1M: 5, priceOutputPer1M: 25,
        }),
        cost: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
      });
      const rivalSamePriceAndQuality = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 60, coding: 60 },
          priceInputPer1M: 5, priceOutputPer1M: 25,
        }),
        cost: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
      });
      const cands = [incumbentLow, rivalSamePriceAndQuality];
      const opts = {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/model',
        switchMargin: 0.15,
        warmPrefixTokens: new Map([['test/model:high', 60000], ['test/rival', 60000]]),
      };
      const decision = pickBest(cands, 'lightweight', undefined, opts);
      // Identical price/quality: only the switch credit can break the tie, and
      // an unrelated model gets none of it.
      expect(decision.chosen).toBe('test/model');
    });

    it('exempts a same-model candidate at the model\'s own (unmeasured) default effort from the effort-change discount', () => {
      // A same-model candidate with no measured effort represents the model's
      // default call shape, so it keeps the FULL incumbent credit rather than
      // the warm-prefix share an explicit effort change receives.
      const incumbentHigh = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'high', benchSlug: 'model-high',
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 5, priceOutputPer1M: 25,
        }),
        reasoning: true, effort: 'high',
        cost: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
      });
      const sameModelDefaultEffort = candidate('test/model', {
        bench: benchRow('test/model', {
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 5.1, priceOutputPer1M: 25.1,
        }),
        cost: { input: 0.0000051, output: 0.0000251 },
      });
      const rival = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 5.05, priceOutputPer1M: 25.05,
        }),
        cost: { input: 0.00000505, output: 0.0000251 },
      });
      const cands = [incumbentHigh, sameModelDefaultEffort, rival];
      const opts = {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/model:high',
        switchMargin: 0.15,
        // Deliberately small: the default-effort exemption must still grant
        // the FULL credit even though a warm prefix this small would only
        // give an ordinary effort change a negligible fraction of it.
        warmPrefixTokens: new Map([['test/model', 1000]]),
      };
      const decision = pickBest(cands, 'lightweight', undefined, opts);
      // sameModelDefaultEffort is priced slightly worse than rival, so on
      // economics alone (or with only the tiny ordinary effort-change share)
      // rival would outrank it. The full exemption credit must still lift it
      // above rival in the fallback chain.
      const chain = decision.fallbackChain;
      expect(chain.indexOf('test/model')).toBeLessThan(chain.indexOf('test/rival'));
    });

    it('grants no retention credit at all when the incumbent publishes no cache pricing, scoring it on ordinary economics', () => {
      // Guessing at a universal per-token rate when the incumbent's registry
      // entry does not publish enough pricing to compute a real loss would
      // reintroduce the exact provider-blind behavior this mechanism
      // replaces. Absent `cacheRead` (or a `cacheWrite`/`input` write basis),
      // every candidate — including the incumbent itself and a same-model
      // effort change — is scored on quality/cost/speed alone, regardless of
      // `warmPrefixTokens`.
      const incumbentLow = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'low', benchSlug: 'model-low',
          quality: { intelligence: 50, coding: 50 },
          priceInputPer1M: 8, priceOutputPer1M: 40,
        }),
        reasoning: true, effort: 'low',
        cost: { input: 0.000008, output: 0.00004, cacheRead: undefined, cacheWrite: undefined },
      });
      const sameModelHigh = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'high', benchSlug: 'model-high',
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 3, priceOutputPer1M: 15,
        }),
        reasoning: true, effort: 'high',
        cost: { input: 0.000003, output: 0.000015, cacheRead: undefined, cacheWrite: undefined },
      });
      const rival = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 2.9, priceOutputPer1M: 14.9,
        }),
        cost: { input: 0.0000029, output: 0.0000149, cacheRead: undefined, cacheWrite: undefined },
      });
      const cands = [incumbentLow, sameModelHigh, rival];
      const opts = {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/model:low',
        switchMargin: 0.15,
      };
      // No pricing, no credit: the marginally cheaper different model wins.
      expect(pickBest(cands, 'lightweight', undefined, opts).chosen).toBe('test/rival');
      // A large warm prefix must not resurrect a credit the missing pricing
      // cannot support — the outcome is unchanged.
      expect(
        pickBest(cands, 'lightweight', undefined, {
          ...opts,
          warmPrefixTokens: new Map([['test/model:high', 60000]]),
        }).chosen,
      ).toBe('test/rival');
    });

    it('produces a deterministic incumbent-retention outcome regardless of candidate array order', () => {
      const incumbentLow = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'low', benchSlug: 'model-low',
          quality: { intelligence: 50, coding: 50 },
          priceInputPer1M: 8, priceOutputPer1M: 40,
        }),
        reasoning: true, effort: 'low',
        cost: { input: 0.000008, output: 0.00004, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
      });
      const sameModelHigh = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'high', benchSlug: 'model-high',
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 3, priceOutputPer1M: 15,
        }),
        reasoning: true, effort: 'high',
        cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
      });
      const rival = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 70, coding: 70 },
          priceInputPer1M: 2.9, priceOutputPer1M: 14.9,
        }),
        cost: { input: 0.0000029, output: 0.0000149 },
      });
      const opts = {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/model:low',
        switchMargin: 0.15,
        warmPrefixTokens: new Map([['test/model:high', 60000], ['test/rival', 60000]]),
      };
      const forward = pickBest([incumbentLow, sameModelHigh, rival], 'lightweight', undefined, opts).chosen;
      const reversed = pickBest([rival, sameModelHigh, incumbentLow], 'lightweight', undefined, opts).chosen;
      expect(forward).toBe(reversed);
    });

    it('does not penalize switch on subagent spawn even when the incumbent publishes cache pricing', () => {
      const incumbentLow = candidate('test/model', {
        bench: benchRow('test/model', {
          effort: 'low', benchSlug: 'model-low',
          quality: { intelligence: 50, coding: 50 },
          priceInputPer1M: 8, priceOutputPer1M: 40,
        }),
        reasoning: true, effort: 'low',
        cost: { input: 0.000008, output: 0.00004, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
      });
      const rival = candidate('test/rival', {
        bench: benchRow('test/rival', {
          quality: { intelligence: 50, coding: 50 },
          priceInputPer1M: 2.9, priceOutputPer1M: 14.9,
        }),
        cost: { input: 0.0000029, output: 0.0000149 },
      });
      const decision = pickBest([incumbentLow, rival], 'lightweight', undefined, {
        estimatedContextTokens: 80000,
        incumbentRegistryId: 'test/model:low',
        switchMargin: 0.15,
        warmPrefixTokens: new Map([['test/model:high', 60000], ['test/rival', 60000]]),
        isSubagentSpawn: true,
      });
      expect(decision.chosen).toBe('test/rival');
    });

    it('routes-up on unknown quality for plan/review', () => {
      const a = candidate('test/ua', { bench: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      const b = candidate('test/ub', { bench: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      const decision = pickBest([a, b], 'review', undefined, { estimatedContextTokens: 500 });
      expect(decision.routedUp).toBe(true);
      expect(decision.chosen).toBeDefined();
    });

    it('returns the same complete fallback chain for reversed tied input', () => {
      const tiedCandidates = ['test/zulu', 'test/alpha', 'test/mid'].map((registryId) =>
        candidate(registryId, {
          contextWindow: 200000,
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          bench: {
            registryId,
            benchSlug: registryId.split('/').at(-1)!,
            active: true,
            quality: { intelligence: 90, coding: 90, agenticCoding: 90, },
            priceInputPer1M: 1,
            priceOutputPer1M: 1,
            outputSpeedTps: 100,
            source: 'test',
          },
        }),
      );

      const forward = pickBest(tiedCandidates, 'implement', DEFAULT_DIMENSION_WEIGHTS.implement).fallbackChain;
      const reverse = pickBest([...tiedCandidates].reverse(), 'implement', DEFAULT_DIMENSION_WEIGHTS.implement).fallbackChain;
      expect(reverse).toEqual(forward);
    });

    it('gives zero cost credit to models with no price data', () => {
      const noPriceModel = candidate('test/no-price', {
        bench: undefined,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      const hasPriceModel = candidate('test/has-price', {
        bench: {
          registryId: 'test/has-price', benchSlug: 'hp', active: true,
          quality: { intelligence: 40 },
          priceInputPer1M: 0.5, priceOutputPer1M: 2.0,
          source: 'aa',
        },
        cost: { input: 0.0000005, output: 0.000002, cacheRead: 0, cacheWrite: 0 },
      });
      // For lightweight (cost weight 0.6), the cheap known model should win over
      // the unknown-price model (which gets zero cost credit, not free).
      const decision = pickBest([noPriceModel, hasPriceModel], 'lightweight', undefined, {
        estimatedContextTokens: 100,
      });
      expect(decision.chosen).toBe('test/has-price');
    });

    it('buildCandidate merges registry metadata', () => {
      const model = registryModel('openai/gpt-4o', {
        contextWindow: 128000,
        input: ['text', 'image'],
        cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.75 },
      });
      const c = buildCandidate(model);
      expect(c.registryId).toBe('openai/gpt-4o');
      expect(c.vision).toBe(true);
      expect(c.contextWindow).toBe(128000);
      expect(c.cost?.input).toBe(2.5);
    });

    it('marks effort as sharing the cache only for per-message effort on anthropic-messages', () => {
      const perMessage = { supportsMidConvoEffort: true };
      expect(buildCandidate(registryModel('a/claude', { api: 'anthropic-messages', compat: perMessage })).effortSharesCache)
        .toBe(true);
      expect(buildCandidate(registryModel('a/claude', { api: 'anthropic-messages' })).effortSharesCache).toBeUndefined();
      expect(buildCandidate(registryModel('o/gpt', { api: 'openai-responses', compat: perMessage })).effortSharesCache)
        .toBeUndefined();
    });

    it('preserves an explicit reasoning level when the model supports it', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: 'low', high: 'high', xhigh: null, max: null },
      });
      expect(resolveThinkingLevel(model, 'low', 'implement')).toBe('low');
    });

    it('clamps an unsupported explicit reasoning request to the nearest supported level', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: null, medium: null, high: 'high', xhigh: null, max: null },
      });
      expect(resolveThinkingLevel(model, 'max', 'plan')).toBe('high');
    });

    // ── Minimum effort: a scored effort may raise it, never lower it ──

    it('serves a measured effort at or above the dimension floor', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'high',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      });
      // implement floor is medium; measured high wins.
      expect(chooseThinkingLevel(model, 'implement')).toBe('high');
      // gather floor is low; measured high wins.
      expect(chooseThinkingLevel(model, 'gather')).toBe('high');
    });

    it('raises a measured effort below the dimension minimum to that minimum', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'low',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      });
      // plan floor is medium: a cheap low measurement must never serve plan at low.
      expect(chooseThinkingLevel(model, 'plan')).toBe('medium');
      // implement floor is medium: low is raised to medium.
      expect(chooseThinkingLevel(model, 'implement')).toBe('medium');
      // review floor is medium: low is raised to medium.
      expect(chooseThinkingLevel(model, 'review')).toBe('medium');
      // gather floor is low: measured low is at the floor and wins.
      expect(chooseThinkingLevel(model, 'gather')).toBe('low');
    });

    it('raises an off measurement to the floor on thinking dimensions', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'off',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      });
      expect(chooseThinkingLevel(model, 'implement')).toBe('medium');
      // lightweight floor is off: an off measurement is at the floor.
      expect(chooseThinkingLevel(model, 'lightweight')).toBe('off');
    });

    it('lets an explicit user reasoning level suppress the router effort choice', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'low',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      });
      // The router would serve low (gather floor), but the user asked for high.
      expect(resolveThinkingLevel(model, 'high', 'gather')).toBe('high');
    });

    it('drops an effort the model cannot serve instead of sending it', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'low',
        thinkingLevelMap: { off: 'off', low: null, medium: null, high: null, xhigh: null, max: null },
      });
      // Nothing at or above the measured low is supported: no reasoning is
      // sent rather than an unsupported level.
      expect(chooseThinkingLevel(model, 'gather')).toBeUndefined();
    });

    // Regression (M1): levelFrom (up-only) never serves below the dimension
    // floor even when the nearest-first walk would pick a lower level first.
    // Scenario: measured high, map nulls high + xhigh but lists max → levelFrom
    // yields max; the nearest-first resolveThinkingLevel would yield medium.
    it('levelFrom walks up-only from the clamped effort, never below the floor', () => {
      // A provider whose map lacks high/xhigh but supports max (e.g. a model
      // with {off, low, medium, max} and no high/xhigh entries).
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'high',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: null, xhigh: null, max: 'max' },
      });
      // levelFrom from high: walks up → xhigh (unsupported) → max (supported) = 'max'
      expect(levelFrom(clampEffortToFloor('high', 'implement'), model)).toBe('max');
      // Same for review:
      expect(levelFrom(clampEffortToFloor('high', 'review'), model)).toBe('max');
      // Nearest-first (resolveThinkingLevel) would return 'medium' — prove the divergence:
      expect(resolveThinkingLevel(model, 'high', 'implement')).toBe('medium');
    });

    it('builds a router thinking-level map from the union of registry capabilities', () => {
      const models: RegistryModelInfo[] = [
        registryModel('test/a', { reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', high: 'high', xhigh: null, max: null } }),
        registryModel('test/b', { reasoning: true, thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: 'max' } }),
      ];
      const map = buildRouterThinkingLevelMap(models);
      expect(map.low).toBe('low');
      expect(map.high).toBe('high');
      expect(map.max).toBe('max');
      expect(map.medium).toBe('medium');
    });
  });
});

describe('pickEscalation', () => {
  it('excludes the source model and returns the best alternative', () => {
    const stuck = candidate('test/stuck', {
      bench: {
        registryId: 'test/stuck', benchSlug: 'stuck', active: true,
        quality: { intelligence: 70, }, priceInputPer1M: 0.1, priceOutputPer1M: 0.4,
        outputSpeedTps: 50, source: 'aa',
      },
      cost: { input: 0.0000001, output: 0.0000004, cacheRead: 0, cacheWrite: 0 },
    });
    const better = candidate('test/strong', {
      bench: {
        registryId: 'test/strong', benchSlug: 'strong', active: true,
        quality: { intelligence: 92, }, priceInputPer1M: 50, priceOutputPer1M: 200,
        outputSpeedTps: 30, source: 'aa',
      },
      cost: { input: 0.00005, output: 0.0002, cacheRead: 0, cacheWrite: 0 },
    });
    const decision = pickEscalation([stuck, better], 'plan', 'test/stuck', { estimatedContextTokens: 0 });
    expect(decision?.chosen).toBe('test/strong');
    expect(decision?.cause).toBe('capability-escalation');
  });

  it('returns undefined when no alternative exists', () => {
    const only = candidate('test/only', {
      bench: {
        registryId: 'test/only', benchSlug: 'only', active: true,
        quality: { intelligence: 80, }, source: 'aa',
      },
    });
    expect(pickEscalation([only], 'plan', 'test/only', { estimatedContextTokens: 0 })).toBeUndefined();
  });

  it('rejects the same effort of the same model through another provider', () => {
    const githubMedium = candidate('github-copilot/gpt-5.6-luna', {
      effort: 'medium',
      bench: {
        registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-medium', active: true,
        effort: 'medium', quality: { intelligence: 90, coding: 90 }, source: 'aa',
      },
    });
    const codexMedium = candidate('openai-codex/gpt-5.6-luna', {
      effort: 'medium',
      bench: {
        registryId: 'openai-codex/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-medium', active: true,
        effort: 'medium', quality: { intelligence: 95, coding: 95 }, source: 'aa',
      },
    });

    const decision = pickEscalation(
      [githubMedium, codexMedium],
      'plan',
      'github-copilot/gpt-5.6-luna:medium',
      { estimatedContextTokens: 0 },
    );

    expect(decision).toBeUndefined();
  });

  it('accepts a higher effort through another provider', () => {
    const githubMedium = candidate('github-copilot/gpt-5.6-luna', {
      effort: 'medium',
      bench: {
        registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-medium', active: true,
        effort: 'medium', quality: { intelligence: 90, coding: 90 }, source: 'aa',
      },
    });
    const codexMax = candidate('openai-codex/gpt-5.6-luna', {
      effort: 'max',
      bench: {
        registryId: 'openai-codex/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-max', active: true,
        effort: 'max', quality: { intelligence: 95, coding: 95 }, source: 'aa',
      },
    });

    const decision = pickEscalation(
      [githubMedium, codexMax],
      'plan',
      'github-copilot/gpt-5.6-luna:medium',
      { estimatedContextTokens: 0 },
    );

    expect(decision?.chosen).toBe('openai-codex/gpt-5.6-luna:max');
  });

  it('rejects lower effort through another provider', () => {
    expect(pickEscalation(
      [
        candidate('github-copilot/gpt-5.6-luna', { effort: 'medium' }),
        candidate('openai-codex/gpt-5.6-luna', { effort: 'low' }),
      ],
      'plan',
      'github-copilot/gpt-5.6-luna:medium',
      { estimatedContextTokens: 0 },
    )).toBeUndefined();
  });

  it('fails closed when same-model effort is missing', () => {
    expect(pickEscalation(
      [
        candidate('github-copilot/gpt-5.6-luna', { effort: 'medium' }),
        candidate('openai-codex/gpt-5.6-luna'),
      ],
      'plan',
      'github-copilot/gpt-5.6-luna:medium',
      { estimatedContextTokens: 0 },
    )).toBeUndefined();
    expect(pickEscalation(
      [
        candidate('github-copilot/gpt-5.6-luna'),
        candidate('openai-codex/gpt-5.6-luna', { effort: 'max' }),
      ],
      'plan',
      'github-copilot/gpt-5.6-luna',
      { estimatedContextTokens: 0 },
    )).toBeUndefined();
  });

  it('rejects lower effort of the same provider/model', () => {
    const githubMedium = candidate('github-copilot/gpt-5.6-luna', {
      effort: 'medium',
      bench: {
        registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-medium', active: true,
        effort: 'medium', quality: { intelligence: 95, coding: 95 }, source: 'aa',
      },
    });
    const githubLow = candidate('github-copilot/gpt-5.6-luna', {
      effort: 'low',
      bench: {
        registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-low', active: true,
        effort: 'low', quality: { intelligence: 90, coding: 90 }, source: 'aa',
      },
    });

    const decision = pickEscalation(
      [githubMedium, githubLow],
      'plan',
      'github-copilot/gpt-5.6-luna:medium',
      { estimatedContextTokens: 0 },
    );

    expect(decision).toBeUndefined();
  });

  it('accepts a higher effort of the same provider/model', () => {
    const githubLow = candidate('github-copilot/gpt-5.6-luna', {
      effort: 'low',
      bench: {
        registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-low', active: true,
        effort: 'low', quality: { intelligence: 90, coding: 90 }, source: 'aa',
      },
    });
    const githubHigh = candidate('github-copilot/gpt-5.6-luna', {
      effort: 'high',
      bench: {
        registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-high', active: true,
        effort: 'high', quality: { intelligence: 95, coding: 95 }, source: 'aa',
      },
    });

    const decision = pickEscalation(
      [githubLow, githubHigh],
      'plan',
      'github-copilot/gpt-5.6-luna:low',
      { estimatedContextTokens: 0 },
    );

    expect(decision?.chosen).toBe('github-copilot/gpt-5.6-luna:high');
  });

  it('quality beats cost during escalation', () => {
    // The source model is filtered out, but two real alternatives remain.
    // With normal cost-sensitive plan weights the cheap alternative would win;
    // pickEscalation uses quality-only weights, so the stronger model must win.
    const source = candidate('test/source', {
      bench: {
        registryId: 'test/source', benchSlug: 'source', active: true,
        quality: { intelligence: 70, }, priceInputPer1M: 1, priceOutputPer1M: 4,
        source: 'aa',
      },
      cost: { input: 0.000001, output: 0.000004, cacheRead: 0, cacheWrite: 0 },
    });
    const cheap = candidate('test/cheap', {
      bench: {
        registryId: 'test/cheap', benchSlug: 'cheap', active: true,
        quality: { intelligence: 80, }, priceInputPer1M: 0.1, priceOutputPer1M: 0.4,
        source: 'aa',
      },
      cost: { input: 0.0000001, output: 0.0000004, cacheRead: 0, cacheWrite: 0 },
    });
    const strong = candidate('test/strong', {
      bench: {
        registryId: 'test/strong', benchSlug: 'strong', active: true,
        quality: { intelligence: 90, }, priceInputPer1M: 100, priceOutputPer1M: 400,
        source: 'aa',
      },
      cost: { input: 0.0001, output: 0.0004, cacheRead: 0, cacheWrite: 0 },
    });
    const decision = pickEscalation([source, cheap, strong], 'plan', 'test/source', {
      estimatedContextTokens: 0,
    });
    expect(decision?.chosen).toBe('test/strong');
  });

  it('retains the context-window guard', () => {
    const stuck = candidate('test/stuck', {
      contextWindow: 200000,
      bench: {
        registryId: 'test/stuck', benchSlug: 'stuck', active: true,
        quality: { intelligence: 90, }, source: 'aa',
      },
    });
    const smallAlt = candidate('test/small', {
      contextWindow: 4000,
      bench: {
        registryId: 'test/small', benchSlug: 'small', active: true,
        quality: { intelligence: 95, }, source: 'aa',
      },
    });
    const bigAlt = candidate('test/big', {
      contextWindow: 200000,
      bench: {
        registryId: 'test/big', benchSlug: 'big', active: true,
        quality: { intelligence: 85, }, source: 'aa',
      },
    });
    const decision = pickEscalation(
      [stuck, smallAlt, bigAlt],
      'plan',
      'test/stuck',
      { estimatedContextTokens: 8000 }, // 8000 * 1.2 = 9600 > 4000
    );
    expect(decision?.chosen).toBe('test/big');
  });

  it('retains the vision guard', () => {
    const stuck = candidate('test/stuck', {
      vision: true,
      bench: {
        registryId: 'test/stuck', benchSlug: 'stuck', active: true,
        quality: { intelligence: 70, }, source: 'aa',
      },
    });
    const noVision = candidate('test/no-vision', {
      vision: false,
      bench: {
        registryId: 'test/no-vision', benchSlug: 'no-vision', active: true,
        quality: { intelligence: 95, }, source: 'aa',
      },
    });
    const visionAlt = candidate('test/vision', {
      vision: true,
      bench: {
        registryId: 'test/vision', benchSlug: 'vision', active: true,
        quality: { intelligence: 85, }, source: 'aa',
      },
    });
    const decision = pickEscalation(
      [stuck, noVision, visionAlt],
      'plan',
      'test/stuck',
      { estimatedContextTokens: 0, needsVision: true },
    );
    expect(decision?.chosen).toBe('test/vision');
  });
});

describe('scorer — log-cost normalization', () => {
  it('maps positive geometric steps evenly in log space', () => {
    expect(logCostUtilities([1, 10, 100])).toEqual([1, 0.5, 0]);
  });

  it('returns full utility when every known price is equal', () => {
    expect(logCostUtilities([5, 5, undefined])).toEqual([1, 1, undefined]);
    expect(logCostUtilities([0, 0])).toEqual([1, 1]);
  });

  it('makes free strictly best without sending zero through Math.log', () => {
    const utilities = logCostUtilities([0, 1, 9]);
    expect(utilities[0]).toBe(1);
    expect(utilities[1]).toBeGreaterThan(utilities[2]!);
    expect(utilities[1]).toBeLessThan(1);
    expect(utilities[2]).toBe(0);
  });

  it('excludes unknown and invalid prices instead of treating them as free', () => {
    expect(logCostUtilities([undefined, -1, Number.NaN, 2])).toEqual([
      undefined,
      undefined,
      undefined,
      1,
    ]);
  });

  it('keeps distinct prices finite when their logarithms round equal', () => {
    const utilities = logCostUtilities([999_999.999_999_997, 999_999.999_999_997_1]);
    expect(utilities.every((value) => value != null && Number.isFinite(value))).toBe(true);
    expect(utilities[0]!).toBeGreaterThanOrEqual(utilities[1]!);
  });

  it('is invariant to the price unit scale', () => {
    const base = logCostUtilities([0, 1, 9, 81]);
    const scaled = logCostUtilities([0, 1_000, 9_000, 81_000]);
    scaled.forEach((value, index) => expect(value).toBeCloseTo(base[index]!, 12));
  });
});

describe('scorer — degraded mode (no benchmark data)', () => {
  // Regression: with an empty benchmark store every candidate scored
  // identically, so pickBest degenerated to registry insertion order and
  // routed to whatever model happened to be first (see 421 incident).
  const noBench = (registryId: string, inputPer1M: number, outputPer1M: number) =>
    candidate(registryId, {
      bench: undefined,
      cost: { input: inputPer1M, output: outputPer1M, cacheRead: 0, cacheWrite: 0 },
    });

  const set = [
    noBench('p/expensive', 15, 75),
    noBench('p/mid', 3, 15),
    noBench('p/cheap', 0.5, 2),
  ];

  it('derives a price signal from the registry when bench data is missing', () => {
    // Cost is relative across the candidate set, so an absolute per-candidate
    // score is meaningless; assert the underlying price signal instead.
    expect(blendedPricePer1M(set[0])).toBeGreaterThan(blendedPricePer1M(set[1])!);
    expect(blendedPricePer1M(set[1])).toBeGreaterThan(blendedPricePer1M(set[2])!);
  });

  it('treats a 0/0 price from the registry as genuinely free when benchmark data is present', () => {
    const freeModel = noBench('p/free', 0, 0);
    freeModel.bench = {
      registryId: 'p/free', benchSlug: 'free', active: true,
      quality: { intelligence: 55 },
      source: 'aa',
    };
    expect(blendedPricePer1M(freeModel)).toBe(0);
  });

  it('treats a 0/0 price without benchmark data as unknown (custom-model zero-fill)', () => {
    expect(blendedPricePer1M(noBench('p/unknown-zero', 0, 0))).toBeUndefined();
  });

  it('treats absent cost data as unknown price', () => {
    const c = candidate('p/unknown', {
      bench: undefined,
      cost: undefined,
    });
    expect(blendedPricePer1M(c)).toBeUndefined();
  });

  it('prefers provider registry pricing over benchmark pricing', () => {
    const candidate1 = noBench('p/model', 1, 4);
    candidate1.bench = {
      registryId: 'p/model',
      benchSlug: 'model',
      active: true,
      quality: {},
      priceInputPer1M: 100,
      priceOutputPer1M: 400,
      source: 'benchmark',
    };
    expect(blendedPricePer1M(candidate1)).toBe(3.25);
  });

  it('ranks by registry price when bench data is missing', () => {
    const decision = pickBest(set, 'lightweight', undefined, {
      estimatedContextTokens: 100,
    });
    expect(decision.chosen).toBe('p/cheap');
    // The fallback chain follows registry price: cheapest leads, priciest trails.
    const chain = decision.fallbackChain;
    expect(chain.indexOf('p/cheap')).toBeLessThan(chain.indexOf('p/mid'));
    expect(chain.indexOf('p/mid')).toBeLessThan(chain.indexOf('p/expensive'));
  });

  it('is insensitive to registry insertion order', () => {
    const a = pickBest(set, 'lightweight', undefined, { estimatedContextTokens: 100 });
    const b = pickBest([...set].reverse(), 'lightweight', undefined, {
      estimatedContextTokens: 100,
    });
    expect(a.chosen).toBe(b.chosen);
  });

  it('still prefers benchmarked quality over an unbenchmarked free model', () => {
    const freeUnknown = noBench('p/free-unknown', 0, 0);
    const decision = pickBest([freeUnknown, midModel], 'implement', undefined, {
      estimatedContextTokens: 100,
    });
    expect(decision.chosen).toBe('test/mid');
  });

  it('prefers a benchmarked free model over its identical paid twin on cost-sensitive dimensions', () => {
    const bench = {
      registryId: '', benchSlug: 'model', active: true,
      quality: { intelligence: 55, coding: 69 },
      outputSpeedTps: 107,
      source: 'aa' as const,
    };
    const freeFlash = candidate('zen/deepseek-v4-flash-free', {
      bench: { ...bench, registryId: 'zen/deepseek-v4-flash-free' },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const paidFlash = candidate('go/deepseek-v4-flash', {
      bench: { ...bench, registryId: 'go/deepseek-v4-flash' },
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    });
    // Lightweight: cost weight 0.6 — free should win.
    const lwDecision = pickBest([freeFlash, paidFlash], 'lightweight', undefined, {
      estimatedContextTokens: 100,
    });
    expect(lwDecision.chosen).toBe('zen/deepseek-v4-flash-free');
    expect(lwDecision.fallbackChain.indexOf('zen/deepseek-v4-flash-free')).toBeLessThan(
      lwDecision.fallbackChain.indexOf('go/deepseek-v4-flash'),
    );

    // Implement: quality 0.6, cost 0.3 — tie on quality, free wins on cost.
    const implDecision = pickBest([freeFlash, paidFlash], 'implement', undefined, {
      estimatedContextTokens: 100,
    });
    expect(implDecision.chosen).toBe('zen/deepseek-v4-flash-free');
    expect(implDecision.fallbackChain.indexOf('zen/deepseek-v4-flash-free')).toBeLessThan(
      implDecision.fallbackChain.indexOf('go/deepseek-v4-flash'),
    );
  });
});

describe('scorer — frontier eligibility', () => {
  const frontier = candidate('test/frontier', {
    bench: {
      registryId: 'test/frontier',
      benchSlug: 'frontier',
      active: true,
      quality: { intelligence: 54.8, coding: 74.9, agenticCoding: 44.9 },
      outputSpeedTps: 20,
      source: 'aa',
    },
    cost: { input: 10, output: 30 },
  });

  const freeFlash = candidate('test/deepseek-v4-flash-free', {
    bench: {
      registryId: 'test/deepseek-v4-flash-free',
      benchSlug: 'deepseek-v4-flash-non-reasoning',
      active: true,
      quality: { intelligence: 28.7, coding: 69.1, agenticCoding: 45.7 },
      outputSpeedTps: 106.83,
      source: 'aa',
    },
    cost: { input: 0, output: 0 },
  });

  it('keeps a gather candidate below the intelligence frontier behind it', () => {
    const decision = pickBest([freeFlash, frontier], 'gather', undefined, {
      estimatedContextTokens: 100,
    });
    expect(decision.chosen).toBe('test/frontier');
    expect(decision.fallbackChain.indexOf('test/frontier')).toBeLessThan(
      decision.fallbackChain.indexOf('test/deepseek-v4-flash-free'),
    );
  });

  it.each(['implement', 'review'] as const)(
    'admits a cheaper specialist that clears the %s task axis and sanity floor',
    (dimension) => {
      const decision = pickBest([freeFlash, frontier], dimension, undefined, {
        estimatedContextTokens: 100,
      });
      expect(decision.chosen).toBe('test/deepseek-v4-flash-free');
      expect(decision.fallbackChain.indexOf('test/deepseek-v4-flash-free')).toBeLessThan(
        decision.fallbackChain.indexOf('test/frontier'),
      );
    },
  );

  it('applies the floor to plan before economic weights', () => {
    const planFrontier = candidate('test/plan-frontier', {
      ...frontier,
      registryId: 'test/plan-frontier',
      bench: {
        ...frontier.bench!,
        registryId: 'test/plan-frontier',
        quality: { intelligence: 35 },
      },
    });
    const decision = pickBest(
      [freeFlash, planFrontier],
      'plan',
      { quality: 0.5, cost: 0.5, speed: 0 },
      { estimatedContextTokens: 100 },
    );
    expect(decision.chosen).toBe('test/plan-frontier');
    expect(decision.fallbackChain.indexOf('test/plan-frontier')).toBeLessThan(
      decision.fallbackChain.indexOf('test/deepseek-v4-flash-free'),
    );
  });

  it('still lets a free model win lightweight work', () => {
    const decision = pickBest([freeFlash, frontier], 'lightweight', undefined, {
      estimatedContextTokens: 100,
    });
    expect(decision.chosen).toBe('test/deepseek-v4-flash-free');
  });

  it('keeps missing-quality candidates eligible while demoting known weak candidates', () => {
    const unknown = candidate('test/unknown', {
      bench: undefined,
      cost: undefined,
    });
    const weakKnown = candidate('test/weak-known', {
      ...freeFlash,
      registryId: 'test/weak-known',
      bench: { ...freeFlash.bench!, registryId: 'test/weak-known' },
    });
    const decision = pickBest([weakKnown, unknown, frontier], 'gather', undefined, {
      estimatedContextTokens: 100,
    });
    expect(decision.fallbackChain.indexOf('test/unknown')).toBeLessThan(
      decision.fallbackChain.indexOf('test/weak-known'),
    );
  });

  it('keeps candidates with missing review quality eligible', () => {
    const missingReviewQuality = candidate('test/missing-review-quality', {
      bench: {
        registryId: 'test/missing-review-quality',
        benchSlug: 'missing-review-quality',
        active: true,
        quality: { intelligence: 28.7 },
        source: 'aa',
      },
      cost: undefined,
    });
    const weakKnown = candidate('test/weak-review', {
      bench: {
        registryId: 'test/weak-review',
        benchSlug: 'weak-review',
        active: true,
        quality: { intelligence: 28.7, coding: 50 },
        source: 'aa',
      },
      cost: { input: 0, output: 0 },
    });
    const decision = pickBest(
      [weakKnown, missingReviewQuality, frontier],
      'review',
      undefined,
      { estimatedContextTokens: 100 },
    );
    expect(decision.fallbackChain.indexOf('test/missing-review-quality')).toBeLessThan(
      decision.fallbackChain.indexOf('test/weak-review'),
    );
  });
});

describe('scorer — task-axis eligibility', () => {
  const make = (
    registryId: string,
    quality: { intelligence?: number; coding?: number; agenticCoding?: number; reasoning?: number },
    price: number,
  ) => candidate(registryId, {
    bench: benchRow(registryId, { quality, outputSpeedTps: 50 }),
    cost: { input: price, output: price },
  });

  it('admits an implement specialist that clears task and sanity floors', () => {
    const frontier = make('test/implement-frontier', { intelligence: 100, agenticCoding: 100 }, 20);
    const specialist = make('test/implement-specialist', { intelligence: 50, agenticCoding: 90 }, 1);

    expect(pickBest([frontier, specialist], 'implement').chosen).toBe('test/implement-specialist');
  });

  it('admits a review specialist that clears coding and sanity floors', () => {
    const frontier = make('test/review-frontier', { intelligence: 100, agenticCoding: 100 }, 20);
    const specialist = make('test/review-specialist', { intelligence: 50, coding: 90 }, 1);

    expect(pickBest([frontier, specialist], 'review').chosen).toBe('test/review-specialist');
  });

  it.each(['implement', 'review'] as const)(
    'demotes %s candidates below the general sanity floor',
    (dimension) => {
      const frontier = make(`test/${dimension}-frontier`, { intelligence: 100, coding: 100, agenticCoding: 100 }, 20);
      const belowSanity = make(`test/${dimension}-below-sanity`, { intelligence: 44, coding: 90, agenticCoding: 90 }, 0);

      const decision = pickBest([frontier, belowSanity], dimension);
      expect(decision.fallbackChain.indexOf(frontier.registryId)).toBeLessThan(
        decision.fallbackChain.indexOf(belowSanity.registryId),
      );
    },
  );

  it.each(['gather', 'plan'] as const)('does not apply a general sanity floor to %s', (dimension) => {
    const frontier = make(`test/${dimension}-frontier`, { intelligence: 100, }, 20);
    const lowerTask = make(`test/${dimension}-lower-task`, { intelligence: 50, }, 1);

    expect(pickBest([frontier, lowerTask], dimension).chosen).toBe(frontier.registryId);
  });

  it('keeps lightweight work ungated', () => {
    const frontier = make('test/lightweight-frontier', { intelligence: 100 }, 20);
    const cheap = make('test/lightweight-cheap', { intelligence: 1 }, 0);

    expect(pickBest([frontier, cheap], 'lightweight').chosen).toBe(cheap.registryId);
  });

  it('plan eligibility uses only intelligence, never a second axis on a different scale', () => {
    // Pins redundancy-report G3: quality axes from different benchmark
    // sources (e.g. coding vs intelligence, or different raw scales) must
    // never be blended inside one request-local ratio — a candidate measured
    // only on the other source's scale would silently reset taskMaximum and
    // could demote a frontier model measured only by intelligence. A
    // weak-intelligence, strong-on-another-axis candidate must not outrank
    // or gain eligibility from that other axis.
    const frontier = make('test/plan-frontier', { intelligence: 100 }, 20);
    const reasoningOutlier = make('test/plan-reasoning-outlier', { intelligence: 40, coding: 999 }, 1);

    const decision = pickBest([frontier, reasoningOutlier], 'plan');
    expect(decision.chosen).toBe('test/plan-frontier');
    expect(decision.fallbackChain.indexOf('test/plan-frontier')).toBeLessThan(
      decision.fallbackChain.indexOf('test/plan-reasoning-outlier'),
    );
  });
});

describe('scorer — promotion and tier ordering', () => {
  const make = (
    registryId: string,
    quality: { intelligence?: number; coding?: number; agenticCoding?: number; reasoning?: number },
    price: number | undefined,
  ) => candidate(registryId, {
    bench: benchRow(registryId, { quality, outputSpeedTps: 50 }),
    cost: price == null ? undefined : { input: price, output: price },
  });

  it('promotes a cheap, Pareto-undominated candidate at the economy task floor', () => {
    const frontier = make('test/promotion-frontier', { intelligence: 100 }, 20);
    const promoted = make('test/promotion-candidate', { intelligence: 70 }, 1);

    const decision = pickBest([frontier, promoted], 'gather');

    expect(decision.chosen).toBe('test/promotion-candidate');
    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: 'test/promotion-candidate',
      excludedReason: 'promoted',
    });
  });

  it('never promotes a candidate below an execution contract minimum', () => {
    const frontier = make('test/promotion-frontier', { intelligence: 100, agenticCoding: 100 }, 20);
    const cheap = make('test/promotion-candidate', { intelligence: 75, agenticCoding: 75 }, 1);
    expect(pickBest([frontier, cheap], 'implement').chosen).toBe('test/promotion-candidate');
    const decision = pickBest([frontier, cheap], 'implement', undefined, {
      estimatedContextTokens: 100,
      executionMinimum: 0.80,
    });
    expect(decision.chosen).toBe('test/promotion-frontier');
    expect(decision.candidateDiagnostics).not.toContainEqual(
      expect.objectContaining({ candidateKey: 'test/promotion-candidate', excludedReason: 'promoted' }),
    );
  });

  it('does not promote a candidate whose quality was estimated rather than measured', () => {
    // Same shape as the promotion case above, but the cheap candidate's
    // quality is an estimate. Promotion relaxes the capability floor on
    // economic grounds; stacking that on inferred capability would let a
    // variant win on evidence that was never observed.
    const frontier = make('test/estimated-frontier', { intelligence: 100 }, 20);
    const estimated = candidate('test/estimated-candidate', {
      bench: benchRow('test/estimated-candidate', {
        quality: { intelligence: 70 },
        outputSpeedTps: 50,
        qualityEstimated: true,
      }),
      cost: { input: 1, output: 1 },
    });

    const decision = pickBest([frontier, estimated], 'gather');

    expect(decision.chosen).toBe('test/estimated-frontier');
    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: 'test/estimated-candidate',
      excludedReason: 'below-task-floor',
    });
  });

  it('does not promote below-economy candidates, dominated candidates, or plan work', () => {
    const frontier = make('test/no-promotion-frontier', { intelligence: 100 }, 20);
    const belowEconomy = make('test/no-promotion-below-economy', { intelligence: 69 }, 0);
    const dominated = make('test/no-promotion-dominated', { intelligence: 70 }, 1);
    const cheaperPeer = make('test/no-promotion-cheaper-peer', { intelligence: 70 }, 0.5);

    expect(pickBest([frontier, belowEconomy], 'gather').chosen).toBe(frontier.registryId);
    expect(pickBest([frontier, dominated, cheaperPeer], 'gather').chosen).toBe(cheaperPeer.registryId);
    const planFrontier = make('test/no-promotion-plan-frontier', { intelligence: 100, }, 20);
    const planCandidate = make('test/no-promotion-plan-candidate', { intelligence: 70, }, 1);
    expect(pickBest([planFrontier, planCandidate], 'plan').chosen).toBe(planFrontier.registryId);
  });

  it('does not promote a near-frontier candidate without a fourfold price advantage', () => {
    const frontier = make('test/price-frontier', { intelligence: 100 }, 20);
    const insufficientDiscount = make('test/price-insufficient-discount', { intelligence: 70 }, 6);

    expect(pickBest([frontier, insufficientDiscount], 'gather').chosen).toBe(frontier.registryId);
  });

  it.each(['implement', 'review'] as const)(
    'does not promote %s candidates below the sanity floor',
    (dimension) => {
      const frontier = make(`test/${dimension}-promotion-frontier`, {
        intelligence: 100,
        coding: 100,
        agenticCoding: 100,
      }, 20);
      const belowSanity = make(`test/${dimension}-promotion-below-sanity`, {
        intelligence: 44,
        coding: 90,
        agenticCoding: 90,
      }, 1);

      const decision = pickBest([frontier, belowSanity], dimension);
      expect(decision.chosen).toBe(frontier.registryId);
      expect(decision.candidateDiagnostics).toContainEqual({
        candidateKey: belowSanity.registryId,
        excludedReason: 'below-sanity-floor',
      });
    },
  );

  it('orders known eligible candidates before unknown quality and measured weak candidates', () => {
    const frontier = make('test/tier-frontier', { intelligence: 100 }, 20);
    const unknown = candidate('test/tier-unknown', {
      bench: undefined,
      cost: { input: 0, output: 0 },
    });
    const weak = make('test/tier-weak', { intelligence: 60 }, 0);

    const decision = pickBest([weak, unknown, frontier], 'gather');

    expect(decision.fallbackChain).toEqual([
      'test/tier-frontier',
      'test/tier-unknown',
      'test/tier-weak',
    ]);
    expect(decision.candidateDiagnostics).toEqual(expect.arrayContaining([
      { candidateKey: 'test/tier-unknown', excludedReason: 'unknown-quality' },
      { candidateKey: 'test/tier-weak', excludedReason: 'below-task-floor' },
    ]));
  });
  it('promotes every below-floor candidate that clears the economy ratio at a 4x price discount, never on plan', () => {
    // Relational shape of the promotion set — not a snapshot of live-store
    // measurements: a tier-2 candidate earns tier 0 when its task ratio
    // clears ECONOMY_QUALITY_RATIO (0.7), its sanity is satisfied, and it is
    // at least PROMOTION_PRICE_DIVISOR (4x) cheaper than the cheapest
    // eligible candidate. Ratios are expressed directly so a benchmark
    // re-sync cannot silently change what this test asserts.
    const frontier = make('test/promotion-set-frontier', { intelligence: 100, agenticCoding: 100 }, 8);
    const cheapImplement = make('test/promotion-set-cheap-implement', { intelligence: 100, agenticCoding: 84 }, 0.25);
    const cheapGather = make('test/promotion-set-cheap-gather', { intelligence: 72 }, 1);
    const cheaperGather = make('test/promotion-set-cheaper-gather', { intelligence: 74 }, 2);

    // implement: task ratio 0.84 stays below the 0.85 task floor (tier 2) but
    // clears the 0.7 economy floor; the 4x discount and satisfied sanity
    // (intelligence 100) earn the relaxed judgment.
    const implement = pickBest([frontier, cheapImplement], 'implement');
    expect(implement.chosen).toBe(cheapImplement.registryId);
    expect(implement.candidateDiagnostics).toContainEqual({
      candidateKey: cheapImplement.registryId,
      excludedReason: 'promoted',
    });

    // gather: every candidate clearing 0.7 at a 4x discount is promoted —
    // each is independently undominated (neither cheap model undercuts the
    // other on both task axis and price).
    const gather = pickBest([frontier, cheapGather, cheaperGather], 'gather');
    expect(gather.candidateDiagnostics).toEqual(expect.arrayContaining([
      { candidateKey: cheapGather.registryId, excludedReason: 'promoted' },
      { candidateKey: cheaperGather.registryId, excludedReason: 'promoted' },
    ]));

    // plan: the promotion loop never runs for plan — the frontier stays the
    // pick and no candidate is relaxed upward.
    const plan = pickBest([frontier, cheapGather, cheaperGather], 'plan');
    expect(plan.chosen).toBe(frontier.registryId);
    expect(plan.candidateDiagnostics).not.toContainEqual({
      candidateKey: cheapGather.registryId,
      excludedReason: 'promoted',
    });
  });

  it('promotes every provider copy of a promotable benchmark row', () => {
    // Two candidates at different providers that share the same benchSlug
    // (same measured model).  The Pareto check must treat them as substitutes,
    // not competitors: promoting only the cheapest copy pushes the identical
    // model on the other provider below unknown-quality candidates in the
    // fallback chain, defeating the purpose of a cheap-and-capable finding.
    const sharedSlug = 'shared-model';
    const frontier = candidate('test/frontier', {
      bench: { registryId: 'test/frontier', benchSlug: 'frontier', active: true,
        quality: { intelligence: 100, agenticCoding: 100 }, source: 'test' },
      cost: { input: 20, output: 20 },
    });
    const freeCopy = candidate('cheap/model-free', {
      bench: { registryId: 'cheap/model-free', benchSlug: sharedSlug, active: true,
        quality: { intelligence: 50, agenticCoding: 70 }, source: 'test' },
      cost: { input: 0, output: 0 },
    });
    const paidCopy = candidate('other/model', {
      bench: { registryId: 'other/model', benchSlug: sharedSlug, active: true,
        quality: { intelligence: 50, agenticCoding: 70 }, source: 'test' },
      cost: { input: 1, output: 1 },
    });

    const decision = pickBest([frontier, freeCopy, paidCopy], 'implement');
    const reasons = new Map(
      (decision.candidateDiagnostics ?? []).map((d) => [d.candidateKey, d.excludedReason]),
    );
    expect(reasons.get('cheap/model-free')).toBe('promoted');
    expect(reasons.get('other/model')).toBe('promoted');
  });

  it('still Pareto-dominates a genuinely different cheaper model', () => {
    // When the cheaper peer has a DIFFERENT benchSlug it is genuinely
    // different hardware, not just a different provider — it should still
    // dominate.  (Contract test: the substitute exemption must not weaken
    // ordinary Pareto dominance.)
    const frontier = candidate('test/frontier', {
      bench: { registryId: 'test/frontier', benchSlug: 'frontier', active: true,
        quality: { intelligence: 100, agenticCoding: 100 }, source: 'test' },
      cost: { input: 20, output: 20 },
    });
    const dominated = candidate('test/dominated', {
      bench: { registryId: 'test/dominated', benchSlug: 'dominated', active: true,
        quality: { intelligence: 70, agenticCoding: 70 }, source: 'test' },
      cost: { input: 1, output: 1 },
    });
    const cheaperPeer = candidate('test/cheaper-peer', {
      bench: { registryId: 'test/cheaper-peer', benchSlug: 'cheaper-peer', active: true,
        quality: { intelligence: 70, agenticCoding: 70 }, source: 'test' },
      cost: { input: 0.5, output: 0.5 },
    });

    const decision = pickBest([frontier, dominated, cheaperPeer], 'implement');
    // The dominated model should NOT be promoted — the cheaper-peer reaches
    // the same task axis at a lower price and has a different benchSlug, so
    // it is a genuine dominator.
    const reasons = new Map(
      (decision.candidateDiagnostics ?? []).map((d) => [d.candidateKey, d.excludedReason]),
    );
    expect(reasons.get('test/cheaper-peer')).toBe('promoted');
    // dominated is NOT promoted: cheaperPeer dominates it at same task axis
    // with a lower price.
    expect(reasons.get('test/dominated')).not.toBe('promoted');
  });

  it('pins the general-sanity boundary for implement at a fixed task axis', () => {
    // Isolates the SANITY_QUALITY_RATIO (0.45) boundary: both candidates share
    // the same task axis (0.86, above the 0.85 task floor), so the only
    // difference is intelligence crossing the sanity floor. Direct ratios,
    // not transcribed live-store measurements.
    const frontier = make('test/sanity-boundary-frontier', { intelligence: 100, agenticCoding: 100 }, 8);
    const clears = make('test/sanity-boundary-clears', { intelligence: 46, agenticCoding: 86 }, 0.25);
    const fails = make('test/sanity-boundary-fails', { intelligence: 44, agenticCoding: 86 }, 0.25);

    const clearsDecision = pickBest([frontier, clears], 'implement');
    expect(clearsDecision.chosen).toBe(clears.registryId);
    expect(clearsDecision.candidateDiagnostics ?? []).not.toContainEqual({
      candidateKey: clears.registryId,
      excludedReason: 'below-sanity-floor',
    });

    expect(pickBest([frontier, fails], 'implement').candidateDiagnostics).toContainEqual({
      candidateKey: fails.registryId,
      excludedReason: 'below-sanity-floor',
    });
  });

  it('does not move a measured weak review candidate ahead of unknown-quality fallbacks', () => {
    const unknown = candidate('test/review-unknown', {
      bench: undefined,
      cost: { input: 0, output: 0 },
    });
    const missingReviewAxis = candidate('test/review-missing-axis', {
      bench: {
        registryId: 'test/review-missing-axis',
        benchSlug: 'review-missing-axis',
        active: true,
        quality: { intelligence: 100 },
        source: 'test',
      },
      cost: { input: 1, output: 1 },
    });
    const belowSanity = make('test/review-below-sanity', { intelligence: 44, coding: 100 }, 2);

    const decision = pickBest([unknown, missingReviewAxis, belowSanity], 'review');

    expect(decision.fallbackChain.indexOf('test/review-unknown')).toBeLessThan(
      decision.fallbackChain.indexOf('test/review-below-sanity'),
    );
    expect(decision.fallbackChain.indexOf('test/review-missing-axis')).toBeLessThan(
      decision.fallbackChain.indexOf('test/review-below-sanity'),
    );
    expect(decision.chosen).not.toBe('test/review-below-sanity');
  });
});

describe('scorer — relative quality (economy calculation core)', () => {
  const q = (
    registryId: string,
    quality: { intelligence?: number; coding?: number; agenticCoding?: number; reasoning?: number },
    overrides: Partial<Candidate> = {},
  ) =>
    candidate(registryId, {
      bench: benchRow(registryId, { quality, outputSpeedTps: 50 }),
      cost: { input: 1, output: 1 },
      ...overrides,
    });

  it('normalizes each axis against the request-local maximum', () => {
    const strong = q('test/strong', { intelligence: 100, agenticCoding: 100 });
    const lopsided = q('test/lopsided', { intelligence: 50, agenticCoding: 100 });

    const relative = relativeQualities([strong, lopsided], 'implement');

    expect(relative.get('test/strong')).toEqual({
      taskRatio: 1,
      generalRatio: 1,
      bottleneck: 1,
      mean: 1,
    });
    expect(relative.get('test/lopsided')).toEqual({
      taskRatio: 1,
      generalRatio: 0.5,
      bottleneck: 0.5,
      mean: 0.75,
    });
  });

  it('is request-local: the same candidate rescales against a different peer set', () => {
    const mid = q('test/mid-axis', { intelligence: 50, agenticCoding: 50 });
    const strong = q('test/strong', { intelligence: 100, agenticCoding: 100 });

    expect(relativeQualities([mid], 'implement').get('test/mid-axis')).toEqual({
      taskRatio: 1,
      generalRatio: 1,
      bottleneck: 1,
      mean: 1,
    });
    expect(relativeQualities([mid, strong], 'implement').get('test/mid-axis')).toEqual({
      taskRatio: 0.5,
      generalRatio: 0.5,
      bottleneck: 0.5,
      mean: 0.5,
    });
  });

  it('retains task evidence when a hard-dimension sanity axis is missing', () => {
    const known = q('test/known', { intelligence: 80, agenticCoding: 80 });
    const missingGeneral = candidate('test/missing-general', {
      bench: benchRow('test/missing-general', {
        quality: { agenticCoding: 80, intelligence: undefined },
      }),
    });
    const noBench = candidate('test/no-bench', { bench: undefined });

    const relative = relativeQualities([known, missingGeneral, noBench], 'implement');

    expect(relative.has('test/known')).toBe(true);
    expect(relative.get('test/missing-general')).toMatchObject({ taskRatio: 1 });
    expect(relative.get('test/missing-general')?.generalRatio).toBeUndefined();
    expect(relative.has('test/no-bench')).toBe(false);
  });

  it('projects lightweight onto the intelligence axis so the policy owns the floor', () => {
    const a = q('test/a-light', { intelligence: 40 });
    const b = q('test/b-light', { intelligence: 80 });

    const relative = relativeQualities([a, b], 'lightweight');

    expect(relative.get('test/a-light')).toEqual({ taskRatio: 0.5, bottleneck: 0.5, mean: 0.5 });
    expect(relative.get('test/b-light')).toEqual({ taskRatio: 1, bottleneck: 1, mean: 1 });
  });

  it('breaks weighted-score ties by bottleneck before registry id', () => {
    // Equal agenticCoding → equal qualityComponent; equal price/speed → equal
    // cost/speed components. Only the general axis differs, so the weighted
    // score ties and the relative-quality bottleneck must decide.
    const weakGeneral = q('test/aaa-weak-general', { intelligence: 90, agenticCoding: 100 });
    const strongGeneral = q('test/zzz-strong-general', { intelligence: 100, agenticCoding: 100 });

    const decision = pickBest([weakGeneral, strongGeneral], 'implement', undefined, {
      estimatedContextTokens: 100,
    });

    expect(decision.fallbackChain.indexOf('test/zzz-strong-general')).toBeLessThan(
      decision.fallbackChain.indexOf('test/aaa-weak-general'),
    );
  });
});

describe('scorer — AA-Omniscience reliability floor', () => {
  const make = (
    registryId: string,
    quality: NonNullable<Candidate['bench']>['quality'],
    price: number,
  ) => candidate(registryId, {
    bench: benchRow(registryId, { quality, outputSpeedTps: 50 }),
    cost: { input: price, output: price },
  });

  const reliable = make(
    'test/reliable',
    { intelligence: 100, coding: 100, agenticCoding: 100, knowledge: 15.3 },
    8,
  );
  const unreliable = make(
    'test/unreliable',
    { intelligence: 99, coding: 99, agenticCoding: 99, knowledge: -11.2 },
    0.01,
  );

  it.each(['plan', 'review'] as const)(
    'uses the index zero crossing as the %s reliability floor',
    (dimension) => {
      const decision = pickBest([reliable, unreliable], dimension);

      expect(decision.chosen).toBe(reliable.registryId);
      expect(decision.candidateDiagnostics).toContainEqual({
        candidateKey: unreliable.registryId,
        excludedReason: 'below-knowledge-floor',
      });
      expect(decision.fallbackChain).toContain(unreliable.registryId);
    },
  );

  it('keeps missing knowledge ahead of measured negative reliability', () => {
    const unknown = make(
      'test/knowledge-unknown',
      { intelligence: 98, coding: 98, agenticCoding: 98 },
      0.005,
    );
    const decision = pickBest([reliable, unknown, unreliable], 'review');

    expect(decision.fallbackChain.indexOf(unknown.registryId)).toBeLessThan(
      decision.fallbackChain.indexOf(unreliable.registryId),
    );
    expect(decision.candidateDiagnostics).toEqual(expect.arrayContaining([
      { candidateKey: unknown.registryId, excludedReason: 'unknown-quality' },
      { candidateKey: unreliable.registryId, excludedReason: 'below-knowledge-floor' },
    ]));
  });

  it('keeps measured negative knowledge weak when the task axis is missing', () => {
    const negativeOnly = candidate('test/negative-only', {
      bench: {
        ...benchRow('test/negative-only'),
        quality: { knowledge: -11.2 },
      },
      cost: { input: 0.001, output: 0.001 },
    });
    const decision = pickBest([reliable, negativeOnly], 'plan');

    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: negativeOnly.registryId,
      excludedReason: 'below-knowledge-floor',
    });
  });

  it('retains effective-effort evidence when the measured sibling is filtered out', () => {
    const low = candidate('test/effort-bypass', {
      effort: 'low',
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', max: 'max' },
      knowledgeByEffort: { medium: -11.2 },
      bench: benchRow('test/effort-bypass', {
        effort: 'low',
        benchSlug: 'effort-bypass-low',
        quality: { intelligence: 99 },
      }),
      cost: { input: 0.001, output: 0.001 },
    });
    // The medium sibling is absent, as it would be after an effort-specific
    // blacklist, but plan still clamps this low entry to medium at delegation.
    const decision = pickBest([reliable, low], 'plan');

    expect(decision.chosen).toBe(reliable.registryId);
    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: 'test/effort-bypass:low',
      excludedReason: 'below-knowledge-floor',
    });
  });

  it('does not reuse nominal knowledge for an unmeasured higher effective effort', () => {
    const low = candidate('test/effort-unknown-medium', {
      effort: 'low',
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', max: 'max' },
      bench: benchRow('test/effort-unknown-medium', {
        effort: 'low',
        quality: { intelligence: 99, knowledge: 15.3 },
      }),
      cost: { input: 0.001, output: 0.001 },
    });
    // The low row's nominal knowledge cannot stand in for the unmeasured
    // medium level that plan will actually serve via the floor.
    const decision = pickBest([reliable, low], 'plan');

    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: 'test/effort-unknown-medium:low',
      excludedReason: 'unknown-quality',
    });
  });

  it('uses model-wide knowledge for a fixed reasoning mode without effort controls', () => {
    const fixed = candidate('test/fixed-reasoning', {
      reasoning: true,
      bench: benchRow('test/fixed-reasoning', {
        quality: { intelligence: 99, knowledge: -10.7 },
      }),
      cost: { input: 0.001, output: 0.001 },
    });
    const decision = pickBest([reliable, fixed], 'plan');

    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: fixed.registryId,
      excludedReason: 'below-knowledge-floor',
    });
  });

  it('leaves ordinary bounded implementation ungated', () => {
    const decision = pickBest([reliable, unreliable], 'implement');

    expect(decision.chosen).toBe(unreliable.registryId);
    expect(decision.candidateDiagnostics ?? []).not.toContainEqual({
      candidateKey: unreliable.registryId,
      excludedReason: 'below-knowledge-floor',
    });
  });

  it('blocks negative reliability from compound terminal and inspect promotion', () => {
    const policy: MultiWorkScoringPolicy = {
      terminal: {
        kind: 'implement',
        complexity: 'moderate',
        scope: 'bounded',
        compound: true,
        confidence: 'high',
        discountEligible: false,
      },
      terminalRequirement: 0.85,
      terminalBand: 'standard',
      phase: 'inspect',
      phaseReason: 'test',
      terminalFloor: 0.85,
      inspectFloor: 0.70,
      providerInvocation: 0,
    };
    const decision = pickBest([reliable, unreliable], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: policy,
    });

    expect(decision.chosen).toBe(reliable.registryId);
    expect(decision.candidateDiagnostics).toContainEqual({
      candidateKey: unreliable.registryId,
      excludedReason: 'below-knowledge-floor',
    });
    expect(decision.multiWork?.candidateCapability[unreliable.registryId]).toEqual({
      taskRatio: 0.99,
      clearsTerminalFloor: false,
      viaInspectPromotion: false,
    });

    const negativeOnly = candidate('test/compound-negative-only', {
      bench: {
        ...benchRow('test/compound-negative-only'),
        quality: { knowledge: -11.2 },
      },
      cost: { input: 0.001, output: 0.001 },
    });
    const missingTask = pickBest([reliable, negativeOnly], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: policy,
    });
    expect(missingTask.multiWork?.candidateCapability[negativeOnly.registryId]).toEqual({
      clearsTerminalFloor: false,
      viaInspectPromotion: false,
    });
  });
});

describe('scorer — multiWorkPolicy request-local floors', () => {
  const frontierInspectPolicy: MultiWorkScoringPolicy = {
    terminal: {
      kind: 'implement',
      complexity: 'moderate',
      scope: 'bounded',
      compound: true,
      confidence: 'high',
      discountEligible: true,
    },
    terminalRequirement: 0.85,
    terminalBand: 'standard',
    phase: 'inspect',
    phaseReason: 'test-inspect',
    terminalFloor: 0.85,
    inspectFloor: 0.70,
    providerInvocation: 1,
  };

  const frontier = candidate('test/mw-frontier', {
    bench: benchRow('test/mw-frontier', { quality: { intelligence: 90, agenticCoding: 100 } }),
    cost: { input: 10, output: 50 },
  });
  const inspectCheap = candidate('test/mw-inspect-cheap', {
    bench: benchRow('test/mw-inspect-cheap', { quality: { intelligence: 80, agenticCoding: 70 } }),
    cost: { input: 2, output: 8 },
  });
  const belowInspect = candidate('test/mw-below-inspect', {
    bench: benchRow('test/mw-below-inspect', { quality: { intelligence: 70, agenticCoding: 50 } }),
    cost: { input: 1, output: 2 },
  });
  const unknown = candidate('test/mw-unknown', { bench: undefined });

  it('promotes only the economically justified inspect-band candidate', () => {
    const decision = pickBest([frontier, inspectCheap, belowInspect], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: frontierInspectPolicy,
    });
    // Once promoted, the inspect candidate competes in tier 0 and its large
    // economic advantage earns the bounded cheap-first opening.
    expect(decision.chosen).toBe(inspectCheap.registryId);
    expect(decision.multiWork?.candidateCapability[inspectCheap.registryId]).toEqual({
      taskRatio: 0.70,
      clearsTerminalFloor: false,
      viaInspectPromotion: true,
    });
    expect(decision.fallbackChain).toEqual(expect.arrayContaining([
      frontier.registryId,
      inspectCheap.registryId,
      belowInspect.registryId,
    ]));
  });

  it('removes inspect promotion in mutate while preserving the full chain', () => {
    const decision = pickBest([frontier, inspectCheap], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: { ...frontierInspectPolicy, phase: 'mutate', inspectFloor: 0.85 },
    });
    expect(decision.chosen).toBe(frontier.registryId);
    expect(decision.fallbackChain).toContain(inspectCheap.registryId);
    expect(decision.multiWork?.candidateCapability[inspectCheap.registryId]?.viaInspectPromotion).toBe(false);
  });

  it('never grants inspect promotion to unknown quality', () => {
    const decision = pickBest([frontier, unknown], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: frontierInspectPolicy,
    });
    expect(decision.multiWork?.candidateCapability[unknown.registryId]).toEqual({
      clearsTerminalFloor: 'unknown',
      viaInspectPromotion: false,
    });
  });

  it('attaches multiWork.terminalCapableInScoringSet and leaves no policy identical to the current live path', () => {
    const withoutPolicy = pickBest([frontier, inspectCheap, belowInspect], 'implement', undefined, {
      estimatedContextTokens: 100,
    });
    const withUndefinedPolicy = pickBest([frontier, inspectCheap, belowInspect], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: undefined,
    });
    expect(withoutPolicy).toEqual(withUndefinedPolicy);
    expect(withoutPolicy.multiWork).toBeUndefined();

    const withPolicy = pickBest([frontier, inspectCheap, belowInspect], 'implement', undefined, {
      estimatedContextTokens: 100,
      multiWorkPolicy: frontierInspectPolicy,
    });
    expect(withPolicy.multiWork?.terminalCapableInScoringSet).toBe(true);
  });
});

describe('isStrictlyStrongerCandidate', () => {
  const weak = candidate('test/weak', {
    bench: benchRow('test/weak', { quality: { intelligence: 60, coding: 60, agenticCoding: 60 } }),
  });
  const strong = candidate('test/strong', {
    bench: benchRow('test/strong', { quality: { intelligence: 90, coding: 90, agenticCoding: 90 } }),
  });

  it('resolves an unsuffixed source against an effective served effort', () => {
    const source = findSourceCandidate([weak, strong], 'test/weak:medium');
    expect(source?.registryId).toBe('test/weak');
    expect(isStrictlyStrongerCandidate(strong, 'test/weak:medium', 'implement', source)).toBe(true);
  });

  it('fails closed when the source is missing', () => {
    expect(isStrictlyStrongerCandidate(strong, 'test/missing:medium', 'implement', undefined)).toBe(false);
  });

  it('fails closed on estimated quality on either side', () => {
    const estimatedDest = candidate('test/guess', {
      bench: { ...benchRow('test/guess', { quality: { intelligence: 99 } }), qualityEstimated: true },
    });
    const estimatedSource = candidate('test/weak', {
      bench: { ...benchRow('test/weak', { quality: { intelligence: 60 } }), qualityEstimated: true },
    });
    expect(isStrictlyStrongerCandidate(estimatedDest, 'test/weak', 'implement', weak)).toBe(false);
    expect(isStrictlyStrongerCandidate(strong, 'test/weak', 'implement', estimatedSource)).toBe(false);
  });

  it('rejects a weaker measured destination', () => {
    expect(isStrictlyStrongerCandidate(weak, 'test/strong', 'implement', strong)).toBe(false);
  });

  it('accepts same-model higher effort and rejects equal effort', () => {
    const medium = candidate('test/model', { effort: 'medium', bench: benchRow('test/model') });
    const high = candidate('test/model', { effort: 'high', bench: benchRow('test/model') });
    expect(isStrictlyStrongerCandidate(high, 'test/model:medium', 'implement', medium)).toBe(true);
    expect(isStrictlyStrongerCandidate(medium, 'test/model:medium', 'implement', medium)).toBe(false);
  });

  it('compares the effort that will actually serve, not the labelled destination effort', () => {
    const medium = candidate('test/model', {
      effort: 'medium',
      reasoning: true,
      bench: benchRow('test/model', { effort: 'medium', quality: { intelligence: 70, coding: 70, agenticCoding: 70 } }),
    });
    const high = candidate('test/model', {
      effort: 'high',
      reasoning: true,
      bench: benchRow('test/model', { effort: 'high', quality: { intelligence: 90, coding: 90, agenticCoding: 90 } }),
    });
    expect(isStrictlyStrongerCandidate(high, 'test/model:medium', 'implement', medium, {
      userReasoning: 'medium',
      userReasoningOverride: true,
      candidates: [medium, high],
    })).toBe(false);

    const source = candidate('test/weak', {
      effort: 'medium',
      reasoning: true,
      bench: benchRow('test/weak', { effort: 'medium', quality: { intelligence: 60, coding: 60, agenticCoding: 60 } }),
    });
    const destHigh = candidate('test/strong', {
      effort: 'high',
      reasoning: true,
      bench: benchRow('test/strong', { effort: 'high', quality: { intelligence: 95, coding: 95, agenticCoding: 95 } }),
    });
    const destMedium = candidate('test/strong', {
      effort: 'medium',
      reasoning: true,
      bench: benchRow('test/strong', { effort: 'medium', quality: { intelligence: 55, coding: 55, agenticCoding: 55 } }),
    });
    expect(isStrictlyStrongerCandidate(destHigh, 'test/weak:medium', 'implement', source, {
      userReasoning: 'medium',
      userReasoningOverride: true,
      candidates: [source, destHigh, destMedium],
    })).toBe(false);
  });

  it('does not treat a labelled-high destination as stronger when that effort cannot serve', () => {
    const source = candidate('test/weak', {
      effort: 'medium',
      reasoning: true,
      bench: benchRow('test/weak', { effort: 'medium', quality: { intelligence: 60, coding: 60, agenticCoding: 60 } }),
    });
    const dest = candidate('test/strong', {
      effort: 'high',
      reasoning: true,
      thinkingLevelMap: {
        minimal: 'low',
        low: 'low',
        medium: 'medium',
        high: null,
        xhigh: null,
        max: null,
      },
      bench: benchRow('test/strong', { effort: 'high', quality: { intelligence: 95, coding: 95, agenticCoding: 95 } }),
    });
    expect(servedEffort(dest, 'implement')).toBeUndefined();
    expect(isStrictlyStrongerCandidate(dest, 'test/weak:medium', 'implement', source, {
      candidates: [source, dest],
    })).toBe(false);
  });

  it('does not use a different effort variant as the source measurement', () => {
    const low = candidate('test/model', {
      effort: 'low',
      bench: benchRow('test/model', { effort: 'low', quality: { intelligence: 40 } }),
    });
    const high = candidate('test/model', {
      effort: 'high',
      bench: benchRow('test/model', { effort: 'high', quality: { intelligence: 90 } }),
    });
    expect(findSourceCandidate([low, high], 'test/model:medium')).toBeUndefined();
  });
});
