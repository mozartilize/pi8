import { describe, expect, it } from 'vitest';
import { capabilityFit, capabilityTarget } from './mapping.js';

describe('absolute capability targets', () => {
  it('maps easy, middle and unknown demands independently on each benchmark scale', () => {
    expect(capabilityTarget('reasoning', 0)).toBeCloseTo(0.2);
    expect(capabilityTarget('reasoning', 0.5)).toBeCloseTo(0.375);
    expect(capabilityTarget('reasoning', 1)).toBeCloseTo(0.55);
    expect(capabilityTarget('agentic', 0.5)).toBeCloseTo(0.305);
    expect(capabilityTarget('research', 0.5)).toBeCloseTo(0.45);
    for (const axis of ['reasoning', 'agentic', 'research'] as const) {
      expect(capabilityTarget(axis, undefined)).toEqual(capabilityTarget(axis, 1));
      expect(capabilityTarget(axis, NaN)).toEqual(capabilityTarget(axis, 1));
      expect(capabilityTarget(axis, -1)).toEqual(capabilityTarget(axis, 0));
      expect(capabilityTarget(axis, 2)).toEqual(capabilityTarget(axis, 1));
    }
  });

  it('penalizes fixed shortfalls and stops rewarding surplus capability', () => {
    // Reasoning shortfall spans 0.15; these points straddle both clipping boundaries.
    expect(capabilityFit(0.39, 0.55, 'reasoning')).toBe(0);
    expect(capabilityFit(0.40, 0.55, 'reasoning')).toBeCloseTo(0);
    expect(capabilityFit(0.475, 0.55, 'reasoning')).toBeCloseTo(0.5);
    expect(capabilityFit(0.55, 0.55, 'reasoning')).toBe(1);
    expect(capabilityFit(0.70, 0.55, 'reasoning')).toBe(1);
    expect(capabilityFit(0.50, 0.60, 'agentic')).toBeCloseTo(0.5);
  });

  it('does not divide away differences between two actions below a rising target', () => {
    const gap = (target: number) => capabilityFit(0.5, target, 'reasoning') - capabilityFit(0.45, target, 'reasoning');
    expect(gap(0.51)).toBeCloseTo(1 / 3);
    expect(gap(0.55)).toBeCloseTo(1 / 3);
  });

  it('can select an intermediate capability when surplus earns no extra fit', () => {
    // The intermediate action is below the linear quality/cost convex hull.
    // Target fit lets it win at the middle demand without forcing a model identity.
    const actions = [{ q: 0.2, cost: 0 }, { q: 0.375, cost: 0.6 }, { q: 0.55, cost: 1 }];
    const winner = (d: number) => actions.map((a, i) => ({ i, score: capabilityFit(a.q, capabilityTarget('reasoning', d), 'reasoning') - 0.2 * a.cost }))
      .sort((a, b) => b.score - a.score)[0]!.i;
    expect([winner(0), winner(0.5), winner(1)]).toEqual([0, 1, 2]);
  });
});
