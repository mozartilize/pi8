import { describe, it, expect } from 'vitest';
import { clearRouterStatus, formatStatus, formatDecisionDetail, formatWorkContext, servedKey } from './ui.js';
import { emptyLedger, foldEvents } from '../routing/context/ledger.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { candidateKey } from '../routing/score/scorer.js';
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

  it('shows an investigation and its handoff in plain language', () => {
    const served = { registryId: 'alpha/model', viaFallback: false, accumulatedCost: 0 };
    const investigating = {
      ...decision, dimension: 'gather' as const, cause: 'investigation' as const, deliverable: 'plan' as const,
    };
    expect(formatStatus(investigating, served)).toContain('auto:gather · collecting context');
    expect(formatDecisionDetail(investigating, served)).toContain('  cause:      collecting context, read-only, before the deliverable');
    expect(formatDecisionDetail(investigating, served)).toContain('  handoff:    collecting context (deliverable plan)');
    const handoff = {
      id: 'k', requester: 'alpha/model', target: 'plan' as const, minimum: 0.62, requirement: 0.62,
      rubric: { alternatives: 3, stakes: 2, spread: 1, knowledge: 1, uncertainty: 1 },
      evidence: { applicable: false, files: 0, directories: 0 }, pending: true,
    };
    const planning = { ...decision, dimension: 'plan' as const, cause: 'investigation-handoff' as const, reasoningHandoff: handoff };
    expect(formatDecisionDetail(planning, served)).toContain('  handoff:    planning, minimum 0.62, pending');
    const owned = { ...planning, reasoningHandoff: { ...handoff, pending: false, owner: 'beta/planner' } };
    expect(formatDecisionDetail(owned, served)).toContain('  handoff:    planning, minimum 0.62, owned by beta/planner');
  });

  it('explains an execution plan handoff and its return to the submitter', () => {
    const served = { registryId: 'alpha/cheap', viaFallback: false, accumulatedCost: 0 };
    const base = {
      ...decision, cause: 'execution-contract' as const, routedDown: true, routedPickChanged: true,
    };
    const valued = {
      requirement: 0.34,
      rubric: { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 },
      measured: { files: 1, directories: 1, steps: 2, testTargets: 0 },
    };
    const active = formatDecisionDetail({
      ...base,
      executionContract: {
        status: 'active', band: 'economy', release: true, minimum: 0.34, submitter: 'beta/strong', targets: 1, steps: 2,
        ...valued,
      },
    }, served);
    expect(active).toContain('  cause:      routed by an accepted execution plan');
    expect(active).toContain('  plan:       accepted, economy (1 file, 2 steps; executor minimum 0.34); an executor model runs it');
    expect(active).toContain('  note:       task type lowered by the accepted execution plan, so a cheaper model served');
    const broken = formatDecisionDetail({
      ...decision,
      executionContract: {
        status: 'broken', band: 'economy', release: true, submitter: 'beta/strong', targets: 1, steps: 2,
        breakReason: 'undeclared-target', breaker: 'alpha/cheap', excludedExecutors: ['alpha/cheap'], ...valued,
      },
    }, served);
    expect(broken).toContain('  plan:       broken: alpha/cheap edited a file outside the plan; back to beta/strong');
    expect(broken).toContain('  excluded:   alpha/cheap (failed two plans)');
    const executed = formatDecisionDetail({
      ...decision,
      executionContract: {
        status: 'executed', band: 'economy', release: true, submitter: 'beta/strong', targets: 1, steps: 2,
        executor: 'alpha/cheap', executedReason: 'complete', ...valued,
      },
    }, served);
    expect(executed).toContain('  plan:       executed by alpha/cheap; beta/strong reviews it');
    const kept = formatDecisionDetail({
      ...decision,
      executionContract: {
        status: 'active', band: 'frontier', release: false, keepReason: 'difficulty', submitter: 'beta/strong',
        targets: 1, steps: 2, ...valued,
      },
    }, served);
    expect(kept).toContain('  plan:       accepted (1 file, 2 steps); beta/strong keeps running it: too hard to hand off');
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

describe('direction notes in /router-why', () => {
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

  it('renders a downward route with the handoff cause', () => {
    const lines = formatDecisionDetail(
      decisionWith({
        dimension: 'lightweight',
        routedDown: true,
        routedPickChanged: true,
        cause: 'router-consult',
      }),
      served(),
    );

    expect(lines.join('\n')).toContain('task type adopted from a context handoff');
    expect(lines.join('\n')).toContain('task type lowered by a later reading of the request, so a cheaper model served');
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
      decisionWith({ routedUp: true, routedPickChanged: false, cause: 'router-consult' }),
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

describe('formatWorkContext', () => {
  it('names the active work item and its topic', () => {
    const ledger = foldEvents([
      createEvent(workItem('w_1', 't_1', { title: 'Export CSV', topic: { id: 't_1', title: 'Reports' }, anchors: [{ kind: 'path', value: 'req.md', source: 'user' }] })),
      createEvent(workItem('w_2', 't_2', { status: 'done' })),
      activateEvent('w_1'),
    ]);
    const lines = formatWorkContext(ledger, 'tracked');
    expect(lines[0]).toBe('Work context: Export CSV (topic: Reports; 1 open of 2 work items in 2 topics)');
    expect(lines[1]).toContain('w_1, active, 1 anchor, 0 read and fingerprinted');
    expect(lines.some((line) => line.startsWith('  context:'))).toBe(false);
  });

  it('says what context the active work item still holds open', () => {
    const ledger = foldEvents([
      createEvent(workItem('w_1', 't_1', { openContext: ['referenced-artifact'] })),
      activateEvent('w_1'),
    ]);
    expect(formatWorkContext(ledger, 'tracked')).toContain('  context:    still needed before its next change (files it references)');
  });

  it('says an untracked legacy branch starts tracking with the next message', () => {
    expect(formatWorkContext(emptyLedger(), 'legacy-uninitialized')[0]).toContain('your next message starts tracking');
    expect(formatWorkContext(emptyLedger(), 'native-empty')).toEqual(['Work context: none yet']);
  });

  it('notes a lazy migration boundary, and whether earlier work is looked up', () => {
    const ledger = foldEvents([
      { v: 1, op: 'migration-init', legacyHeadEntryId: 'e1', mode: 'lazy', sourceEntryId: 'e2' },
      createEvent(workItem('w_1')),
      activateEvent('w_1'),
    ]);
    expect(formatWorkContext(ledger, 'tracked').at(-1))
      .toContain('tracking started partway through this session; earlier work is looked up when a message returns to it');
  });
});

describe('work context in /router-why', () => {
  it('says which tier resolved the entry and whether its context is in hand, by id only', () => {
    const lines = formatDecisionDetail({
      ...decision,
      workContext: {
        resolver: 'deterministic', relation: 'continue', topicId: 't_1', workItemId: 'w_1',
        contextReasons: ['referenced-artifact'], contextSatisfied: true,
      },
    }, { registryId: 'a/b', viaFallback: false, accumulatedCost: 0 }).join('\n');
    expect(lines).toContain('work:       continue work item w_1 (continues the active work, no model asked)');
    expect(lines).toContain('context:    current (files it references)');
  });

  it('says when the context was collected before the entry was placed', () => {
    const lines = formatDecisionDetail({
      ...decision,
      workContext: {
        resolver: 'context-handoff', relation: 'new', topicId: 't_1', workItemId: 'w_2',
        contextReasons: ['referenced-artifact'], contextSatisfied: true,
      },
    }, undefined).join('\n');
    expect(lines).toContain('work:       new work item w_2 (selected after collecting context)');
    expect(lines).toContain('context:    collected (files it references)');
  });

  it('says when the entry was placed on work from before tracking started', () => {
    const lines = formatDecisionDetail({
      ...decision,
      workContext: {
        resolver: 'context-handoff', relation: 'resume', topicId: 't_1', workItemId: 'w_1',
        contextReasons: [], contextSatisfied: true, legacy: true,
      },
    }, undefined).join('\n');
    expect(lines).toContain('work:       resume work item w_1 (found in conversation from before tracking started)');
    expect(lines).toContain('context:    current');
  });

  it('names a side question and an unrecorded entry plainly', () => {
    const side = formatDecisionDetail({
      ...decision,
      workContext: { resolver: 'context-handoff', relation: 'switch', topicId: 'NEW_TOPIC', workItemId: 'NONE', contextReasons: [], contextSatisfied: true },
    }, undefined).join('\n');
    expect(side).toContain('a side question outside any work item');
    const unresolved = formatDecisionDetail({
      ...decision,
      workContext: { resolver: 'fallback', relation: 'unknown', topicId: 'UNKNOWN', workItemId: 'UNKNOWN', contextReasons: ['carried-open-context'], contextSatisfied: false },
    }, undefined).join('\n');
    expect(unresolved).toContain('no work item (not recorded on this branch)');
    expect(unresolved).toContain('context:    still needed (left open by an earlier request)');
  });
});
