import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { applyEvent, foldEvents, parseContextEvent } from './ledger.js';
import { CONTEXT_ENTRY_TYPE, rebuildLedger } from './persistence.js';
import type { AnchorRole, RoutingContextEvent, WorkItemAnchor, WorkItemPatch } from './types.js';
import { RoutingContextState } from '../../serve/router-session-state.js';
import { SessionTree } from '../../test-support/session-tree.js';
import { activateEvent, createEvent, workItem } from '../../test-support/context-fixtures.js';
import type { Dimension } from '../../types.js';

/**
 * Property tests for the work ledger: a pure fold of branch events that the
 * router rebuilds from Pi's session tree. Each property pins an invariant
 * that must hold for every event sequence, not one scenario. Ids come from
 * small pools so sequences keep hitting the same items: updates before a
 * create, duplicate creates, closes of the active item.
 */

const ITEMS = ['w_a', 'w_b', 'w_c'];
const itemId = fc.constantFrom(...ITEMS);
const topicId = fc.constantFrom('t_a', 't_b');
const source = fc.constantFrom('e1', 'e2', 'e3');
const DIMENSIONS: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];

const anchors = fc.uniqueArray(
  fc.record(
    {
      kind: fc.constant('path' as const),
      value: fc.constantFrom('src/a.ts', 'src/b.ts', 'docs/spec.md'),
      role: fc.constantFrom<AnchorRole>('requirement', 'reference', 'implementation'),
      source: fc.constantFrom<WorkItemAnchor['source']>('user', 'model'),
    },
    { requiredKeys: ['kind', 'value', 'source'] },
  ),
  { selector: (anchor) => anchor.value, maxLength: 3 },
);

const patch: fc.Arbitrary<WorkItemPatch> = fc.record(
  {
    title: fc.constantFrom('Export', 'Import'),
    summary: fc.constantFrom('', 'Writes CSV.'),
    topicTitle: fc.constantFrom('Reports', 'Billing'),
    anchors,
    status: fc.constantFrom<'active' | 'blocked'>('active', 'blocked'),
    lastDeliverable: fc.constantFrom(...DIMENSIONS),
    openContext: fc.subarray<'referenced-artifact' | 'carried-open-context'>(['referenced-artifact', 'carried-open-context']),
    handoffMissed: fc.boolean(),
  },
  { requiredKeys: [] },
);

const event: fc.Arbitrary<RoutingContextEvent> = fc.oneof(
  fc.record({ id: itemId, topic: topicId, anchors, source }).map(({ id, topic, anchors: a, source: s }) =>
    createEvent(workItem(id, topic, { anchors: a, createdAtEntryId: s, updatedAtEntryId: s }), s)),
  fc.record({ id: itemId, patch, source }).map(({ id, patch: p, source: s }): RoutingContextEvent =>
    ({ v: 1, op: 'work-update', workItemId: id, patch: p, sourceEntryId: s })),
  fc.record({ id: itemId, status: fc.constantFrom<'done' | 'superseded'>('done', 'superseded'), source })
    .map(({ id, status, source: s }): RoutingContextEvent => ({ v: 1, op: 'work-close', workItemId: id, status, sourceEntryId: s })),
  fc.record({ id: itemId, source }).map(({ id, source: s }) => activateEvent(id, s)),
  fc.record({ head: fc.constantFrom('h1', 'h2'), source }).map(({ head, source: s }): RoutingContextEvent =>
    ({ v: 1, op: 'migration-init', legacyHeadEntryId: head, mode: 'lazy', sourceEntryId: s })),
  fc.record({
    id: itemId,
    path: fc.constantFrom('src/a.ts', 'docs/spec.md'),
    sha256: fc.constantFrom('a'.repeat(64), 'b'.repeat(64)),
    by: fc.constantFrom<'read' | 'self-edit'>('read', 'self-edit'),
    source,
  }).map(({ id, path, sha256, by, source: s }): RoutingContextEvent => ({
    v: 1, op: 'grounding-upsert', workItemId: id,
    artifact: { anchorValue: path, sha256, observedAtEntryId: s, observedBy: by }, sourceEntryId: s,
  })),
  fc.record({ id: itemId, registryId: fc.constantFrom('alpha/cheap', 'beta/strong'), source })
    .map(({ id, registryId, source: s }): RoutingContextEvent =>
      ({ v: 1, op: 'served', workItemId: id, served: { registryId }, sourceEntryId: s })),
  fc.record({
    id: itemId,
    boundary: fc.constantFrom<'investigation-handoff' | 'execution-contract'>('investigation-handoff', 'execution-contract'),
    source,
  }).map(({ id, boundary, source: s }): RoutingContextEvent =>
    ({ v: 1, op: 'boundary', workItemId: id, boundary, handoffId: 'h_1', sourceEntryId: s })),
);
const events = fc.array(event, { maxLength: 40 });

/** Payloads the fold must skip: malformed, unknown, or from another version. */
const junk: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything(),
  event.map((e) => ({ ...e, v: 2 })),
  event.map((e) => ({ ...e, op: 'work-rename' })),
  event.map((e) => ({ ...e, sourceEntryId: '' })),
  source.map((s) => createEvent(workItem('NEW_WORK_ITEM'), s)),
  itemId.map((id) => ({ v: 1, op: 'work-update', workItemId: id, patch: { status: 'done' }, sourceEntryId: 'e1' })),
  itemId.map((id) => ({
    v: 1, op: 'grounding-upsert', workItemId: id, sourceEntryId: 'e1',
    artifact: { anchorValue: 'src/a.ts', sha256: 'not-a-hash', observedAtEntryId: 'e1', observedBy: 'read' },
  })),
);

const customEntry = (id: string, data: unknown) => ({ type: 'custom', id, customType: CONTEXT_ENTRY_TYPE, data });

describe('work ledger properties', () => {
  it('folds the same events to the same ledger, and so does their persisted form', () => {
    fc.assert(fc.property(events, (sequence) => {
      const ledger = foldEvents(sequence);
      expect(foldEvents(sequence)).toEqual(ledger);
      const persisted = sequence.map((e) => parseContextEvent(JSON.parse(JSON.stringify(e))));
      expect(persisted.every((e) => e != null)).toBe(true);
      expect(foldEvents(persisted as RoutingContextEvent[])).toEqual(ledger);
    }));
  });

  it('never lets an invalid payload create or change work', () => {
    fc.assert(fc.property(events, fc.array(fc.tuple(fc.nat(), junk), { maxLength: 10 }), (sequence, noise) => {
      const clean = sequence.map((e, i) => customEntry(`c${i}`, e));
      const noisy: unknown[] = [...clean];
      noise.forEach(([at, data], i) => noisy.splice(at % (noisy.length + 1), 0, customEntry(`j${i}`, data)));
      expect(rebuildLedger(noisy)).toEqual(rebuildLedger(clean));
      expect(rebuildLedger(clean)).toEqual(foldEvents(sequence));
    }));
  });

  it('keeps the active item and recency on known items, and clears the active item when it closes', () => {
    fc.assert(fc.property(events, fc.constantFrom<'done' | 'superseded'>('done', 'superseded'), (sequence, status) => {
      const ledger = foldEvents(sequence);
      expect([...ledger.recency].sort()).toEqual([...ledger.items.keys()].sort());
      const active = ledger.activeWorkItemId;
      if (!active) return;
      expect(ledger.items.has(active)).toBe(true);
      const closed = applyEvent(ledger, { v: 1, op: 'work-close', workItemId: active, status, sourceEntryId: 'e9' });
      expect(closed.activeWorkItemId).toBeUndefined();
      expect(closed.items.get(active)!.status).toBe(status);
    }));
  });

  it('grounds an item only from grounding recorded for that item', () => {
    fc.assert(fc.property(events, (sequence) => {
      for (const item of foldEvents(sequence).items.values()) {
        const own = sequence.flatMap((e) => (e.op === 'grounding-upsert' && e.workItemId === item.id ? [e.artifact] : []));
        for (const artifact of item.grounding) expect(own).toContainEqual(artifact);
      }
    }));
  });

  it('rebuilds a branch from its own events, never a sibling branch\'s', () => {
    const part = fc.array(event, { maxLength: 15 });
    fc.assert(fc.property(part, part, part, (shared, onA, onB) => {
      const tree = new SessionTree();
      tree.user('start');
      for (const e of shared) tree.event(e);
      const fork = tree.assistant('forked');
      for (const e of onA) tree.event(e);
      tree.navigate(fork);
      tree.user('the other way');
      for (const e of onB) tree.event(e);
      expect(rebuildLedger(tree.getBranch())).toEqual(foldEvents([...shared, ...onB]));
    }));
  });

  it('keeps the in-memory ledger the fold of what the branch recorded when writes fail', () => {
    fc.assert(fc.property(fc.array(fc.tuple(event, fc.boolean()), { maxLength: 40 }), (steps) => {
      const tree = new SessionTree();
      tree.user('start');
      const state = new RoutingContextState();
      let failing = false;
      state.bindPersistence((e) => {
        if (failing) throw new Error('disk full');
        tree.event(e);
      });
      for (const [e, fails] of steps) {
        failing = fails;
        state.append(e);
      }
      expect(state.getLedger()).toEqual(rebuildLedger(tree.getBranch()));
    }));
  });
});
