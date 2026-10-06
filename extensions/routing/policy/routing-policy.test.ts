import { describe, it, expect } from 'vitest';
import {
  resolveRoutingDecision,
  resolveRoutingDecisionForEvaluation,
  POLICY_PASSIVE_CAUSES,
  scoredIncumbentKey,
  type RoutingPolicyInput,
} from './routing-policy.js';
import type { Candidate } from '../../types.js';
import type { PendingTrajectoryEscalation } from '../struggle/types.js';
import { DEFAULT_DIMENSION_WEIGHTS } from '../../constants.js';
import { renderScoredReason } from '../score/decision-reason.js';
import { candidate, benchRow } from '../../test-support/router-fixtures.js';
import { evaluationPolicyVersion } from './policy-version.js';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    registryId: 'test/model-a',
    provider: 'test',
    id: 'model-a',
    contextWindow: 200_000,
    vision: false,
    reasoning: false,
    available: true,
    ...overrides,
  };
}

// Registry-only: no bench data
const registryOnlyCandidates: Candidate[] = [
  makeCandidate({ registryId: 'test/alpha', provider: 'test', id: 'alpha' }),
  makeCandidate({ registryId: 'test/beta', provider: 'test', id: 'beta' }),
];

// Benchmark candidates: with quality data so scoring exercises real paths
const strongPaid = makeCandidate({
  registryId: 'bench/strong-paid',
  provider: 'bench',
  id: 'strong-paid',
  cost: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 },
  bench: {
    registryId: 'bench/strong-paid',
    benchSlug: 'strong-paid',
    active: true,
    quality: { intelligence: 100, coding: 100, agenticCoding: 100, },
    source: 'aa',
  },
});

const adequateFree = makeCandidate({
  registryId: 'bench/adequate-free',
  provider: 'bench',
  id: 'adequate-free',
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  bench: {
    registryId: 'bench/adequate-free',
    benchSlug: 'adequate-free',
    active: true,
    quality: { intelligence: 90, coding: 90, agenticCoding: 90, },
    source: 'aa',
  },
});

const benchmarkCandidates: Candidate[] = [
  makeCandidate({
    registryId: 'bench/cheap',
    provider: 'bench',
    id: 'cheap',
    bench: {
      registryId: 'bench/cheap',
      benchSlug: 'cheap',
      active: true,
      quality: { intelligence: 30, coding: 60, agenticCoding: 30, knowledge: 10, research: 0.4 },
      priceInputPer1M: 0.5,
      priceOutputPer1M: 2.0,
      source: 'aa',
    },
  }),
  makeCandidate({
    registryId: 'bench/strong',
    provider: 'bench',
    id: 'strong',
    bench: {
      registryId: 'bench/strong',
      benchSlug: 'strong',
      active: true,
      quality: { intelligence: 55, coding: 78, agenticCoding: 50, knowledge: 30, research: 0.6 },
      priceInputPer1M: 15.0,
      priceOutputPer1M: 75.0,
      source: 'aa',
    },
  }),
];

function makePolicyConfig(
  overrides: Partial<RoutingPolicyInput['config']> = {},
): RoutingPolicyInput['config'] {
  return {
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    switchMargin: 0.15,
    ...overrides,
  };
}

function makePolicyInput(overrides: Partial<RoutingPolicyInput> = {}): RoutingPolicyInput {
  return {
    candidates: registryOnlyCandidates,
    baseDimension: 'gather',
    baseCause: 'heuristic',
    estimatedContextTokens: 1_000,
    needsVision: false,
    config: makePolicyConfig(),
    ...overrides,
  };
}

// ─── Cause precedence table ──────────────────────────────────────────

describe('resolveRoutingDecision', () => {
  it.each([
    [-10, 0.38, 'p/suitable'],
    [10, undefined, 'p/incumbent'],
  ] as const)('keeps uncertain incumbent strength but not a measured minimum failure: %s, %s', (knowledge, research, expected) => {
    const incumbent = candidate('p/incumbent', { bench: {
      ...benchRow('incumbent'), quality: { intelligence: 40, knowledge, research },
    } });
    const suitable = candidate('p/suitable', { bench: {
      ...benchRow('suitable'), quality: { intelligence: 35, knowledge: 10, research: 0.5 },
    } });
    const { decision } = resolveRoutingDecision(makePolicyInput({
      candidates: [incumbent, suitable], baseDimension: 'plan', incumbentRegistryId: 'p/incumbent',
    }));
    expect(decision.chosen).toBe(expected);
    expect(new Set(decision.fallbackChain)).toEqual(new Set(['p/suitable', 'p/incumbent']));
  });

  it('renders typed policy details without changing the logged reason format', () => {
    const { decision } = resolveRoutingDecision(makePolicyInput({
      estimatedContextTokens: 150_000,
    }));
    expect(decision.contextPressure).toBeDefined();
    expect(decision.scoredReason?.details.map((detail) => detail.kind)).toEqual([
      'context-pressure', 'no-data',
    ]);
    expect(decision.reason).toBe(renderScoredReason(decision.scoredReason!));
    expect(decision.reason).toContain('[context nearly full: prefer a fresh planner subagent] [no benchmark quality data]');
  });

  describe('cause precedence', () => {
    it.each([
      {
        name: 'continuation context remains the primary cause',
        input: {
          baseCause: 'continuation-context' as const,
          baseDimension: 'implement' as const,
          estimatedContextTokens: 100_000,
          candidates: registryOnlyCandidates,
        },
        expectedCause: 'continuation-context',
        expectedDimension: 'implement',
      },
      {
        name: 'a deep context never changes the routed task type',
        input: {
          baseCause: 'heuristic' as const,
          baseDimension: 'gather' as const,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 150_000,
        },
        expectedCause: 'heuristic',
        expectedDimension: 'gather',
      },
      {
        name: 'a deep context never raises a lightweight entry',
        input: {
          baseCause: 'heuristic' as const,
          baseDimension: 'lightweight' as const,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 150_000,
        },
        expectedCause: 'heuristic',
        expectedDimension: 'lightweight',
      },
    ])('$name', ({ input, expectedCause, expectedDimension }) => {
      const result = resolveRoutingDecision(makePolicyInput(input));
      expect(result.decision).toMatchObject({
        cause: expectedCause,
        dimension: expectedDimension,
      });
    });
  });

  it('uses no-data cause when no candidate has benchmark data and heuristic owns the decision', () => {
    const result = resolveRoutingDecision(makePolicyInput({
      baseCause: 'heuristic',
      baseDimension: 'gather',
      candidates: registryOnlyCandidates,
      estimatedContextTokens: 1_000,
    }));

    expect(result.decision.cause).toBe('no-data');
    expect(result.decision.reason).toContain('[no benchmark quality data]');
  });

  it('does not let no-data override stronger causes', () => {
    const continuation = resolveRoutingDecision(makePolicyInput({
      baseCause: 'continuation-context',
      baseDimension: 'implement',
      candidates: registryOnlyCandidates,
    }));

    expect(continuation.decision.cause).toBe('continuation-context');
  });

  it('uses configured weights for the active dimension', () => {
    const qualityFirst = resolveRoutingDecision(makePolicyInput({
      baseDimension: 'implement',
      candidates: [strongPaid, adequateFree],
      config: makePolicyConfig({
        dimensionWeights: {
          ...DEFAULT_DIMENSION_WEIGHTS,
          implement: { quality: 1, cost: 0, speed: 0 },
        },
      }),
    }));
    const costFirst = resolveRoutingDecision(makePolicyInput({
      baseDimension: 'implement',
      candidates: [strongPaid, adequateFree],
      config: makePolicyConfig({
        dimensionWeights: {
          ...DEFAULT_DIMENSION_WEIGHTS,
          implement: { quality: 0, cost: 1, speed: 0 },
        },
      }),
    }));

    expect(qualityFirst.decision.chosen).toBe(strongPaid.registryId);
    expect(costFirst.decision.chosen).toBe(adequateFree.registryId);
  });

  describe('context pressure is advisory only', () => {
    it('attaches contextPressure metadata without changing cause', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'implement',
          baseCause: 'heuristic',
          estimatedContextTokens: 150_000,

          candidates: [makeCandidate({ registryId: 'test/alpha', contextWindow: 200_000 })],
        }),
      );
      // context pressure is advisory: metadata is attached but cause must stay no-data
      expect(result.decision.cause).toBe('no-data');
      expect(result.decision.contextPressure).toBeDefined();
      expect(result.decision.reason).toContain('[context nearly full: prefer a fresh planner subagent]');
    });
  });

  describe('trajectory handoff', () => {
    const weak = candidate('test/weak', {
      bench: benchRow('test/weak', { quality: { intelligence: 60, coding: 60, agenticCoding: 60 } }),
    });
    const strong = candidate('test/strong', {
      bench: benchRow('test/strong', { quality: { intelligence: 90, coding: 90, agenticCoding: 90 } }),
      cost: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 },
    });
    const pending = (fromModel: string): PendingTrajectoryEscalation => ({
      fromModel,
      dimension: 'implement',
      signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }],
      tfi: 1,
      preOutput: false,
    });

    it('repicks a measured stronger model and keeps objective recovery behind it', () => {
      const cheap = candidate('test/cheap', {
        bench: benchRow('test/cheap', { quality: { intelligence: 50, coding: 50, agenticCoding: 50 } }),
      });
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [weak, strong, cheap],
          trajectoryEscalation: pending('test/weak'),
        }),
      );
      expect(result.trajectoryApplied).toBe(true);
      expect(result.decision.chosen).toBe('test/strong');
      expect(result.decision.cause).toBe('trajectory-escalation');
      expect(result.decision.fallbackChain[0]).toBe('test/strong');
      expect(result.decision.fallbackChain).toContain('test/cheap');
      expect(result.decision.fallbackChain).not.toContain('test/weak');
    });

    it('does not treat an unsuffixed source plus effective effort as unknown', () => {
      const unsuffixed = candidate('test/mid', {
        bench: benchRow('test/mid', { quality: { intelligence: 70, coding: 70, agenticCoding: 70 } }),
      });
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [unsuffixed, strong],
          trajectoryEscalation: pending('test/mid:medium'),
        }),
      );
      expect(result.trajectoryApplied).toBe(true);
      expect(result.decision.chosen).toBe('test/strong');
      expect(result.decision.fallbackChain).not.toContain('test/mid');
    });

    it('fails closed when the source is unavailable', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [strong],
          trajectoryEscalation: pending('test/missing:medium'),
        }),
      );
      expect(result.trajectoryApplied).toBe(false);
      expect(result.decision.trajectoryFriction?.unavailable).toBe(true);
      expect(result.decision.chosen).toBe('test/strong');
    });

    it('fails closed on estimated or weaker measured destinations', () => {
      const estimated = candidate('test/guess', {
        bench: {
          ...benchRow('test/guess', { quality: { intelligence: 99, coding: 99, agenticCoding: 99 } }),
          qualityEstimated: true,
        },
      });
      const weaker = candidate('test/weaker', {
        bench: benchRow('test/weaker', { quality: { intelligence: 40, coding: 40, agenticCoding: 40 } }),
      });
      const estimatedResult = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [weak, estimated],
          trajectoryEscalation: pending('test/weak'),
        }),
      );
      expect(estimatedResult.trajectoryApplied).toBe(false);
      const weakerResult = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [weak, weaker],
          trajectoryEscalation: pending('test/weak'),
        }),
      );
      expect(weakerResult.trajectoryApplied).toBe(false);
    });

    it('allows same-model higher effort and rejects equal effort', () => {
      const medium = candidate('test/model', {
        effort: 'medium',
        bench: benchRow('test/model', { effort: 'medium', quality: { intelligence: 80, coding: 80 } }),
      });
      const high = candidate('test/model', {
        effort: 'high',
        bench: benchRow('test/model', { effort: 'high', quality: { intelligence: 80, coding: 80 } }),
      });
      const higher = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [medium, high],
          trajectoryEscalation: pending('test/model:medium'),
        }),
      );
      expect(higher.trajectoryApplied).toBe(true);
      expect(higher.decision.chosen).toBe('test/model:high');

      const equal = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [medium],
          trajectoryEscalation: pending('test/model:medium'),
        }),
      );
      expect(equal.trajectoryApplied).toBe(false);
    });

    it('does not pick a stronger target that fails ordinary context or vision guards', () => {
      const visionSource = candidate('test/weak', {
        vision: true,
        contextWindow: 200_000,
        bench: benchRow('test/weak', { quality: { intelligence: 60, coding: 60, agenticCoding: 60 } }),
      });
      const strongerBlind = candidate('test/strong', {
        vision: false,
        contextWindow: 32_000,
        bench: benchRow('test/strong', { quality: { intelligence: 90, coding: 90, agenticCoding: 90 } }),
      });
      const vision = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          needsVision: true,
          estimatedContextTokens: 1_000,
          candidates: [visionSource, strongerBlind],
          trajectoryEscalation: pending('test/weak'),
        }),
      );
      expect(vision.trajectoryApplied).toBe(false);
      expect(vision.decision.chosen).toBe('test/weak');

      const deep = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          needsVision: false,
          estimatedContextTokens: 100_000,
          candidates: [visionSource, strongerBlind],
          trajectoryEscalation: pending('test/weak'),
        }),
      );
      expect(deep.trajectoryApplied).toBe(false);
      expect(deep.decision.chosen).toBe('test/weak');
    });

    it('does not treat a labelled-high destination as stronger under a medium override', () => {
      const medium = candidate('test/model', {
        effort: 'medium',
        reasoning: true,
        bench: benchRow('test/model', { effort: 'medium', quality: { intelligence: 80, coding: 80, agenticCoding: 80 } }),
      });
      const high = candidate('test/model', {
        effort: 'high',
        reasoning: true,
        bench: benchRow('test/model', { effort: 'high', quality: { intelligence: 80, coding: 80, agenticCoding: 80 } }),
      });
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          candidates: [medium, high],
          trajectoryEscalation: pending('test/model:medium'),
          userReasoning: 'medium',
          userReasoningOverride: true,
        }),
      );
      expect(result.trajectoryApplied).toBe(false);
    });
  });

  describe('metadata', () => {
    it('sets switched when incumbent differs from chosen', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          candidates: registryOnlyCandidates,
          incumbentRegistryId: 'some/other-model',
        }),
      );
      expect(result.decision.switched).toBe(true);
    });

  });

  describe('POLICY_PASSIVE_CAUSES export', () => {
    it('contains expected passive causes', () => {
      expect(POLICY_PASSIVE_CAUSES.has('heuristic')).toBe(true);
      expect(POLICY_PASSIVE_CAUSES.has('continuation-context')).toBe(true);
      expect(POLICY_PASSIVE_CAUSES.has('no-data')).toBe(true);
      // Active causes must NOT be passive — they own the dimension and are
      // not overridable by trajectory repicks.
      expect(POLICY_PASSIVE_CAUSES.has('router-consult')).toBe(false);
    });
  });
});

describe('declared task types', () => {
  it.each(['lightweight', 'gather', 'implement', 'review', 'plan'] as const)(
    'uses %s without classification metadata', (baseDimension) => {
      const { decision } = resolveRoutingDecision(makePolicyInput({ baseDimension }));
      expect(decision.dimension).toBe(baseDimension);
      for (const key of ['confidence', 'routedUp', 'routedDown']) expect(decision).not.toHaveProperty(key);
    },
  );

  it('attaches context-pressure advice without changing a declared task type', () => {
    const { decision } = resolveRoutingDecision(makePolicyInput({ baseDimension: 'lightweight', estimatedContextTokens: 180_000 }));
    expect(decision.dimension).toBe('lightweight');
    expect(decision.contextPressure).toBeDefined();
  });
});

describe('incumbent capability floor', () => {
  // Within one work item, retain the incumbent capability and thinking
  // minimums. Accepted work changes and unserved handoff boundaries release
  // both; applied trajectory evidence must not restore an excluded source.
  it('baseline (no incumbent) picks the cheap model at gather', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        baseDimension: 'gather',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/cheap');
  });

  it('holds the floor under uncertainty: keeps the stronger incumbent', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        baseDimension: 'gather',
        incumbentRegistryId: 'bench/strong',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/strong');
    expect(result.decision.fallbackChain[0]).toBe('bench/strong');
    expect(result.decision.reason).toContain('[kept current model: stronger for this task]');
  });

  it('promotes the first scored candidate meeting the incumbent capability, not the incumbent itself', () => {
    const candidates = [
      makeCandidate({
        registryId: 'bench/weak', provider: 'bench', id: 'weak',
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        bench: benchRow('bench/weak', { quality: { agenticCoding: 38.7, coding: 68 } }),
      }),
      makeCandidate({
        registryId: 'bench/better', provider: 'bench', id: 'better',
        cost: { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 },
        bench: benchRow('bench/better', { quality: { agenticCoding: 42.1, coding: 72 } }),
      }),
      makeCandidate({
        registryId: 'bench/incumbent', provider: 'bench', id: 'incumbent',
        cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
        bench: benchRow('bench/incumbent', { quality: { agenticCoding: 38.8, coding: 75 } }),
      }),
    ];
    const result = resolveRoutingDecision(makePolicyInput({
      candidates, baseDimension: 'implement',
      incumbentRegistryId: 'bench/incumbent',
      sameIntentAsLast: true,
    }));
    expect(result.decision.chosen).toBe('bench/better');
    expect(result.decision.fallbackChain[0]).toBe(result.decision.chosen);
    expect(result.decision.reason).toContain('kept current capability with another model');
  });

  describe('incumbent minimum thinking level', () => {
    // Rows with the same quality, so the incumbent capability minimum keeps
    // any of them; the low effort is cheapest, so the scorer alone serves it.
    const row = (model: string, effort: 'low' | 'high', price: number, quality = {}): Candidate => candidate(model, {
      effort,
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      bench: {
        ...benchRow(model),
        effort,
        quality: { intelligence: 55, coding: 70, agenticCoding: 50, knowledge: 10, research: 0.5, ...quality },
      },
      cost: { input: price, output: price * 4 },
    });
    const efforts = [row('p/strong', 'low', 1), row('p/strong', 'high', 5)];

    it('scores the incumbent model only at the effort it served at or higher', () => {
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: efforts, baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
      }));
      expect(result.decision.chosen).toBe('p/strong:high');
      expect(result.decision.fallbackChain).not.toContain('p/strong:low');
      expect(result.decision.incumbentEffort).toEqual({ model: 'p/strong', effort: 'high' });
      expect(result.decision.reason).toContain("[kept current model's thinking level]");
    });

    it('prices the incumbent model at the effort that will serve, not at a lower row', () => {
      // The low row is cheaper than the other model, the high row is not. The
      // incumbent model serves at high, so the other model wins on price.
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: [...efforts.map((c) => c.effort === 'high' ? row('p/strong', 'high', 10) : c), row('p/other', 'low', 3)],
        baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
        config: { dimensionWeights: DEFAULT_DIMENSION_WEIGHTS, switchMargin: 0 },
      }));
      expect(result.decision.chosen).toBe('p/other:low');
      expect(result.decision.fallbackChain).toEqual(['p/other:low', 'p/strong:high']);
    });

    it('scores the nearest lower row at the served effort when no row measures it', () => {
      const low = { ...row('p/strong', 'low', 1), exactQualityByEffort: { low: { knowledge: 10, research: 0.5 } } };
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: [low], baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
      }));
      expect(result.decision.chosen).toBe('p/strong:high');
      const served = result.candidates.find((c) => c.effort === 'high')!;
      // Effort-specific axes are not estimated across efforts.
      expect(served.bench?.quality).toMatchObject({ intelligence: 55, knowledge: undefined, research: undefined });
      expect(result.candidates.some((c) => c.effort === 'low')).toBe(false);
    });

    it('takes the nearest lower row when no row measures the served effort', () => {
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: [row('p/strong', 'low', 1, { intelligence: 40 }), { ...row('p/strong', 'low', 2, { intelligence: 50 }), effort: 'medium', bench: { ...row('p/strong', 'low', 2, { intelligence: 50 }).bench!, effort: 'medium' } }],
        baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
      }));
      expect(result.candidates.map((c) => c.effort)).toEqual(['high']);
      expect(result.candidates[0]!.bench?.quality.intelligence).toBe(50);
    });

    it('records the minimum and its reason only for a chosen entry of the incumbent model', () => {
      const other = row('p/other', 'low', 0.1);
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: [...efforts, other], baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
        config: { dimensionWeights: DEFAULT_DIMENSION_WEIGHTS, switchMargin: 0 },
      }));
      expect(result.decision.chosen).toBe('p/other:low');
      expect(result.decision.incumbentEffort).toEqual({ model: 'p/strong', effort: 'high' });
      expect(result.decision.reason).not.toContain("[kept current model's thinking level]");
      // At or above the minimum with no raise, no reason is added.
      const atMinimum = resolveRoutingDecision(makePolicyInput({
        candidates: [row('p/strong', 'high', 5)], baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
      }));
      expect(atMinimum.decision.reason).not.toContain("[kept current model's thinking level]");
    });

    it.each(['p/strong:off', 'p/strong:fast', 'p/strong'])('sets no minimum from the incumbent key %s', (incumbentRegistryId) => {
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: efforts, baseDimension: 'gather', incumbentRegistryId, sameIntentAsLast: true,
      }));
      expect(result.candidates).toBe(efforts);
      expect(result.decision.incumbentEffort).toBeUndefined();
    });

    it('reads a retained measurement at the served effort', () => {
      const low = {
        ...row('p/strong', 'low', 1),
        exactQualityByEffort: { low: { knowledge: 10, research: 0.5 }, high: { knowledge: 20, research: 0.6 } },
      };
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: [low], baseDimension: 'gather', incumbentRegistryId: 'p/strong:high', sameIntentAsLast: true,
      }));
      expect(result.candidates[0]!.bench?.quality).toMatchObject({ knowledge: 20, research: 0.6 });
    });

    it('scores the input pool when the minimums are skipped', () => {
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: efforts, baseDimension: 'gather', incumbentRegistryId: 'p/strong:high',
        sameIntentAsLast: false, workRelation: 'new',
      }));
      expect(result.candidates).toBe(efforts);
      expect(result.decision.chosen).toBe('p/strong:low');
    });

    it.each(['new', 'resume', 'reopen', 'switch'] as const)('skips it for recorded %s work', (workRelation) => {
      const result = resolveRoutingDecision(makePolicyInput({
        candidates: efforts, baseDimension: 'gather', incumbentRegistryId: 'p/strong:high',
        sameIntentAsLast: false, workRelation,
      }));
      expect(result.decision.incumbentEffort).toBeUndefined();
    });

    it('needs the incumbent model in the chain and an effort in its key', () => {
      expect(resolveRoutingDecision(makePolicyInput({
        candidates: efforts, baseDimension: 'gather', incumbentRegistryId: 'other/model:max', sameIntentAsLast: true,
      })).decision.incumbentEffort).toBeUndefined();
      expect(resolveRoutingDecision(makePolicyInput({
        candidates: efforts, baseDimension: 'gather', incumbentRegistryId: 'p/strong', sameIntentAsLast: true,
      })).decision.incumbentEffort).toBeUndefined();
    });
  });

  describe('incumbent capability minimum', () => {
    const model = (id: string, intelligence: number, price: number): Candidate => candidate(id, {
      bench: { ...benchRow(id), quality: { intelligence, coding: 70, agenticCoding: 50 } },
      cost: { input: price, output: price * 4 },
    });
    const pool = [model('p/incumbent', 70, 10), model('p/cheap', 50, 1), model('p/middle', 75, 5)];
    const input = (incumbentRegistryId: string, extra: Partial<RoutingPolicyInput> = {}) => makePolicyInput({
      candidates: pool, baseDimension: 'gather', incumbentRegistryId, sameIntentAsLast: true,
      config: { dimensionWeights: DEFAULT_DIMENSION_WEIGHTS, switchMargin: 0 }, ...extra,
    });

    it('moves to the first chain entry at or above the incumbent capability, which may be another model', () => {
      expect(resolveRoutingDecision(makePolicyInput({ ...input('p/incumbent'), incumbentRegistryId: undefined })).decision.chosen).toBe('p/cheap');
      const result = resolveRoutingDecision(input('p/incumbent'));
      expect(result.decision.chosen).toBe('p/middle');
      expect(result.decision.fallbackChain[0]).toBe('p/middle');
    });

    it('changes nothing when the incumbent is weaker than the pick, absent, or skipped', () => {
      expect(resolveRoutingDecision(input('p/cheap')).decision.chosen).toBe('p/cheap');
      expect(resolveRoutingDecision(input('gone/model')).decision.chosen).toBe('p/cheap');
      expect(resolveRoutingDecision(input('p/incumbent', { sameIntentAsLast: false, workRelation: 'new' })).decision.chosen).toBe('p/cheap');
    });
  });

  describe('decision metadata', () => {
    it('measures context pressure against the chosen model window', () => {
      const small = candidate('p/small', { contextWindow: 100_000 });
      const big = candidate('p/big', { contextWindow: 1_000_000, cost: { input: 50, output: 50 } });
      const pressured = resolveRoutingDecision(makePolicyInput({ candidates: [small, big], estimatedContextTokens: 70_000 }));
      expect(pressured.decision.chosen).toBe('p/small');
      expect(pressured.decision.contextPressure?.usageRatio).toBeCloseTo(0.7, 6);
      const relaxed = resolveRoutingDecision(makePolicyInput({ candidates: [big], estimatedContextTokens: 70_000 }));
      expect(relaxed.decision.contextPressure).toBeUndefined();
    });

    it('marks no-data only when no candidate has benchmark data', () => {
      const unbenchmarked = candidate('p/plain', { bench: undefined });
      const benchmarked = candidate('p/bench', { bench: benchRow('p/bench') });
      expect(resolveRoutingDecision(makePolicyInput({ candidates: [unbenchmarked] })).decision.cause).toBe('no-data');
      expect(resolveRoutingDecision(makePolicyInput({ candidates: [unbenchmarked, benchmarked] })).decision.cause).toBe('heuristic');
    });
  });

  describe('scoredIncumbentKey', () => {
    const low = candidate('p/strong', {
      effort: 'low', reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      bench: { ...benchRow('strong'), effort: 'low' },
    });

    it('keeps a key that a row has', () => {
      expect(scoredIncumbentKey([low], 'p/strong:low')).toBe('p/strong:low');
    });

    it('keeps an effort above a labelled row of the model', () => {
      expect(scoredIncumbentKey([low], 'p/strong:high')).toBe('p/strong:high');
    });

    it('rejects an effort the model has no lower labelled row for', () => {
      expect(scoredIncumbentKey([low], 'p/strong:off')).toBeUndefined();
      expect(scoredIncumbentKey([{ ...low, effort: 'high' }], 'p/strong:low')).toBeUndefined();
      expect(scoredIncumbentKey([{ ...low, effort: undefined }], 'p/strong:high')).toBeUndefined();
      expect(scoredIncumbentKey([low], 'p/other:high')).toBeUndefined();
    });
  });

  it('keeps both incumbent protections for a contract that keeps its submitter', () => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'implement', baseCause: 'execution-contract',
      incumbentRegistryId: 'bench/strong', sameIntentAsLast: true,
    }));
    expect(result.decision.dimension).toBe('implement');
    expect(result.decision.chosen).toBe('bench/strong');
  });

  it('lets a released contract pick a cheaper executor at its implement minimum', () => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'implement', baseCause: 'execution-contract',
      incumbentRegistryId: 'bench/strong', sameIntentAsLast: true,
      handoffMinimum: 0.45, handoffPending: true,
    }));
    expect(result.decision.chosen).toBe('bench/cheap');
    expect(result.decision.cause).toBe('execution-contract');
  });

  it('keeps the incumbent once a handoff boundary has served', () => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'implement', baseCause: 'execution-contract',
      incumbentRegistryId: 'bench/strong', sameIntentAsLast: true,
      handoffMinimum: 0.45,
    }));
    expect(result.decision.chosen).toBe('bench/strong');
  });

  it.each(['new', 'resume', 'reopen', 'switch'] as const)('releases both minimums for recorded %s work', (workRelation) => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'gather', baseCause: 'heuristic',
      incumbentRegistryId: 'bench/strong', sameIntentAsLast: false,
      workRelation,
    }));
    expect(result.decision.chosen).toBe('bench/cheap');
  });

  it.each(['continue', 'unknown', undefined] as const)('keeps both minimums for %s work', (workRelation) => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'gather', baseCause: 'heuristic',
      incumbentRegistryId: 'bench/strong', sameIntentAsLast: false,
      workRelation,
    }));
    expect(result.decision.chosen).toBe('bench/strong');
  });

  it('keeps the minimums on post-tool invocations of an entry that began new work', () => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'gather',
      incumbentRegistryId: 'bench/strong',
      sameIntentAsLast: true, workRelation: 'new',
    }));
    expect(result.decision.chosen).toBe('bench/strong');
  });

  it('still demotes an executor below the contract minimum', () => {
    const result = resolveRoutingDecision(makePolicyInput({
      candidates: benchmarkCandidates,
      baseDimension: 'implement', baseCause: 'execution-contract',
      incumbentRegistryId: 'bench/strong', sameIntentAsLast: true,
      handoffMinimum: 0.70, handoffPending: true,
    }));
    expect(result.decision.chosen).toBe('bench/strong');
  });

  it('skips the incumbent minimums on a side question placed outside the current work', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        baseDimension: 'gather',
        workRelation: 'switch',
        incumbentRegistryId: 'bench/strong',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/cheap');
  });

  it('never raises a weaker incumbent above the fresh pick', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        baseDimension: 'gather',
        // The incumbent minimum must not limit a stronger fresh pick.
        incumbentRegistryId: 'bench/cheap',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/cheap');
    expect(result.decision.reason).not.toContain('incumbent-floor');
  });

  it('keeps the incumbent minimum within the same intent at gather', () => {
    // Post-tool invocations retain the same intent's serving minimum.
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        baseDimension: 'gather',
        incumbentRegistryId: 'bench/strong',
        sameIntentAsLast: true,
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/strong');
    expect(result.decision.reason).toContain('[kept current model: stronger for this task]');
  });

  it('skips the incumbent minimums for an applied trajectory handoff and never restores the excluded source', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        baseDimension: 'implement',
        incumbentRegistryId: 'bench/cheap',
        trajectoryEscalation: {
          fromModel: 'bench/cheap',
          dimension: 'implement',
          signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }],
          tfi: 1,
          preOutput: false,
        },
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).not.toBe('bench/cheap');
    expect(result.decision.reason).not.toContain('incumbent-floor');
  });

  it('keeps the incumbent capability minimum for implementation on unresolved work', () => {
    // Unresolved work identity does not authorize a weaker economic pick.
    const close: Candidate[] = [
      makeCandidate({
        registryId: 'bench/near', provider: 'bench', id: 'near',
        bench: {
          registryId: 'bench/near', benchSlug: 'near', active: true,
          quality: { intelligence: 85, coding: 85 },
          priceInputPer1M: 0.5, priceOutputPer1M: 2.0, source: 'aa',
        },
      }),
      makeCandidate({
        registryId: 'bench/top', provider: 'bench', id: 'top',
        bench: {
          registryId: 'bench/top', benchSlug: 'top', active: true,
          quality: { intelligence: 90, coding: 88 },
          priceInputPer1M: 15.0, priceOutputPer1M: 75.0, source: 'aa',
        },
      }),
    ];
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: close,
        baseDimension: 'implement',
        baseCause: 'work-context',
        incumbentRegistryId: 'bench/top',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.dimension).toBe('implement');
    expect(result.decision.chosen).toBe('bench/top');
    expect(result.decision.reason).toContain('[kept current model: stronger for this task]');
  });

  it('never reintroduces an incumbent the scorer filtered out of the chain', () => {
    // The incumbent is present in `candidates` but its context window is too
    // small for the estimate, so the long-context guard drops it from the
    // scored chain. The floor must not inject it back and bypass that safety
    // filter — exercises the incumbentInChain >= 0 guard, not the missing-
    // candidate path.
    const candidates = benchmarkCandidates.map((c) =>
      c.registryId === 'bench/strong' ? { ...c, contextWindow: 1_000 } : c,
    );
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates,
        baseDimension: 'gather',
        incumbentRegistryId: 'bench/strong',
        // Above bench/strong's 1k window * 1.2; bench/cheap keeps its 200k.
        estimatedContextTokens: 2_000,
      }),
    );
    expect(result.decision.fallbackChain).not.toContain('bench/strong');
    expect(result.decision.chosen).toBe('bench/cheap');
    expect(result.decision.reason).not.toContain('incumbent-floor');
  });
});

describe('policy version', () => {
  it('runs the legacy policy unless the evaluation variable names the candidate policy exactly', () => {
    expect(evaluationPolicyVersion({})).toBe('legacy');
    expect(evaluationPolicyVersion({ PI8_POLICY_VERSION: 'cheapest-sufficient' })).toBe('cheapest-sufficient');
    for (const value of ['', 'Cheapest-Sufficient', 'cheapest', 'legacy', '1']) {
      expect(evaluationPolicyVersion({ PI8_POLICY_VERSION: value })).toBe('legacy');
    }
  });

  it('marks a decision only when the candidate policy made it, and the production binding is the legacy policy', () => {
    const input = makePolicyInput({ candidates: benchmarkCandidates });
    const legacy = resolveRoutingDecisionForEvaluation(input, 'legacy').decision;
    expect(legacy.policyVersion).toBeUndefined();
    expect(resolveRoutingDecision(input).decision).toEqual(legacy);
    expect(resolveRoutingDecisionForEvaluation(input, 'cheapest-sufficient').decision.policyVersion).toBe('cheapest-sufficient');
  });

  it('chooses the trajectory target by price among all stronger candidates under the candidate policy only', () => {
    const at = (id: string, level: number, price: number) => candidate(id, {
      bench: benchRow(id, { quality: { intelligence: 50, coding: 70, agenticCoding: level } }),
      cost: { input: price, output: price * 4, cacheRead: 0, cacheWrite: 0 },
    });
    const pool = [at('test/source', 40, 1), at('test/mid', 45, 0.5), at('test/frontier', 50, 3)];
    const input = makePolicyInput({
      baseDimension: 'implement', candidates: pool,
      trajectoryEscalation: {
        fromModel: 'test/source', dimension: 'implement', tfi: 1, preOutput: false,
        signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }],
      },
    });
    expect(resolveRoutingDecisionForEvaluation(input, 'legacy').decision.chosen).toBe('test/frontier');
    expect(resolveRoutingDecisionForEvaluation(input, 'cheapest-sufficient').decision.chosen).toBe('test/mid');
  });
});

describe('selection under the candidate policy', () => {
  const priced = (id: string, quality: number, price?: number) => candidate(id, {
    bench: benchRow(id, { quality: { intelligence: quality, coding: quality, agenticCoding: quality } }),
    ...(price != null ? { cost: { input: price, output: price * 4, cacheRead: 0, cacheWrite: 0 } } : {}),
  });
  const pick = (candidates: Candidate[], version: 'legacy' | 'cheapest-sufficient', over: Partial<RoutingPolicyInput> = {}) =>
    resolveRoutingDecisionForEvaluation(makePolicyInput({
      candidates,
      baseDimension: 'implement',
      config: makePolicyConfig({ dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS, implement: { quality: 1, cost: 0, speed: 0 } } }),
      ...over,
    }), version).decision;

  it('gives no credit for quality above the minimums, whatever the configured weights say', () => {
    const pool = [priced('p/strong', 56, 10), priced('p/adequate', 35, 1)];
    expect(pick(pool, 'legacy').chosen).toBe('p/strong');
    expect(pick(pool, 'cheapest-sufficient').chosen).toBe('p/adequate');
  });

  it('never lets a lower price offset a missed minimum', () => {
    const pool = [priced('p/weak-free', 10, 0), priced('p/adequate', 35, 5)];
    const decision = pick(pool, 'cheapest-sufficient');
    expect(decision.chosen).toBe('p/adequate');
    expect(decision.fallbackChain).toEqual(['p/adequate', 'p/weak-free']);
  });

  it('never counts an unknown price as free', () => {
    const unpriced = makeCandidate({
      registryId: 'p/unpriced', provider: 'p', id: 'unpriced',
      bench: benchRow('p/unpriced', { quality: { intelligence: 35, coding: 35, agenticCoding: 35 } }),
    });
    expect(unpriced.cost).toBeUndefined();
    expect(pick([unpriced, priced('p/priced', 35, 5)], 'cheapest-sufficient').chosen).toBe('p/priced');
  });

  it('keeps every candidate in the fallback chain', () => {
    const pool = [priced('p/a', 56, 10), priced('p/b', 35, 1), priced('p/c', 10, 0)];
    expect(new Set(pick(pool, 'cheapest-sufficient').fallbackChain)).toEqual(new Set(['p/a', 'p/b', 'p/c']));
  });
});
