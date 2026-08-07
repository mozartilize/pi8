import { describe, expect, it } from 'vitest';
import { adoptAssessment, shouldVetoLatch, oneTierAbove, oneTierBelow } from './assessment-adoption.js';
import type { AssessmentConfidence, AssessmentScope, Dimension, RoutingAssessment } from './types.js';

const verdict = (
  dimension: Dimension,
  confidence: AssessmentConfidence,
  scope: AssessmentScope,
): RoutingAssessment => ({
  dimension,
  scope,
  outcome: 'extract',
  confidence,
  reasoning: 'test',
  model: 'test/assessor',
  ms: 100,
  usage: { input: 100, output: 20 },
  costUsd: 0.0001,
});

const active = (over: Partial<Parameters<typeof adoptAssessment>[0]>) =>
  adoptAssessment({ heuristic: 'gather', mode: 'active', latchEngaged: false, ...over });

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

describe('adoptAssessment — shadow mode', () => {
  it('never changes the dimension regardless of the verdict', () => {
    const result = adoptAssessment({
      heuristic: 'gather',
      assessment: verdict('lightweight', 'high', 'bounded'),
      mode: 'shadow',
      latchEngaged: false,
    });
    expect(result).toEqual({ dimension: 'gather', changed: false });
  });

  it('never changes the dimension for an upward verdict either', () => {
    const result = adoptAssessment({
      heuristic: 'gather',
      assessment: verdict('implement', 'high', 'open-ended'),
      mode: 'shadow',
      latchEngaged: false,
    });
    expect(result).toEqual({ dimension: 'gather', changed: false });
  });
});

describe('adoptAssessment — unavailable', () => {
  it('keeps the heuristic when no assessment exists', () => {
    expect(active({ assessment: undefined })).toEqual({ dimension: 'gather', changed: false });
  });
});

describe('adoptAssessment — high confidence', () => {
  it('permits one tier down for a bounded verdict — the reported regression', () => {
    expect(active({ assessment: verdict('lightweight', 'high', 'bounded') })).toEqual({
      dimension: 'lightweight',
      changed: true,
    });
  });

  it('caps downward movement at one tier from a permitted dimension', () => {
    expect(
      active({ heuristic: 'plan', assessment: verdict('lightweight', 'high', 'bounded') }),
    ).toEqual({ dimension: 'review', changed: true });
  });

  it('refuses downward movement from implement (NEVER_ROUTE_DOWN_FROM)', () => {
    expect(
      active({ heuristic: 'implement', assessment: verdict('lightweight', 'high', 'bounded') }),
    ).toEqual({ dimension: 'implement', changed: false });
  });

  it('keeps the heuristic on a high-confidence bounded same-dimension verdict', () => {
    expect(active({ assessment: verdict('gather', 'high', 'bounded') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });

  it('still routes up on a high-confidence bounded stronger verdict', () => {
    expect(active({ assessment: verdict('implement', 'high', 'bounded') })).toEqual({
      dimension: 'implement',
      changed: true,
    });
  });

  it('refuses downward movement without bounded scope', () => {
    expect(active({ assessment: verdict('lightweight', 'high', 'open-ended') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });

  it('never routes down from implement, at any confidence', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      expect(
        active({ heuristic: 'implement', assessment: verdict('gather', confidence, 'bounded') }),
      ).toEqual({ dimension: 'implement', changed: false });
    }
  });

  it('never routes down from review, at any confidence', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      expect(
        active({ heuristic: 'review', assessment: verdict('gather', confidence, 'bounded') }),
      ).toEqual({ dimension: 'review', changed: false });
    }
  });

  it('refuses downward movement while the depth latch is engaged', () => {
    expect(
      adoptAssessment({
        heuristic: 'gather',
        assessment: verdict('lightweight', 'high', 'bounded'),
        mode: 'active',
        latchEngaged: true,
      }),
    ).toEqual({ dimension: 'gather', changed: false });
  });

  it('still routes up on a high-confidence stronger verdict', () => {
    expect(active({ assessment: verdict('plan', 'high', 'open-ended') })).toEqual({
      dimension: 'plan',
      changed: true,
    });
  });
});

describe('adoptAssessment — medium confidence', () => {
  it('routes up but never down', () => {
    expect(active({ assessment: verdict('implement', 'medium', 'open-ended') })).toEqual({
      dimension: 'implement',
      changed: true,
    });
    expect(active({ assessment: verdict('lightweight', 'medium', 'bounded') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });
});

describe('adoptAssessment — low confidence', () => {
  it('applies max(H, oneTierAbove(A))', () => {
    expect(active({ assessment: verdict('implement', 'low', 'open-ended') })).toEqual({
      dimension: 'review',
      changed: true,
    });
  });

  it('never drags a stronger heuristic down — uncertainty is non-decreasing', () => {
    expect(
      active({ heuristic: 'plan', assessment: verdict('lightweight', 'low', 'bounded') }),
    ).toEqual({ dimension: 'plan', changed: false });
  });
});

describe('shouldVetoLatch', () => {
  it('vetoes on a high-confidence bounded verdict', () => {
    expect(shouldVetoLatch(verdict('gather', 'high', 'bounded'))).toBe(true);
  });

  it('does not veto on medium confidence', () => {
    expect(shouldVetoLatch(verdict('gather', 'medium', 'bounded'))).toBe(false);
  });

  it('does not veto on an open-ended verdict', () => {
    expect(shouldVetoLatch(verdict('gather', 'high', 'open-ended'))).toBe(false);
  });

  it('does not veto when the assessment is unavailable — failure is up', () => {
    expect(shouldVetoLatch(undefined)).toBe(false);
  });
});
