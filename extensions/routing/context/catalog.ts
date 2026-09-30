/**
 * The bounded candidate catalog a resolver chooses from, and the rules a
 * choice must satisfy.
 *
 * Retrieval is deterministic — no embeddings. Candidates are ordered: the
 * active item, items whose anchors the prompt names exactly, recent items in
 * the active topic, then recent items in other topics. Every listed item's
 * topic is listed too, so each choice can be read on its own. The catalog is
 * never part of a tool schema: ids change as the ledger does, and a changed
 * schema would rebuild the prompt head.
 */
import type { Dimension } from '../../types.js';
import { hasAnchor, type PromptAnchor } from './anchors.js';
import type { TopicLedger } from './ledger.js';
import {
  NEW_TOPIC,
  NEW_WORK_ITEM,
  NONE,
  UNKNOWN,
  type AnchorKind,
  type WorkItem,
  type WorkItemStatus,
} from './types.js';

export const CATALOG_SIZES = {
  normal: { workItems: 12, topics: 8 },
  expanded: { workItems: 32, topics: 16 },
} as const;

/** Anchors shown per item: enough to recognize it, never its whole history. */
const ANCHORS_PER_ITEM = 4;

export interface CatalogSnapshot {
  v: 1;
  activeWorkItemId?: string;
  topics: Array<{ id: string; title: string }>;
  workItems: Array<{
    id: string;
    topicId: string;
    title: string;
    status: WorkItemStatus;
    anchors: Array<{ kind: AnchorKind; value: string }>;
    /** The prompt names one of the item's anchors exactly. */
    anchorMatch?: true;
  }>;
}

function orderedItems(ledger: TopicLedger, anchors: readonly PromptAnchor[]): WorkItem[] {
  const items = ledger.recency.map((id) => ledger.items.get(id)).filter((item): item is WorkItem => item != null);
  const active = ledger.activeWorkItemId ? ledger.items.get(ledger.activeWorkItemId) : undefined;
  const matched = items.filter((item) => item !== active && anchors.some((anchor) => hasAnchor(item, anchor)));
  const rest = items.filter((item) => item !== active && !matched.includes(item));
  const sameTopic = rest.filter((item) => active != null && item.topic.id === active.topic.id);
  const otherTopics = rest.filter((item) => !sameTopic.includes(item));
  return [...(active ? [active] : []), ...matched, ...sameTopic, ...otherTopics];
}

export function buildCatalog(
  ledger: TopicLedger,
  anchors: readonly PromptAnchor[],
  size: keyof typeof CATALOG_SIZES = 'normal',
): CatalogSnapshot {
  const limits = CATALOG_SIZES[size];
  const topics: CatalogSnapshot['topics'] = [];
  const workItems: CatalogSnapshot['workItems'] = [];
  for (const item of orderedItems(ledger, anchors)) {
    const anchorMatch = anchors.some((anchor) => hasAnchor(item, anchor));
    if (workItems.length >= limits.workItems) break;
    const topicListed = topics.some((topic) => topic.id === item.topic.id);
    if (!topicListed) {
      if (topics.length >= limits.topics) continue;
      topics.push({ id: item.topic.id, title: item.topic.title });
    }
    workItems.push({
      id: item.id,
      topicId: item.topic.id,
      title: item.title,
      status: item.status,
      anchors: item.anchors.slice(0, ANCHORS_PER_ITEM).map((anchor) => ({ kind: anchor.kind, value: anchor.value })),
      ...(anchorMatch ? { anchorMatch: true as const } : {}),
    });
  }
  const activeListed = workItems.some((item) => item.id === ledger.activeWorkItemId);
  return { v: 1, ...(activeListed ? { activeWorkItemId: ledger.activeWorkItemId } : {}), topics, workItems };
}

/** Whether `larger` lists anything `smaller` does not. */
export function catalogAddsItems(smaller: CatalogSnapshot, larger: CatalogSnapshot): boolean {
  const known = new Set(smaller.workItems.map((item) => item.id));
  return larger.workItems.some((item) => !known.has(item.id));
}

export type CheckedChoice =
  | { kind: 'existing'; workItemId: string; topicId: string; relation: 'continue' | 'resume' }
  | { kind: 'new-item'; topicId: string; relation: 'new' | 'switch' }
  | { kind: 'none'; topicId: string; relation: 'switch' }
  | { kind: 'unknown' }
  | { kind: 'invalid'; reason: string };

/**
 * Validate a choice against the catalog it was made from. Ids are the
 * router's to check, and the relation follows from them: the active item
 * continues, another listed item resumes, a side question switches, and new
 * work under a new topic switches away from the active item when there is
 * one.
 */
export function checkChoice(
  choice: { topicId: string; workItemId: string },
  snapshot: CatalogSnapshot,
  deliverable: Dimension,
): CheckedChoice {
  const { topicId, workItemId } = choice;
  if (topicId === UNKNOWN || workItemId === UNKNOWN) return { kind: 'unknown' };
  const topicKnown = topicId === NEW_TOPIC || snapshot.topics.some((topic) => topic.id === topicId);
  if (!topicKnown) return { kind: 'invalid', reason: `topic ${topicId} is not in the catalog` };
  if (workItemId === NONE) {
    if (deliverable !== 'lightweight') return { kind: 'invalid', reason: 'NONE applies only to a lightweight side question' };
    return { kind: 'none', topicId, relation: 'switch' };
  }
  if (workItemId === NEW_WORK_ITEM) {
    const relation = topicId === NEW_TOPIC && snapshot.activeWorkItemId != null ? 'switch' : 'new';
    return { kind: 'new-item', topicId, relation };
  }
  const item = snapshot.workItems.find((candidate) => candidate.id === workItemId);
  if (!item) return { kind: 'invalid', reason: `work item ${workItemId} is not in the catalog` };
  if (topicId !== item.topicId) return { kind: 'invalid', reason: `work item ${workItemId} belongs to topic ${item.topicId}` };
  return { kind: 'existing', workItemId, topicId, relation: workItemId === snapshot.activeWorkItemId ? 'continue' : 'resume' };
}
