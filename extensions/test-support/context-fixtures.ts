/** Builders for work-context state in tests. */
import type { RoutingContextEvent, WorkItem } from '../routing/context/types.js';

export function workItem(id: string, topicId = 't_1', over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    topic: { id: topicId, title: `topic ${topicId}` },
    title: `work ${id}`,
    summary: '',
    anchors: [],
    grounding: [],
    status: 'active',
    createdAtEntryId: 'u1',
    updatedAtEntryId: 'u1',
    ...over,
  };
}

export const createEvent = (item: WorkItem, source = 'u1'): RoutingContextEvent =>
  ({ v: 1, op: 'work-create', workItem: item, sourceEntryId: source });

export const activateEvent = (id: string, source = 'u1'): RoutingContextEvent =>
  ({ v: 1, op: 'activate', workItemId: id, sourceEntryId: source });
