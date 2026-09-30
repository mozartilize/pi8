import { describe, it, expect } from 'vitest';
import { CATALOG_SIZES, buildCatalog, catalogAddsItems, checkChoice } from './catalog.js';
import { extractPromptAnchors } from './anchors.js';
import { foldEvents } from './ledger.js';
import { activateEvent, createEvent, workItem } from '../../test-support/context-fixtures.js';
import type { RoutingContextEvent } from './types.js';

describe('buildCatalog', () => {
  const ledger = foldEvents([
    createEvent(workItem('w_old', 't_2', { anchors: [{ kind: 'path', value: 'docs/auth.md', source: 'user' }] })),
    createEvent(workItem('w_other', 't_2')),
    createEvent(workItem('w_sib', 't_1')),
    createEvent(workItem('w_act', 't_1')),
    activateEvent('w_act'),
  ]);

  it('orders the active item, exact anchor matches, the active topic, then other topics', () => {
    const catalog = buildCatalog(ledger, extractPromptAnchors('back to docs/auth.md'));
    expect(catalog.workItems.map((i) => i.id)).toEqual(['w_act', 'w_old', 'w_sib', 'w_other']);
    expect(catalog.activeWorkItemId).toBe('w_act');
    expect(catalog.topics.map((t) => t.id)).toEqual(['t_1', 't_2']);
  });

  it('marks exactly the items whose anchors the prompt names', () => {
    const catalog = buildCatalog(ledger, extractPromptAnchors('back to docs/auth.md'));
    expect(catalog.workItems.filter((i) => i.anchorMatch).map((i) => i.id)).toEqual(['w_old']);
    expect(buildCatalog(ledger, []).workItems.some((i) => i.anchorMatch)).toBe(false);
  });

  it('caps items and topics, listing a topic for every listed item', () => {
    const events: RoutingContextEvent[] = [];
    for (let i = 0; i < 40; i += 1) events.push(createEvent(workItem(`w_${i}`, `t_${i % 20}`)));
    const big = foldEvents(events);
    const normal = buildCatalog(big, []);
    const expanded = buildCatalog(big, [], 'expanded');
    expect(normal.workItems.length).toBeLessThanOrEqual(CATALOG_SIZES.normal.workItems);
    expect(normal.topics.length).toBeLessThanOrEqual(CATALOG_SIZES.normal.topics);
    expect(expanded.workItems.length).toBe(CATALOG_SIZES.expanded.workItems);
    for (const catalog of [normal, expanded]) {
      const topics = new Set(catalog.topics.map((t) => t.id));
      expect(catalog.workItems.every((item) => topics.has(item.topicId))).toBe(true);
    }
    expect(catalogAddsItems(normal, expanded)).toBe(true);
    expect(catalogAddsItems(buildCatalog(ledger, []), buildCatalog(ledger, [], 'expanded'))).toBe(false);
  });
});

describe('checkChoice', () => {
  const catalog = buildCatalog(foldEvents([
    createEvent(workItem('w_1', 't_1')),
    createEvent(workItem('w_2', 't_1')),
    activateEvent('w_1'),
  ]), []);

  it('derives continue and resume from the ids', () => {
    expect(checkChoice({ topicId: 't_1', workItemId: 'w_1' }, catalog, 'implement'))
      .toEqual({ kind: 'existing', workItemId: 'w_1', topicId: 't_1', relation: 'continue' });
    expect(checkChoice({ topicId: 't_1', workItemId: 'w_2' }, catalog, 'implement'))
      .toMatchObject({ kind: 'existing', relation: 'resume' });
  });

  it('accepts new work under a listed or a new topic', () => {
    expect(checkChoice({ topicId: 't_1', workItemId: 'NEW_WORK_ITEM' }, catalog, 'plan'))
      .toEqual({ kind: 'new-item', topicId: 't_1', relation: 'new' });
    expect(checkChoice({ topicId: 'NEW_TOPIC', workItemId: 'NEW_WORK_ITEM' }, catalog, 'plan'))
      .toEqual({ kind: 'new-item', topicId: 'NEW_TOPIC', relation: 'switch' });
  });

  it('reads new work under a new topic as new when no item is active', () => {
    const idle = buildCatalog(foldEvents([createEvent(workItem('w_1', 't_1'))]), []);
    expect(checkChoice({ topicId: 'NEW_TOPIC', workItemId: 'NEW_WORK_ITEM' }, idle, 'plan'))
      .toEqual({ kind: 'new-item', topicId: 'NEW_TOPIC', relation: 'new' });
  });

  it('accepts NONE only for a lightweight side question', () => {
    expect(checkChoice({ topicId: 'NEW_TOPIC', workItemId: 'NONE' }, catalog, 'lightweight'))
      .toEqual({ kind: 'none', topicId: 'NEW_TOPIC', relation: 'switch' });
    expect(checkChoice({ topicId: 'NEW_TOPIC', workItemId: 'NONE' }, catalog, 'implement').kind)
      .toBe('invalid');
  });

  it('rejects ids outside the catalog and an item paired with another topic', () => {
    expect(checkChoice({ topicId: 't_9', workItemId: 'NEW_WORK_ITEM' }, catalog, 'plan').kind).toBe('invalid');
    expect(checkChoice({ topicId: 't_1', workItemId: 'w_9' }, catalog, 'plan').kind).toBe('invalid');
    expect(checkChoice({ topicId: 'NEW_TOPIC', workItemId: 'w_1' }, catalog, 'plan').kind).toBe('invalid');
  });

  it('reads any UNKNOWN as unknown', () => {
    expect(checkChoice({ topicId: 'UNKNOWN', workItemId: 'w_1' }, catalog, 'plan').kind).toBe('unknown');
    expect(checkChoice({ topicId: 't_1', workItemId: 'UNKNOWN' }, catalog, 'plan').kind).toBe('unknown');
  });
});
