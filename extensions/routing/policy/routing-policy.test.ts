import { describe, it, expect } from 'vitest';
import {
  resolveRoutingDecision,
  wouldDepthEscalate,
  POLICY_PASSIVE_CAUSES,
  type AppliedEscalation,
  type RoutingPolicyInput,
} from './routing-policy.js';
import type { Candidate, Dimension } from '../../types.js';
import { DEFAULT_DIMENSION_WEIGHTS } from '../../constants.js';
import { candidate, terminalAssessment } from '../../test-support/router-fixtures.js';

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
        name: 'user escalation beats depth escalation',
        input: {
          baseCause: 'heuristic' as const,
          baseDimension: 'gather' as const,
          userEscalation: { target: undefined },
          candidates: registryOnlyCandidates,
          // depth would fire (tokens >= 32768, passive cause, gather) but the
          // explicit user request owns the dimension.
          estimatedContextTokens: 100_000,
        },
        expectedCause: 'user-escalation',
        expectedDimension: 'implement',
      },
      {
        name: 'explicit user escalation target is honoured',
        input: {
          baseCause: 'heuristic' as const,
          baseDimension: 'gather' as const,
          userEscalation: { target: 'plan' as const },
          candidates: registryOnlyCandidates,
          estimatedContextTokens: 1_000,
        },
        expectedCause: 'user-escalation',
        expectedDimension: 'plan',
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
    const user = resolveRoutingDecision(makePolicyInput({
      baseCause: 'heuristic',
      baseDimension: 'gather',
      userEscalation: { target: undefined },
      candidates: registryOnlyCandidates,
    }));

    expect(continuation.decision.cause).toBe('continuation-context');
    expect(user.decision.cause).toBe('user-escalation');
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
      expect(result.decision.reason).toContain('context-pressure');
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

  describe('escalation integration', () => {
    it('applies model escalation to raise dimension', () => {
      const escalation: AppliedEscalation = {
        dimension: 'plan',
        cause: 'model-escalation',
        reason: 'needs deeper planning',
        fromModel: undefined,
      };
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          escalation,
          candidates: benchmarkCandidates,
        }),
      );
      expect(result.decision).toMatchObject({
        cause: 'model-escalation',
        dimension: 'plan',
      });
      expect(result.decision.reason).toContain('escalated: needs deeper planning');
    });

    it('repicks the same model id through another provider at higher effort', () => {
      const source = candidate('github-copilot/gpt-5.6-luna', {
        effort: 'medium',
        bench: {
          registryId: 'github-copilot/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-medium', active: true,
          effort: 'medium', quality: { intelligence: 95, coding: 95 }, source: 'aa',
        },
      });
      const sibling = candidate('openai-codex/gpt-5.6-luna', {
        effort: 'max',
        bench: {
          registryId: 'openai-codex/gpt-5.6-luna', benchSlug: 'gpt-5.6-luna-max', active: true,
          effort: 'max', quality: { intelligence: 95, coding: 95 }, source: 'aa',
        },
      });
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          escalation: {
            dimension: 'plan',
            cause: 'model-escalation',
            reason: 'needs stronger planning',
            fromModel: 'github-copilot/gpt-5.6-luna:medium',
          },
          candidates: [source, sibling],
        }),
      );

      expect(result.decision.dimension).toBe('plan');
      expect(result.decision.chosen).toBe('openai-codex/gpt-5.6-luna:max');
    });

    it('does not leak an equal-effort sibling when the source is unavailable', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          escalation: {
            dimension: 'plan',
            cause: 'model-escalation',
            reason: 'needs stronger planning',
            fromModel: 'github-copilot/gpt-5.6-luna:medium',
          },
          candidates: [candidate('openai-codex/gpt-5.6-luna', { effort: 'medium' })],
        }),
      );

      expect(result.decision.chosen).toBe('');
      expect(result.decision.fallbackChain).toEqual([]);
    });

    it('uses only strictly higher effort when source effort is effective', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          escalation: {
            dimension: 'plan',
            cause: 'model-escalation',
            reason: 'needs stronger planning',
            fromModel: 'github-copilot/gpt-5.6-luna:medium',
          },
          candidates: [
            candidate('github-copilot/gpt-5.6-luna', { effort: 'medium' }),
            candidate('openai-codex/gpt-5.6-luna', { effort: 'max' }),
          ],
        }),
      );

      expect(result.decision.chosen).toBe('openai-codex/gpt-5.6-luna:max');
    });

    it('applies pickEscalation when fromModel would remain chosen', () => {
      const chosen = benchmarkCandidates[0]!.registryId;
      const escalation: AppliedEscalation = {
        dimension: 'implement',
        cause: 'capability-escalation',
        reason: 'not good enough',
        fromModel: chosen,
      };
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          escalation,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 1_000,
        }),
      );
      // pickEscalation should exclude `chosen` and pick the other candidate
      expect(result.decision.chosen).not.toBe(chosen);
    });

    it('preserves user-escalation cause when a same-dimension capability repick fires', () => {
      // Scenario: the user raised gather→implement, then model-escalation at
      // implement triggers a capability repick (sticky scoring). The user
      // request owns the dimension; capability-escalation must not overwrite it.
      const chosen = benchmarkCandidates[0]!.registryId;
      const escalation: AppliedEscalation = {
        dimension: 'implement',
        cause: 'capability-escalation',
        reason: 'not good enough',
        fromModel: chosen,
      };
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'gather',
          userEscalation: { target: 'implement' },
          escalation,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 1_000,
        }),
      );
      // The user raised gather→implement; the capability repick excludes the
      // incumbent but does not claim the cause — the dimension was already
      // elevated by the user request.
      expect(result.decision.cause).toBe('user-escalation');
      expect(result.decision.dimension).toBe('implement');
      expect(result.decision.chosen).not.toBe(chosen);
    });

    it('preserves consult cause when a same-dimension capability repick fires', () => {
      // Scenario: consult raised gather→implement, then model-escalation at
      // implement triggers a capability repick. The consult owns the
      // dimension; capability-escalation must not overwrite it.
      const chosen = benchmarkCandidates[0]!.registryId;
      const escalation: AppliedEscalation = {
        dimension: 'implement',
        cause: 'capability-escalation',
        reason: 'not good enough',
        fromModel: chosen,
      };
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'router-consult',
          baseDimension: 'implement',
          escalation,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 1_000,
        }),
      );
      // Consult owns the dimension; capability repick is secondary model selection.
      expect(result.decision.cause).toBe('router-consult');
      expect(result.decision.dimension).toBe('implement');
      expect(result.decision.chosen).not.toBe(chosen);
    });

    it('lets capability-escalation claim the cause when no prior step raised dimension', () => {
      // Scenario: base dimension is implement, heuristic cause, model
      // escalation at same dimension with a sticky scorer triggers a
      // capability repick. No prior step changed the dimension, so the
      // repick IS the most significant event.
      const chosen = benchmarkCandidates[0]!.registryId;
      const escalation: AppliedEscalation = {
        dimension: 'implement',
        cause: 'capability-escalation',
        reason: 'not good enough',
        fromModel: chosen,
      };
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseCause: 'heuristic',
          baseDimension: 'implement',
          escalation,
          candidates: benchmarkCandidates,
          estimatedContextTokens: 1_000,
        }),
      );
      expect(result.decision.cause).toBe('capability-escalation');
      expect(result.decision.dimension).toBe('implement');
      expect(result.decision.chosen).not.toBe(chosen);
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
      expect(result.decision.reason).toContain('context-depth: 100000 tokens');
    });
  });

  describe('POLICY_PASSIVE_CAUSES export', () => {
    it('contains expected passive causes', () => {
      expect(POLICY_PASSIVE_CAUSES.has('heuristic')).toBe(true);
      expect(POLICY_PASSIVE_CAUSES.has('continuation-context')).toBe(true);
      expect(POLICY_PASSIVE_CAUSES.has('no-data')).toBe(true);
      // Active causes must NOT be passive — they own the dimension and are
      // not overridable by depth escalation or capability repicks.
      expect(POLICY_PASSIVE_CAUSES.has('router-consult')).toBe(false);
      expect(POLICY_PASSIVE_CAUSES.has('user-escalation')).toBe(false);
      expect(POLICY_PASSIVE_CAUSES.has('context-depth')).toBe(false);
    });
  });

  describe('user escalation', () => {
    it('raises one tier when no explicit target is given', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'gather',
          userEscalation: { target: undefined },
          candidates: benchmarkCandidates,
        }),
      );
      expect(result.decision.dimension).toBe('implement');
      expect(result.decision.cause).toBe('user-escalation');
    });

    it('caps a no-arg escalation at the top dimension', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'plan',
          classifyResult: {
            dimension: 'plan',
            confidence: 0.8,
            signals: [],
            terminal: terminalAssessment(),
      hasCategoricalEvidence: true,
          },
          userEscalation: { target: undefined, fromModel: benchmarkCandidates[0]!.registryId },
          candidates: benchmarkCandidates,
        }),
      );
      expect(result.decision.dimension).toBe('plan');
      expect(result.decision.cause).toBe('user-escalation');
    });

    it('performs a quality-first repick at the top dimension instead of retaining the source model', () => {
      const fromModel = benchmarkCandidates[0]!.registryId;
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'plan',
          classifyResult: {
            dimension: 'plan',
            confidence: 0.8,
            signals: [],
            terminal: terminalAssessment(),
      hasCategoricalEvidence: true,
          },
          userEscalation: { target: 'plan', fromModel },
          candidates: benchmarkCandidates,
          incumbentRegistryId: fromModel,
        }),
      );
      expect(result.decision.chosen).not.toBe(fromModel);
      expect(result.decision.cause).toBe('user-escalation');
    });

    it('wins over a stale model escalation on the same invocation', () => {
      const escalation: AppliedEscalation = {
        dimension: 'review',
        cause: 'model-escalation',
        reason: 'model asked earlier',
      };
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'gather',
          userEscalation: { target: 'implement' },
          escalation,
          candidates: benchmarkCandidates,
        }),
      );
      expect(result.decision.dimension).toBe('implement');
      expect(result.decision.cause).toBe('user-escalation');
    });

    it('keeps user-escalation cause when no candidate has benchmark data', () => {
      const result = resolveRoutingDecision(
        makePolicyInput({
          baseDimension: 'gather',
          userEscalation: { target: undefined },
          candidates: registryOnlyCandidates,
        }),
      );
      expect(result.decision.cause).toBe('user-escalation');
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
  // cheaper model. Sanctioned downward moves (user pick, escalation, inspect
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
    expect(result.decision.reason).toContain('incumbent-floor');
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
    expect(result.decision.reason).toContain('incumbent-effort-floor');
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

  it('stands down for an explicit user escalation', () => {
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.1,
        incumbentRegistryId: 'bench/strong',
        userEscalation: { target: undefined },
        estimatedContextTokens: 1_000,
      }),
    );
    // The user owns the pick; the floor must not append its marker.
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
    expect(result.decision.reason).toContain('incumbent-floor');
  });

  it('stands down for an active escalation and never restores the excluded source', () => {
    // pickEscalation excludes the requesting model; the floor must not resurrect
    // it, which would re-serve the requester under a model-escalation cause.
    const result = resolveRoutingDecision(
      makePolicyInput({
        candidates: benchmarkCandidates,
        classifyDimension: 'gather',
        baseDimension: 'gather',
        confidence: 0.1,
        incumbentRegistryId: 'bench/strong',
        escalation: {
          dimension: 'implement',
          cause: 'model-escalation',
          reason: 'route_up',
          fromModel: 'bench/strong',
        },
        estimatedContextTokens: 1_000,
      }),
    );
    expect(result.decision.chosen).not.toBe('bench/strong');
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
    expect(result.decision.reason).toContain('incumbent-floor');
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
      wouldDepthEscalate({ ...base, cause: 'user-escalation', estimatedContextTokens: 90_000 }),
    ).toBe(false);
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
    { cause: 'user-escalation' as const, expectEscalate: false },
    { cause: 'model-escalation' as const, expectEscalate: false },
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
