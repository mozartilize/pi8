import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { RouterSession } from './router-session-state.js';
import { COMPLETION_SETTLE_TEXT, CONTEXT_SETTLE_TEXT, logSettleOutcomes, settleReminder } from './settle-reminder.js';

vi.mock('../host/decisionlog.js', () => ({ appendWorkLifecycleSignal: vi.fn() }));
const logged = vi.mocked(appendWorkLifecycleSignal);
const actions = () => logged.mock.calls.map(([signal]) => [signal.action, signal.reminder]);
beforeEach(() => logged.mockClear());

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

/**
 * Pi builds the event's context before any handler adds an entry, so after a
 * final assistant reply `canContinue` is false; Pi checks it again after the
 * entries are applied.
 */
function settle(
  outcome: AgentBeforeSettleEvent['outcome'] = 'completed',
  entries: AgentBeforeSettleEvent['entries'] = [],
) {
  return { outcome, entries, context: { canContinue: false } } as unknown as
    Pick<AgentBeforeSettleEvent, 'outcome' | 'entries'>;
}

function reminder(result: ReturnType<typeof settleReminder>) {
  const message = result?.entries?.at(-1);
  return message && 'content' in message ? message.content : undefined;
}

describe('settle reminder', () => {
  it('continues once after a final reply when this entry executed its plan and did not complete the work', () => {
    const session = ready();
    const result = settleReminder(settle(), session);
    expect(result?.continue).toBe(true);
    expect(result?.entries?.[0]).toMatchObject({ type: 'custom_message', customType: 'pi8-settle', display: false });
    expect(reminder(result)).toBe(`${ROUTER_SETTLE_PREFIX}\n${COMPLETION_SETTLE_TEXT}`);
    expect(session.getWorkPhaseState()?.completionSettleReminded).toBe(true);
    expect(logged.mock.calls[0]?.[0]).toMatchObject({ action: 'settle-reminder', reminder: 'completion', workItemId: 'w_1' });
    expect(session.context.getLedger().items.get('w_1')?.status).toBe('active');
    expect(settleReminder(settle(), session)).toBeUndefined();
  });

  it('keeps the drafts of earlier handlers', () => {
    const draft = { type: 'custom_message', customType: 'other', content: 'x', display: false } as const;
    const result = settleReminder(settle('completed', [draft]), ready());
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries?.[0]).toBe(draft);
  });

  it('reminds about completion when the entry changed files without a plan', () => {
    const session = ready({ contract: undefined, observedMutationTools: 2 });
    expect(reminder(settleReminder(settle(), session))).toBe(`${ROUTER_SETTLE_PREFIX}\n${COMPLETION_SETTLE_TEXT}`);
  });

  it('reminds about completion when a model served the entry\'s plan or review handoff', () => {
    for (const deliverable of ['plan', 'review'] as const) {
      const session = ready({ contract: undefined, contextStatus: 'served', deliverable });
      expect(reminder(settleReminder(settle(), session))).toBe(`${ROUTER_SETTLE_PREFIX}\n${COMPLETION_SETTLE_TEXT}`);
    }
  });

  it('does not remind about completion without evidence that the requested work was done', () => {
    for (const session of [
      ready({ contract: undefined }),
      ready({ contract: undefined, contextStatus: 'served', deliverable: 'implement' }),
      ready({ contract: undefined, deliverable: 'review' }),
      ready({ contract: { status: 'active' } as WorkPhaseState['contract'], contextStatus: 'served', deliverable: 'plan' }),
      ready({ contract: { status: 'active' } as WorkPhaseState['contract'], observedMutationTools: 1 }),
      ready({ contract: { status: 'broken' } as WorkPhaseState['contract'], observedMutationTools: 1 }),
      ready({ completion: { workItemId: 'w_1', status: 'done' } }),
      ready({ contextStatus: 'ready-pending' }),
      ready({ contextStatus: 'clarification-only' }),
    ]) {
      expect(settleReminder(settle(), session)).toBeUndefined();
      expect(session.getWorkPhaseState()?.completionSettleReminded).toBeUndefined();
    }
    const closed = ready();
    closed.context.append({ v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u1' });
    expect(settleReminder(settle(), closed)).toBeUndefined();
  });

  it('does nothing after an error or an abort', () => {
    for (const outcome of ['error', 'aborted'] as const) {
      const session = ready({ contextStatus: 'acquiring', contextDenials: 1 });
      expect(settleReminder(settle(outcome), session)).toBeUndefined();
      expect(session.getWorkPhaseState()?.contextSettleReminded).toBeUndefined();
    }
  });

  it('lets a direct answer to a gather or lightweight request settle when nothing was refused', () => {
    for (const deliverable of ['gather', 'lightweight'] as const) {
      const session = ready({ contextStatus: 'acquiring', deliverable });
      expect(settleReminder(settle(), session)).toBeUndefined();
      expect(session.getWorkPhaseState()?.contextSettleReminded).toBeUndefined();
    }
  });

  it('reminds about hand_off_context when a request of any other type settles undeclared', () => {
    for (const deliverable of ['implement', 'plan', 'review', undefined] as const) {
      const session = ready({ contextStatus: 'acquiring', deliverable });
      expect(reminder(settleReminder(settle(), session))).toBe(`${ROUTER_SETTLE_PREFIX}\n${CONTEXT_SETTLE_TEXT}`);
    }
  });

  it('reminds once about hand_off_context after a refusal, before any completion reminder', () => {
    const session = ready({ contextStatus: 'acquiring', contextDenials: 1 });
    expect(reminder(settleReminder(settle(), session))).toBe(`${ROUTER_SETTLE_PREFIX}\n${CONTEXT_SETTLE_TEXT}`);
    expect(session.getWorkPhaseState()).toMatchObject({ contextSettleReminded: true });
    expect(session.getWorkPhaseState()?.completionSettleReminded).toBeUndefined();
    // Still collecting context: no second reminder of either kind.
    expect(settleReminder(settle(), session)).toBeUndefined();
    expect(actions()).toEqual([['settle-reminder', 'context']]);
  });

  it('does not remind about hand_off_context after a declared direct answer', () => {
    const session = ready({ contextStatus: 'acquiring', contextDenials: 1, contextAnswer: 'gather' });
    expect(settleReminder(settle(), session)).toBeUndefined();
  });
});

describe('settle outcomes', () => {
  it('records each declared handoff outcome as followed', () => {
    for (const declared of [{ handoffKey: 'k' }, { contextAnswer: 'gather' as const }, { contextNeedsUser: true }]) {
      logged.mockClear();
      logSettleOutcomes(ready({ contextSettleReminded: true, ...declared }));
      expect(actions()).toEqual([['settle-followed', 'context']]);
    }
  });

  it('records an ignored reminder, once per entry', () => {
    const session = ready({ contextStatus: 'clarification-only', contextSettleReminded: true });
    logSettleOutcomes(session);
    logSettleOutcomes(session);
    expect(actions()).toEqual([['settle-ignored', 'context']]);
  });

  it('records the completion reminder against its work item', () => {
    logSettleOutcomes(ready({ completionSettleReminded: true }));
    logSettleOutcomes(ready({ completionSettleReminded: true, completion: { workItemId: 'w_1', status: 'done' } }));
    expect(logged.mock.calls.map(([signal]) => [signal.action, signal.reminder, signal.workItemId])).toEqual([
      ['settle-ignored', 'completion', 'w_1'],
      ['settle-followed', 'completion', 'w_1'],
    ]);
  });

  it('logs nothing for an entry without a reminder', () => {
    logSettleOutcomes(ready());
    expect(logged).not.toHaveBeenCalled();
  });
});
