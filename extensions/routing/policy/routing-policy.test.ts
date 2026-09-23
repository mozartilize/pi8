import { describe, it, expect } from 'vitest';
import {
  resolveRoutingDecision,
  wouldDepthEscalate,
  POLICY_PASSIVE_CAUSES,
  type RoutingPolicyInput,
} from './routing-policy.js';
import type { Candidate, Dimension } from '../../types.js';
import type { PendingTrajectoryEscalation } from '../struggle/types.js';
import { DEFAULT_DIMENSION_WEIGHTS } from '../../constants.js';
import { renderScoredReason } from '../score/decision-reason.js';
import { candidate, terminalAssessment, benchRow } from '../../test-support/router-fixtures.js';

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

// Benchmark candidates: with quality data so depth/scoring exercises real paths
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
      quality: { intelligence: 65, coding: 60 },
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
      quality: { intelligence: 90, coding: 88, },
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
    lowConfidenceThreshold: 0.15,
    depthEscalation: true,
    depthEscalationTokens: 32_768,
    ...overrides,
  };
}

type PolicyInputOverrides = Partial<RoutingPolicyInput> & {
  /** Shorthand for `classifyResult.dimension`. */
  classifyDimension?: Dimension;
  /** Shorthand for `classifyResult.confidence`. */
  confidence?: number;
};

function makePolicyInput(overrides: PolicyInputOverrides = {}): RoutingPolicyInput {
  const { classifyDimension, confidence, ...rest } = overrides;
  return {
    candidates: registryOnlyCandidates,
    classifyResult: {
      dimension: classifyDimension ?? 'gather',
      confidence: confidence ?? 0.8,
      signals: [],
      terminal: terminalAssessment(),
      hasCategoricalEvidence: false,
    },
    baseDimension: 'gather',
    baseCause: 'heuristic',
    estimatedContextTokens: 1_000,
    needsVision: false,
    config: makePolicyConfig(),
    ...rest,
  };
}

// ─── Cause precedence table ──────────────────────────────────────────

describe('resolveRoutingDecision', () => {
  it('renders typed policy details without changing the logged reason format', () => {
    const { decision } = resolveRoutingDecision(makePolicyInput({
      estimatedContextTokens: 150_000,
      confidence: 0.05,
      config: makePolicyConfig({ depthEscalation: false }),
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
          // implement has strength 2 > gather strength 1, so depth never fires
          estimatedContextTokens: 100_000,
          candidates: registryOnlyCandidates,
        },
        expectedCause: 'continuation-context',
        expectedDimension: 'implement',
      },
      {
        name: 'depth escalation replaces passive heuristic',
        input: {
          baseCause: 'heuristic' as const,
          baseDimension: 'gather' as const,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 100_000,
        },
        expectedCause: 'context-depth',
        expectedDimension: 'implement',
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
      classifyResult: {
        dimension: 'implement',
        confidence: 0.8,
        signals: [],
        terminal: terminalAssessment(),
      hasCategoricalEvidence: true,
      },
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
      classifyResult: {
        dimension: 'implement',
        confidence: 0.8,
        signals: [],
        terminal: terminalAssessment(),
      hasCategoricalEvidence: true,
      },
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
      // Large context, low confidence, routedUp → triggers undercertainty check
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'implement',
          baseCause: 'heuristic',
          estimatedContextTokens: 150_000,
          // low confidence ensures undercertainty
          classifyResult: {
            dimension: 'gather',
            confidence: 0.05,
            signals: [],
            terminal: terminalAssessment(),
      hasCategoricalEvidence: false,
          },
          candidates: [makeCandidate({ registryId: 'test/alpha', contextWindow: 200_000 })],
        }),
      );
      // context pressure is advisory: metadata is attached but cause must stay no-data
      expect(result.decision.cause).toBe('no-data');
      expect(result.decision.contextPressure).toBeDefined();
      expect(result.decision.reason).toContain('[context nearly full: prefer a fresh planner subagent]');
    });

    it('does not change context-depth cause when pressure also fires', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          estimatedContextTokens: 150_000,
          classifyResult: {
            dimension: 'gather',
            confidence: 0.05,
            signals: [],
            terminal: terminalAssessment(),
      hasCategoricalEvidence: false,
          },
          candidates: [makeCandidate({ registryId: 'test/alpha', contextWindow: 200_000 })],
        }),
      );
      // depth escalation fires first (gather→implement), then pressure check sees routedUp=true
      // but cause must remain 'context-depth', not be overwritten to 'context-pressure'
      expect(result.decision.cause).toBe('context-depth');
      expect(result.decision.contextPressure).toBeDefined();
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
          candidates: [weak, estimated],
          trajectoryEscalation: pending('test/weak'),
        }),
      );
      expect(estimatedResult.trajectoryApplied).toBe(false);
      const weakerResult = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
          classifyDimension: 'implement',
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
    it('sets routedUp when dimension differs from classifyResult.dimension', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          classifyResult: {
            dimension: 'gather',
            confidence: 0.8,
            signals: [],
            terminal: terminalAssessment(),
      hasCategoricalEvidence: false,
          },
          baseDimension: 'gather',
          baseCause: 'heuristic',
          estimatedContextTokens: 100_000, // depth escalation fires
          candidates: registryOnlyCandidates,
        }),
      );
      expect(result.decision.routedUp).toBe(true);
    });

    it('sets switched when incumbent differs from chosen', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          candidates: registryOnlyCandidates,
          incumbentRegistryId: 'some/other-model',
        }),
      );
      expect(result.decision.switched).toBe(true);
    });

    it('appends context-depth reason suffix', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          estimatedContextTokens: 100_000,
          candidates: registryOnlyCandidates,
        }),
      );
      expect(result.decision.reason).toContain('long conversation: 100000 tokens');
    });
  });

  describe('POLICY_PASSIVE_CAUSES export', () => {
    it('contains expected passive causes', () => {
      expect(POLICY_PASSIVE_CAUSES.has('heuristic')).toBe(true);
      expect(POLICY_PASSIVE_CAUSES.has('continuation-context')).toBe(true);
      expect(POLICY_PASSIVE_CAUSES.has('no-data')).toBe(true);
      // Active causes must NOT be passive — they own the dimension and are
      // not overridable by depth escalation or trajectory repicks.
      expect(POLICY_PASSIVE_CAUSES.has('router-consult')).toBe(false);
      expect(POLICY_PASSIVE_CAUSES.has('context-depth')).toBe(false);
    });
  });
});

describe('routing direction', () => {
  it('sets routedUp when the routed dimension is stronger than the heuristic', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({ classifyDimension: 'gather', baseDimension: 'implement' }),
    );
    expect(result.decision.routedUp).toBe(true);
    expect(result.decision.routedDown).toBe(false);
  });

  it('sets routedDown when the routed dimension is weaker than the heuristic', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({ classifyDimension: 'gather', baseDimension: 'lightweight' }),
    );
    expect(result.decision.routedUp).toBe(false);
    expect(result.decision.routedDown).toBe(true);
  });

  it('sets neither when the dimension is unchanged', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({ classifyDimension: 'gather', baseDimension: 'gather' }),
    );
    expect(result.decision.routedUp).toBe(false);
    expect(result.decision.routedDown).toBe(false);
  });

  it('leaves routedPickChanged false when a raise re-selects the same model', () => {
    // The reported case: dimension raised (gather→implement) but the heuristic
    // dimension would have picked the same model, so nothing stronger was
    // served. routedUp stays true (dimension-level truth for the log/cause),
    // but the pick did not move — the UI must not claim "routed-up".
    const result = resolveRoutingDecision(
      makePolicyInput({ classifyDimension: 'gather', baseDimension: 'implement' }),
    );
    expect(result.decision.routedUp).toBe(true);
    expect(result.decision.routedPickChanged).toBe(false);
  });

  it('does not attach context-pressure advice to a downward route', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        classifyDimension: 'gather',
        baseDimension: 'lightweight',
        // High enough to clear CONTEXT_PRESSURE_THRESHOLD against the pick —
        // but depth escalation is disabled so the downward route survives.
        estimatedContextTokens: 180_000,
        confidence: 0.9,
        config: makePolicyConfig({ depthEscalation: false }),
      }),
    );
    expect(result.decision.routedDown).toBe(true);
    expect(result.decision.contextPressure).toBeUndefined();
  });

  it('still attaches context-pressure advice to an upward route', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        classifyDimension: 'gather',
        baseDimension: 'implement',
        estimatedContextTokens: 180_000,
        confidence: 0.9,
      }),
    );
    expect(result.decision.contextPressure).toBeDefined();
  });
});

describe('incumbent capability floor', () => {
  // Contract: within one task the served model stays at or above the
  // incumbent's measured capability. Uncertainty holds the floor; only a
  // genuine new entry with a high-confidence trivial classification resets to a
  // cheaper model. Sanctioned downward moves (trajectory escalation, inspect
  // promotion, consult that lowered the dimension) stand the floor down.
  it('baseline (no incumbent) picks the cheap model at gather', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.1,
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/cheap');
  });

  it('holds the floor under uncertainty: keeps the stronger incumbent', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        // Below lowConfidenceThreshold (0.15): not an off-topic reset, so the
        // floor stands.
        confidence: 0.1,
        incumbentRegistryId: 'bench/strong',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/strong');
    expect(result.decision.fallbackChain[0]).toBe('bench/strong');
    expect(result.decision.reason).toContain('[kept current model: stronger for this task]');
  });

  it('carries the incumbent resolved dimension as an up-only effort floor', () => {
    // A cheap-phrased same-task follow-up classifies gather but keeps the
    // strong incumbent; its served effort floor must not drop to gather's.
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.1,
        incumbentRegistryId: 'bench/strong',
        incumbentResolvedDimension: 'implement',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.effortFloorDimension).toBe('implement');
    expect(result.decision.reason).toContain("[kept current model's thinking level]");
  });

  it('does not lower the effort floor when the carried dimension is weaker', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'plan',
        baseDimension: 'plan',
        confidence: 0.1,
        incumbentRegistryId: 'bench/strong',
        incumbentResolvedDimension: 'gather',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.effortFloorDimension).toBeUndefined();
  });

  it('drops the effort floor carry on an off-topic reset', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.9,
        incumbentRegistryId: 'bench/strong',
        incumbentResolvedDimension: 'implement',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.effortFloorDimension).toBeUndefined();
  });

  it('stands down on a fresh, high-confidence trivial classification (off-topic reset)', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        // High confidence + trivial dimension = the user changed topic; a
        // cheaper model is the correct step-1 route.
        confidence: 0.9,
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
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.1,
        // Incumbent is the cheap model; the floor is a floor, never a ceiling.
        incumbentRegistryId: 'bench/cheap',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/cheap');
    expect(result.decision.reason).not.toContain('incumbent-floor');
  });

  it('holds the floor within the same intent even at high-confidence gather', () => {
    // A cached high-confidence gather intent must not reset on every post-tool
    // re-invocation: sameIntentAsLast keeps the stickiness across the loop.
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.9,
        incumbentRegistryId: 'bench/strong',
        sameIntentAsLast: true,
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).toBe('bench/strong');
    expect(result.decision.reason).toContain('[kept current model: stronger for this task]');
  });

  it('stands down for an applied trajectory handoff and never restores the excluded source', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'implement',
        baseDimension: 'implement',
        confidence: 0.1,
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

  it('holds on a fresh entry whose heuristic gather was raised to an involved dimension', () => {
    // Regression for keying offTopicReset on the heuristic instead of the final
    // dimension: a fresh, high-confidence gather entry that an adopted consult
    // raised to implement is involved work, so a measurably weaker economic
    // pick must not stand the floor down.
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
        classifyDimension: 'gather',
        baseDimension: 'implement',
        baseCause: 'router-consult',
        confidence: 0.9,
        incumbentRegistryId: 'bench/top',
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.dimension).toBe('implement');
    expect(result.decision.chosen).toBe('bench/top');
    expect(result.decision.reason).toContain('[kept current model: stronger for this task]');
  });

  it('stands down when a consult actually lowered the dimension', () => {
    // A bounded high-confidence assessment lowering implement→gather is a
    // sanctioned downgrade; the floor must not fight it.
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'implement',
        baseDimension: 'gather',
        baseCause: 'router-consult',
        confidence: 0.9,
        incumbentRegistryId: 'bench/strong',
        sameIntentAsLast: true,
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.reason).not.toContain('incumbent-floor');
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
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.1,
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

describe('depth-escalation probe and veto', () => {
  it('predicts exactly when step 4 would fire', () => {
    const base = {
      dimension: 'gather' as const,
      cause: 'heuristic' as const,
      config: { depthEscalation: true, depthEscalationTokens: 32_768 },
    };
    expect(wouldDepthEscalate({ ...base, estimatedContextTokens: 40_000 })).toBe(true);
    expect(wouldDepthEscalate({ ...base, estimatedContextTokens: 10_000 })).toBe(false);
    expect(wouldDepthEscalate({ ...base, dimension: 'plan', estimatedContextTokens: 90_000 })).toBe(false);
    expect(
      wouldDepthEscalate({
        ...base,
        config: { depthEscalation: false, depthEscalationTokens: 32_768 },
        estimatedContextTokens: 90_000,
      }),
    ).toBe(false);
  });

  it.each([
    { cause: 'router-consult' as const, expectEscalate: true },
    { cause: 'capability-escalation' as const, expectEscalate: false },
    { cause: 'error-fallback' as const, expectEscalate: false },
    { cause: 'context-depth' as const, expectEscalate: false },
  ])('returns $expectEscalate for cause $cause', ({ cause, expectEscalate }) => {
    expect(
      wouldDepthEscalate({
        dimension: 'gather',
        cause,
        estimatedContextTokens: 90_000,
        config: { depthEscalation: true, depthEscalationTokens: 32_768 },
      }),
    ).toBe(expectEscalate);
  });

  it('skips depth escalation when the veto flag is set, keeping cause heuristic', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        estimatedContextTokens: 90_000,
        vetoDepthEscalation: true,
      }),
    );
    expect(result.decision.dimension).toBe('gather');
    // A veto is a refusal to escalate, so no cause changed hands. This is why
    // no new DecisionCause value is needed and POLICY_PASSIVE_CAUSES is untouched.
    expect(result.decision.cause).toBe('heuristic');
    expect(result.decision.routedUp).toBe(false);
  });

  it('escalates normally when the veto flag is absent', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        estimatedContextTokens: 90_000,
      }),
    );
    expect(result.decision.dimension).toBe('implement');
    expect(result.decision.cause).toBe('context-depth');
  });

  it('depth escalates when cause is router-consult and dimension is depth-eligible', () => {
    // The assessment lowered gather→lightweight and was adopted, so cause is
    // router-consult. lightweight is still depth-eligible (strength 0 ≤ gather),
    // and router-consult is in DEPTH_PASSIVE_CAUSES (unlike POLICY_PASSIVE_CAUSES),
    // so the 90k-token context must trigger depth escalation: lightweight → gather.
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'lightweight',
        baseCause: 'router-consult',
        estimatedContextTokens: 90_000,
        vetoDepthEscalation: false,
      }),
    );
    expect(result.decision.dimension).toBe('gather');
    expect(result.decision.cause).toBe('context-depth');
  });
});

describe('resolveRoutingDecision — multiWorkPolicy threading', () => {
  it('threads multiWorkPolicy onto the primary scoring call and attaches decision.multiWork', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'implement',
        baseDimension: 'implement',
        baseCause: 'heuristic',
        multiWorkPolicy: {
          terminal: terminalAssessment(),
          terminalRequirement: 0.85,
          terminalBand: 'standard',
          phase: 'inspect',
          phaseReason: 'test-inspect',
          terminalFloor: 0.85,
          inspectFloor: 0.70,
          providerInvocation: 1,
        },
      }),
    );
    expect(result.decision.multiWork).toBeDefined();
    expect(result.decision.multiWork?.phase).toBe('inspect');
  });

  it('keeps the request-local floors out of the routed-pick counterfactual', () => {
    const policy = {
      terminal: terminalAssessment(),
      terminalRequirement: 0.85,
      terminalBand: 'frontier' as const,
      phase: 'inspect' as const,
      phaseReason: 'test-inspect',
      terminalFloor: 0.85,
      inspectFloor: 0.70,
      providerInvocation: 1,
    };
    const withPolicy = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        estimatedContextTokens: 90_000,
        multiWorkPolicy: policy,
      }),
    );
    const withoutPolicy = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        estimatedContextTokens: 90_000,
      }),
    );

    expect(withPolicy.decision.routedUp).toBe(true);
    expect(withPolicy.decision.chosen).toBe(withoutPolicy.decision.chosen);
    expect(withPolicy.decision.routedPickChanged).toBe(withoutPolicy.decision.routedPickChanged);
  });

  it('leaves decision.multiWork undefined when no multiWorkPolicy is supplied', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'implement',
        baseDimension: 'implement',
        baseCause: 'heuristic',
      }),
    );
    expect(result.decision.multiWork).toBeUndefined();
  });
});
