import { describe, expect, it } from 'vitest';
import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { RouterSession } from './router-session-state.js';
import { COMPLETION_SETTLE_TEXT, completionSettleNudge } from './completion-settle.js';

const executed = { status: 'executed' } as WorkPhaseState['contract'];

function ready(over: Partial<WorkPhaseState> = {}): RouterSession {
  const session = new RouterSession();
  session.context.append(createEvent(workItem('w_1', 't_1'), 'u1'));
  session.context.append(activateEvent('w_1', 'u1'));
  session.commitWorkPhaseState({
    intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0, contract: executed, ...over,
  });
  return session;
}

function settle(outcome: AgentBeforeSettleEvent['outcome'] = 'completed', canContinue = true) {
  return { outcome, context: { canContinue } } as Pick<AgentBeforeSettleEvent, 'outcome' | 'context'>;
}

describe('completion settle', () => {
  it('continues once when this entry executed its plan and did not complete the work', () => {
    const session = ready();
    const result = completionSettleNudge(settle(), session);
    expect(result?.continue).toBe(true);
    const message = result?.entries?.[0];
    expect(message).toMatchObject({ type: 'custom_message', customType: 'pi8-settle', display: false });
    expect(message && 'content' in message && message.content).toBe(`${ROUTER_SETTLE_PREFIX}\n${COMPLETION_SETTLE_TEXT}`);
    expect(session.getWorkPhaseState()?.completionSettleNudged).toBe(true);
    expect(session.context.getLedger().items.get('w_1')?.status).toBe('active');
    expect(completionSettleNudge(settle(), session)).toBeUndefined();
  });

  it('does nothing after an error, an abort, a completion, or while the plan is still running', () => {
    for (const event of [settle('error'), settle('aborted'), settle('completed', false)]) {
      const session = ready();
      expect(completionSettleNudge(event, session)).toBeUndefined();
      expect(session.getWorkPhaseState()?.completionSettleNudged).toBeUndefined();
    }
    const completed = ready({ completion: { workItemId: 'w_1', status: 'done' } });
    expect(completionSettleNudge(settle(), completed)).toBeUndefined();
    const running = ready({ contract: { status: 'active' } as WorkPhaseState['contract'] });
    expect(completionSettleNudge(settle(), running)).toBeUndefined();
    const closed = ready();
    closed.context.append({ v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u1' });
    expect(completionSettleNudge(settle(), closed)).toBeUndefined();
  });

  it('does not continue a context handoff that was never declared', () => {
    const session = ready({ contextStatus: 'acquiring' });
    expect(completionSettleNudge(settle(), session)).toBeUndefined();
    expect(session.getWorkPhaseState()?.completionSettleNudged).toBeUndefined();
  });
});
