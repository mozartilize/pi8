import { describe, expect, it, vi } from 'vitest';
import { SERVING_ENTRY_TYPE, ServingHistoryState, rebuildServingHistory } from './serving-history.js';
import { SELECTION_ENTRY_TYPE } from '../routing/context/persistence.js';

const event = (customType: string, data: unknown) => ({ type: 'custom', customType, data });
const served = (registryId: string, effort?: string) => event(SERVING_ENTRY_TYPE,
  { v: 1, op: 'served', registryId, ...(effort ? { effort } : {}), sourceEntryId: 'entry' });
const selection = (provider: string, modelId: string) => event(SELECTION_ENTRY_TYPE, { provider, modelId });
const legacy = (patch = {}) => event('pi8-routing-context-v1', { v: 1, op: 'incumbent',
  served: { registryId: 'a/model', thinkingLevel: 'high' }, dimension: 'implement', sourceEntryId: 'old',
  workItemId: 'work', contractStrikes: { 'a/model': 2 }, excludedExecutors: ['a/model'], ...patch });

describe('branch serving history', () => {
  it('writes only model identity and source provenance, once per identity change', () => {
    const state = new ServingHistoryState();
    const persist = vi.fn(); state.bindPersistence(persist);
    state.record({ registryId: 'a/model', thinkingLevel: 'high' }, 'first');
    state.record({ registryId: 'a/model', thinkingLevel: 'high' }, 'second');
    expect(persist.mock.calls).toEqual([[{ v: 1, op: 'served', registryId: 'a/model', effort: 'high', sourceEntryId: 'first' }]]);
    state.clearIncumbent();
    state.record({ registryId: 'a/model', thinkingLevel: 'high' }, 'after-manual');
    expect(persist).toHaveBeenCalledTimes(2);
    state.record({ registryId: 'a/model', thinkingLevel: 'low' }, 'new-effort');
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('reads legacy incumbent identity without work status, task type, grounding, or penalties', () => {
    expect(rebuildServingHistory([legacy()])).toEqual({ routerSelected: true,
      incumbent: { registryId: 'a/model', thinkingLevel: 'high' } });
    expect(rebuildServingHistory([event('pi8-routing-context-v1', { v: 1, op: 'work-create',
      sourceEntryId: 'old', workItem: { id: 'work', lastDeliverable: 'implement' } })])).toEqual({ routerSelected: false });
  });

  it.each([{ v: 2 }, { sourceEntryId: '' }, { served: { registryId: 'noslash' } },
    { served: { registryId: 'a/model', thinkingLevel: 3 } }, { served: { registryId: 'a/model', thinkingLevel: 'invalid' } }])(
    'ignores invalid legacy identity %j', (patch) => {
      expect(rebuildServingHistory([served('b/valid'), legacy(patch)])).toEqual({ routerSelected: true, incumbent: { registryId: 'b/valid' } });
    });

  it('folds model selections and serving events in branch order without reviving an identity after a manual period', () => {
    const manual = { type: 'model_change', provider: 'manual', modelId: 'model' };
    expect(rebuildServingHistory([legacy(), manual])).toEqual({ routerSelected: false });
    expect(rebuildServingHistory([legacy(), manual, selection('router', 'auto')])).toEqual({ routerSelected: true });
    expect(rebuildServingHistory([legacy(), manual, selection('router', 'auto'), served('b/new', 'low')])).toEqual({
      routerSelected: true, incumbent: { registryId: 'b/new', thinkingLevel: 'low' },
    });
    expect(rebuildServingHistory([served('b/new'), selection('manual', 'model')])).toEqual({ routerSelected: false });
  });

  it('restores each branch read-only and clears the identity on an unreadable branch', () => {
    const persist = vi.fn(); const state = new ServingHistoryState(); state.bindPersistence(persist);
    state.restore([served('a/left', 'high')]);
    expect(state.getIncumbent()).toEqual({ registryId: 'a/left', thinkingLevel: 'high' });
    state.restore([legacy(), served('b/right', 'low')]);
    expect(state.getIncumbent()).toEqual({ registryId: 'b/right', thinkingLevel: 'low' });
    state.restore(undefined);
    expect(state.getIncumbent()).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it('retains actual serving identity in memory when persistence fails', () => {
    const state = new ServingHistoryState(); state.bindPersistence(() => { throw new Error('cannot persist'); });
    expect(() => state.record({ registryId: 'a/model' }, 'entry')).not.toThrow();
    expect(state.getIncumbent()).toEqual({ registryId: 'a/model' });
  });
});
