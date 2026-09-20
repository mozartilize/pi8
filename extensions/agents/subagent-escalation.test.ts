import { describe, expect, it } from 'vitest';

import type { Role } from '../types.js';
import {
  SUBAGENT_ESCALATION_MARKER,
  SubagentEscalationState,
  appendSubagentEscalationContract,
  nextRoleFallback,
  parseSubagentEscalation,
  planSubagentOutcome,
} from './subagent-escalation.js';

describe('subagent escalation protocol', () => {
  it('appends the child contract idempotently', () => {
    const task = 'Implement the requested change.';
    const once = appendSubagentEscalationContract(task);
    const twice = appendSubagentEscalationContract(once);

    expect(once).toContain(SUBAGENT_ESCALATION_MARKER);
    expect(twice).toBe(once);
    expect(once.match(/\[router-escalate\]/g)).toHaveLength(1);
  });

  it('parses only an exact marker as the complete trimmed output', () => {
    expect(parseSubagentEscalation(
      `  ${SUBAGENT_ESCALATION_MARKER}{"reason":"Need stronger code reasoning"}\n\t  `,
    )).toEqual({ reason: 'Need stronger code reasoning' });

    expect(parseSubagentEscalation(
      `${SUBAGENT_ESCALATION_MARKER}{"reason":"Need stronger code reasoning"}\nignored detail`,
    )).toBeUndefined();

    expect(parseSubagentEscalation(
      `preface\n${SUBAGENT_ESCALATION_MARKER}{"reason":"too late"}`,
    )).toBeUndefined();
    expect(parseSubagentEscalation(
      `[router-escalated]{"reason":"near match"}`,
    )).toBeUndefined();
  });

  it('rejects malformed, untrusted, or unbounded marker payloads', () => {
    const invalid = [
      `${SUBAGENT_ESCALATION_MARKER} {"reason":"space before payload"}`,
      `${SUBAGENT_ESCALATION_MARKER}{reason:"not json"}`,
      `${SUBAGENT_ESCALATION_MARKER}{"reason":""}`,
      `${SUBAGENT_ESCALATION_MARKER}{"reason":"ok","model":"attacker/chosen"}`,
      `${SUBAGENT_ESCALATION_MARKER}{"reason":42}`,
      `${SUBAGENT_ESCALATION_MARKER}{"reason":"line\\nbreak"}`,
      `${SUBAGENT_ESCALATION_MARKER}{"reason":"ok"} trailing`,
      `${SUBAGENT_ESCALATION_MARKER}{"reason":"${'x'.repeat(501)}"}`,
    ];

    for (const text of invalid) expect(parseSubagentEscalation(text)).toBeUndefined();
  });
});

describe('nextRoleFallback', () => {
  const fallbacks = new Map<Role, string[]>([
    ['worker', ['provider/fast', 'provider/strong', 'provider/strongest']],
    ['reviewer', ['other/reviewer', 'third/reviewer']],
  ]);

  it('selects only the next entry in the same role fallback chain', () => {
    expect(nextRoleFallback('worker', 'provider/fast', fallbacks)).toBe('provider/strong');
    expect(nextRoleFallback('reviewer', 'other/reviewer', fallbacks)).toBe('third/reviewer');
  });

  it('returns no alternative at the end of or outside the chain', () => {
    expect(nextRoleFallback('worker', 'provider/strongest', fallbacks)).toBeUndefined();
    expect(nextRoleFallback('worker', 'user/explicit', fallbacks)).toBeUndefined();
    expect(nextRoleFallback('planner', 'provider/fast', fallbacks)).toBeUndefined();
  });
});

describe('SubagentEscalationState', () => {
  const fallbacks = new Map<Role, string[]>([
    ['worker', ['provider/fast', 'provider/strong', 'provider/strongest']],
    // This is the already-complementary reviewer chain; no worker-family model
    // is available to the retry planner.
    ['reviewer', ['independent/review', 'other/review']],
  ]);

  it('self-report schedules and advertises one next-model retry without blacklisting', () => {
    const state = new SubagentEscalationState();
    const outcome = planSubagentOutcome(
      state,
      'self-report',
      'worker',
      'provider/fast',
      fallbacks,
      'The task needs stronger reasoning',
    );

    expect(outcome.blacklistCurrent).toBe(false);
    expect(outcome.retry).toMatchObject({ model: 'provider/strong', role: 'worker' });
    expect(outcome.retry?.directive).toContain('provider/strong');
    // Duplicate results cannot emit another directive before consumption.
    expect(planSubagentOutcome(
      state,
      'self-report',
      'worker',
      'provider/fast',
      fallbacks,
      'duplicate',
    ).retry).toBeUndefined();
  });

  it('the next router-owned spawn consumes exactly one override', () => {
    const state = new SubagentEscalationState();
    planSubagentOutcome(state, 'self-report', 'worker', 'provider/fast', fallbacks, 'reason');

    expect(state.consume('worker', undefined, fallbacks, () => false)).toBe('provider/strong');
    expect(state.consume('worker', undefined, fallbacks, () => false)).toBeUndefined();
    // Consumption releases the role/current pair for a future independent try.
    expect(planSubagentOutcome(
      state,
      'self-report',
      'worker',
      'provider/fast',
      fallbacks,
      'new attempt',
    ).retry?.model).toBe('provider/strong');
  });

  it('leaves a normal result unchanged when no alternative exists', () => {
    const state = new SubagentEscalationState();
    expect(planSubagentOutcome(
      state,
      'self-report',
      'worker',
      'provider/strongest',
      fallbacks,
      'nothing stronger',
    )).toEqual({ blacklistCurrent: false });
  });

  it('hard failure retains blacklisting and schedules the next chain entry', () => {
    const state = new SubagentEscalationState();
    const outcome = planSubagentOutcome(
      state,
      'hard-failure',
      'worker',
      'provider/fast',
      fallbacks,
      'spawn failed',
    );

    expect(outcome.blacklistCurrent).toBe(true);
    expect(outcome.retry?.model).toBe('provider/strong');
  });

  it('uses only the reviewer role already-filtered fallback chain', () => {
    const state = new SubagentEscalationState();
    expect(planSubagentOutcome(
      state,
      'self-report',
      'reviewer',
      'independent/review',
      fallbacks,
      'need stronger review',
    ).retry?.model).toBe('other/review');
  });

  it('session reset clears pending overrides and pair suppression', () => {
    const state = new SubagentEscalationState();
    planSubagentOutcome(state, 'self-report', 'worker', 'provider/fast', fallbacks, 'reason');
    state.reset();

    expect(state.consume('worker', undefined, fallbacks, () => false)).toBeUndefined();
    expect(planSubagentOutcome(
      state,
      'self-report',
      'worker',
      'provider/fast',
      fallbacks,
      'after reset',
    ).retry?.model).toBe('provider/strong');
  });

  it('queues multiple pending overrides for the same role and current model when keyed by different tasks', () => {
    const state = new SubagentEscalationState();
    const a = planSubagentOutcome(
      state,
      'hard-failure',
      'worker',
      'provider/fast',
      fallbacks,
      'failed',
      'review routing',
      '$.tasks[0]:0',
    );
    const b = planSubagentOutcome(
      state,
      'hard-failure',
      'worker',
      'provider/fast',
      fallbacks,
      'failed',
      'review release notes',
      '$.tasks[1]:1',
    );
    expect(a.retry?.model).toBe('provider/strong');
    expect(b.retry?.model).toBe('provider/strong');

    expect(state.consume('worker', 'review release notes', fallbacks, () => false)).toBe('provider/strong');
    expect(state.consume('worker', 'review routing', fallbacks, () => false)).toBe('provider/strong');
    expect(state.consume('worker', undefined, fallbacks, () => false)).toBeUndefined();
  });

  it('does not let an unrelated task consume a task-keyed override', () => {
    const state = new SubagentEscalationState();
    planSubagentOutcome(
      state,
      'hard-failure',
      'worker',
      'provider/fast',
      fallbacks,
      'failed',
      'review routing',
      '$.tasks[0]:0',
    );

    expect(state.consume('worker', 'review release notes', fallbacks, () => false)).toBeUndefined();
    expect(state.consume('worker', 'review routing', fallbacks, () => false)).toBe('provider/strong');
  });

  it('lets a task-agnostic override match any task', () => {
    const state = new SubagentEscalationState();
    planSubagentOutcome(state, 'self-report', 'worker', 'provider/fast', fallbacks, 'retry');
    expect(state.consume('worker', 'any task', fallbacks, () => false)).toBe('provider/strong');
  });
});
