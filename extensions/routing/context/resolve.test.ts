import { describe, it, expect } from 'vitest';
import {
  contextCheck,
  planFromChoice,
  planFromLegacy,
  referencedArtifactPaths,
  requestContext,
  type PlanBase,
} from './resolve.js';
import { extractPromptAnchors } from './anchors.js';
import { buildCatalog } from './catalog.js';
import { emptyLedger, foldEvents, type TopicLedger } from './ledger.js';
import { activateEvent, createEvent, workItem } from '../../test-support/context-fixtures.js';
import type { Dimension } from '../../types.js';

const base = (prompt: string, over: Partial<PlanBase> & { deliverable?: Dimension } = {}): PlanBase => ({
  ledger: emptyLedger(),
  branchState: 'native-empty',
  sourceEntryId: 'e9',
  prompt,
  anchors: extractPromptAnchors(prompt),
  deliverable: 'implement',
  ...over,
});

const fold = (ledger: TopicLedger, events: Parameters<typeof foldEvents>[0]) => foldEvents(events, ledger);

describe('planFromChoice (cold entry)', () => {
  const cold = buildCatalog(emptyLedger(), []);
  const newWork = { topicId: 'NEW_TOPIC', workItemId: 'NEW_WORK_ITEM' };

  it('turns @requirements/foo.md implement this into new work that owes the referenced file', () => {
    const plan = planFromChoice(base('@requirements/foo.md implement this'), cold, newWork,
      { topicTitle: 'Foo export', workItemTitle: 'Implement foo' })!;
    expect(plan.resolution).toMatchObject({
      relation: 'new', deliverable: 'implement', contextReasons: ['referenced-artifact'], resolver: 'context-handoff',
    });
    const ledger = fold(emptyLedger(), plan.events);
    const item = ledger.items.get(plan.workItemId!)!;
    expect(ledger.activeWorkItemId).toBe(item.id);
    expect(item).toMatchObject({ title: 'Implement foo', topic: { title: 'Foo export' }, grounding: [], openContext: ['referenced-artifact'] });
    expect(item.anchors).toEqual([{ kind: 'path', value: 'requirements/foo.md', role: 'reference', source: 'user' }]);
    expect(plan).toMatchObject({ createdTopic: true, createdWorkItem: true });
  });

  it('titles new work from the prompt when the handoff gives a blank title', () => {
    const plan = planFromChoice(base('refactor the cache\nmore detail'), cold, newWork, { topicTitle: '' })!;
    const item = fold(emptyLedger(), plan.events).items.get(plan.workItemId!)!;
    expect(item).toMatchObject({ title: 'refactor the cache', topic: { title: 'refactor the cache' }, openContext: [] });
  });

  it('writes one migration boundary first on a legacy branch', () => {
    const plan = planFromChoice(base('continue with step 2', {
      branchState: 'legacy-uninitialized', legacyHeadEntryId: 'e8',
    }), cold, newWork, { topicTitle: 'Cache', workItemTitle: 'Refactor cache' })!;
    expect(plan.events[0]).toEqual({ v: 1, op: 'migration-init', legacyHeadEntryId: 'e8', mode: 'lazy', sourceEntryId: 'e9' });
    expect(plan.events.filter((e) => e.op === 'migration-init')).toHaveLength(1);
  });
});

describe('planFromChoice (catalog)', () => {
  const ledger = foldEvents([
    createEvent(workItem('w_1', 't_1', { lastDeliverable: 'implement' })),
    createEvent(workItem('w_2', 't_1', { status: 'done' })),
    createEvent(workItem('w_3', 't_1', { status: 'blocked' })),
    createEvent(workItem('w_4', 't_1', { status: 'superseded' })),
    activateEvent('w_1'),
  ]);
  const catalog = buildCatalog(ledger, []);

  it('reopens a completed item as one recorded transition, owing what the request owes', () => {
    const plan = planFromChoice(base('back to the auth work: check @docs/auth.md first', { ledger }), catalog,
      { topicId: 't_1', workItemId: 'w_2' }, { topicTitle: 'x', workItemTitle: 'y' })!;
    expect(plan.resolution).toMatchObject({ workItemId: 'w_2', relation: 'reopen', contextReasons: ['referenced-artifact'] });
    expect(plan.events.map((e) => e.op)).toEqual(['work-update', 'activate', 'boundary']);
    expect(plan.events[2]).toMatchObject({ boundary: 'work-reopen', workItemId: 'w_2' });
    const after = fold(ledger, plan.events);
    expect(after.activeWorkItemId).toBe('w_2');
    expect(after.items.get('w_2')).toMatchObject({ status: 'active', openContext: ['referenced-artifact'] });
  });

  it('resumes a blocked item without reopening it', () => {
    const plan = planFromChoice(base('back to the blocked work', { ledger }), catalog, { topicId: 't_1', workItemId: 'w_3' }, {})!;
    expect(plan.resolution.relation).toBe('resume');
    expect(plan.events.some((e) => e.op === 'boundary')).toBe(false);
    expect(fold(ledger, plan.events).items.get('w_3')?.status).toBe('blocked');
  });

  it('never offers or accepts a superseded item', () => {
    expect(catalog.workItems.map((item) => item.id)).not.toContain('w_4');
    const listed = { ...catalog, workItems: [...catalog.workItems,
      { id: 'w_4', topicId: 't_1', title: 'old', status: 'superseded' as const, anchors: [] }] };
    expect(planFromChoice(base('back to it', { ledger }), listed, { topicId: 't_1', workItemId: 'w_4' }, {})).toBeUndefined();
  });

  it('keeps an obligation the item already holds open when the request adds one', () => {
    const open = foldEvents([createEvent(workItem('w_1', 't_1', { openContext: ['carried-open-context'] })), activateEvent('w_1')]);
    const plan = planFromChoice(base('@docs/auth.md implement it', { ledger: open }), buildCatalog(open, []),
      { topicId: 't_1', workItemId: 'w_1' }, {})!;
    expect(fold(open, plan.events).items.get('w_1')?.openContext).toEqual(['carried-open-context', 'referenced-artifact']);
  });

  it('creates new work under the chosen topic', () => {
    const plan = planFromChoice(base('rework topic routing', { ledger, deliverable: 'plan' }), catalog,
      { topicId: 't_1', workItemId: 'NEW_WORK_ITEM' },
      { topicTitle: 'ignored', workItemTitle: 'Topic routing core' })!;
    const after = fold(ledger, plan.events);
    expect(after.items.get(plan.workItemId!)).toMatchObject({ topic: { id: 't_1' }, title: 'Topic routing core' });
    expect(plan).toMatchObject({ createdTopic: false, createdWorkItem: true });
  });

  it('keeps the active item for a side question', () => {
    const plan = planFromChoice(base('what is a good buttermilk substitute?', { ledger, deliverable: 'lightweight' }), catalog,
      { topicId: 'NEW_TOPIC', workItemId: 'NONE' }, {})!;
    expect(plan.events).toEqual([]);
    expect(plan.resolution.workItemId).toBe('NONE');
  });

  it('returns nothing for UNKNOWN or an invalid choice', () => {
    expect(planFromChoice(base('x', { ledger }), catalog, { topicId: 'UNKNOWN', workItemId: 'UNKNOWN' }, {})).toBeUndefined();
    expect(planFromChoice(base('x', { ledger }), catalog, { topicId: 't_1', workItemId: 'w_9' }, {})).toBeUndefined();
  });
});

describe('planFromLegacy (earlier work)', () => {
  const SHA = 'c'.repeat(64);
  const ledger = foldEvents([
    createEvent(workItem('w_1', 't_1')),
    activateEvent('w_1'),
    { v: 1, op: 'migration-init', legacyHeadEntryId: 'e3', mode: 'lazy', sourceEntryId: 'e4' },
  ]);
  const catalog = buildCatalog(ledger, []);
  const titles = { topicTitle: 'Auth', workItemTitle: 'Login flow' };

  it('starts work linked to the request it was found from, owing what the request owes and carrying nothing else', () => {
    const plan = planFromLegacy(base('back to the old auth work in @docs/auth.md', { ledger }), catalog,
      { topicId: 'NEW_TOPIC', workItemId: 'l_1' }, 'e2', titles)!;
    expect(plan).toMatchObject({ createdTopic: true, createdWorkItem: true, legacy: true });
    expect(plan.resolution).toMatchObject({ relation: 'resume', resolver: 'context-handoff', contextReasons: ['referenced-artifact'] });
    const item = fold(ledger, plan.events).items.get(plan.workItemId!)!;
    expect(item).toMatchObject({ legacySourceEntryId: 'e2', title: 'Login flow', topic: { title: 'Auth' }, grounding: [], openContext: ['referenced-artifact'] });
    expect(item.lastServed).toBeUndefined();
    expect(fold(ledger, plan.events).activeWorkItemId).toBe(item.id);
  });

  it('files it under a listed topic the catalog choice selected', () => {
    const plan = planFromLegacy(base('back to it', { ledger }), catalog, { topicId: 't_1', workItemId: 'l_2' }, 'e2', titles)!;
    expect(plan).toMatchObject({ createdTopic: false, resolution: { topicId: 't_1' } });
  });

  it('reopens the completed item already found from that request instead of starting another', () => {
    const found = fold(ledger, [
      createEvent(workItem('w_2', 't_2', { legacySourceEntryId: 'e2', grounding: [{ anchorValue: 'a.ts', sha256: SHA, observedAtEntryId: 'e5', observedBy: 'read' }] })),
      { v: 1, op: 'work-close', workItemId: 'w_2', status: 'done', sourceEntryId: 'e6' },
      activateEvent('w_1', 'e7'),
    ]);
    const plan = planFromLegacy(base('back to the old auth work in @docs/auth.md', { ledger: found }), buildCatalog(found, []),
      { topicId: 'NEW_TOPIC', workItemId: 'l_1' }, 'e2', titles)!;
    expect(plan).toMatchObject({ workItemId: 'w_2', createdWorkItem: false, createdTopic: false, legacy: true });
    expect(plan.resolution).toMatchObject({ relation: 'reopen', topicId: 't_2' });
    const after = fold(found, plan.events);
    expect(after.items.size).toBe(2);
    expect(after.activeWorkItemId).toBe('w_2');
    expect(after.items.get('w_2')).toMatchObject({ status: 'active', openContext: ['referenced-artifact'] });
  });

  it('does not return to superseded work through its history', () => {
    const superseded = fold(ledger, [
      createEvent(workItem('w_2', 't_2', { legacySourceEntryId: 'e2' })),
      { v: 1, op: 'work-close', workItemId: 'w_2', status: 'superseded', sourceEntryId: 'e6' },
    ]);
    expect(planFromLegacy(base('back to it', { ledger: superseded }), buildCatalog(superseded, []),
      { topicId: 'NEW_TOPIC', workItemId: 'l_1' }, 'e2', titles)).toBeUndefined();
  });

  it('writes the migration boundary first on the entry that starts tracking', () => {
    const plan = planFromLegacy(base('back to the auth work', { branchState: 'legacy-uninitialized', legacyHeadEntryId: 'e3' }),
      buildCatalog(emptyLedger(), []), { topicId: 'NEW_TOPIC', workItemId: 'l_1' }, 'e2', titles)!;
    expect(plan.events.map((e) => e.op)).toEqual(['migration-init', 'work-create', 'activate']);
  });

  it('returns nothing when the topic choice does not hold', () => {
    expect(planFromLegacy(base('x', { ledger }), catalog, { topicId: 'UNKNOWN', workItemId: 'l_1' }, 'e2', titles)).toBeUndefined();
    expect(planFromLegacy(base('x', { ledger }), catalog, { topicId: 't_9', workItemId: 'l_1' }, 'e2', titles)).toBeUndefined();
  });
});

describe('context reasons', () => {
  it('owes an @-referenced file only for plan, change, or review work', () => {
    const anchors = extractPromptAnchors('@spec.md do it');
    expect(requestContext(anchors, 'implement')).toEqual(['referenced-artifact']);
    expect(requestContext(anchors, 'lightweight')).toEqual([]);
    expect(requestContext(extractPromptAnchors('fix the typo in src/a.ts'), 'implement')).toEqual([]);
  });

  it('checks referenced files by grounding and an open obligation by the handoff boundary', () => {
    const item = workItem('w_1', 't_1', {
      anchors: [
        { kind: 'path', value: 'req.md', role: 'reference', source: 'user' },
        { kind: 'path', value: 'src/a.ts', source: 'user' },
      ],
      openContext: ['carried-open-context'],
    });
    expect(referencedArtifactPaths(item)).toEqual(['req.md']);
    expect(contextCheck(['referenced-artifact'], item)).toEqual({ freshPaths: ['req.md'] });
    expect(contextCheck(['carried-open-context'], item)).toEqual({ satisfied: false });
    expect(contextCheck(['referenced-artifact'], { anchors: [], openContext: ['referenced-artifact'] })).toEqual({ satisfied: false });
    expect(contextCheck(['referenced-artifact'], { anchors: [], openContext: [] })).toEqual({ satisfied: true });
    // Unknown open context counts as open.
    expect(contextCheck(['referenced-artifact'], { anchors: [] })).toEqual({ satisfied: false });
    expect(contextCheck([], undefined)).toEqual({ satisfied: true });
    expect(contextCheck(['referenced-artifact'], undefined)).toEqual({ satisfied: false });
  });

  it('lets model anchors add required files but never drop one the user named', () => {
    const referenced = foldEvents([
      createEvent(workItem('w_1', 't_1', { anchors: [{ kind: 'path', value: 'req.md', role: 'reference', source: 'user' }] })),
      { v: 1, op: 'work-update', workItemId: 'w_1', sourceEntryId: 'u2', patch: { anchors: [
        { kind: 'path', value: 'req.md', role: 'implementation', source: 'model' },
        { kind: 'path', value: 'notes.md', role: 'design', source: 'model' },
      ] } },
    ]).items.get('w_1')!;
    expect(referencedArtifactPaths(referenced)).toEqual(['req.md', 'notes.md']);

    const named = workItem('w_2', 't_1', { anchors: [
      { kind: 'path', value: 'x.md', source: 'user' },
      { kind: 'path', value: 'y.md', source: 'user' },
      { kind: 'path', value: 'z.md', role: 'requirement', source: 'model' },
    ] });
    expect(referencedArtifactPaths(named)).toEqual(['x.md', 'y.md', 'z.md']);
  });
});
