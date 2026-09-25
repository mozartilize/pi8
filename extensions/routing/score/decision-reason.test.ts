import { describe, expect, it } from 'vitest';
import type { RoutingDecision } from '../../types.js';
import { addReasonDetail, renderScoredReason, type ScoredReason } from './decision-reason.js';

const base: ScoredReason = {
  score: 0.8124, quality: 0.55, cost: 0.21, speed: 0.05,
  costBasis: 'task', upgraded: false, details: [],
};

function decision(scoredReason?: ScoredReason): RoutingDecision {
  return {
    dimension: 'implement', chosen: 'test/model',
    reason: scoredReason ? renderScoredReason(scoredReason) : 'manual selection',
    ...(scoredReason ? { scoredReason } : {}),
    confidence: 0.8, routedUp: false, routedDown: false,
    cause: 'heuristic', fallbackChain: ['test/model'],
  };
}

describe('scored decision reasons', () => {
  it('renders the score and typed policy details in insertion order', () => {
    const routed = decision({ ...base, details: [] });
    addReasonDetail(routed, { kind: 'incumbent-effort' });
    addReasonDetail(routed, { kind: 'context-pressure' });
    addReasonDetail(routed, { kind: 'assessment', task: 'implement', scope: 'bounded', confidence: 'high' });
    expect(routed.reason).toBe(
      "score 0.812 (quality 0.55, cost 0.21, speed 0.05) [cost per task]" +
      " [kept current model's thinking level]" +
      ' [context nearly full: prefer a fresh planner subagent]' +
      ' [assessment: implement, limited scope, high confidence]',
    );
    expect(routed.reason).toBe(renderScoredReason(routed.scoredReason!));
    expect(routed.scoredReason?.details.map((detail) => detail.kind)).toEqual([
      'incumbent-effort', 'context-pressure', 'assessment',
    ]);
  });

  it('keeps free-text decisions usable for manual and caller-supplied choices', () => {
    const routed = decision();
    addReasonDetail(routed, { kind: 'no-data' });
    expect(routed.reason).toBe('manual selection [no benchmark quality data]');
    expect(routed.scoredReason).toBeUndefined();
  });
});
