import { describe, expect, it } from 'vitest';
import { composeTaskDemand } from './task-demand.js';
import type { TaskSnapshot } from './state.js';

const task = (patch: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  phase: 'implement', estimatedContextTokens: 10_000, needsVision: false, ...patch,
});

describe('composeTaskDemand', () => {
  it('unknown difficulty keeps the whole demand range on every axis', () => {
    const result = composeTaskDemand(task());
    for (const axis of ['reasoning', 'agentic', 'research'] as const) {
      expect(result.demand[axis]).toEqual({ center: 0.5, lower: 0, upper: 1 });
    }
    expect(result.details).toEqual({ difficulty: 'difficulty:unknown', openDecisions: 'openDecisions:unknown' });
  });

  it('a declared difficulty bounds the targets on the axis scale', () => {
    const result = composeTaskDemand(task({
      difficulty: { value: 0.5, axes: { reasoning: 0, agentic: 0.5, research: 1 }, source: 'execution-rubric' },
    }));
    // Targets: easy + (hard - easy) * demand. Reasoning [0.2, 0.55], agentic [0.01, 0.6], research [0.25, 0.65].
    expect(result.targets.reasoning.center).toBeCloseTo(0.2, 12);
    expect(result.targets.agentic.center).toBeCloseTo(0.305, 12);
    expect(result.targets.research.center).toBeCloseTo(0.65, 12);
  });

  it('collecting context fixes the reasoning target and requires intelligence evidence only', () => {
    const result = composeTaskDemand(task({ phase: 'gather', contextAcquisition: true }));
    expect(result.collecting).toBe(true);
    expect(result.targets.reasoning).toEqual({ center: 0.2, lower: 0.2, upper: 0.2 });
    expect(result.requiredEvidence).toEqual(['intelligence']);
    expect(composeTaskDemand(task({ phase: 'plan', contextAcquisition: true })).collecting).toBe(false);
  });

  it('open decisions raise reasoning relevance, and only when observed above zero', () => {
    expect(composeTaskDemand(task({ openDecisions: 2 })).relevance.reasoning).toBe(0.9);
    expect(composeTaskDemand(task({ openDecisions: 0 })).relevance.reasoning).toBe(0.6);
    expect(composeTaskDemand(task({ phase: 'plan', openDecisions: 2 })).relevance.reasoning).toBe(1);
  });

  it('measured workload adds input relevance at the long-context size and for images', () => {
    expect(composeTaskDemand(task({ estimatedContextTokens: 63_999 })).longContext).toBe(false);
    const both = composeTaskDemand(task({ estimatedContextTokens: 64_000, needsVision: true }));
    expect(both.longContext).toBe(true);
    expect(both.vision).toBe(true);
    expect(both.requiredEvidence).toEqual(expect.arrayContaining(['visionReasoning', 'longContext']));
  });
});
