import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routingDecision } from '../test-support/router-fixtures.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { RouterSession } from './router-session-state.js';
import { gateCompletedWorkToolCall } from './completed-work-gate.js';

vi.mock('../host/decisionlog.js', () => ({ appendWorkLifecycleSignal: vi.fn() }));

function sessionFor(over: Partial<WorkPhaseState>): RouterSession {
  const session = new RouterSession();
  session.commitWorkPhaseState({ intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0, ...over });
  session.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'entry' });
  return session;
}

beforeEach(() => vi.clearAllMocks());

for (const [label, marker] of [
  ['first look', { firstLook: { workItemId: 'w_1' } }],
  ['completed in this entry', { completion: { workItemId: 'w_1', status: 'done' as const } }],
] as const) {
  describe(label, () => {
    it.each([
      ['edit', {}], ['write', {}], ['bash', { command: 'echo hi > out.txt' }],
      ['commit_execution', {}], ['subagent', {}],
    ])('refuses %s without counting it or closing the entry', (toolName, input) => {
      const session = sessionFor(marker);
      const before = session.getWorkPhaseState();
      expect(gateCompletedWorkToolCall({ toolName, input }, session)?.block).toBe(true);
      expect(gateCompletedWorkToolCall({ toolName, input }, session)?.block).toBe(true);
      expect(session.getWorkPhaseState()).toBe(before);
    });

    it.each([
      ['read', { path: 'file.ts' }], ['bash', { command: 'git status --short' }],
      ['hand_off_context', {}], ['reopen_work', {}], ['ask_user_question', {}],
    ])('allows %s', (toolName, input) => {
      expect(gateCompletedWorkToolCall({ toolName, input }, sessionFor(marker))).toBeUndefined();
    });
  });
}

it('does not restrict an open entry or a stale entry marker', () => {
  expect(gateCompletedWorkToolCall({ toolName: 'write', input: {} }, sessionFor({}))).toBeUndefined();
  const session = sessionFor({ firstLook: { workItemId: 'w_1' } });
  session.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'newer' });
  expect(gateCompletedWorkToolCall({ toolName: 'write', input: {} }, session)).toBeUndefined();
});
