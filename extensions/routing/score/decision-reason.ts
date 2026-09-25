import type { RoutingDecision } from '../../types.js';

export interface ScoredReason {
  score: number;
  quality: number;
  cost: number;
  speed: number;
  costBasis: 'task' | 'per-1m';
  upgraded: boolean;
  details: ReasonDetail[];
}

export type ReasonDetail =
  | { kind: 'incumbent-model' }
  | { kind: 'incumbent-capability' }
  | { kind: 'incumbent-effort' }
  | { kind: 'context-pressure' }
  | { kind: 'no-data' }
  | { kind: 'trajectory'; fromModel: string }
  | { kind: 'assessment'; task: string; scope: 'bounded' | 'open-ended'; confidence: string };

function renderDetail(detail: ReasonDetail): string {
  switch (detail.kind) {
    case 'incumbent-model': return 'kept current model: stronger for this task';
    case 'incumbent-capability': return 'kept current capability with another model';
    case 'incumbent-effort': return "kept current model's thinking level";
    case 'context-pressure': return 'context nearly full: prefer a fresh planner subagent';
    case 'no-data': return 'no benchmark quality data';
    case 'trajectory': return `${detail.fromModel} struggled: stronger model`;
    case 'assessment': return `assessment: ${detail.task}, ${detail.scope === 'bounded' ? 'limited' : 'open-ended'} scope, ${detail.confidence} confidence`;
  }
}

export function renderScoredReason(reason: ScoredReason): string {
  const { score, quality, cost, speed, costBasis, upgraded, details } = reason;
  return `score ${score.toFixed(3)} (quality ${quality.toFixed(2)}, cost ${cost.toFixed(2)}, speed ${speed.toFixed(2)}) [cost ${costBasis === 'task' ? 'per task' : 'per 1M tokens'}]${upgraded ? ' [upgraded]' : ''}${details.map((detail) => ` [${renderDetail(detail)}]`).join('')}`;
}

export function addReasonDetail(decision: RoutingDecision, detail: ReasonDetail): void {
  if (decision.scoredReason) {
    decision.scoredReason.details.push(detail);
    decision.reason = renderScoredReason(decision.scoredReason);
  } else {
    // Decisions supplied by callers outside the scorer still have a free-text reason.
    decision.reason += ` [${renderDetail(detail)}]`;
  }
}
