/**
 * The TopicLedger: a pure fold of work-context events in branch order.
 *
 * No I/O, no session access. Events that do not apply (an unknown item, a
 * duplicate create) leave the ledger unchanged, and malformed persisted data
 * is rejected by {@link parseContextEvent} before it reaches the fold, so a
 * damaged entry can only lose state, never invent it.
 */
import { randomBytes } from 'node:crypto';
import type { Dimension } from '../../types.js';
import {
  CONTEXT_COMMIT_EVENT_LIMIT,
  RESERVED_IDS,
  type FlatContextEvent,
  type AnchorKind,
  type AnchorRole,
  type GroundedArtifact,
  type ContextReason,
  type RoutingContextEvent,
  type TopicLabel,
  type WorkItem,
  type WorkItemAnchor,
  type WorkItemPatch,
  type WorkItemStatus,
} from './types.js';

/** Internal bounds on descriptive metadata; not semantic restrictions. */
export const CONTEXT_LIMITS = {
  topicTitle: 120,
  workTitle: 120,
  summary: 1200,
  anchorValue: 512,
  anchors: 32,
  grounding: 32,
  id: 64,
} as const;

export interface TopicLedger {
  /** Every WorkItem on the branch, keyed by id. */
  readonly items: ReadonlyMap<string, WorkItem>;
  /** Item ids, most recently touched first. */
  readonly recency: readonly string[];
  readonly activeWorkItemId?: string;
  /** The lazy migration boundary, when this branch predates pi8. */
  readonly migration?: { legacyHeadEntryId: string; sourceEntryId: string };
  /** Events applied; zero means the branch carries no ledger. */
  readonly events: number;
}

export function emptyLedger(): TopicLedger {
  return { items: new Map(), recency: [], events: 0 };
}

const hexId = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex')}`;

/** A fresh opaque topic id; never collides with a reserved value. */
export function newTopicId(): string {
  return hexId('t');
}

/** A fresh opaque work item id; never collides with a reserved value. */
export function newWorkItemId(): string {
  return hexId('w');
}

export function bound(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

const ANCHOR_KINDS: ReadonlySet<AnchorKind> = new Set(['path', 'symbol', 'issue', 'requirement', 'other']);
const ANCHOR_ROLES: ReadonlySet<AnchorRole> = new Set(['requirement', 'design', 'implementation', 'test', 'reference']);
const ANCHOR_SOURCES = new Set(['user', 'model', 'router']);
const STATUSES: ReadonlySet<WorkItemStatus> = new Set(['active', 'blocked', 'done', 'superseded']);
const DIMENSIONS: ReadonlySet<Dimension> = new Set(['lightweight', 'gather', 'plan', 'implement', 'review']);
/** Reasons a work item can hold open; the others belong to one entry. */
const OPEN_CONTEXT: ReadonlySet<ContextReason> = new Set(['referenced-artifact', 'carried-open-context']);

const anchorKey = (anchor: Pick<WorkItemAnchor, 'kind' | 'value'>) => `${anchor.kind}\0${anchor.value}`;

/**
 * Merge anchors by kind and value; a later role wins, except that only the
 * user sets the role of an anchor the user named: that role decides which
 * files a referenced artifact requires. Over the cap, the oldest anchors the
 * user did not name go first, then the oldest user ones: what the user
 * referenced is the evidence the request rests on.
 */
export function mergeAnchors(existing: readonly WorkItemAnchor[], added: readonly WorkItemAnchor[]): WorkItemAnchor[] {
  const merged = [...existing];
  for (const anchor of added) {
    const index = merged.findIndex((a) => anchorKey(a) === anchorKey(anchor));
    if (index < 0) {
      merged.push(anchor);
      continue;
    }
    const current = merged[index]!;
    const setsRole = anchor.role != null && (current.source !== 'user' || anchor.source === 'user');
    merged[index] = {
      ...current,
      ...(setsRole ? { role: anchor.role } : {}),
      source: current.source === 'user' ? 'user' : anchor.source,
    };
  }
  while (merged.length > CONTEXT_LIMITS.anchors) {
    const dropIndex = merged.findIndex((a) => a.source !== 'user');
    merged.splice(dropIndex >= 0 ? dropIndex : 0, 1);
  }
  return merged;
}

/** Replace the record for the same anchor, keep the newest records under the cap. */
export function upsertGrounding(existing: readonly GroundedArtifact[], artifact: GroundedArtifact): GroundedArtifact[] {
  const next = [...existing.filter((g) => g.anchorValue !== artifact.anchorValue), artifact];
  return next.slice(-CONTEXT_LIMITS.grounding);
}

function touch(recency: readonly string[], id: string): string[] {
  return [id, ...recency.filter((other) => other !== id)];
}

function withItem(ledger: TopicLedger, item: WorkItem, touched = true): TopicLedger {
  const items = new Map(ledger.items);
  items.set(item.id, item);
  return {
    ...ledger,
    items,
    recency: touched ? touch(ledger.recency, item.id) : ledger.recency,
    events: ledger.events + 1,
  };
}

function applyPatch(item: WorkItem, patch: WorkItemPatch, sourceEntryId: string): WorkItem {
  return {
    ...item,
    ...(patch.title != null ? { title: patch.title } : {}),
    ...(patch.summary != null ? { summary: patch.summary } : {}),
    ...(patch.anchors ? { anchors: mergeAnchors(item.anchors, patch.anchors) } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.lastDeliverable ? { lastDeliverable: patch.lastDeliverable } : {}),
    ...(patch.openContext ? { openContext: patch.openContext } : {}),
    ...(patch.handoffMissed != null ? { handoffMissed: patch.handoffMissed } : {}),
    updatedAtEntryId: sourceEntryId,
  };
}

/** Apply one validated event. Events that do not apply return the ledger unchanged. */
export function applyEvent(ledger: TopicLedger, event: RoutingContextEvent): TopicLedger {
  switch (event.op) {
    case 'work-create': {
      if (ledger.items.has(event.workItem.id)) return ledger;
      // A topic keeps the label its first item gave it; renames go through work-update.
      const known = [...ledger.items.values()].find((item) => item.topic.id === event.workItem.topic.id);
      const topic = known ? known.topic : event.workItem.topic;
      return withItem(ledger, { ...event.workItem, topic });
    }
    case 'work-update': {
      const item = ledger.items.get(event.workItemId);
      if (!item) return ledger;
      let next = withItem(ledger, applyPatch(item, event.patch, event.sourceEntryId));
      const topicTitle = event.patch.topicTitle;
      if (topicTitle != null && topicTitle !== item.topic.title) {
        const items = new Map(next.items);
        for (const [id, other] of items) {
          if (other.topic.id === item.topic.id) items.set(id, { ...other, topic: { ...other.topic, title: topicTitle } });
        }
        next = { ...next, items };
      }
      return next;
    }
    case 'work-close': {
      const item = ledger.items.get(event.workItemId);
      if (!item) return ledger;
      const next = withItem(ledger, { ...item, status: event.status, updatedAtEntryId: event.sourceEntryId });
      if (next.activeWorkItemId !== item.id) return next;
      const { activeWorkItemId: _closed, ...rest } = next;
      return rest;
    }
    case 'activate': {
      if (!ledger.items.has(event.workItemId)) return ledger;
      return {
        ...ledger,
        activeWorkItemId: event.workItemId,
        recency: touch(ledger.recency, event.workItemId),
        events: ledger.events + 1,
      };
    }
    case 'migration-init': {
      if (ledger.migration) return ledger;
      return {
        ...ledger,
        migration: { legacyHeadEntryId: event.legacyHeadEntryId, sourceEntryId: event.sourceEntryId },
        events: ledger.events + 1,
      };
    }
    case 'grounding-upsert': {
      const item = ledger.items.get(event.workItemId);
      if (!item) return ledger;
      return withItem(ledger, { ...item, grounding: upsertGrounding(item.grounding, event.artifact) }, false);
    }
    case 'served': {
      const item = ledger.items.get(event.workItemId);
      if (!item) return ledger;
      const lastServed = {
        registryId: event.served.registryId,
        ...(event.served.thinkingLevel ? { thinkingLevel: event.served.thinkingLevel } : {}),
        entryId: event.sourceEntryId,
      };
      return withItem(ledger, { ...item, lastServed }, false);
    }
    case 'boundary': {
      const item = ledger.items.get(event.workItemId);
      if (!item) return ledger;
      // An accepted context handoff is the explicit boundary that ends the
      // item's open context, and shows its acquisitions hand off again; a
      // contract only associates its record.
      const next = event.boundary === 'investigation-handoff'
        ? { ...item, openContext: [], ...(item.handoffMissed ? { handoffMissed: false } : {}) }
        : item;
      return withItem(ledger, next, false);
    }
    case 'context-commit':
      // Branch restoration validates the entire commit before applying its flat events.
      return ledger;
  }
}

export function foldEvents(events: readonly RoutingContextEvent[], from: TopicLedger = emptyLedger()): TopicLedger {
  return events.reduce(applyEvent, from);
}

export function getWorkItem(ledger: TopicLedger, id: string | undefined): WorkItem | undefined {
  return id ? ledger.items.get(id) : undefined;
}

export function activeWorkItem(ledger: TopicLedger): WorkItem | undefined {
  return getWorkItem(ledger, ledger.activeWorkItemId);
}

/** The item already found from the pre-tracking user entry `entryId`, if any. */
export function legacyWorkItem(ledger: TopicLedger, entryId: string): WorkItem | undefined {
  for (const item of ledger.items.values()) {
    if (item.legacySourceEntryId === entryId) return item;
  }
  return undefined;
}

/** Whether an item can be continued without a new resolution. */
export function isOpen(item: WorkItem | undefined): item is WorkItem {
  return item != null && (item.status === 'active' || item.status === 'blocked');
}

/** Topics derived from their items, most recently touched first. */
export function ledgerTopics(ledger: TopicLedger): TopicLabel[] {
  const seen = new Map<string, TopicLabel>();
  for (const id of ledger.recency) {
    const item = ledger.items.get(id);
    if (item && !seen.has(item.topic.id)) seen.set(item.topic.id, item.topic);
  }
  return [...seen.values()];
}

// ─── Validation of persisted data ────────────────────────────────────

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => value != null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function parseId(value: unknown): string | undefined {
  if (!text(value) || value.length > CONTEXT_LIMITS.id || RESERVED_IDS.has(value)) return undefined;
  return value;
}

export function parseAnchor(value: unknown): WorkItemAnchor | undefined {
  if (!isRecord(value) || !text(value.value)) return undefined;
  if (!ANCHOR_KINDS.has(value.kind as AnchorKind) || !ANCHOR_SOURCES.has(value.source as string)) return undefined;
  if (value.role != null && !ANCHOR_ROLES.has(value.role as AnchorRole)) return undefined;
  return {
    kind: value.kind as AnchorKind,
    value: bound(value.value, CONTEXT_LIMITS.anchorValue),
    ...(value.role ? { role: value.role as AnchorRole } : {}),
    source: value.source as WorkItemAnchor['source'],
  };
}

function parseAnchors(value: unknown): WorkItemAnchor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const anchors = value.map(parseAnchor);
  if (anchors.some((a) => a == null)) return undefined;
  return mergeAnchors([], anchors as WorkItemAnchor[]);
}

function parseArtifact(value: unknown): GroundedArtifact | undefined {
  if (!isRecord(value) || !text(value.anchorValue) || !text(value.observedAtEntryId)) return undefined;
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return undefined;
  if (value.observedBy !== 'read' && value.observedBy !== 'self-edit') return undefined;
  return {
    anchorValue: bound(value.anchorValue, CONTEXT_LIMITS.anchorValue),
    sha256: value.sha256,
    observedAtEntryId: value.observedAtEntryId,
    observedBy: value.observedBy,
  };
}

function parseTopic(value: unknown): TopicLabel | undefined {
  if (!isRecord(value)) return undefined;
  const id = parseId(value.id);
  if (!id || !text(value.title)) return undefined;
  return { id, title: bound(value.title, CONTEXT_LIMITS.topicTitle) };
}

function parseWorkItem(value: unknown): WorkItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = parseId(value.id);
  const topic = parseTopic(value.topic);
  const anchors = parseAnchors(value.anchors ?? []);
  const grounding = Array.isArray(value.grounding) ? value.grounding.map(parseArtifact) : undefined;
  if (!id || !topic || !anchors || !grounding || grounding.some((g) => g == null)) return undefined;
  if (!text(value.title) || typeof value.summary !== 'string') return undefined;
  if (!STATUSES.has(value.status as WorkItemStatus)) return undefined;
  if (!text(value.createdAtEntryId) || !text(value.updatedAtEntryId)) return undefined;
  const item: WorkItem = {
    id,
    topic,
    title: bound(value.title, CONTEXT_LIMITS.workTitle),
    summary: bound(value.summary, CONTEXT_LIMITS.summary),
    anchors,
    grounding: (grounding as GroundedArtifact[]).slice(-CONTEXT_LIMITS.grounding),
    status: value.status as WorkItemStatus,
    createdAtEntryId: value.createdAtEntryId,
    updatedAtEntryId: value.updatedAtEntryId,
  };
  if (DIMENSIONS.has(value.lastDeliverable as Dimension)) item.lastDeliverable = value.lastDeliverable as Dimension;
  const openContext = parseOpenContext(value);
  if (openContext) item.openContext = openContext;
  if (typeof value.handoffMissed === 'boolean') item.handoffMissed = value.handoffMissed;
  // A damaged reference loses the link to history, never the item.
  if (text(value.legacySourceEntryId) && value.legacySourceEntryId.length <= CONTEXT_LIMITS.id) {
    item.legacySourceEntryId = value.legacySourceEntryId;
  }
  return item;
}

const LEGACY_PREREQUISITES: ReadonlySet<unknown> = new Set([
  'none', 'referenced-artifact', 'explicit-investigation', 'missing-context',
]);

/**
 * A record's open context. Records written before context reasons carry
 * `prerequisiteOpen` and `lastPrerequisite` instead: an open referenced
 * artifact stays one, and any other open prerequisite becomes an obligation
 * only a context handoff ends. Undefined when the record holds none, or a
 * malformed one.
 */
function parseOpenContext(value: Record<string, unknown>): ContextReason[] | undefined {
  if (value.openContext != null) {
    if (!Array.isArray(value.openContext) || value.openContext.length > OPEN_CONTEXT.size) return undefined;
    if (!value.openContext.every((reason) => OPEN_CONTEXT.has(reason as ContextReason))) return undefined;
    return [...new Set(value.openContext as ContextReason[])];
  }
  if (typeof value.prerequisiteOpen !== 'boolean') return undefined;
  if (value.lastPrerequisite != null && !LEGACY_PREREQUISITES.has(value.lastPrerequisite)) return undefined;
  if (!value.prerequisiteOpen) return [];
  return [value.lastPrerequisite === 'referenced-artifact' ? 'referenced-artifact' : 'carried-open-context'];
}

function parsePatch(value: unknown): WorkItemPatch | undefined {
  if (!isRecord(value)) return undefined;
  const patch: WorkItemPatch = {};
  if (value.title != null) {
    if (!text(value.title)) return undefined;
    patch.title = bound(value.title, CONTEXT_LIMITS.workTitle);
  }
  if (value.summary != null) {
    if (typeof value.summary !== 'string') return undefined;
    patch.summary = bound(value.summary, CONTEXT_LIMITS.summary);
  }
  if (value.topicTitle != null) {
    if (!text(value.topicTitle)) return undefined;
    patch.topicTitle = bound(value.topicTitle, CONTEXT_LIMITS.topicTitle);
  }
  if (value.anchors != null) {
    const anchors = parseAnchors(value.anchors);
    if (!anchors) return undefined;
    patch.anchors = anchors;
  }
  if (value.status != null) {
    if (value.status !== 'active' && value.status !== 'blocked') return undefined;
    patch.status = value.status;
  }
  if (value.lastDeliverable != null) {
    if (!DIMENSIONS.has(value.lastDeliverable as Dimension)) return undefined;
    patch.lastDeliverable = value.lastDeliverable as Dimension;
  }
  if (value.openContext != null || value.prerequisiteOpen != null) {
    const openContext = parseOpenContext(value);
    if (!openContext) return undefined;
    patch.openContext = openContext;
  }
  if (value.handoffMissed != null) {
    if (typeof value.handoffMissed !== 'boolean') return undefined;
    patch.handoffMissed = value.handoffMissed;
  }
  return patch;
}

/**
 * Validate one persisted event. An unknown version or operation, or any
 * malformed field, yields undefined: the fold skips it rather than guessing.
 */
function parseFlatContextEvent(data: unknown): FlatContextEvent | undefined {
  try {
    if (!isRecord(data) || data.v !== 1 || !text(data.sourceEntryId)) return undefined;
    const sourceEntryId = data.sourceEntryId;
    switch (data.op) {
      case 'work-create': {
        const workItem = parseWorkItem(data.workItem);
        return workItem ? { v: 1, op: 'work-create', workItem, sourceEntryId } : undefined;
      }
      case 'work-update': {
        const workItemId = parseId(data.workItemId);
        const patch = parsePatch(data.patch);
        return workItemId && patch ? { v: 1, op: 'work-update', workItemId, patch, sourceEntryId } : undefined;
      }
      case 'work-close': {
        const workItemId = parseId(data.workItemId);
        if (!workItemId || (data.status !== 'done' && data.status !== 'superseded')) return undefined;
        return { v: 1, op: 'work-close', workItemId, status: data.status, sourceEntryId };
      }
      case 'activate': {
        const workItemId = parseId(data.workItemId);
        return workItemId ? { v: 1, op: 'activate', workItemId, sourceEntryId } : undefined;
      }
      case 'migration-init': {
        if (!text(data.legacyHeadEntryId) || data.mode !== 'lazy') return undefined;
        return { v: 1, op: 'migration-init', legacyHeadEntryId: data.legacyHeadEntryId, mode: 'lazy', sourceEntryId };
      }
      case 'grounding-upsert': {
        const workItemId = parseId(data.workItemId);
        const artifact = parseArtifact(data.artifact);
        return workItemId && artifact ? { v: 1, op: 'grounding-upsert', workItemId, artifact, sourceEntryId } : undefined;
      }
      case 'served': {
        const workItemId = parseId(data.workItemId);
        const served = isRecord(data.served) ? data.served : undefined;
        if (!workItemId || !served || !text(served.registryId)) return undefined;
        if (served.thinkingLevel != null && typeof served.thinkingLevel !== 'string') return undefined;
        return {
          v: 1,
          op: 'served',
          workItemId,
          served: {
            registryId: served.registryId,
            ...(served.thinkingLevel ? { thinkingLevel: served.thinkingLevel as string } : {}),
          },
          sourceEntryId,
        };
      }
      case 'boundary': {
        const workItemId = parseId(data.workItemId);
        if (!workItemId || !text(data.handoffId)) return undefined;
        if (data.boundary !== 'investigation-handoff' && data.boundary !== 'execution-contract') return undefined;
        return { v: 1, op: 'boundary', workItemId, boundary: data.boundary, handoffId: data.handoffId, sourceEntryId };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Reject a damaged commit as a unit; inner events never nest. */
export function parseContextEvent(data: unknown): RoutingContextEvent | undefined {
  try {
    if (!isRecord(data) || data.op !== 'context-commit') return parseFlatContextEvent(data);
    if (data.v !== 1 || !text(data.sourceEntryId) || !Array.isArray(data.events)
      || data.events.length === 0 || data.events.length > CONTEXT_COMMIT_EVENT_LIMIT) return undefined;
    const events: FlatContextEvent[] = [];
    for (const raw of data.events) {
      const event = parseFlatContextEvent(raw);
      if (!event || event.sourceEntryId !== data.sourceEntryId) return undefined;
      events.push(event);
    }
    return { v: 1, op: 'context-commit', sourceEntryId: data.sourceEntryId, events };
  } catch {
    return undefined;
  }
}
