import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import { CONVERSATION_EVIDENCE } from '../routing/policy/context-acquisition.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { REOPEN_WORK_TOOL } from '../routing/policy/work-completion.js';
import { routingDecision } from '../test-support/router-fixtures.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import type { PendingIdentity } from './context-resolution.js';
import { RouterSession } from './router-session-state.js';
import { prepareReopenFacts, registerReopenWorkTool, submitReopenWork, type ReopenWorkParams } from './reopen-work-tool.js';

vi.mock('../host/decisionlog.js', () => ({ appendWorkLifecycleSignal: vi.fn() }));

const AUTO = { model: { provider: 'router', id: 'auto' }, cwd: process.cwd() } as unknown as ExtensionContext;
const SHAPE: ReopenWorkParams = { deliverable: 'implement', complexity: 'routine', scope: 'bounded' };

function doneSession(over: Partial<WorkPhaseState> = {}, incumbentWorkItem = true): RouterSession {
  const session = new RouterSession();
  session.context.append(createEvent(workItem('w_1', 't_1', { lastDeliverable: 'implement' }), 'u1'));
  session.context.append(activateEvent('w_1', 'u1'));
  session.context.append({
    v: 1, op: 'incumbent', served: { registryId: 'a/model' }, dimension: 'implement', sourceEntryId: 'u1',
    ...(incumbentWorkItem ? { workItemId: 'w_1' } : {}),
  });
  session.context.append({ v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u1' });
  session.commitWorkPhaseState({
    intentKey: 'entry', deliverable: 'implement', providerInvocation: 1, observedMutationTools: 0,
    priorCompletion: { workItemId: 'w_1' }, ...over,
  });
  session.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'entry', dimension: 'implement' });
  session.setLastServed({ registryId: 'a/model', viaFallback: false, accumulatedCost: 0 });
  session.setCachedIntent({ key: 'entry', dimension: 'gather', cause: 'incumbent' });
  return session;
}

beforeEach(() => vi.clearAllMocks());

describe('reopen_work', () => {
  it('reopens the completed incumbent, records one boundary, and leaves one repick pending', () => {
    const session = doneSession({ priorWork: { workItemId: 'w_1', contractStrikes: { 'a/model': 2 } } });
    const persisted: unknown[] = [];
    session.context.bindPersistence((event) => persisted.push(event));
    const result = submitReopenWork(SHAPE, AUTO, session);
    expect(result).toMatchObject({ accepted: true, workItemId: 'w_1' });
    const ledger = session.context.getLedger();
    expect(ledger.items.get('w_1')?.status).toBe('active');
    expect(ledger.activeWorkItemId).toBe('w_1');
    expect(ledger.incumbent).toMatchObject({ registryId: 'a/model', workItemId: 'w_1', dimension: 'implement' });
    expect(session.getWorkPhaseState()).toMatchObject({
      contextStatus: 'ready-pending',
      workItemId: 'w_1',
      deliverable: 'implement',
      contractStrikes: { 'a/model': 2 },
      contextResolution: { relation: 'reopen', workItemId: 'w_1', deliverable: 'implement' },
    });
    expect(session.getWorkPhaseState()?.priorCompletion).toBeUndefined();
    expect(session.getCachedIntent()).toMatchObject({ dimension: 'implement', context: { resolution: { relation: 'reopen' } } });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ op: 'context-commit', events: [
      { op: 'work-update', workItemId: 'w_1', patch: { status: 'active', lastDeliverable: 'implement' } },
      { op: 'activate', workItemId: 'w_1' },
      { op: 'boundary', workItemId: 'w_1', boundary: 'work-reopen' },
    ] });
    expect(vi.mocked(appendWorkLifecycleSignal).mock.calls[0]![0]).toMatchObject({ action: 'reopen-accept', workItemId: 'w_1' });
    expect(submitReopenWork(SHAPE, AUTO, session).accepted).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it('forces a new repick when this entry already served, including a plan minimum', () => {
    const session = doneSession({
      priorCompletion: undefined,
      completion: { workItemId: 'w_1', status: 'done' },
      contextStatus: 'served',
      reasoningHandoff: {
        id: 'old', pending: false, owner: 'a/model', requester: 'a/model', target: 'review',
        minimum: 0.4, requirement: 0.4,
        rubric: { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 },
        evidence: CONVERSATION_EVIDENCE,
      },
    });
    const result = submitReopenWork({ ...SHAPE, deliverable: 'plan', difficulty: { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 } }, AUTO, session);
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('minimum');
    const state = session.getWorkPhaseState();
    expect(state?.contextStatus).toBe('ready-pending');
    expect(state?.completion).toBeUndefined();
    expect(state?.reasoningHandoff).toMatchObject({ pending: true, target: 'plan', id: 'entry' });
    expect(session.context.getLedger().incumbent?.dimension).toBe('plan');
  });

  it('refuses a stale entry or an unread referenced file without reopening', async () => {
    const stale = doneSession({
      pendingIdentity: { generation: 9, entryKey: 'entry', base: { sourceEntryId: 'u1', anchors: [] } } as unknown as PendingIdentity,
    });
    const staleFacts = await prepareReopenFacts(AUTO, stale);
    expect(staleFacts.stale).toBe(true);
    expect(submitReopenWork(SHAPE, AUTO, stale, staleFacts).accepted).toBe(false);
    expect(stale.context.getLedger().items.get('w_1')?.status).toBe('done');

    const unread = doneSession({
      pendingIdentity: {
        generation: 0, entryKey: 'entry',
        base: { sourceEntryId: 'u1', anchors: [{ kind: 'path', value: 'package.json', mention: 'at' }] },
      } as unknown as PendingIdentity,
    });
    const facts = await prepareReopenFacts(AUTO, unread);
    // package.json exists and this entry has not read it.
    expect(facts.unmet).toContain('package.json');
    expect(submitReopenWork(SHAPE, AUTO, unread, facts).accepted).toBe(false);
    expect(unread.context.getLedger().activeWorkItemId).toBeUndefined();
  });

  it.each([
    ['collecting context', { contextStatus: 'acquiring' as const }],
    ['a handoff waiting for its next step', { contextStatus: 'ready-pending' as const }],
  ])('refuses while %s', (_label, over) => {
    const session = doneSession(over);
    expect(submitReopenWork(SHAPE, AUTO, session).accepted).toBe(false);
    expect(session.context.getLedger().items.get('w_1')?.status).toBe('done');
  });

  it('refuses superseded work, a missing owner, another active item, a bad shape, and a non-router model', () => {
    const superseded = doneSession();
    superseded.context.append({ v: 1, op: 'work-close', workItemId: 'w_1', status: 'superseded', sourceEntryId: 'u1' });
    expect(submitReopenWork(SHAPE, AUTO, superseded).accepted).toBe(false);

    const unowned = doneSession({}, false);
    expect(submitReopenWork(SHAPE, AUTO, unowned).accepted).toBe(false);
    expect(unowned.context.getLedger().items.get('w_1')?.status).toBe('done');

    const active = new RouterSession();
    active.context.append(createEvent(workItem('w_1', 't_1'), 'u1'));
    active.context.append(activateEvent('w_1', 'u1'));
    active.commitWorkPhaseState({ intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0, priorCompletion: { workItemId: 'w_1' } });
    active.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'entry' });
    active.setLastServed({ registryId: 'a/model', viaFallback: false, accumulatedCost: 0 });
    expect(submitReopenWork(SHAPE, AUTO, active).accepted).toBe(false);

    expect(submitReopenWork({ deliverable: 'implement' }, AUTO, doneSession()).accepted).toBe(false);
    expect(submitReopenWork({ deliverable: 'lightweight', complexity: 'routine', scope: 'bounded' }, AUTO, doneSession()).accepted).toBe(false);
    const concrete = { model: { provider: 'openai', id: 'gpt-5' } } as unknown as ExtensionContext;
    expect(submitReopenWork(SHAPE, concrete, doneSession()).accepted).toBe(false);
  });

  it('leaves the item done when the branch does not record the reopen', () => {
    const session = doneSession();
    session.context.bindPersistence(() => { throw new Error('disk full'); });
    expect(submitReopenWork(SHAPE, AUTO, session).accepted).toBe(false);
    expect(session.context.getLedger().items.get('w_1')?.status).toBe('done');
    expect(session.getWorkPhaseState()?.contextStatus).toBeUndefined();
    // The prior completion, and with it the completed-work mutation gate, stays.
    expect(session.getWorkPhaseState()?.priorCompletion).toEqual({ workItemId: 'w_1' });
  });

  it('registers one sequential tool that does not take a work item id', () => {
    const registerTool = vi.fn();
    registerReopenWorkTool({ registerTool } as unknown as ExtensionAPI, new RouterSession());
    const tool = registerTool.mock.calls[0]![0] as { name: string; executionMode: string; description: string; parameters: { properties: Record<string, unknown> } };
    expect(tool).toMatchObject({ name: REOPEN_WORK_TOOL, executionMode: 'sequential' });
    expect(tool.description).toContain('Do not give an id');
    expect(tool.parameters.properties.workItemId).toBeUndefined();
  });
});
