import { describe, it, expect } from 'vitest';
import { foldEvents } from '../context/ledger.js';
import type { RoutingContextEvent } from '../context/types.js';
import { activateEvent, createEvent, workItem } from '../../test-support/context-fixtures.js';
import { completedIncumbent, incumbentWorkItem } from './work-completion.js';

const incumbent = (workItemId?: string, registryId = 'a/b'): RoutingContextEvent => ({
  v: 1, op: 'incumbent', served: { registryId }, dimension: 'implement',
  ...(workItemId ? { workItemId } : {}), sourceEntryId: 'u1',
});
const close = (status: 'done' | 'superseded'): RoutingContextEvent =>
  ({ v: 1, op: 'work-close', workItemId: 'w_1', status, sourceEntryId: 'u2' });

describe('completedIncumbent', () => {
  it('keeps the conversation after completion, and owns nothing while the item is still open', () => {
    const active = foldEvents([createEvent(workItem('w_1')), activateEvent('w_1'), incumbent('w_1')]);
    expect(completedIncumbent(active)).toBeUndefined();

    const done = foldEvents([close('done')], active);
    expect(completedIncumbent(done)).toMatchObject({ incumbent: { registryId: 'a/b' }, workItem: { id: 'w_1', status: 'done' } });
  });

  it('gives no completed work to an incumbent without a work item, a superseded item, or while other work is active', () => {
    const base = [createEvent(workItem('w_1')), activateEvent('w_1')];
    expect(completedIncumbent(foldEvents([...base, incumbent(), close('done')]))).toBeUndefined();
    expect(completedIncumbent(foldEvents([...base, incumbent('w_1'), close('superseded')]))).toBeUndefined();
    expect(completedIncumbent(foldEvents([...base, incumbent('w_1'), close('done'),
      createEvent(workItem('w_2')), activateEvent('w_2')]))).toBeUndefined();
  });
});

describe('incumbentWorkItem', () => {
  it('records the entry\'s item first, then the active item', () => {
    const ledger = foldEvents([createEvent(workItem('w_1')), activateEvent('w_1')]);
    expect(incumbentWorkItem(ledger, 'a/b', 'w_2')).toBe('w_2');
    expect(incumbentWorkItem(ledger, 'a/b', undefined)).toBe('w_1');
  });

  it('keeps completed work with the model that served it, never with another model', () => {
    const ledger = foldEvents([createEvent(workItem('w_1')), activateEvent('w_1'), incumbent('w_1'), close('done')]);
    expect(incumbentWorkItem(ledger, 'a/b', undefined)).toBe('w_1');
    expect(incumbentWorkItem(ledger, 'c/d', undefined)).toBeUndefined();
  });
});
