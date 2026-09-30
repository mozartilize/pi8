import { describe, it, expect } from 'vitest';
import { continuationFloor, fastPathItem } from './fast-path.js';
import { extractPromptAnchors } from './anchors.js';
import { foldEvents } from './ledger.js';
import { activateEvent, createEvent, workItem } from '../../test-support/context-fixtures.js';

const ledger = foldEvents([
  createEvent(workItem('w_1', 't_1', { lastDeliverable: 'implement', anchors: [{ kind: 'path', value: 'requirements/foo.md', source: 'user' }] })),
  createEvent(workItem('w_3', 't_1', { anchors: [{ kind: 'path', value: 'docs/auth.md', source: 'user' }] })),
  activateEvent('w_1'),
]);
const hit = (prompt: string) => fastPathItem(ledger, prompt, extractPromptAnchors(prompt))?.id;

describe('fastPathItem', () => {
  it('continues the active item for a thin continuation with no anchors', () => {
    expect(hit('implement it')).toBe('w_1');
    expect(hit('ok go ahead')).toBe('w_1');
  });

  it('requires a resolver for a request on an existing anchor, even when it is the only anchor', () => {
    expect(hit('@requirements/foo.md implement this')).toBeUndefined();
    expect(hit('review requirements/foo.md for missing security requirements')).toBeUndefined();
  });

  it.each(['gather', 'lightweight', undefined] as const)('requires a resolver for an approval after %s work', (lastDeliverable) => {
    const collecting = foldEvents([
      createEvent(workItem('w_1', 't_1', { lastDeliverable })),
      activateEvent('w_1'),
    ]);
    for (const prompt of ['ok go ahead', 'yeah fix it', 'ok commit']) {
      expect(fastPathItem(collecting, prompt, [])).toBeUndefined();
    }
  });

  it('misses on an anchor of a dormant item, a new anchor, or a prompt with content', () => {
    expect(hit('back to docs/auth.md: finish the token refresh part')).toBeUndefined();
    expect(hit('@requirements/foo.md and src/new.ts implement this')).toBeUndefined();
    expect(hit('now rework the billing webhook')).toBeUndefined();
  });

  it('never continues a closed item or a branch with no active item', () => {
    const closed = foldEvents([
      createEvent(workItem('w_1', 't_1', { status: 'done' })),
      activateEvent('w_1'),
    ]);
    expect(fastPathItem(closed, 'implement it', [])).toBeUndefined();
    const inactive = foldEvents([createEvent(workItem('w_1'))]);
    expect(fastPathItem(inactive, 'implement it', [])).toBeUndefined();
  });
});

describe('continuationFloor', () => {
  it('keeps the item\'s task type as the continuation minimum, including plan and review', () => {
    expect(continuationFloor(workItem('w', 't', { lastDeliverable: 'implement' }))).toBe('implement');
    expect(continuationFloor(workItem('w', 't', { lastDeliverable: 'gather' }))).toBe('gather');
    expect(continuationFloor(workItem('w', 't', { lastDeliverable: 'plan' }))).toBe('plan');
    expect(continuationFloor(workItem('w', 't', { lastDeliverable: 'review' }))).toBe('review');
    expect(continuationFloor(workItem('w', 't'))).toBeUndefined();
  });
});
