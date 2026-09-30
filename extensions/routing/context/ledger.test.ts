import { describe, it, expect } from 'vitest';
import {
  CONTEXT_LIMITS,
  activeWorkItem,
  applyEvent,
  emptyLedger,
  foldEvents,
  legacyWorkItem,
  ledgerTopics,
  mergeAnchors,
  newTopicId,
  newWorkItemId,
  parseContextEvent,
} from './ledger.js';
import { CONTEXT_COMMIT_EVENT_LIMIT, RESERVED_IDS, type RoutingContextEvent, type WorkItemAnchor } from './types.js';
import { activateEvent as activate, createEvent as create, workItem } from '../../test-support/context-fixtures.js';

const SHA = 'a'.repeat(64);

describe('ledger fold', () => {
  it('creates, updates, and closes a work item, deriving topics from item labels', () => {
    const ledger = foldEvents([
      create(workItem('w_1', 't_1')),
      create(workItem('w_2', 't_2')),
      activate('w_1'),
      { v: 1, op: 'work-update', workItemId: 'w_1', patch: { title: 'renamed', summary: 'why' }, sourceEntryId: 'u2' },
      { v: 1, op: 'work-close', workItemId: 'w_2', status: 'done', sourceEntryId: 'u3' },
    ]);
    expect(ledger.items.get('w_1')).toMatchObject({ title: 'renamed', summary: 'why', updatedAtEntryId: 'u2' });
    expect(ledger.items.get('w_2')?.status).toBe('done');
    expect(activeWorkItem(ledger)?.id).toBe('w_1');
    expect(ledgerTopics(ledger).map((t) => t.id)).toEqual(['t_2', 't_1']);
  });

  it('keeps a topic label from its first item and renames it on every item through an update', () => {
    const ledger = foldEvents([
      create(workItem('w_1', 't_1')),
      create(workItem('w_2', 't_1', { topic: { id: 't_1', title: 'another title' } })),
      { v: 1, op: 'work-update', workItemId: 'w_2', patch: { topicTitle: 'Routing' }, sourceEntryId: 'u2' },
    ]);
    expect(ledger.items.get('w_1')?.topic.title).toBe('Routing');
    expect(ledger.items.get('w_2')?.topic.title).toBe('Routing');
    expect(ledgerTopics(ledger)).toEqual([{ id: 't_1', title: 'Routing' }]);
  });

  it('ignores events for unknown items and duplicate creates', () => {
    const base = foldEvents([create(workItem('w_1')), activate('w_1')]);
    expect(applyEvent(base, activate('w_9'))).toBe(base);
    expect(applyEvent(base, create(workItem('w_1', 't_9', { title: 'impostor' })))).toBe(base);
    expect(applyEvent(base, { v: 1, op: 'work-close', workItemId: 'w_9', status: 'done', sourceEntryId: 'u' })).toBe(base);
  });

  it('clears the active selection when the active item closes', () => {
    const ledger = foldEvents([
      create(workItem('w_1')),
      activate('w_1'),
      { v: 1, op: 'work-close', workItemId: 'w_1', status: 'superseded', sourceEntryId: 'u2' },
    ]);
    expect(ledger.activeWorkItemId).toBeUndefined();
    expect(ledger.items.get('w_1')?.status).toBe('superseded');
  });

  it('keeps the first migration boundary', () => {
    const ledger = foldEvents([
      { v: 1, op: 'migration-init', legacyHeadEntryId: 'e5', mode: 'lazy', sourceEntryId: 'e6' },
      { v: 1, op: 'migration-init', legacyHeadEntryId: 'e9', mode: 'lazy', sourceEntryId: 'e10' },
    ]);
    expect(ledger.migration).toEqual({ legacyHeadEntryId: 'e5', sourceEntryId: 'e6' });
  });

  it('upserts grounding per anchor and ends open context at its handoff boundary', () => {
    const ledger = foldEvents([
      create(workItem('w_1', 't_1', { openContext: ['carried-open-context'] })),
      { v: 1, op: 'grounding-upsert', workItemId: 'w_1', artifact: { anchorValue: 'a.md', sha256: SHA, observedAtEntryId: 'u1', observedBy: 'read' }, sourceEntryId: 'u1' },
      { v: 1, op: 'grounding-upsert', workItemId: 'w_1', artifact: { anchorValue: 'a.md', sha256: 'b'.repeat(64), observedAtEntryId: 'u2', observedBy: 'self-edit' }, sourceEntryId: 'u2' },
      { v: 1, op: 'boundary', workItemId: 'w_1', boundary: 'investigation-handoff', handoffId: 'k', sourceEntryId: 'u2' },
    ]);
    const item = ledger.items.get('w_1')!;
    expect(item.grounding).toEqual([{ anchorValue: 'a.md', sha256: 'b'.repeat(64), observedAtEntryId: 'u2', observedBy: 'self-edit' }]);
    expect(item.openContext).toEqual([]);
  });

  it('reads a recorded missed-handoff flag and carries nothing from it', () => {
    const recorded = { v: 1, op: 'work-update', workItemId: 'w_1', patch: { handoffMissed: true }, sourceEntryId: 'u1' };
    const parsed = parseContextEvent(recorded);
    expect(parsed).toBeDefined();
    expect(foldEvents([create(workItem('w_1')), parsed!]).items.get('w_1')).not.toHaveProperty('handoffMissed');
    expect(parseContextEvent({ ...recorded, patch: { handoffMissed: 'yes' } })).toBeUndefined();
  });

  it('records the last served model as a hint on the item', () => {
    const ledger = foldEvents([
      create(workItem('w_1')),
      { v: 1, op: 'served', workItemId: 'w_1', served: { registryId: 'a/b', thinkingLevel: 'high' }, sourceEntryId: 'u3' },
    ]);
    expect(ledger.items.get('w_1')?.lastServed).toEqual({ registryId: 'a/b', thinkingLevel: 'high', entryId: 'u3' });
  });

  it('finds the item a pre-tracking entry was found as, whatever its status', () => {
    const ledger = foldEvents([
      create(workItem('w_1', 't_1', { legacySourceEntryId: 'e4' })),
      create(workItem('w_2')),
      { v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u2' },
    ]);
    expect(legacyWorkItem(ledger, 'e4')?.id).toBe('w_1');
    expect(legacyWorkItem(ledger, 'e5')).toBeUndefined();
  });

  it('orders recency by the latest touch', () => {
    const ledger = foldEvents([create(workItem('w_1')), create(workItem('w_2')), activate('w_1')]);
    expect(ledger.recency).toEqual(['w_1', 'w_2']);
  });
});

describe('ids', () => {
  it('generates opaque ids that never collide with reserved values', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const t = newTopicId();
      const w = newWorkItemId();
      expect(t).toMatch(/^t_[0-9a-f]{10}$/);
      expect(w).toMatch(/^w_[0-9a-f]{10}$/);
      expect(RESERVED_IDS.has(t) || RESERVED_IDS.has(w)).toBe(false);
      ids.add(t).add(w);
    }
    expect(ids.size).toBe(400);
  });

  it('keeps ids stable across updates, closes, and reordering', () => {
    const ledger = foldEvents([
      create(workItem('w_1')),
      create(workItem('w_2')),
      activate('w_1'),
      { v: 1, op: 'work-update', workItemId: 'w_2', patch: { title: 'x' }, sourceEntryId: 'u2' },
      { v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u3' },
    ]);
    expect([...ledger.items.keys()].sort()).toEqual(['w_1', 'w_2']);
    expect([...ledger.items.values()].map((i) => i.id).sort()).toEqual(['w_1', 'w_2']);
  });
});

describe('bounded metadata', () => {
  it('drops the oldest anchors the user did not name first', () => {
    const user: WorkItemAnchor = { kind: 'path', value: 'req.md', source: 'user' };
    const model = Array.from({ length: CONTEXT_LIMITS.anchors }, (_, i): WorkItemAnchor => ({
      kind: 'symbol', value: `s${i}`, source: 'model',
    }));
    const merged = mergeAnchors([user], model);
    expect(merged).toHaveLength(CONTEXT_LIMITS.anchors);
    expect(merged[0]).toEqual(user);
    expect(merged.some((a) => a.value === 's0')).toBe(false);
  });

  it('merges anchors by kind and value, keeping a user source and the role only the user set', () => {
    const user = [
      { kind: 'path', value: 'a.md', source: 'user' },
      { kind: 'path', value: 'b.md', role: 'reference', source: 'user' },
    ] as const;
    expect(mergeAnchors([...user], [
      { kind: 'path', value: 'a.md', role: 'requirement', source: 'model' },
      { kind: 'path', value: 'b.md', role: 'implementation', source: 'model' },
    ])).toEqual(user);
    expect(mergeAnchors([{ kind: 'path', value: 'c.md', role: 'requirement', source: 'model' }], [
      { kind: 'path', value: 'c.md', role: 'reference', source: 'user' },
    ])).toEqual([{ kind: 'path', value: 'c.md', role: 'reference', source: 'user' }]);
  });
});

describe('parseContextEvent', () => {
  it('round-trips every event shape', () => {
    const events: RoutingContextEvent[] = [
      create(workItem('w_1', 't_1', { anchors: [{ kind: 'path', value: 'a.md', source: 'user' }], lastDeliverable: 'implement', openContext: [], legacySourceEntryId: 'e4' })),
      { v: 1, op: 'work-update', workItemId: 'w_1', patch: { title: 't', summary: 's', topicTitle: 'T', status: 'blocked', anchors: [{ kind: 'issue', value: '#12', source: 'model' }], lastDeliverable: 'plan', openContext: ['referenced-artifact', 'carried-open-context'] }, sourceEntryId: 'u' },
      { v: 1, op: 'work-close', workItemId: 'w_1', status: 'done', sourceEntryId: 'u' },
      activate('w_1'),
      { v: 1, op: 'migration-init', legacyHeadEntryId: 'e1', mode: 'lazy', sourceEntryId: 'e2' },
      { v: 1, op: 'grounding-upsert', workItemId: 'w_1', artifact: { anchorValue: 'a.md', sha256: SHA, observedAtEntryId: 'u', observedBy: 'read' }, sourceEntryId: 'u' },
      { v: 1, op: 'served', workItemId: 'w_1', served: { registryId: 'a/b' }, sourceEntryId: 'u' },
      { v: 1, op: 'boundary', workItemId: 'w_1', boundary: 'execution-contract', handoffId: 'k', sourceEntryId: 'u' },
    ];
    for (const event of events) expect(parseContextEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('round-trips a bounded commit and rejects malformed batches as a unit', () => {
    const createItem = { v: 1 as const, op: 'work-create' as const, workItem: workItem('w_1'), sourceEntryId: 'u1' };
    const activateItem = { v: 1 as const, op: 'activate' as const, workItemId: 'w_1', sourceEntryId: 'u1' };
    const commit: RoutingContextEvent = { v: 1, op: 'context-commit', sourceEntryId: 'u1',
      events: [createItem, activateItem] };
    expect(parseContextEvent(JSON.parse(JSON.stringify(commit)))).toEqual(commit);
    const invalid = [
      { ...commit, events: [] },
      { ...commit, events: [createItem, { ...activateItem, sourceEntryId: 'u2' }] },
      { ...commit, events: [createItem, { v: 1, op: 'context-commit', sourceEntryId: 'u1', events: [activateItem] }] },
      { ...commit, events: Array.from({ length: CONTEXT_COMMIT_EVENT_LIMIT + 1 }, () => createItem) },
    ];
    for (const record of invalid) expect(parseContextEvent(record)).toBeUndefined();
  });

  it.each([
    ['an unknown version', { v: 2, op: 'activate', workItemId: 'w_1', sourceEntryId: 'u' }],
    ['an unknown operation', { v: 1, op: 'topic-create', sourceEntryId: 'u' }],
    ['a reserved id', { v: 1, op: 'activate', workItemId: 'NEW_WORK_ITEM', sourceEntryId: 'u' }],
    ['a missing source', { v: 1, op: 'activate', workItemId: 'w_1' }],
    ['a routing fact in a patch', { v: 1, op: 'work-update', workItemId: 'w_1', patch: { status: 'done' }, sourceEntryId: 'u' }],
    ['a non-boolean missed handoff', { v: 1, op: 'work-update', workItemId: 'w_1', patch: { handoffMissed: 'yes' }, sourceEntryId: 'u' }],
    ['an entry-local open reason', { v: 1, op: 'work-update', workItemId: 'w_1', patch: { openContext: ['reasoning-prep'] }, sourceEntryId: 'u' }],
    ['a non-boolean legacy open flag', { v: 1, op: 'work-update', workItemId: 'w_1', patch: { prerequisiteOpen: 'yes' }, sourceEntryId: 'u' }],
    ['a malformed fingerprint', { v: 1, op: 'grounding-upsert', workItemId: 'w_1', artifact: { anchorValue: 'a', sha256: 'xyz', observedAtEntryId: 'u', observedBy: 'read' }, sourceEntryId: 'u' }],
    ['a non-object', 'activate'],
  ])('rejects %s', (_label, data) => {
    expect(parseContextEvent(data)).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['over the id bound', 'e'.repeat(CONTEXT_LIMITS.id + 1)],
    ['not a string', 42],
  ])('keeps an item whose history reference is %s, without the reference', (_label, legacySourceEntryId) => {
    const parsed = parseContextEvent({ ...create(workItem('w_1')), workItem: { ...workItem('w_1'), legacySourceEntryId } });
    expect(parsed?.op).toBe('work-create');
    expect((parsed as Extract<RoutingContextEvent, { op: 'work-create' }>).workItem).not.toHaveProperty('legacySourceEntryId');
  });

  it.each([
    ['an open referenced artifact', { lastPrerequisite: 'referenced-artifact', prerequisiteOpen: true }, ['referenced-artifact']],
    ['an open investigation', { lastPrerequisite: 'explicit-investigation', prerequisiteOpen: true }, ['carried-open-context']],
    ['open missing context', { lastPrerequisite: 'missing-context', prerequisiteOpen: true }, ['carried-open-context']],
    ['a closed prerequisite', { lastPrerequisite: 'explicit-investigation', prerequisiteOpen: false }, []],
  ])('reads an item recorded before context reasons with %s', (_label, legacy, openContext) => {
    const { openContext: _unset, ...item } = workItem('w_1');
    const parsed = parseContextEvent({ ...create(workItem('w_1')), workItem: { ...item, ...legacy } });
    expect((parsed as Extract<RoutingContextEvent, { op: 'work-create' }>).workItem.openContext).toEqual(openContext);
    const patch = parseContextEvent({ v: 1, op: 'work-update', workItemId: 'w_1', patch: legacy, sourceEntryId: 'u' });
    expect((patch as Extract<RoutingContextEvent, { op: 'work-update' }>).patch).toEqual({ openContext });
  });

  it('bounds over-long descriptive text instead of rejecting it', () => {
    const parsed = parseContextEvent(create(workItem('w_1', 't_1', { title: 'x'.repeat(500), summary: 'y'.repeat(5000) })));
    expect(parsed?.op).toBe('work-create');
    const item = (parsed as Extract<RoutingContextEvent, { op: 'work-create' }>).workItem;
    expect(item.title.length).toBe(CONTEXT_LIMITS.workTitle);
    expect(item.summary.length).toBe(CONTEXT_LIMITS.summary);
  });

  it('starts from an empty ledger', () => {
    expect(emptyLedger()).toMatchObject({ events: 0, recency: [] });
  });
});
