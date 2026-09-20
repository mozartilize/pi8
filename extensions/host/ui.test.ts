import { describe, it, expect } from 'vitest';
import { clearRouterStatus, formatStatus, formatDecisionDetail, formatAssessmentSpend, formatEmbeddingStats } from './ui.js';
import { multiWorkRoutingMeta } from '../test-support/router-fixtures.js';
import type { RoutingDecision } from '../types.js';

const decision: RoutingDecision = {
  dimension: 'implement',
  chosen: 'opencode-go/kimi-k2.7-code',
  reason: 'scored 0.812 (q:0.55 c:0.21 s:0.05)',
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
    expect(s).toMatch(/\(FALLBACK 2!\)/);
  });

  it('shows a waiting state before any turn is routed', () => {
    expect(formatStatus(undefined, undefined)).toContain('waiting');
  });

  it('marks context-pressure decisions in the status line', () => {
    const s = formatStatus({ ...decision, contextPressure: { usageRatio: 0.6, threshold: 0.5, suggestion: 'offload' } }, {
      registryId: 'opencode-go/kimi-k2.7-code',
      thinkingLevel: 'high',
      viaFallback: false,
      accumulatedCost: 0,
    });
    expect(s).toContain('context-pressure');
  });
});

describe('formatEmbeddingStats', () => {
  it('derives kept = fired - promoted - abstainedLowConf', () => {
    const line = formatEmbeddingStats({ fired: 10, promoted: 4, abstainedLowConf: 3, degraded: 2 });
    expect(line).toContain('fired 10');
    expect(line).toContain('promoted 4');
    expect(line).toContain('kept 3');
    expect(line).toContain('abstained-lowconf 3');
    expect(line).toContain('degraded 2');
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

  it('adds explicit detail for no-data decisions', () => {
    const lines = formatDecisionDetail(
      { ...decision, cause: 'no-data', reason: 'scored 0.123 [no benchmark quality data]' },
      { registryId: 'opencode-go/kimi-k2.7-code', viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(lines).toMatch(/no-data/i);
    expect(lines).toMatch(/no benchmark quality data/i);
  });

  it('renders candidate gate diagnostics', () => {
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

    expect(lines).toContain('gate:       cheap/model promoted');
    expect(lines).toContain('gate:       weak/model below-task-floor');
  });

  it('shows terminal kind/band and phase for engaged multi-work decisions', () => {
    const lines = formatDecisionDetail(
      { ...decision, multiWork: multiWorkRoutingMeta({ phase: 'inspect', providerInvocation: 2 }) },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(lines).toContain('terminal:   implement/hard, frontier band, phase inspect (invocation 2)');
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
    expect(withRatio).toContain('served-cap: ratio 0.72, clears floor: true');

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
    expect(withoutRatio).toContain('served-cap: ratio unknown, clears floor: unknown');
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
    expect(escaped).toContain('gate:       blocked invocation 2, escaped (capability degraded)');

    const clean = formatDecisionDetail(
      { ...decision, multiWork: multiWorkRoutingMeta() },
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0 },
    ).join('\n');
    expect(clean).not.toContain('escaped');
    expect(clean).not.toContain('capability degraded');
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
    expect(lines).toContain('context pressure 68% >= 60%');
    expect(lines).toContain('handoff planning to a fresh planner');
  });

  it('is explicit when nothing has been routed yet', () => {
    expect(formatDecisionDetail(undefined, undefined).join('\n')).toMatch(/none yet/i);
  });
});

import { notifyRouting, notifyEscalation } from './ui.js';
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

describe('notifyEscalation', () => {
  it('names the target dimension and reason', () => {
    const msgs: Array<[string, string | undefined]> = [];
    const ctx = { ui: { notify: (m: string, t?: string) => msgs.push([m, t]) } } as unknown as ExtensionContext;
    notifyEscalation(ctx, 'plan', 'needs architecture');
    expect(msgs[0][0]).toMatch(/route_up → plan/);
    expect(msgs[0][0]).toContain('needs architecture');
    expect(msgs[0][1]).toBe('info');
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

    expect(lines.join('\n')).toContain('assessment: lightweight/trivial/bounded, compound=no, high');
    expect(lines.join('\n')).toContain('a bounded extraction from one named file');
    expect(lines.join('\n')).toContain('routed down');
  });

  it('reports the latch veto when one occurred', () => {
    const lines = formatDecisionDetail(
      decisionWith({ assessment: { ...validAssessment(), vetoedLatch: true } }),
      served(),
    );
    expect(lines.join('\n')).toContain('depth escalation vetoed');
  });

  it('reports why the assessment was unavailable', () => {
    const lines = formatDecisionDetail(decisionWith({ fallbackReason: 'no-assessor' }), served());
    expect(lines.join('\n')).toContain('assessment unavailable (no-assessor)');
  });

  it('shows assessment spend beside routed spend', () => {
    expect(formatAssessmentSpend(0.0123)).toContain('0.0123');
  });

  it('marks a downward route in the status widget', () => {
    expect(formatStatus(decisionWith({ routedDown: true, routedPickChanged: true }), served())).toContain('routed-down');
  });

  it('suppresses the routed-up label when the raise did not change the served model', () => {
    // Dimension was raised (routedUp) but the heuristic dimension would have
    // picked the same model, so nothing stronger was served: no label.
    const status = formatStatus(
      decisionWith({ routedUp: true, routedPickChanged: false }),
      served(),
    );
    expect(status).not.toContain('routed-up');
    const detail = formatDecisionDetail(
      decisionWith({ routedUp: true, routedPickChanged: false, cause: 'context-depth' }),
      served(),
    ).join('\n');
    expect(detail).not.toContain('routed up');
    expect(detail).toContain('served model was already the top pick');
  });

  it('shows the routed-up label when the raise changed the served model', () => {
    expect(
      formatStatus(decisionWith({ routedUp: true, routedPickChanged: true }), served()),
    ).toContain('routed-up');
  });
});
