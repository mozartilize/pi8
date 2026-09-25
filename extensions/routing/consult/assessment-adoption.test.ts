import { describe, expect, it } from 'vitest';
import { adoptAssessment, oneTierAbove, oneTierBelow } from './assessment-adoption.js';
import type { AssessmentConfidence, Dimension, RoutingAssessment, TaskScope } from '../../types.js';

const verdict = (
  kind: Dimension,
  confidence: AssessmentConfidence,
  scope: TaskScope,
  over: Partial<RoutingAssessment> = {},
): RoutingAssessment => ({
  kind,
  complexity: 'moderate',
  scope,
  compound: false,
  confidence,
  reasoning: 'test',
  model: 'test/assessor',
  ms: 100,
  usage: { input: 100, output: 20 },
  costUsd: 0.0001,
  ...over,
});

const adopt = (over: Partial<Parameters<typeof adoptAssessment>[0]>) =>
  adoptAssessment({ heuristic: 'gather', ...over });

describe('tier helpers', () => {
  it('orders lightweight < gather < implement < review < plan', () => {
    expect(oneTierAbove('lightweight')).toBe('gather');
    expect(oneTierAbove('implement')).toBe('review');
    expect(oneTierAbove('review')).toBe('plan');
    expect(oneTierAbove('plan')).toBe('plan');
    expect(oneTierBelow('gather')).toBe('lightweight');
    expect(oneTierBelow('plan')).toBe('review');
    expect(oneTierBelow('review')).toBe('implement');
    expect(oneTierBelow('lightweight')).toBe('lightweight');
  });
});

describe('adoptAssessment — unavailable', () => {
  it('keeps the heuristic when no assessment exists', () => {
    expect(adopt({ assessment: undefined })).toEqual({ dimension: 'gather', changed: false });
  });
});

describe('adoptAssessment — diagnostic fields', () => {
  it('ignores complexity and compound: only kind, scope and confidence route', () => {
    const base = verdict('implement', 'high', 'bounded', { complexity: 'trivial', compound: false });
    const opposite = verdict('implement', 'high', 'bounded', { complexity: 'frontier', compound: true });
    expect(adopt({ assessment: base })).toEqual(adopt({ assessment: opposite }));
  });
});

describe('adoptAssessment — high confidence', () => {
  it('permits one tier down for a bounded verdict — the reported regression', () => {
    expect(adopt({ assessment: verdict('lightweight', 'high', 'bounded') })).toEqual({
      dimension: 'lightweight',
      changed: true,
    });
  });

  it('caps downward movement at one tier from a permitted dimension', () => {
    expect(
      adopt({ heuristic: 'plan', assessment: verdict('lightweight', 'high', 'bounded') }),
    ).toEqual({ dimension: 'review', changed: true });
  });

  it('refuses downward movement from implement (NEVER_ROUTE_DOWN_FROM)', () => {
    expect(
      adopt({ heuristic: 'implement', assessment: verdict('lightweight', 'high', 'bounded') }),
    ).toEqual({ dimension: 'implement', changed: false });
  });

  it('keeps the heuristic on a high-confidence bounded same-dimension verdict', () => {
    expect(adopt({ assessment: verdict('gather', 'high', 'bounded') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });

  it('still routes up on a high-confidence bounded stronger verdict', () => {
    expect(adopt({ assessment: verdict('implement', 'high', 'bounded') })).toEqual({
      dimension: 'implement',
      changed: true,
    });
  });

  it('refuses downward movement without bounded scope', () => {
    expect(adopt({ assessment: verdict('lightweight', 'high', 'open-ended') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });

  it('never routes down from implement, at any confidence', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      expect(
        adopt({ heuristic: 'implement', assessment: verdict('gather', confidence, 'bounded') }),
      ).toEqual({ dimension: 'implement', changed: false });
    }
  });

  it('never routes down from review, at any confidence', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      expect(
        adopt({ heuristic: 'review', assessment: verdict('gather', confidence, 'bounded') }),
      ).toEqual({ dimension: 'review', changed: false });
    }
  });

  it('still routes up on a high-confidence stronger verdict', () => {
    expect(adopt({ assessment: verdict('plan', 'high', 'open-ended') })).toEqual({
      dimension: 'plan',
      changed: true,
    });
  });

  it('releases an ambiguity bump down to rawHeuristic on a high-confidence bounded verdict', () => {
    // Scenario: heuristic was bumped gather -> plan due to low confidence,
    // but the assessment confirms it is bounded gather work with high confidence.
    expect(
      adoptAssessment({
        heuristic: 'plan',
        rawHeuristic: 'gather',
        ambiguityBumped: true,
        assessment: verdict('gather', 'high', 'bounded'),
      }),
    ).toEqual({
      dimension: 'gather',
      changed: true,
    });
  });

  it('does not release to rawHeuristic when ambiguityBumped is false (e.g. embedding promotion)', () => {
    // An unbumped gather was promoted to plan by embedding. A high-confidence bounded
    // gather verdict can drop at most one tier (plan -> review), NOT down to rawHeuristic gather.
    expect(
      adoptAssessment({
        heuristic: 'plan',
        rawHeuristic: 'gather',
        ambiguityBumped: false,
        assessment: verdict('gather', 'high', 'bounded'),
      }),
    ).toEqual({
      dimension: 'review',
      changed: true,
    });
  });

});

describe('adoptAssessment — medium confidence', () => {
  it('routes up but never down', () => {
    expect(adopt({ assessment: verdict('implement', 'medium', 'open-ended') })).toEqual({
      dimension: 'implement',
      changed: true,
    });
    expect(adopt({ assessment: verdict('lightweight', 'medium', 'bounded') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });
});

describe('adoptAssessment — low confidence', () => {
  it('applies max(H, oneTierAbove(A))', () => {
    expect(adopt({ assessment: verdict('implement', 'low', 'open-ended') })).toEqual({
      dimension: 'review',
      changed: true,
    });
  });

  it('never drags a stronger heuristic down — uncertainty is non-decreasing', () => {
    expect(
      adopt({ heuristic: 'plan', assessment: verdict('lightweight', 'low', 'bounded') }),
    ).toEqual({ dimension: 'plan', changed: false });
  });
});
