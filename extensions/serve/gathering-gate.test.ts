import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendContextHandoffSignal } from '../host/decisionlog.js';
import { ACQUISITION_DENIAL_LIMIT } from '../routing/policy/context-acquisition.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { routingDecision } from '../test-support/router-fixtures.js';
import { RouterSession } from './router-session-state.js';
import { submitContextHandoff } from './context-handoff-tool.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import { countContextRefusal, gateContextToolCall, withGatheringNote } from './gathering-gate.js';

vi.mock('../host/decisionlog.js', () => ({ appendContextHandoffSignal: vi.fn() }));

function acquiringSession(): RouterSession {
  const session = new RouterSession();
  const state: WorkPhaseState = {
    intentKey: 'entry', deliverable: 'plan', contextStatus: 'acquiring',
    contextDenials: 0,
    providerInvocation: 1, observedMutationTools: 0,
  };
  session.commitWorkPhaseState(state);
  session.setLastDecision({ ...routingDecision(['a/model']), intentKey: state.intentKey, dimension: 'gather' });
  session.setLastServed({ registryId: 'a/model', viaFallback: false, accumulatedCost: 0 });
  return session;
}

beforeEach(() => vi.clearAllMocks());

describe('gathering gate refusal accounting', () => {
  it('shares one refusal between a blocked mutation and a rejected handoff in the same invocation', () => {
    const session = acquiringSession();
    expect(gateContextToolCall({ toolName: 'write', input: {} }, session)?.block).toBe(true);
    const ctx = { model: { provider: 'router', id: 'auto' } } as unknown as ExtensionContext;
    expect(submitContextHandoff({ outcome: 'ready' }, ctx, session).accepted).toBe(false);
    expect(session.getWorkPhaseState()?.contextDenials).toBe(1);
    expect(session.getWorkPhaseState()?.deniedAtInvocation).toBe(1);
    expect(vi.mocked(appendContextHandoffSignal).mock.calls.map(([signal]) => signal.action)).toEqual(['deny', 'reject']);
  });

  it('ends gathering at the same refusal limit and logs exhaustion once', () => {
    const session = acquiringSession();
    for (let invocation = 1; invocation <= ACQUISITION_DENIAL_LIMIT; invocation += 1) {
      session.commitWorkPhaseState({
        ...session.getWorkPhaseState()!, providerInvocation: invocation,
      });
      expect(gateContextToolCall({ toolName: 'edit', input: {} }, session)?.block).toBe(true);
    }
    const ended = session.getWorkPhaseState()!;
    expect(ended.contextDenials).toBe(ACQUISITION_DENIAL_LIMIT);
    expect(ended.contextStatus).toBe('clarification-only');
    expect(countContextRefusal(session, ended, 'a/model')).toBe(ended);
    expect(gateContextToolCall({ toolName: 'edit', input: {} }, session)?.block).toBe(true);
    expect(vi.mocked(appendContextHandoffSignal).mock.calls.filter(([signal]) => signal.action === 'budget-exhausted'))
      .toHaveLength(1);
  });

  it('refuses a shell call without spending the mutation refusal budget', () => {
    const session = acquiringSession();
    expect(gateContextToolCall({ toolName: 'bash', input: { command: 'pwd' } }, session)?.block).toBe(true);
    expect(session.getWorkPhaseState()?.contextDenials).toBe(0);
    expect(gateContextToolCall({ toolName: 'read', input: { path: 'file.ts' } }, session)).toBeUndefined();
  });

  it('does not count refusals while the accepted handoff awaits its next invocation', () => {
    const session = acquiringSession();
    session.commitWorkPhaseState({ ...session.getWorkPhaseState()!, contextStatus: 'ready-pending' });
    expect(gateContextToolCall({ toolName: 'subagent', input: {} }, session)?.block).toBe(true);
    expect(session.getWorkPhaseState()?.contextDenials).toBe(0);
  });

  it('blocks an unchecked call in a restricted phase if bookkeeping fails', () => {
    const session = acquiringSession();
    vi.mocked(appendContextHandoffSignal).mockImplementationOnce(() => { throw new Error('log failed'); });
    expect(gateContextToolCall({ toolName: 'write', input: {} }, session)).toEqual({
      block: true,
      reason: 'Router: this call was not made: the router could not check it while collecting context.',
    });
  });
});

describe('withGatheringNote', () => {
  it('keeps the note on the entry message when a router settle reminder follows it', () => {
    const reminder = { role: 'user' as const, content: `${ROUTER_SETTLE_PREFIX}\nRouter: remind`, timestamp: 3 };
    const noted = withGatheringNote({ messages: [
      { role: 'user', content: 'do it', timestamp: 1 },
      reminder,
    ] }, 'NOTE');
    expect(noted.messages[0]!.content).toEqual([{ type: 'text', text: 'do it' }, { type: 'text', text: 'NOTE' }]);
    expect(noted.messages[1]).toBe(reminder);
  });
});
