import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import type { Dimension } from '../types.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { COMPLETE_WORK_TOOL } from '../routing/policy/work-completion.js';
import { routingDecision } from '../test-support/router-fixtures.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { RouterSession } from './router-session-state.js';
import { registerCompleteWorkTool, submitCompleteWork } from './complete-work-tool.js';

vi.mock('../host/decisionlog.js', () => ({ appendWorkLifecycleSignal: vi.fn() }));

const AUTO = { model: { provider: 'router', id: 'auto' } } as unknown as ExtensionContext;

function servingSession(over: Partial<WorkPhaseState> = {}, deliverable: Dimension = 'implement'): RouterSession {
  const session = new RouterSession();
  session.context.append(createEvent(workItem('w_1', 't_1', { lastDeliverable: deliverable }), 'u1'));
  session.context.append(activateEvent('w_1', 'u1'));
  session.context.append({ v: 1, op: 'incumbent', served: { registryId: 'a/model' }, dimension: deliverable, workItemId: 'w_1', sourceEntryId: 'u1' });
  session.commitWorkPhaseState({ intentKey: 'entry', deliverable, providerInvocation: 1, observedMutationTools: 0, ...over });
  session.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'entry', dimension: deliverable });
  session.setLastServed({ registryId: 'a/model', viaFallback: false, accumulatedCost: 0 });
  return session;
}

beforeEach(() => vi.clearAllMocks());

describe('complete_work', () => {
  it.each(['gather', 'plan', 'review', 'implement'] as const)('completes the active item after a %s entry', (deliverable) => {
    const session = servingSession({}, deliverable);
    const result = submitCompleteWork({ outcome: 'done' }, AUTO, session);
    expect(result).toMatchObject({ accepted: true, workItemId: 'w_1' });
    const ledger = session.context.getLedger();
    expect(ledger.items.get('w_1')?.status).toBe('done');
    expect(ledger.activeWorkItemId).toBeUndefined();
    // The model keeps the conversation: the incumbent stays, tied to the completed item.
    expect(ledger.incumbent).toMatchObject({ registryId: 'a/model', workItemId: 'w_1' });
    expect(session.getWorkPhaseState()?.completion).toEqual({ workItemId: 'w_1', status: 'done' });
    expect(vi.mocked(appendWorkLifecycleSignal).mock.calls[0]![0]).toMatchObject({ action: 'complete-accept', workItemId: 'w_1' });
  });

  it('records the close and its boundary as one branch entry', () => {
    const session = servingSession();
    const persisted: unknown[] = [];
    session.context.bindPersistence((event) => persisted.push(event));
    submitCompleteWork({ outcome: 'done' }, AUTO, session);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ op: 'context-commit', events: [
      { op: 'work-close', workItemId: 'w_1', status: 'done' },
      { op: 'boundary', workItemId: 'w_1', boundary: 'work-complete' },
    ] });
  });

  it('answers the same completion again without recording it twice, and refuses a different outcome', () => {
    const session = servingSession();
    const persisted: unknown[] = [];
    session.context.bindPersistence((event) => persisted.push(event));
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, session).accepted).toBe(true);
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, session).accepted).toBe(true);
    expect(submitCompleteWork({ outcome: 'superseded' }, AUTO, session).accepted).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it('closes unfinished planned work only as superseded', () => {
    for (const status of ['active', 'broken'] as const) {
      const session = servingSession({ contract: { status } as never });
      expect(submitCompleteWork({ outcome: 'done' }, AUTO, session).accepted).toBe(false);
      expect(session.context.getLedger().items.get('w_1')?.status).toBe('active');
      expect(submitCompleteWork({ outcome: 'superseded' }, AUTO, session).accepted).toBe(true);
    }
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, servingSession({ contract: { status: 'executed' } as never })).accepted)
      .toBe(true);
  });

  it.each([
    ['collecting context', { contextStatus: 'acquiring' as const }],
    ['asking the user', { contextStatus: 'clarification-only' as const }],
    ['a handoff waiting for its next step', { contextStatus: 'ready-pending' as const }],
  ])('refuses while %s, without changing the ledger', (_label, over) => {
    const session = servingSession(over);
    const before = session.context.getLedger();
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, session).accepted).toBe(false);
    expect(session.context.getLedger()).toBe(before);
  });

  it('refuses without an active item, an outcome, a routed request, or router/auto', () => {
    const idle = servingSession();
    idle.context.append({ v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u1' });
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, idle).accepted).toBe(false);
    expect(submitCompleteWork({ outcome: 'finished' }, AUTO, servingSession()).accepted).toBe(false);
    const stale = servingSession();
    stale.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'older', dimension: 'implement' });
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, stale).accepted).toBe(false);
    const concrete = { model: { provider: 'openai', id: 'gpt-5' } } as unknown as ExtensionContext;
    const pinned = servingSession();
    expect(submitCompleteWork({ outcome: 'done' }, concrete, pinned).accepted).toBe(false);
    expect(pinned.context.getLedger().items.get('w_1')?.status).toBe('active');
  });

  it('leaves the item active and the entry open when the branch does not record it', () => {
    const session = servingSession();
    session.context.bindPersistence(() => { throw new Error('disk full'); });
    expect(submitCompleteWork({ outcome: 'done' }, AUTO, session)).toMatchObject({ accepted: false });
    expect(session.context.getLedger().activeWorkItemId).toBe('w_1');
    expect(session.getWorkPhaseState()?.completion).toBeUndefined();
  });

  it('registers one sequential tool whose description says suggestions do not keep work open', () => {
    const registerTool = vi.fn();
    registerCompleteWorkTool({ registerTool } as unknown as ExtensionAPI, new RouterSession());
    const tool = registerTool.mock.calls[0]![0] as { name: string; executionMode: string; description: string };
    expect(tool).toMatchObject({ name: COMPLETE_WORK_TOOL, executionMode: 'sequential' });
    expect(tool.description).toContain('A suggestion that you made');
    expect(tool.description).toContain('the router reopens this work item');
  });
});
