import { afterEach, describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { setDebugPath } from './debuglog.js';
import { clearRouterStatus, renderDebugEntry, formatStatus, formatDecisionDetail, servedKey, preferenceBinding } from './ui.js';
import { candidateKey } from '../routing/score/scorer.js';
import type { RoutingDecision } from '../types.js';

const decision: RoutingDecision = {
  dimension: 'implement',
  chosen: 'opencode-go/kimi-k2.7-code',
  reason: 'score 0.812 (quality 0.55, cost 0.21, speed 0.05)',
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

  it('shows an investigation and its handoff in plain language', () => {
    const served = { registryId: 'alpha/model', viaFallback: false, accumulatedCost: 0 };
    const investigating = {
      ...decision, dimension: 'gather' as const, cause: 'investigation' as const, deliverable: 'plan' as const,
    };
    expect(formatStatus(investigating, served)).toContain('auto:gather · collecting context');
    expect(formatDecisionDetail(investigating, served)).toContain('  cause:      collecting context, read-only, before the deliverable');
    expect(formatDecisionDetail(investigating, served)).toContain('  handoff:    collecting context (deliverable plan)');
    const handoff = {
      id: 'k', requester: 'alpha/model', target: 'plan' as const,
      rubric: { alternatives: 3, stakes: 2, spread: 1, knowledge: 1, uncertainty: 1 },
      evidence: { applicable: false, files: 0, directories: 0 }, pending: true,
    };
    const planning = { ...decision, dimension: 'plan' as const, cause: 'investigation-handoff' as const, reasoningHandoff: handoff };
    expect(formatDecisionDetail(planning, served)).toContain('  handoff:    planning, pending');
    const owned = { ...planning, reasoningHandoff: { ...handoff, pending: false, owner: 'beta/planner' } };
    expect(formatDecisionDetail(owned, served)).toContain('  handoff:    planning, owned by beta/planner');
  });

  it('explains an execution plan handoff and its return to the submitter', () => {
    const served = { registryId: 'alpha/cheap', viaFallback: false, accumulatedCost: 0 };
    const base = { ...decision, cause: 'execution-contract' as const };
    const valued = {
      rubric: { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 },
      measured: { files: 1, directories: 1, steps: 2, testTargets: 0 },
    };
    const active = formatDecisionDetail({
      ...base,
      executionContract: {
        status: 'active', release: true, submitter: 'beta/strong', targets: 1, steps: 2,
        ...valued,
      },
    }, served);
    expect(active).toContain('  cause:      routed by an accepted execution plan');
    expect(active).toContain('  plan:       accepted (1 file, 2 steps); an executor model runs it');
    const broken = formatDecisionDetail({
      ...decision,
      executionContract: {
        status: 'broken', release: true, submitter: 'beta/strong', targets: 1, steps: 2,
        breakReason: 'undeclared-target', breaker: 'alpha/cheap', excludedExecutors: ['alpha/cheap'], ...valued,
      },
    }, served);
    expect(broken).toContain('  plan:       broken: alpha/cheap edited a file outside the plan; back to beta/strong');
    expect(broken).toContain('  excluded:   alpha/cheap (failed two plans)');
    const executed = formatDecisionDetail({
      ...decision,
      executionContract: {
        status: 'executed', release: true, submitter: 'beta/strong', targets: 1, steps: 2,
        executor: 'alpha/cheap', executedReason: 'complete', ...valued,
      },
    }, served);
    expect(executed).toContain('  plan:       executed by alpha/cheap; beta/strong reviews it');
    const kept = formatDecisionDetail({
      ...decision,
      executionContract: {
        status: 'active', release: false, keepReason: 'open-decisions', submitter: 'beta/strong',
        targets: 1, steps: 2, ...valued,
      },
    }, served);
    expect(kept).toContain('  plan:       accepted (1 file, 2 steps); beta/strong keeps running it: it leaves a choice open');
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

  it('explains the ranking, next action, and feature values of a unified decision', () => {
    const lines = formatDecisionDetail({
      ...decision,
      unified: {
        solver: 'exact',
        domainStatus: 'ready',
        constraintsEnforced: true,
        profileDigest: 'p',
        featureSchemaDigest: 'f',
        ranked: 3,
        insufficientEvidence: 0,
        holdingPrompt: 2,
        top: [
          {
            key: 'beta/cheap:low',
            rank: 1,
            capabilityShortfall: 0,
            maxRegret: 0.12,
            features: { costDesirability: 0.66, reasoningFit: 1 },
            evidenceGaps: [],
          },
          {
            key: 'alpha/strong:low',
            rank: 2,
            capabilityShortfall: 0,
            maxRegret: 0.15,
            features: { costDesirability: 0.4, reasoningFit: 1 },
            evidenceGaps: [],
            costUsd: { central: 0.006 },
          },
        ],
      },
    }, {
      registryId: 'beta/cheap',
      thinkingLevel: 'low',
      viaFallback: false,
      accumulatedCost: 0,
    }).join('\n');
    expect(lines).toContain('ranking:    minimax regret, 3 actions; binding applied');
    expect(lines).toContain('solver:     exact');
    expect(lines).toContain('next:       alpha/strong:low  shortfall 0  regret 0.15  $0.006');
    expect(lines).toContain('features:   costDesirability 0.66, reasoningFit 1');
  });

  it('names applied, none, softened, and fallback-inoperative preference binding', () => {
    const base = {
      solver: 'exact' as const,
      domainStatus: 'ready',
      constraintsEnforced: true,
      profileDigest: 'p',
      featureSchemaDigest: 'f',
      ranked: 2,
      insufficientEvidence: 0,
      holdingPrompt: 2,
    };
    expect(preferenceBinding({ ...base, domainMode: 'hard' })).toBe('applied');
    expect(preferenceBinding({ ...base, domainMode: 'base' })).toBe('none');
    expect(preferenceBinding({ ...base, domainMode: 'min-slack', totalSlack: 1 })).toBe('softened (slack 1)');
    expect(preferenceBinding({
      ...base,
      solver: 'fallback-central',
      solverFallbackReason: 'timeout',
      constraintsEnforced: false,
    })).toBe('not applied (timeout)');
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
      ['router-consult', 'task type adopted from a context handoff'],
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

describe('renderDebugEntry', () => {
  afterEach(() => setDebugPath(undefined));
  const theme = { fg: (_color: 'dim', text: string) => `\x1b[2m${text}\x1b[22m` };
  const line = `pi8 attempt.timing ${JSON.stringify({ candidate: 'anthropic/claude-haiku-5-5:high', stack: 'x'.repeat(600) })}`;

  it('shows the line dim and inside the terminal width', () => {
    setDebugPath('/tmp/pi8-ui-test-debug.log');
    const rows = renderDebugEntry({ data: { line } }, theme)!.render(80);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 80)).toBe(true);
    expect(rows[0]).toContain('\x1b[2m');
  });

  it('shows nothing while debug is off', () => {
    setDebugPath(null);
    expect(renderDebugEntry({ data: { line } }, theme)).toBeUndefined();
  });
});
