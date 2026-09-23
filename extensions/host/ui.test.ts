import { describe, it, expect } from 'vitest';
import { clearRouterStatus, formatStatus, formatDecisionDetail, formatAssessmentSpend, formatEmbeddingStats, servedKey } from './ui.js';
import { candidateKey } from '../routing/score/scorer.js';
import { multiWorkRoutingMeta } from '../test-support/router-fixtures.js';
import type { RoutingDecision } from '../types.js';

const decision: RoutingDecision = {
  dimension: 'implement',
  chosen: 'opencode-go/kimi-k2.7-code',
  reason: 'score 0.812 (quality 0.55, cost 0.21, speed 0.05)',
  confidence: 0.72,
  routedUp: false,
  routedDown: false,
  cause: 'heuristic',
  fallbackChain: ['opencode-go/kimi-k2.7-code', 'github-copilot/gpt-5.4', 'opencode-go/glm-5.2'],
};

describe('formatStatus', () => {
  it('names the model that actually served the turn', () => {
    const s = formatStatus(decision, {
      registryId: 'opencode-go/kimi-k2.7-code',
      thinkingLevel: 'high',
      viaFallback: false,
      accumulatedCost: 0.0123,
    });
    expect(s).toContain('opencode-go/kimi-k2.7-code');
    expect(s).toContain(':high');
    expect(s).toContain('implement');
    expect(s).not.toContain('$0.0123');
  });

  it('shows a specific unavailable status for an empty escalation chain', () => {
    const s = formatStatus({
      ...decision,
      reason: 'no valid escalation target from alpha/model:medium',
      fallbackChain: [],
    }, undefined);
    expect(s).toContain('unavailable');
    expect(s).toContain('no valid escalation target');
  });

  it('names the fallback, not the top pick, when the first choice failed', () => {
    const s = formatStatus(decision, {
      registryId: 'github-copilot/gpt-5.4',
      thinkingLevel: 'xmax',
      viaFallback: true,
      fallbackRank: 2,
      accumulatedCost: 0,
    });
    expect(s).toContain('github-copilot/gpt-5.4');
    expect(s).toContain(':xmax');
    expect(s).not.toContain('kimi');
    expect(s).toContain('(fallback #2)');
  });

  it('shows a waiting state before any turn is routed', () => {
    expect(formatStatus(undefined, undefined)).toContain('waiting');
  });

  it('distinguishes observed editing from the routed task type', () => {
    const served = { registryId: 'alpha/model', viaFallback: false, accumulatedCost: 0 };
    const plan = { ...decision, dimension: 'plan' as const, mutationObserved: true };
    expect(formatStatus(plan, served)).toContain('auto:plan · editing');
    expect(formatDecisionDetail(plan, served)).toContain('  phase:      editing');
    expect(formatStatus({ ...plan, dimension: 'implement' }, served)).not.toContain('· editing');
  });

  it('marks context-pressure decisions in the status line', () => {
    const s = formatStatus({ ...decision, contextPressure: { usageRatio: 0.6, threshold: 0.5, suggestion: 'offload' } }, {
      registryId: 'opencode-go/kimi-k2.7-code',
      thinkingLevel: 'high',
      viaFallback: false,
      accumulatedCost: 0,
    });
    expect(s).toContain('(context nearly full)');
  });
});

describe('formatEmbeddingStats', () => {
  it('derives kept = fired - promoted - abstainedLowConf', () => {
    const line = formatEmbeddingStats({ fired: 10, promoted: 4, abstainedLowConf: 3, degraded: 2 });
    expect(line).toContain('ran 10');
    expect(line).toContain('raised 4');
    expect(line).toContain('unchanged 3');
    expect(line).toContain('too unsure 3');
    expect(line).toContain('failed 2');
  });
});

describe('clearRouterStatus', () => {
  it('removes the footer entry instead of leaving a stale router decision', () => {
    const values: Array<string | undefined> = [];
    clearRouterStatus({ ui: { setStatus: (_key: string, value?: string) => values.push(value) } } as never);
    expect(values).toEqual([undefined]);
  });
});

describe('formatDecisionDetail', () => {
  it('distinguishes the top pick from the model that served', () => {
    const lines = formatDecisionDetail(decision, {
      registryId: 'github-copilot/gpt-5.4',
      thinkingLevel: 'high',
      viaFallback: true,
      accumulatedCost: 0.5,
    }).join('\n');
    expect(lines).toContain('Last turn served by: github-copilot/gpt-5.4:high');
    expect(lines).toContain('top pick:   opencode-go/kimi-k2.7-code');
    expect(lines).toContain('top pick failed');
    expect(lines).not.toContain('$0.5000');
  });

  it('reports the effective thinking level', () => {
    const lines = formatDecisionDetail(decision, {
      registryId: 'opencode-go/kimi-k2.7-code',
      thinkingLevel: 'high',
      viaFallback: false,
      accumulatedCost: 0,
    }).join('\n');
    expect(lines).toContain('thinking:   high');
  });

  it('reports off when no thinking level was resolved', () => {
    const lines = formatDecisionDetail(decision, {
      registryId: 'opencode-go/kimi-k2.7-code',
      viaFallback: false,
      accumulatedCost: 0,
    }).join('\n');
    expect(lines).toContain('thinking:   off');
  });

  it('explains the decision cause without changing its stored value', () => {
    const causes = [
      ['context-depth', 'long conversation raised the task type'],
      ['router-consult', 'LLM assessment'],
      ['manual-override', 'manual pin'],
      ['trajectory-escalation', 'stronger model, because the previous one struggled'],
    ] as const;
    for (const [cause, label] of causes) {
      const routed = { ...decision, cause };
      expect(formatDecisionDetail(routed, undefined).join('\n')).toContain(`cause:      ${label}`);
      expect(routed.cause).toBe(cause);
    }
  });

  it('adds explicit detail for no-data decisions', () => {
    const lines = formatDecisionDetail(
      { ...decision, cause: 'no-data', reason: 'scored 0.123 [no benchmark quality data]' },
      { registryId: 'opencode-go/kimi-k2.7-code', viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(lines).toContain('cause:      no benchmark data; ranked by price and context window');
    expect(lines).toMatch(/no benchmark quality data/i);
  });

  it('renders demoted and promoted candidates with their reasons', () => {
    const lines = formatDecisionDetail(
      {
        ...decision,
        candidateDiagnostics: [
          { candidateKey: 'cheap/model', excludedReason: 'promoted' },
          { candidateKey: 'weak/model', excludedReason: 'below-task-floor' },
        ],
      },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');

    expect(lines).toContain('promoted:   cheap/model (much cheaper and strong enough)');
    expect(lines).toContain('demoted:    weak/model (too weak for this task type)');
  });

  it('shows the final step, its required model level, and the current phase for engaged multi-work decisions', () => {
    const lines = formatDecisionDetail(
      { ...decision, multiWork: multiWorkRoutingMeta({ phase: 'inspect', providerInvocation: 2 }) },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(lines).toContain(
      'final step: implement, hard complexity, needs a frontier-level model; now investigating (provider call 2)',
    );
  });

  it('reports the actual served capability ratio, or unknown without a task ratio', () => {
    const withRatio = formatDecisionDetail(
      {
        ...decision,
        multiWork: multiWorkRoutingMeta({
          servedCandidateKey: decision.chosen,
          servedCapability: { taskRatio: 0.72, clearsTerminalFloor: true, viaInspectPromotion: false },
        }),
      },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(withRatio).toContain('served:     72% of the strongest model; strong enough for the final step');

    const withoutRatio = formatDecisionDetail(
      {
        ...decision,
        multiWork: multiWorkRoutingMeta({
          servedCandidateKey: decision.chosen,
          servedCapability: { clearsTerminalFloor: 'unknown', viaInspectPromotion: false },
        }),
      },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(withoutRatio).toContain('served:     strength unknown; unknown whether strong enough for the final step');
  });

  it('reports a mutation-gate escape and capability degradation only when present', () => {
    const escaped = formatDecisionDetail(
      {
        ...decision,
        multiWork: multiWorkRoutingMeta({
          gateBlockedInvocation: 2,
          mutationGateEscaped: true,
          capabilityDegraded: true,
        }),
      },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(escaped).toContain('edits:      held at provider call 2, then allowed without a strong enough model');

    const clean = formatDecisionDetail(
      { ...decision, multiWork: multiWorkRoutingMeta() },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(clean).not.toContain('edits:');
  });

  it('adds advisory detail for context pressure', () => {
    const lines = formatDecisionDetail(
      {
        ...decision,
        contextPressure: {
          usageRatio: 0.68,
          threshold: 0.6,
          suggestion: 'handoff planning to a fresh planner',
        },
      },
      {
        registryId: 'opencode-go/kimi-k2.7-code',
        viaFallback: false,
        accumulatedCost: 0,
      },
    ).join('\n');
    expect(lines).toContain('context 68% full (advice starts at 60%)');
    expect(lines).toContain('handoff planning to a fresh planner');
  });

  it('is explicit when nothing has been routed yet', () => {
    expect(formatDecisionDetail(undefined, undefined).join('\n')).toMatch(/none yet/i);
  });
});

import { notifyRouting } from './ui.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

describe('notifyRouting', () => {
  function capture() {
    const msgs: Array<[string, string | undefined]> = [];
    const ctx = { ui: { notify: (m: string, t?: string) => msgs.push([m, t]) } } as unknown as ExtensionContext;
    return { ctx, msgs };
  }

  it('appends the thinking level to the served model', () => {
    const { ctx, msgs } = capture();
    notifyRouting(ctx, decision, {
      registryId: 'github-copilot/claude-sonnet-5',
      thinkingLevel: 'high',
      viaFallback: false,
      accumulatedCost: 0,
    });
    expect(msgs[0][0]).toContain('github-copilot/claude-sonnet-5:high');
    expect(msgs[0][0]).toContain('(implement)');
  });

  it('omits the level suffix when thinking is off/absent', () => {
    const { ctx, msgs } = capture();
    notifyRouting(ctx, decision, { registryId: 'a/b', thinkingLevel: 'off', viaFallback: false, accumulatedCost: 0 });
    notifyRouting(ctx, decision, { registryId: 'c/d', viaFallback: false, accumulatedCost: 0 });
    expect(msgs[0][0]).toContain('a/b ');
    expect(msgs[0][0]).not.toContain('a/b:');
    expect(msgs[1][0]).not.toContain('c/d:');
  });
});

describe('assessment in /router-why', () => {
  const decisionWith = (over: Partial<RoutingDecision> = {}): RoutingDecision => ({
    ...decision,
    ...over,
  });

  const served = () => ({
    registryId: 'opencode-go/kimi-k2.7-code',
    thinkingLevel: 'high' as const,
    viaFallback: false,
    accumulatedCost: 0.0123,
  });

  const validAssessment = () => ({
    kind: 'lightweight' as const,
    complexity: 'trivial' as const,
    scope: 'bounded' as const,
    compound: false,
    confidence: 'high' as const,
    reasoning: 'a bounded extraction from one named file',
    model: 'test/assessor',
    ms: 380,
    usage: { input: 800, output: 24 },
    costUsd: 0.0003,
  });

  it('renders a direction change with the assessment verdict', () => {
    const lines = formatDecisionDetail(
      decisionWith({
        dimension: 'lightweight',
        routedDown: true,
        routedPickChanged: true,
        cause: 'router-consult',
        assessment: validAssessment(),
      }),
      served(),
    );

    expect(lines.join('\n')).toContain(
      'assessment: lightweight, trivial complexity, limited scope, single step, high confidence',
    );
    expect(lines.join('\n')).toContain('a bounded extraction from one named file');
    expect(lines.join('\n')).toContain('task type lowered by the assessment, so a cheaper model served');
  });

  it('reports a skipped long-conversation upgrade', () => {
    const lines = formatDecisionDetail(
      decisionWith({ assessment: { ...validAssessment(), vetoedLatch: true } }),
      served(),
    );
    expect(lines.join('\n')).toContain('long-conversation upgrade skipped');
  });

  it('reports why the assessment was unavailable', () => {
    const lines = formatDecisionDetail(decisionWith({ fallbackReason: 'no-assessor' }), served());
    expect(lines.join('\n')).toContain('assessment unavailable (no model available to assess)');
  });

  it('shows assessment spend beside routed spend', () => {
    expect(formatAssessmentSpend(0.0123)).toContain('0.0123');
  });

  it('marks a downward route in the status widget', () => {
    expect(formatStatus(decisionWith({ routedDown: true, routedPickChanged: true }), served())).toContain('(downgraded)');
  });

  it('suppresses the upgraded label when the raise did not change the served model', () => {
    // Dimension was raised (routedUp) but the heuristic dimension would have
    // picked the same model, so nothing stronger was served: no label.
    const status = formatStatus(
      decisionWith({ routedUp: true, routedPickChanged: false }),
      served(),
    );
    expect(status).not.toContain('(upgraded)');
    const detail = formatDecisionDetail(
      decisionWith({ routedUp: true, routedPickChanged: false, cause: 'context-depth' }),
      served(),
    ).join('\n');
    expect(detail).not.toContain('so a stronger model served');
    expect(detail).toContain('no stronger model was available');
  });

  it('shows the upgraded label when the raise changed the served model', () => {
    expect(
      formatStatus(decisionWith({ routedUp: true, routedPickChanged: true }), served()),
    ).toContain('(upgraded)');
  });
});

describe('servedKey', () => {
  // The served identity is matched against the candidate pool (capability
  // handoff), bound to the trajectory owner, and persisted to the decision log.
  // All three compare it to `candidateKey` output, so the two encodings must
  // stay equivalent for the same (model, effort) identity.
  it('mirrors candidateKey for the same identity, with and without effort', () => {
    expect(servedKey({ registryId: 'alpha/model', thinkingLevel: 'high' }))
      .toBe(candidateKey({ registryId: 'alpha/model', effort: 'high' }));
    expect(servedKey({ registryId: 'alpha/model' })).toBe(candidateKey({ registryId: 'alpha/model' }));
  });
});
