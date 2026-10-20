import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import { RouterSession } from './router-session-state.js';
import { CONTEXT_SETTLE_TEXT, logSettleOutcomes, settleReminder } from './settle-reminder.js';

vi.mock('../host/decisionlog.js', () => ({ appendWorkLifecycleSignal: vi.fn() }));
const logged = vi.mocked(appendWorkLifecycleSignal);
const actions = () => logged.mock.calls.map(([signal]) => [signal.action, signal.reminder]);
beforeEach(() => logged.mockClear());

function ready(over: Partial<WorkPhaseState> = {}): RouterSession {
  const session = new RouterSession();
  session.commitWorkPhaseState({
    intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0,
    status: 'triage', deliverable: 'gather', ...over,
  });
  return session;
}

// Pi checks continuation again after the handlers add their entries.
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
  it('lets a triage answer settle without a handoff or a second selector pass', () => {
    const session = ready();
    const state = session.getWorkPhaseState();
    expect(settleReminder(settle(), session)).toBeUndefined();
    expect(session.getWorkPhaseState()).toBe(state);
    expect(logged).not.toHaveBeenCalled();
  });

  it('reminds once after a refused action and retains earlier handlers\' drafts', () => {
    const draft = { type: 'custom_message', customType: 'other', content: 'x', display: false } as const;
    const session = ready({ contextDenials: 1 });
    const result = settleReminder(settle('completed', [draft]), session);
    expect(result?.continue).toBe(true);
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries?.[0]).toBe(draft);
    expect(result?.entries?.[1]).toMatchObject({ type: 'custom_message', customType: 'pi8-settle', display: false });
    expect(reminder(result)).toBe(`${ROUTER_SETTLE_PREFIX}\n${CONTEXT_SETTLE_TEXT}`);
    expect(session.getWorkPhaseState()?.contextSettleReminded).toBe(true);
    expect(settleReminder(settle(), session)).toBeUndefined();
    expect(actions()).toEqual([['settle-reminder', 'context']]);
  });

  it.each(['implement', 'plan', 'review'] as const)('does not require a completion declaration after served %s', (deliverable) => {
    const session = ready({ status: 'served', deliverable, observedMutationTools: 2,
      contract: { status: 'executed' } as WorkPhaseState['contract'] });
    expect(settleReminder(settle(), session)).toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });

  it('does nothing after an error or an abort', () => {
    for (const outcome of ['error', 'aborted'] as const) {
      const session = ready({ contextDenials: 1 });
      expect(settleReminder(settle(outcome), session)).toBeUndefined();
      expect(session.getWorkPhaseState()?.contextSettleReminded).toBeUndefined();
    }
  });
});

describe('settle outcomes', () => {
  it('records ready and needs-user declarations as followed', () => {
    for (const declared of [{ handoffKey: 'k' }, { contextNeedsUser: true }]) {
      logged.mockClear();
      logSettleOutcomes(ready({ contextSettleReminded: true, ...declared }));
      expect(actions()).toEqual([['settle-followed', 'context']]);
    }
  });

  it('records an ignored reminder once per entry', () => {
    const session = ready({ status: 'clarification-only', contextSettleReminded: true });
    logSettleOutcomes(session);
    logSettleOutcomes(session);
    expect(actions()).toEqual([['settle-ignored', 'context']]);
  });

  it('logs nothing for an entry without a reminder', () => {
    logSettleOutcomes(ready());
    expect(logged).not.toHaveBeenCalled();
  });
});
