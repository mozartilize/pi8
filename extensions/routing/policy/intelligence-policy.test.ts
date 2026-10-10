import { describe, expect, it } from 'vitest';
import { resolveRoutingDecision, resolveRoutingDecisionForEvaluation, type RoutingPolicyInput } from './routing-policy.js';
import { DEFAULT_DIMENSION_WEIGHTS } from '../../constants.js';
import { benchRow, candidate } from '../../test-support/router-fixtures.js';
import type { BenchModel, Candidate } from '../../types.js';

const priced = (id: string, quality: BenchModel['quality'], price = 1): Candidate => candidate(id, {
  bench: benchRow(id, { quality: { intelligence: undefined, coding: undefined, agenticCoding: undefined, ...quality } }),
  cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 },
});
const input = (candidates: Candidate[], over: Partial<RoutingPolicyInput> = {}): RoutingPolicyInput => ({
  candidates, baseDimension: 'implement', baseCause: 'heuristic', estimatedContextTokens: 0,
  needsVision: false, config: { dimensionWeights: DEFAULT_DIMENSION_WEIGHTS, switchMargin: 0 }, ...over,
});
const pick = (candidates: Candidate[], over: Partial<RoutingPolicyInput> = {}) =>
  resolveRoutingDecisionForEvaluation(input(candidates, over), 'cheapest-sufficient').decision;

describe('Intelligence implementation comparator', () => {
  it.each([undefined, 0.30, 0.44, 0.45, 0.70, 0.85])('uses the same axis at requirement %s', (handoffMinimum) => {
    const modern = priced('p/modern', { intelligence: 51 }, 1);
    const subset = priced('p/subset', { intelligence: 50, agenticIndex: 100, agenticCoding: 100 }, 10);
    const decision = pick([modern, subset], { handoffMinimum });
    expect(decision.chosen).toBe('p/modern');
    expect(decision.candidateDiagnostics ?? []).not.toContainEqual(expect.objectContaining({ candidateKey: 'p/modern' }));
    expect(decision.fallbackChain).toContain('p/subset');
  });

  it('keeps a model below 65% of the Intelligence reference out of a default implementation pick', () => {
    const below = priced('p/below', { intelligence: 37 }, 1);
    const above = priced('p/above', { intelligence: 38 }, 10);
    const decision = pick([below, above]);
    expect(decision.chosen).toBe('p/above');
    expect(decision.candidateDiagnostics).toContainEqual({ candidateKey: 'p/below', excludedReason: 'below-intelligence-minimum' });
  });

  it('does not substitute component or coding scores for missing Intelligence', () => {
    const unknown = priced('p/unknown', { coding: 100, agenticCoding: 100, agenticIndex: 100 }, 1);
    const weak = priced('p/weak', { intelligence: 10 }, 0);
    const adequate = priced('p/adequate', { intelligence: 40 }, 10);
    const decision = pick([weak, unknown, adequate]);
    expect(decision.fallbackChain).toEqual(['p/adequate', 'p/unknown', 'p/weak']);
    expect(decision.candidateDiagnostics).toEqual(expect.arrayContaining([
      { candidateKey: 'p/unknown', excludedReason: 'unknown-quality' },
      { candidateKey: 'p/weak', excludedReason: 'below-intelligence-minimum' },
    ]));
  });

  it('keeps the incumbent Intelligence minimum, not its component score', () => {
    const incumbent = priced('p/incumbent', { intelligence: 40, agenticCoding: 5 }, 10);
    const cheap = priced('p/cheap', { intelligence: 38, agenticCoding: 80 }, 1);
    expect(pick([incumbent, cheap], { incumbentRegistryId: 'p/incumbent', sameIntentAsLast: true }).chosen).toBe('p/incumbent');
    expect(pick([incumbent, cheap], { incumbentRegistryId: 'p/incumbent', handoffPending: true }).chosen).toBe('p/cheap');
  });

  it('proves strength on Intelligence and applies the active minimum before cost', () => {
    const source = priced('p/source', { intelligence: 35, agenticCoding: 50 }, 1);
    const insufficient = priced('p/cheap-stronger', { intelligence: 40, agenticCoding: 100 }, 0);
    const sufficient = priced('p/sufficient', { intelligence: 48, agenticCoding: 1 }, 10);
    const decision = pick([source, insufficient, sufficient], {
      handoffMinimum: 0.8,
      trajectoryEscalation: {
        fromModel: 'p/source', dimension: 'implement', tfi: 1, preOutput: false,
        signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }],
      },
    });
    expect(decision.chosen).toBe('p/sufficient');
    expect(decision.trajectoryFriction?.unavailable).not.toBe(true);
    expect(decision.fallbackChain).toContain('p/cheap-stronger');
    expect(decision.fallbackChain).not.toContain('p/source');
  });

  it('preserves the production binding and records the candidate minimum identity', () => {
    const pool = [priced('p/intelligence', { intelligence: 45, agenticCoding: 5 }, 1), priced('p/terminal', { intelligence: 40, agenticCoding: 60 }, 10)];
    expect(resolveRoutingDecision(input(pool)).decision.chosen).toBe('p/terminal');
    const decision = pick(pool);
    expect(decision.chosen).toBe('p/intelligence');
    expect(decision.policyVersion).toBe('cheapest-sufficient');
    expect(decision.capabilityEvidence).toMatchObject({ comparisonAxis: 'intelligence', metricVersion: '4.3', minimums: { intelligence: expect.any(Number) } });
    expect(decision.capabilityEvidence?.policyDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
