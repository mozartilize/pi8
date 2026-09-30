/**
 * Entry resolution plans: what each tier decided, as an EntryResolution plus
 * the ledger events that record it.
 *
 * Pure: the caller supplies the ledger, the prompt's anchors, the entry's
 * deliverable, and the handoff's choice; it appends the events and checks
 * grounding itself. A plan never reuses state it cannot justify: new work
 * starts with nothing grounded for other work.
 */
import type { Dimension, WorkChoice } from '../../types.js';
import type { PromptAnchor } from './anchors.js';
import { checkChoice, type CatalogSnapshot } from './catalog.js';
import { bound, CONTEXT_LIMITS, getWorkItem, legacyWorkItem, newTopicId, newWorkItemId, type TopicLedger } from './ledger.js';
import {
  NEW_TOPIC,
  NONE,
  type BranchState,
  type ContextReason,
  type EntryResolution,
  type RoutingContextEvent,
  type WorkItem,
  type WorkItemAnchor,
} from './types.js';

export interface PlanBase {
  ledger: TopicLedger;
  branchState: BranchState;
  sourceEntryId: string;
  /** The entry's parent on a legacy branch: the end of history that predates the ledger. */
  legacyHeadEntryId?: string;
  prompt: string;
  anchors: readonly PromptAnchor[];
  /** The entry's task type. */
  deliverable: Dimension;
}

/** Titles a handoff gives new work; a blank one falls back to the prompt's first line. */
export interface WorkTitles {
  topicTitle?: string;
  workItemTitle?: string;
}

export interface ContextPlan {
  resolution: EntryResolution;
  events: RoutingContextEvent[];
  /** Id of the work item the entry resolved to, once materialized. */
  workItemId?: string;
  createdTopic: boolean;
  createdWorkItem: boolean;
  /** Placed on work found in the branch's history from before tracking started. */
  legacy?: true;
}

/** Only a context handoff selects work. */
const RESOLVER = 'context-handoff' as const;

/** Task types whose request rests on the files it references. */
export const CONTEXT_DELIVERABLES: ReadonlySet<Dimension> = new Set(['plan', 'implement', 'review']);

/**
 * What the request itself owes, without a model: an `@`-referenced file
 * behind a plan, change, or review must be read first. Plain path mentions
 * name targets, not references.
 */
export function requestContext(anchors: readonly PromptAnchor[], deliverable: Dimension): ContextReason[] {
  const referenced = anchors.some((anchor) => anchor.kind === 'path' && anchor.mention === 'at');
  return referenced && CONTEXT_DELIVERABLES.has(deliverable) ? ['referenced-artifact'] : [];
}

/**
 * What returning to `item` owes: files the user referenced for it, checked
 * again because they may have changed, and any obligation an earlier entry
 * left open.
 */
export function carriedContext(item: Pick<WorkItem, 'anchors' | 'openContext'>): ContextReason[] {
  const referenced = item.anchors.some((anchor) =>
    anchor.kind === 'path' && anchor.source === 'user' && anchor.role != null && REFERENCE_ROLES.has(anchor.role));
  return [
    ...(referenced || item.openContext?.includes('referenced-artifact') ? ['referenced-artifact' as const] : []),
    ...(item.openContext?.includes('carried-open-context') ? ['carried-open-context' as const] : []),
  ];
}

/** What an entry selecting existing `item` owes: its own request's context and what the item carries. */
function ownedAndCarried(base: PlanBase, item: WorkItem): ContextReason[] {
  return [...new Set([...requestContext(base.anchors, base.deliverable), ...carriedContext(item)])];
}

/** No accepted context handoff is still owed on the item; unknown counts as owed. */
export function contextClosed(item: Pick<WorkItem, 'openContext'>): boolean {
  return item.openContext?.length === 0;
}

/** Prompt anchors as the user's anchors; `@`-references carry the reference role. */
export function promptAnchorsForItem(anchors: readonly PromptAnchor[]): WorkItemAnchor[] {
  return anchors.map((anchor) => ({
    kind: anchor.kind,
    value: anchor.value,
    ...(anchor.mention === 'at' ? { role: 'reference' as const } : {}),
    source: 'user' as const,
  }));
}

const REFERENCE_ROLES: ReadonlySet<string> = new Set(['requirement', 'design', 'reference']);

/**
 * The files a referenced artifact requires reading: the user's paths
 * with a requirement, design, or reference role (every path the user named
 * when none has one), plus any such path the model added. Model anchors only
 * add files; they never replace one the user named.
 */
export function referencedArtifactPaths(item: Pick<WorkItem, 'anchors'>): string[] {
  const paths = item.anchors.filter((anchor) => anchor.kind === 'path');
  const referencing = (anchor: WorkItemAnchor) => anchor.role != null && REFERENCE_ROLES.has(anchor.role);
  const user = paths.filter((anchor) => anchor.source === 'user');
  const userReferences = user.filter(referencing);
  const added = paths.filter((anchor) => anchor.source !== 'user' && referencing(anchor));
  const required = [...(userReferences.length > 0 ? userReferences : user), ...added].map((anchor) => anchor.value);
  return [...new Set(required)];
}

/**
 * How to decide whether the context a request owes is in hand: referenced
 * files by fresh grounding, an open obligation only by an accepted context
 * handoff. A referenced artifact with no file to check is met by a handoff.
 */
export function contextCheck(
  reasons: readonly ContextReason[],
  item: Pick<WorkItem, 'anchors' | 'openContext'> | undefined,
): { satisfied: boolean } | { freshPaths: string[] } {
  if (reasons.length === 0) return { satisfied: true };
  if (!item || reasons.includes('carried-open-context')) return { satisfied: false };
  const paths = referencedArtifactPaths(item);
  return paths.length > 0 ? { freshPaths: paths } : { satisfied: contextClosed(item) };
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return bound(line || 'Untitled work', CONTEXT_LIMITS.workTitle);
}

function migration(base: PlanBase): RoutingContextEvent[] {
  if (base.branchState !== 'legacy-uninitialized' || base.ledger.migration) return [];
  return [{
    v: 1,
    op: 'migration-init',
    legacyHeadEntryId: base.legacyHeadEntryId ?? base.sourceEntryId,
    mode: 'lazy',
    sourceEntryId: base.sourceEntryId,
  }];
}

function resolution(
  base: PlanBase,
  fields: Pick<EntryResolution, 'topicId' | 'workItemId' | 'relation' | 'contextReasons' | 'resolver'>,
): EntryResolution {
  return { sourceEntryId: base.sourceEntryId, deliverable: base.deliverable, ...fields };
}

/** Events that record an entry on an item it continues or resumes. */
function touchItem(base: PlanBase, item: WorkItem, reasons: readonly ContextReason[]): RoutingContextEvent[] {
  const events: RoutingContextEvent[] = [];
  if (base.ledger.activeWorkItemId !== item.id) {
    events.push({ v: 1, op: 'activate', workItemId: item.id, sourceEntryId: base.sourceEntryId });
  }
  const anchors = promptAnchorsForItem(base.anchors);
  // A request that owes context opens it for this entry, even when an
  // earlier entry of the same item already handed off.
  const opened = [...new Set([...(item.openContext ?? []), ...reasons])];
  const patch = {
    ...(anchors.length > 0 ? { anchors } : {}),
    ...(item.status !== 'active' && item.status !== 'blocked' ? { status: 'active' as const } : {}),
    ...(item.lastDeliverable !== base.deliverable ? { lastDeliverable: base.deliverable } : {}),
    ...(reasons.length > 0 && opened.length !== item.openContext?.length ? { openContext: opened } : {}),
  };
  if (Object.keys(patch).length > 0) {
    events.push({ v: 1, op: 'work-update', workItemId: item.id, patch, sourceEntryId: base.sourceEntryId });
  }
  return events;
}

function createItem(
  base: PlanBase,
  topic: { id: string; title: string },
  title: string,
  reasons: readonly ContextReason[],
  legacySourceEntryId?: string,
): { item: WorkItem; events: RoutingContextEvent[] } {
  const item: WorkItem = {
    id: newWorkItemId(),
    topic: { id: topic.id, title: bound(topic.title, CONTEXT_LIMITS.topicTitle) },
    title: bound(title, CONTEXT_LIMITS.workTitle),
    summary: '',
    anchors: promptAnchorsForItem(base.anchors),
    grounding: [],
    status: 'active',
    createdAtEntryId: base.sourceEntryId,
    updatedAtEntryId: base.sourceEntryId,
    lastDeliverable: base.deliverable,
    openContext: [...reasons],
    ...(legacySourceEntryId ? { legacySourceEntryId } : {}),
  };
  return {
    item,
    events: [
      { v: 1, op: 'work-create', workItem: item, sourceEntryId: base.sourceEntryId },
      { v: 1, op: 'activate', workItemId: item.id, sourceEntryId: base.sourceEntryId },
    ],
  };
}

/**
 * A `hand_off_context` choice from the catalog shown to the entry.
 * Undefined when the choice is UNKNOWN or does not hold against it.
 */
export function planFromChoice(
  base: PlanBase,
  snapshot: CatalogSnapshot,
  choice: WorkChoice,
  titles: WorkTitles,
): ContextPlan | undefined {
  const checked = checkChoice(choice, snapshot, base.deliverable);
  if (checked.kind === 'unknown' || checked.kind === 'invalid') return undefined;
  if (checked.kind === 'none') {
    return {
      resolution: resolution(base, {
        topicId: checked.topicId,
        workItemId: NONE,
        relation: 'switch',
        contextReasons: requestContext(base.anchors, base.deliverable),
        resolver: RESOLVER,
      }),
      events: migration(base),
      createdTopic: false,
      createdWorkItem: false,
    };
  }
  if (checked.kind === 'existing') {
    const item = getWorkItem(base.ledger, checked.workItemId);
    if (!item) return undefined;
    const reasons = ownedAndCarried(base, item);
    return {
      resolution: resolution(base, {
        topicId: item.topic.id,
        workItemId: item.id,
        relation: checked.relation,
        contextReasons: reasons,
        resolver: RESOLVER,
      }),
      events: [...migration(base), ...touchItem(base, item, reasons)],
      workItemId: item.id,
      createdTopic: false,
      createdWorkItem: false,
    };
  }
  const reasons = requestContext(base.anchors, base.deliverable);
  const existingTopic = snapshot.topics.find((topic) => topic.id === checked.topicId);
  const topic = existingTopic ?? { id: newTopicId(), title: titles.topicTitle || titleFromPrompt(base.prompt) };
  const created = createItem(base, topic, titles.workItemTitle ?? titleFromPrompt(base.prompt), reasons);
  return {
    resolution: resolution(base, {
      topicId: topic.id,
      workItemId: created.item.id,
      relation: checked.relation,
      contextReasons: reasons,
      resolver: RESOLVER,
    }),
    events: [...migration(base), ...created.events],
    workItemId: created.item.id,
    createdTopic: existingTopic == null,
    createdWorkItem: true,
  };
}

/**
 * A `hand_off_context` choice of work from before tracking started: the
 * pre-tracking request `seedEntryId` it named. The entry resumes the item
 * already found from that request, or starts one linked to it. Nothing comes
 * from the transcript but the link: no grounding, served model, or phase
 * state, since history shows what was discussed, not that files are
 * unchanged; and context the request owes stays owed, since finding the work
 * does not put its context in front of the model. Undefined when the topic
 * choice does not hold.
 */
export function planFromLegacy(
  base: PlanBase,
  snapshot: CatalogSnapshot,
  choice: WorkChoice,
  seedEntryId: string,
  titles: WorkTitles,
): ContextPlan | undefined {
  const listedTopic = snapshot.topics.find((topic) => topic.id === choice.topicId);
  if (choice.topicId !== NEW_TOPIC && !listedTopic) return undefined;
  const reasons = requestContext(base.anchors, base.deliverable);
  const found = legacyWorkItem(base.ledger, seedEntryId);
  if (found) {
    const carried = ownedAndCarried(base, found);
    return {
      resolution: resolution(base, {
        topicId: found.topic.id,
        workItemId: found.id,
        relation: 'resume',
        contextReasons: carried,
        resolver: RESOLVER,
      }),
      events: [...migration(base), ...touchItem(base, found, carried)],
      workItemId: found.id,
      createdTopic: false,
      createdWorkItem: false,
      legacy: true,
    };
  }
  const topic = listedTopic ?? { id: newTopicId(), title: titles.topicTitle || titleFromPrompt(base.prompt) };
  const created = createItem(base, topic, titles.workItemTitle ?? titleFromPrompt(base.prompt), reasons, seedEntryId);
  return {
    resolution: resolution(base, {
      topicId: topic.id,
      workItemId: created.item.id,
      relation: 'resume',
      contextReasons: reasons,
      resolver: RESOLVER,
    }),
    events: [...migration(base), ...created.events],
    workItemId: created.item.id,
    createdTopic: listedTopic == null,
    createdWorkItem: true,
    legacy: true,
  };
}
