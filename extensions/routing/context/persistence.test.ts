import { describe, it, expect } from 'vitest';
import {
  CONTEXT_ENTRY_TYPE,
  SELECTION_ENTRY_TYPE,
  branchEvents,
  branchHoldsEntry,
  classifyBranch,
  lastUnroutedRequest,
  latestGenuineUserEntry,
  readBranch,
  rebuildLedger,
  requestRouting,
} from './persistence.js';
import { SessionTree } from '../../test-support/session-tree.js';
import { activateEvent, createEvent, workItem } from '../../test-support/context-fixtures.js';

describe('branch reconstruction', () => {
  // U1 → C(w1, t1) → U2 → C(w2)
  //                    └→ U3 → C(w3)
  function tree() {
    const t = new SessionTree();
    const u1 = t.user('first');
    t.event(createEvent(workItem('w_1', 't_1'), u1));
    t.event(activateEvent('w_1', u1));
    const branchPoint = t.getLeafId();
    const u2 = t.user('second');
    t.event(createEvent(workItem('w_2', 't_1'), u2));
    t.event(activateEvent('w_2', u2));
    const leafA = t.getLeafId();
    t.navigate(branchPoint);
    const u3 = t.user('alternate');
    t.event(createEvent(workItem('w_3', 't_2'), u3));
    t.event(activateEvent('w_3', u3));
    const leafB = t.getLeafId();
    return { t, u1, branchPoint, leafA, leafB };
  }

  it('folds exactly the events on the selected leaf', () => {
    const { t, leafA, leafB, branchPoint } = tree();
    t.navigate(leafA);
    let ledger = rebuildLedger(t.getBranch());
    expect([...ledger.items.keys()]).toEqual(['w_1', 'w_2']);
    expect(ledger.activeWorkItemId).toBe('w_2');

    t.navigate(leafB);
    ledger = rebuildLedger(t.getBranch());
    expect([...ledger.items.keys()]).toEqual(['w_1', 'w_3']);
    expect(ledger.activeWorkItemId).toBe('w_3');

    t.navigate(branchPoint);
    ledger = rebuildLedger(t.getBranch());
    expect([...ledger.items.keys()]).toEqual(['w_1']);
  });

  it('forgets a work item when the tree moves to before its creation, and restores it going back', () => {
    const { t, u1, leafA } = tree();
    t.navigate(u1);
    expect(rebuildLedger(t.getBranch()).items.size).toBe(0);
    t.navigate(leafA);
    expect(rebuildLedger(t.getBranch()).items.has('w_2')).toBe(true);
  });

  it('restores the incumbent, and a switch to another model ends it', () => {
    const t = new SessionTree();
    const u = t.user('implement the exporter');
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'incumbent', served: { registryId: 'a/opus', thinkingLevel: 'high' }, dimension: 'implement', sourceEntryId: u });
    const ledger = rebuildLedger(t.getBranch());
    expect(ledger.incumbent).toEqual({ registryId: 'a/opus', thinkingLevel: 'high', dimension: 'implement', entryId: u });
    // Serving history never makes a branch tracked.
    expect(ledger.events).toBe(0);
    // Pi re-selecting router/auto on resume keeps it.
    t.modelChange('router', 'auto');
    expect(rebuildLedger(t.getBranch()).incumbent?.registryId).toBe('a/opus');
    t.modelChange('openai', 'gpt-5');
    t.modelChange('router', 'auto');
    expect(rebuildLedger(t.getBranch()).incumbent).toBeUndefined();
  });

  it('restores a completed item with the incumbent that served it, until another model is chosen', () => {
    const t = new SessionTree();
    const u = t.user('implement the exporter');
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: u,
      events: [createEvent(workItem('w_1'), u), activateEvent('w_1', u)] });
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'incumbent', served: { registryId: 'a/opus' }, dimension: 'implement', workItemId: 'w_1', sourceEntryId: u });
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: u, events: [
      { v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: u },
      { v: 1, op: 'boundary', workItemId: 'w_1', boundary: 'work-complete', handoffId: u, sourceEntryId: u },
    ] });
    const ledger = rebuildLedger(t.getBranch());
    expect(ledger.activeWorkItemId).toBeUndefined();
    expect(ledger.items.get('w_1')?.status).toBe('done');
    expect(ledger.incumbent).toMatchObject({ registryId: 'a/opus', workItemId: 'w_1' });
    t.modelChange('openai', 'gpt-5');
    t.modelChange('router', 'auto');
    expect(rebuildLedger(t.getBranch()).incumbent).toBeUndefined();
  });

  it('follows completion and reopen along the selected branch, and a fork before completion never sees it', () => {
    const t = new SessionTree();
    const u1 = t.user('implement the exporter');
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: u1,
      events: [createEvent(workItem('w_1'), u1), activateEvent('w_1', u1)] });
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'incumbent', served: { registryId: 'a/opus' }, dimension: 'implement', workItemId: 'w_1', sourceEntryId: u1 });
    const beforeCompletion = t.getLeafId();
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: u1, events: [
      { v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: u1 },
      { v: 1, op: 'boundary', workItemId: 'w_1', boundary: 'work-complete', handoffId: u1, sourceEntryId: u1 },
    ] });
    const completed = t.getLeafId();
    const u2 = t.user('fix the retry branch too');
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: u2, events: [
      { v: 1, op: 'work-update', workItemId: 'w_1', patch: { status: 'active' }, sourceEntryId: u2 },
      activateEvent('w_1', u2),
      { v: 1, op: 'boundary', workItemId: 'w_1', boundary: 'work-reopen', handoffId: u2, sourceEntryId: u2 },
    ] });
    const reopened = t.getLeafId();
    const boundaries = () => branchEvents(t.getBranch()).flatMap((e) => (e.op === 'boundary' ? [e.boundary] : []));

    t.navigate(beforeCompletion);
    let ledger = rebuildLedger(t.getBranch());
    expect(ledger.items.get('w_1')?.status).toBe('active');
    expect(ledger.activeWorkItemId).toBe('w_1');

    t.navigate(completed);
    ledger = rebuildLedger(t.getBranch());
    expect(ledger.items.get('w_1')?.status).toBe('done');
    expect(ledger.activeWorkItemId).toBeUndefined();
    expect(ledger.incumbent).toMatchObject({ registryId: 'a/opus', workItemId: 'w_1' });

    t.navigate(reopened);
    ledger = rebuildLedger(t.getBranch());
    expect(ledger.items.get('w_1')?.status).toBe('active');
    expect(ledger.activeWorkItemId).toBe('w_1');
    expect(boundaries()).toEqual(['work-complete', 'work-reopen']);

    // A fork from before completion holds neither later boundary.
    t.navigate(beforeCompletion);
    t.user('try another exporter design');
    ledger = rebuildLedger(t.getBranch());
    expect(ledger.items.get('w_1')?.status).toBe('active');
    expect(boundaries()).toEqual([]);
  });

  it('skips other extensions\' entries and malformed ledger entries', () => {
    const t = new SessionTree();
    const u = t.user('hi');
    t.custom('other-extension', { v: 1, op: 'activate', workItemId: 'w_1', sourceEntryId: u });
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'work-create', workItem: { id: 'w_bad' }, sourceEntryId: u });
    t.custom(CONTEXT_ENTRY_TYPE, 'garbage');
    t.event(createEvent(workItem('w_1'), u));
    expect(branchEvents(t.getBranch()).map((e) => e.op)).toEqual(['work-create']);
    expect(rebuildLedger(t.getBranch()).items.size).toBe(1);
  });
});

describe('classifyBranch', () => {
  it('replays a ready handoff as one persisted entry with flat work and boundary events', () => {
    const tree = new SessionTree();
    tree.user('implement the parser');
    const item = { ...workItem('w:ready', 't:parser'), openContext: ['referenced-artifact' as const] };
    tree.appendEntry(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: 'e:ready', events: [
      { v: 1, op: 'work-create', workItem: item, sourceEntryId: 'e:ready' },
      { v: 1, op: 'activate', workItemId: item.id, sourceEntryId: 'e:ready' },
      { v: 1, op: 'boundary', workItemId: item.id, boundary: 'investigation-handoff',
        handoffId: 'h:ready', sourceEntryId: 'e:ready' },
    ] });
    expect(tree.getBranch().filter((entry) => entry.type === 'custom')).toHaveLength(1);
    expect(branchEvents(tree.getBranch()).map((event) => event.op)).toEqual(['work-create', 'activate', 'boundary']);
    const restored = rebuildLedger(tree.getBranch());
    expect(restored.activeWorkItemId).toBe(item.id);
    expect(restored.items.get(item.id)?.openContext).toEqual([]);
    tree.navigate(null);
    expect(rebuildLedger(tree.getBranch()).items.size).toBe(0);
  });

  it('skips the whole commit if a subevent cannot apply while retaining flat records', () => {
    const tree = new SessionTree();
    tree.user('continue an earlier task');
    const prior = workItem('w:prior', 't:prior');
    const other = workItem('w:other', 't:other');
    tree.appendEntry(CONTEXT_ENTRY_TYPE, { v: 1, op: 'work-create', workItem: prior, sourceEntryId: 'e:prior' });
    tree.appendEntry(CONTEXT_ENTRY_TYPE, { v: 1, op: 'context-commit', sourceEntryId: 'e:other', events: [
      { v: 1, op: 'work-create', workItem: other, sourceEntryId: 'e:other' },
      { v: 1, op: 'activate', workItemId: 'w:missing', sourceEntryId: 'e:other' },
    ] });
    expect(branchEvents(tree.getBranch()).map((event) => event.op)).toEqual(['work-create']);
    const restored = rebuildLedger(tree.getBranch());
    expect(restored.items.size).toBe(1);
    expect(restored.items.has(prior.id)).toBe(true);
    expect(restored.items.has(other.id)).toBe(false);
  });

  it('tracks a branch with ledger events', () => {
    const t = new SessionTree();
    const u = t.user('hi');
    t.event({ v: 1, op: 'migration-init', legacyHeadEntryId: 'e0', mode: 'lazy', sourceEntryId: u });
    expect(classifyBranch(t.getBranch(), rebuildLedger(t.getBranch()))).toBe('tracked');
  });

  it('marks conversation without a ledger as legacy, and an empty branch as native', () => {
    const t = new SessionTree();
    expect(classifyBranch(t.getBranch(), rebuildLedger(t.getBranch()))).toBe('native-empty');
    t.user('refactor the cache');
    t.assistant('done');
    expect(classifyBranch(t.getBranch(), rebuildLedger(t.getBranch()))).toBe('legacy-uninitialized');
  });

  it('marks a branch legacy only for a request sent while router/auto was not the model', () => {
    const t = new SessionTree();
    const state = () => classifyBranch(t.getBranch(), rebuildLedger(t.getBranch()));
    t.modelChange('router', 'auto');
    t.user('hi');
    t.assistant('hello');
    expect(state()).toBe('native-empty');
    // A switch with no request sent under it leaves nothing unrouted.
    t.modelChange('openai', 'gpt-5');
    t.modelChange('router', 'auto');
    expect(state()).toBe('native-empty');
    t.modelChange('openai', 'gpt-5');
    t.user('refactor the cache');
    t.assistant('done');
    t.modelChange('router', 'auto');
    expect(state()).toBe('legacy-uninitialized');
  });

  it('keeps a branch tracked through a stored migration record, which keeps no state', () => {
    const t = new SessionTree();
    const u = t.user('hi');
    t.event({ v: 1, op: 'migration-init', legacyHeadEntryId: 'e0', mode: 'lazy', sourceEntryId: u });
    expect(rebuildLedger(t.getBranch())).toMatchObject({ events: 1 });
    expect('migration' in rebuildLedger(t.getBranch())).toBe(false);
  });
});

describe('requestRouting', () => {
  it('marks every request sent under another model, in each stretch, and none sent to router/auto', () => {
    const t = new SessionTree();
    const legacy = t.user('first, before any model was recorded');
    t.modelChange('router', 'auto');
    const routed = t.user('served by the router');
    t.modelChange('openai', 'gpt-5');
    const concrete1 = t.user('sent to gpt-5');
    t.modelChange('router', 'auto');
    t.user('served again');
    t.modelChange('openai', 'gpt-5');
    const concrete2 = t.user('sent to gpt-5 again');
    t.modelChange('router', 'auto');
    const current = t.user('current entry');
    const { unrouted, routedAtEnd } = requestRouting(t.getBranch());
    expect([...unrouted]).toEqual([legacy, concrete1, concrete2]);
    expect(unrouted.has(routed)).toBe(false);
    expect(routedAtEnd).toBe(true);
    expect(lastUnroutedRequest(t.getBranch(), current)).toBe(concrete2);
    expect(lastUnroutedRequest(t.getBranch(), concrete2)).toBe(concrete1);
  });

  it('reads the router selection record like model_change', () => {
    const t = new SessionTree();
    t.modelChange('router', 'auto');
    t.custom(SELECTION_ENTRY_TYPE, { provider: 'openai', modelId: 'gpt-5' });
    const concrete = t.user('resumed with --model gpt-5');
    t.custom(SELECTION_ENTRY_TYPE, { provider: 'router', modelId: 'auto' });
    const routed = t.user('resumed with --model router/auto');
    const { unrouted } = requestRouting(t.getBranch());
    expect(unrouted.has(concrete)).toBe(true);
    expect(unrouted.has(routed)).toBe(false);
  });

  it('counts a request as served when a router event names it or follows it with no record', () => {
    const t = new SessionTree();
    // History without any selection record: the router's own events show it served.
    const first = t.user('first routed entry');
    t.custom(CONTEXT_ENTRY_TYPE, { v: 1, op: 'incumbent', served: { registryId: 'a/opus', thinkingLevel: 'high' }, dimension: 'implement', sourceEntryId: first });
    const answer = t.user('answered without a ledger write');
    const { unrouted, routedAtEnd } = requestRouting(t.getBranch());
    expect(unrouted.has(first)).toBe(false);
    expect(unrouted.has(answer)).toBe(false);
    expect(routedAtEnd).toBe(true);
  });

  it('stops continuing the active item after a request the router did not serve', () => {
    const t = new SessionTree();
    t.modelChange('router', 'auto');
    const u1 = t.user('build the exporter');
    t.event(createEvent(workItem('w_1', 't_1'), u1));
    t.event(activateEvent('w_1', u1));
    // A switch with no request sent under it keeps the active item.
    t.modelChange('openai', 'gpt-5');
    t.modelChange('router', 'auto');
    expect(rebuildLedger(t.getBranch()).activeWorkItemId).toBe('w_1');
    t.modelChange('openai', 'gpt-5');
    t.user('something else entirely');
    t.modelChange('router', 'auto');
    const ledger = rebuildLedger(t.getBranch());
    expect(ledger.activeWorkItemId).toBeUndefined();
    expect(ledger.items.get('w_1')?.status).toBe('active');
  });
});

describe('latestGenuineUserEntry', () => {
  it('matches the intent key timestamp, then the text, then the newest user message', () => {
    const t = new SessionTree();
    const first = t.user('first', 111);
    t.assistant('ok');
    const second = t.user('second', 222);
    const branch = t.getBranch();
    expect(latestGenuineUserEntry(branch, { key: '1:111:abcd' })).toBe(first);
    expect(latestGenuineUserEntry(branch, { key: '1:none:abcd', promptText: 'first' })).toBe(first);
    expect(latestGenuineUserEntry(branch, {})).toBe(second);
    expect(latestGenuineUserEntry([], {})).toBeUndefined();
  });
});

describe('branchHoldsEntry', () => {
  it('finds the user entry an intent key names only on the branch that holds it', () => {
    const t = new SessionTree();
    t.user('first', 111);
    const fork = t.assistant('ok');
    t.user('second', 222);
    expect(branchHoldsEntry(t.getBranch(), '2:222:abcd')).toBe(true);
    t.navigate(fork);
    t.user('other', 333);
    expect(branchHoldsEntry(t.getBranch(), '2:222:abcd')).toBe(false);
    expect(branchHoldsEntry(t.getBranch(), '1:111:abcd')).toBe(true);
    expect(branchHoldsEntry(t.getBranch(), '1:none:abcd')).toBe(false);
    expect(branchHoldsEntry(undefined, '1:111:abcd')).toBe(false);
  });
});

describe('readBranch', () => {
  it('fails open when the session has no readable branch', () => {
    expect(readBranch(undefined)).toBeUndefined();
    expect(readBranch({})).toBeUndefined();
    expect(readBranch({ getBranch: () => { throw new Error('closed'); } })).toBeUndefined();
  });
});
