import { describe, it, expect, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ROUTING_CONTEXT_TOOL, registerRoutingContextTool, submitRoutingContext } from './routing-context-tool.js';
import { RouterSession } from './router-session-state.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { SessionTree } from '../test-support/session-tree.js';

function setup() {
  const tree = new SessionTree();
  const session = new RouterSession();
  const u = tree.user('implement the export');
  session.context.append(createEvent(workItem('w_1', 't_1', { title: 'Export', anchors: [{ kind: 'path', value: 'req.md', source: 'user' }] }), u));
  session.context.append(createEvent(workItem('w_2', 't_1')));
  session.context.append(activateEvent('w_1', u));
  const ctx = { cwd: '/repo', model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() } as never;
  return { tree, session, ctx };
}

describe('routing_context registration', () => {
  function registered(session: RouterSession) {
    const registerTool = vi.fn();
    registerRoutingContextTool({ registerTool } as unknown as ExtensionAPI, session);
    expect(registerTool).toHaveBeenCalledTimes(1);
    return registerTool.mock.calls[0]![0] as { name: string; executionMode?: string; description: string; parameters: unknown };
  }

  it('registers one sequential tool whose schema and description never depend on the ledger', () => {
    const empty = registered(new RouterSession());
    const { session } = setup();
    const full = registered(session);
    expect(full.name).toBe(ROUTING_CONTEXT_TOOL);
    expect(full.executionMode).toBe('sequential');
    expect(JSON.stringify(full.parameters)).toBe(JSON.stringify(empty.parameters));
    expect(full.description).toBe(empty.description);
    expect(JSON.stringify(full.parameters)).not.toContain('w_1');
  });
});

describe('routing_context update', () => {
  it('records titles, a summary, and model anchors on the active item', () => {
    const { session, ctx } = setup();
    const result = submitRoutingContext({
      op: 'update',
      title: 'CSV export',
      summary: 'Writes CSV with a header row.',
      anchors: [{ kind: 'path', value: './src/export.ts', role: 'implementation' }, { kind: 'symbol', value: 'writeCsv' }],
    }, ctx, session);
    expect(result.accepted).toBe(true);
    const item = session.context.getLedger().items.get('w_1')!;
    expect(item).toMatchObject({ title: 'CSV export', summary: 'Writes CSV with a header row.' });
    expect(item.anchors).toContainEqual({ kind: 'path', value: 'src/export.ts', role: 'implementation', source: 'model' });
    expect(item.anchors).toContainEqual({ kind: 'symbol', value: 'writeCsv', source: 'model' });
    expect(item.grounding).toEqual([]);
  });

  it('renames a topic when only the topic is named', () => {
    const { session, ctx } = setup();
    expect(submitRoutingContext({ op: 'update', topicId: 't_1', title: 'Reports' }, ctx, session).accepted).toBe(true);
    expect([...session.context.getLedger().items.values()].every((item) => item.topic.title === 'Reports')).toBe(true);
  });

  it.each([
    ['a routing fact', { op: 'update', deliverable: 'lightweight', title: 'x' }],
    ['a prerequisite', { op: 'update', prerequisite: 'none' }],
    ['an unknown item', { op: 'update', workItemId: 'w_9', title: 'x' }],
    ['a reserved id', { op: 'update', workItemId: 'NEW_WORK_ITEM', title: 'x' }],
    ['an oversized title', { op: 'update', title: 'x'.repeat(121) }],
    ['an oversized summary', { op: 'update', summary: 'x'.repeat(1201) }],
    ['too many anchors', { op: 'update', anchors: Array.from({ length: 33 }, (_, i) => ({ kind: 'symbol', value: `s${i}` })) }],
    ['a path outside the working directory', { op: 'update', anchors: [{ kind: 'path', value: '/etc/passwd' }] }],
    ['a close status', { op: 'update', status: 'done' }],
    ['nothing to change', { op: 'update' }],
  ])('rejects %s without changing the ledger', (_label, params) => {
    const { session, ctx } = setup();
    const before = session.context.getLedger();
    expect(submitRoutingContext(params, ctx, session).accepted).toBe(false);
    expect(session.context.getLedger()).toBe(before);
  });

  it.each(['done', 'superseded'] as const)('never changes the status of a %s item, but still describes it', (status) => {
    const { session, ctx } = setup();
    expect(submitRoutingContext({ op: 'close', workItemId: 'w_2', status }, ctx, session).accepted).toBe(true);
    const before = session.context.getLedger();
    for (const next of ['active', 'blocked']) {
      expect(submitRoutingContext({ op: 'update', workItemId: 'w_2', status: next }, ctx, session).accepted).toBe(false);
    }
    expect(session.context.getLedger()).toBe(before);
    expect(submitRoutingContext({ op: 'update', workItemId: 'w_2', title: 'Renamed' }, ctx, session).accepted).toBe(true);
    expect(session.context.getLedger().items.get('w_2')).toMatchObject({ status, title: 'Renamed' });
  });
});

describe('routing_context close', () => {
  it('closes a known item and clears it as the active one', () => {
    const { session, ctx } = setup();
    expect(submitRoutingContext({ op: 'close', workItemId: 'w_1', status: 'done' }, ctx, session).accepted).toBe(true);
    expect(session.context.getLedger().items.get('w_1')?.status).toBe('done');
    expect(session.context.getLedger().activeWorkItemId).toBeUndefined();
  });

  it('closes the active item when no id is given', () => {
    const { session, ctx } = setup();
    const result = submitRoutingContext({ op: 'close', status: 'superseded' }, ctx, session);
    expect(result).toMatchObject({ accepted: true, details: { workItemId: 'w_1' } });
    expect(session.context.getLedger().items.get('w_1')?.status).toBe('superseded');
    expect(session.context.getLedger().items.get('w_2')?.status).toBe('active');
  });

  it('rejects an unknown or reserved item, a missing status, or no active item without changing the ledger', () => {
    const { session, ctx } = setup();
    const before = session.context.getLedger();
    expect(submitRoutingContext({ op: 'close', workItemId: 'w_9', status: 'done' }, ctx, session).accepted).toBe(false);
    expect(submitRoutingContext({ op: 'close', workItemId: 'UNKNOWN', status: 'done' }, ctx, session).accepted).toBe(false);
    expect(submitRoutingContext({ op: 'close', workItemId: 'w_1' }, ctx, session).accepted).toBe(false);
    expect(session.context.getLedger()).toBe(before);

    submitRoutingContext({ op: 'close', status: 'done' }, ctx, session);
    const closed = session.context.getLedger();
    expect(submitRoutingContext({ op: 'close', status: 'done' }, ctx, session).accepted).toBe(false);
    expect(session.context.getLedger()).toBe(closed);
  });
});

describe('routing_context when the session does not record it', () => {
  it('rejects update and close and leaves the ledger as it was', () => {
    const { session, ctx } = setup();
    session.context.bindPersistence(() => { throw new Error('disk full'); });
    const before = session.context.getLedger();
    expect(submitRoutingContext({ op: 'update', title: 'CSV export' }, ctx, session))
      .toMatchObject({ accepted: false, text: expect.stringContaining('did not record') });
    expect(submitRoutingContext({ op: 'close', status: 'done' }, ctx, session))
      .toMatchObject({ accepted: false, text: expect.stringContaining('did not record') });
    expect(session.context.getLedger()).toBe(before);
  });
});

describe('routing_context outside its scope', () => {
  it('has no effect outside router/auto', () => {
    const { session } = setup();
    const result = submitRoutingContext({ op: 'update', title: 'x' }, { model: { provider: 'openai', id: 'gpt' } } as never, session);
    expect(result).toMatchObject({ accepted: false });
    expect(result.text).toContain('has no effect');
  });

  it('rejects any op other than update or close without changing the ledger', () => {
    const { session, ctx } = setup();
    const before = session.context.getLedger();
    expect(submitRoutingContext({ op: 'resolve', topicId: 't_1', workItemId: 'w_1', relation: 'continue' }, ctx, session).accepted).toBe(false);
    expect(session.context.getLedger()).toBe(before);
  });
});
