import { describe, it, expect } from 'vitest';
import {
  CONTEXT_ENTRY_TYPE,
  branchEvents,
  branchHoldsEntry,
  classifyBranch,
  classifyBranchBefore,
  latestGenuineUserEntry,
  readBranch,
  rebuildLedger,
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

  it('reads the branch before the entry being routed, not the entry itself', () => {
    const t = new SessionTree();
    const first = t.user('refactor the cache');
    expect(classifyBranchBefore(t.getBranch(), first, rebuildLedger(t.getBranch()))).toBe('native-empty');
    t.assistant('done');
    const second = t.user('add eviction metrics');
    expect(classifyBranchBefore(t.getBranch(), second, rebuildLedger(t.getBranch()))).toBe('legacy-uninitialized');
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
