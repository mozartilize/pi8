/**
 * Work item lifecycle around the incumbent: which work item a serving model
 * owns, and whether a completed item still has its model.
 *
 * An incumbent and active work are different facts. A model keeps serving
 * after its work item completes, with the conversation it had, but it no
 * longer owns active work: the next request either reopens that same item,
 * hands off to other work, or only talks about the completed work.
 *
 * Pure: no I/O, no registry or session access.
 */
import type { TopicLedger } from '../context/ledger.js';
import type { Incumbent, WorkItem } from '../context/types.js';

/** The incumbent, when it serves the active work item. */
export function activeIncumbent(ledger: TopicLedger): Incumbent | undefined {
  const incumbent = ledger.incumbent;
  if (!incumbent?.workItemId || incumbent.workItemId !== ledger.activeWorkItemId) return undefined;
  const item = ledger.items.get(incumbent.workItemId);
  return item && (item.status === 'active' || item.status === 'blocked') ? incumbent : undefined;
}

/**
 * The incumbent and the completed work item it served last, while no work
 * item is active. An incumbent recorded without a work item, or whose item
 * was superseded, has no completed work to return to.
 */
export function completedIncumbent(ledger: TopicLedger): { incumbent: Incumbent; workItem: WorkItem } | undefined {
  const incumbent = ledger.incumbent;
  if (!incumbent?.workItemId || ledger.activeWorkItemId != null) return undefined;
  const workItem = ledger.items.get(incumbent.workItemId);
  return workItem?.status === 'done' ? { incumbent, workItem } : undefined;
}

/**
 * The work item to record with a serving model. The entry's own item comes
 * first, then the branch's active item. An entry on no item keeps the
 * association only for the model that already held it: another model never
 * inherits ownership of completed work it did not serve.
 */
export function incumbentWorkItem(
  ledger: TopicLedger,
  registryId: string,
  entryWorkItemId: string | undefined,
): string | undefined {
  if (entryWorkItemId) return entryWorkItemId;
  if (ledger.activeWorkItemId) return ledger.activeWorkItemId;
  const current = ledger.incumbent;
  return current?.registryId === registryId ? current.workItemId : undefined;
}
