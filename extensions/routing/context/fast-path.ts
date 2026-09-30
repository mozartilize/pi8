/**
 * The deterministic tier: resolve an entry to the active work item without
 * any model call.
 *
 * Only an anchor-free, thin continuation of established plan, review, or
 * implementation work qualifies. A shared file does not imply shared intent.
 * An approval after information gathering can start a different deliverable;
 * collecting context needs the conversation to distinguish it from more gathering.
 */
import { isThinPrompt } from '../policy/continuation.js';
import type { PromptAnchor } from './anchors.js';
import { activeWorkItem, isOpen, type TopicLedger } from './ledger.js';
import type { Dimension } from '../../types.js';
import type { WorkItem } from './types.js';

/**
 * The active work item when the fast path applies, else undefined. A closed
 * item never continues without a resolver.
 */
export function fastPathItem(ledger: TopicLedger, prompt: string, anchors: readonly PromptAnchor[]): WorkItem | undefined {
  const active = activeWorkItem(ledger);
  if (!isOpen(active) || anchors.length > 0) return undefined;
  if (active.lastDeliverable !== 'implement' && active.lastDeliverable !== 'plan' && active.lastDeliverable !== 'review') return undefined;
  return isThinPrompt(prompt) ? active : undefined;
}

/**
 * The least task type a thin continuation of `item` routes at. A prompt such
 * as "ok continue" names no deliverable of its own and does not collect
 * context on the fast path, so it preserves the item's task type. An acknowledgement
 * is not an execution handoff. Undefined when the item has none recorded.
 */
export function continuationFloor(item: Pick<WorkItem, 'lastDeliverable'>): Dimension | undefined {
  return item.lastDeliverable;
}
