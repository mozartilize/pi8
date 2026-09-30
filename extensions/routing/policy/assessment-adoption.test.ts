import { describe, expect, it } from 'vitest';
import { adoptAssessment, oneTierAbove, oneTierBelow } from './assessment-adoption.js';
import type { Dimension, TaskScope } from '../../types.js';

const verdict = (kind: Dimension | 'unknown', scope: TaskScope) => ({ kind, scope });

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

describe('adoptAssessment — UNKNOWN', () => {
  it('keeps the heuristic, never lower and never guessed higher', () => {
    for (const heuristic of ['lightweight', 'gather', 'plan', 'implement', 'review'] as const) {
      expect(adopt({ heuristic, assessment: verdict('unknown', 'bounded') })).toEqual({ dimension: heuristic, changed: false });
    }
  });

  it('never releases an ambiguity bump', () => {
    expect(adoptAssessment({
      heuristic: 'plan', rawHeuristic: 'gather', ambiguityBumped: true, assessment: verdict('unknown', 'bounded'),
    })).toEqual({ dimension: 'plan', changed: false });
  });
});

describe('adoptAssessment — categorical verdict', () => {
  it('permits one tier down for a bounded verdict', () => {
    expect(adopt({ assessment: verdict('lightweight', 'bounded') })).toEqual({
      dimension: 'lightweight',
      changed: true,
    });
  });

  it('caps downward movement at one tier from a permitted dimension', () => {
    expect(
      adopt({ heuristic: 'plan', assessment: verdict('lightweight', 'bounded') }),
    ).toEqual({ dimension: 'review', changed: true });
  });

  it('keeps the heuristic on a bounded same-dimension verdict', () => {
    expect(adopt({ assessment: verdict('gather', 'bounded') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });

  it('routes up on a stronger verdict, bounded or not', () => {
    expect(adopt({ assessment: verdict('implement', 'bounded') })).toEqual({ dimension: 'implement', changed: true });
    expect(adopt({ assessment: verdict('plan', 'open-ended') })).toEqual({ dimension: 'plan', changed: true });
  });

  it('refuses downward movement without bounded scope', () => {
    expect(adopt({ assessment: verdict('lightweight', 'open-ended') })).toEqual({
      dimension: 'gather',
      changed: false,
    });
  });

  it('never routes down from implement or review', () => {
    for (const heuristic of ['implement', 'review'] as const) {
      for (const scope of ['bounded', 'open-ended'] as const) {
        expect(
          adopt({ heuristic, assessment: verdict('gather', scope) }),
        ).toEqual({ dimension: heuristic, changed: false });
      }
    }
  });

  it('releases an ambiguity bump down to rawHeuristic on a bounded verdict', () => {
    // The heuristic was bumped gather -> plan for low keyword confidence; a
    // bounded gather verdict releases that bump.
    expect(
      adoptAssessment({
        heuristic: 'plan',
        rawHeuristic: 'gather',
        ambiguityBumped: true,
        assessment: verdict('gather', 'bounded'),
      }),
    ).toEqual({
      dimension: 'gather',
      changed: true,
    });
  });

  it('does not release to rawHeuristic when ambiguityBumped is false', () => {
    // A heuristic plan raised from gather by anything but the ambiguity bump.
    // A bounded gather verdict drops at most one tier (plan -> review), not
    // down to rawHeuristic gather.
    expect(
      adoptAssessment({
        heuristic: 'plan',
        rawHeuristic: 'gather',
        ambiguityBumped: false,
        assessment: verdict('gather', 'bounded'),
      }),
    ).toEqual({
      dimension: 'review',
      changed: true,
    });
  });
});
