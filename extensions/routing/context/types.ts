/**
 * Work-context state: which piece of work a user entry continues, resumes,
 * switches to, or starts.
 *
 * A WorkItem is one concrete piece of work; its Topic is the broader context
 * it belongs to. No routing policy reads Topic state, so a Topic is a bounded
 * label carried on its WorkItems rather than an entity with a lifecycle of
 * its own: the topic list is derived from the WorkItems.
 */
import type { Dimension } from '../../types.js';

export type TopicId = string;
export type WorkItemId = string;

export type WorkItemStatus = 'active' | 'blocked' | 'done' | 'superseded';

export interface TopicLabel {
  /** Opaque, immutable: `t_<random>`. */
  id: TopicId;
  title: string;
}

export type AnchorKind = 'path' | 'symbol' | 'issue' | 'requirement' | 'other';
export type AnchorRole = 'requirement' | 'design' | 'implementation' | 'test' | 'reference';

/**
 * What a WorkItem is about. An anchor is descriptive: it never says that the
 * artifact was read or is current — only a {@link GroundedArtifact} does.
 */
export interface WorkItemAnchor {
  kind: AnchorKind;
  /** Normalized and bounded; a path is relative to the working directory. */
  value: string;
  role?: AnchorRole;
  source: 'user' | 'model' | 'router';
}

/** A router-observed read (or own write) of an anchored file, by content. */
export interface GroundedArtifact {
  anchorValue: string;
  /** SHA-256 of the file's bytes; files above the size cap are never grounded. */
  sha256: string;
  observedAtEntryId: string;
  observedBy: 'read' | 'self-edit';
}

/**
 * Why an entry must collect context before its deliverable. The router
 * derives every reason; no model reports one.
 */
export type ContextReason =
  /** No work item can be chosen for the entry without reading more. */
  | 'identity-unresolved'
  /** The request rests on `@`-referenced files not read as they are now. */
  | 'referenced-artifact'
  /** A plan or review is prepared before it is written. */
  | 'reasoning-prep'
  /** An earlier entry of the same work item left an obligation only a context handoff ends. */
  | 'carried-open-context';

export interface WorkItem {
  /** Opaque, immutable: `w_<random>`. */
  id: WorkItemId;
  topic: TopicLabel;
  title: string;
  summary: string;
  anchors: WorkItemAnchor[];
  grounding: GroundedArtifact[];
  status: WorkItemStatus;
  createdAtEntryId: string;
  updatedAtEntryId: string;
  /** Telemetry and resume hint; never route authority. */
  lastServed?: { registryId: string; thinkingLevel?: string; entryId: string };
  lastDeliverable?: Dimension;
  /**
   * Context reasons an entry of this item raised that no accepted context
   * handoff has ended yet; empty once one has. Absent means unknown, and an
   * unknown obligation counts as open.
   */
  openContext?: ContextReason[];
  /**
   * The user entry, recorded before tracking started on the branch, this
   * item was found from. It identifies the item for later entries that
   * return to the same history; nothing routes on it.
   */
  legacySourceEntryId?: string;
}

export type ContextRelation = 'continue' | 'resume' | 'switch' | 'new' | 'unknown';

/** Reserved choices: uppercase, never generated as ids. */
export const NEW_TOPIC = 'NEW_TOPIC';
export const NEW_WORK_ITEM = 'NEW_WORK_ITEM';
export const NONE = 'NONE';
export const UNKNOWN = 'UNKNOWN';
export const RESERVED_IDS: ReadonlySet<string> = new Set([NEW_TOPIC, NEW_WORK_ITEM, NONE, UNKNOWN]);

export type ResolverTier =
  | 'deterministic'
  | 'context-handoff'
  | 'fallback';

/** What one genuine user entry resolved to, and which tier decided it. */
export interface EntryResolution {
  sourceEntryId: string;
  topicId: TopicId | typeof NEW_TOPIC | typeof UNKNOWN;
  workItemId: WorkItemId | typeof NEW_WORK_ITEM | typeof NONE | typeof UNKNOWN;
  relation: ContextRelation;
  deliverable: Dimension;
  /** Reasons the request itself owes context; identity and reasoning preparation are the entry's. */
  contextReasons: ContextReason[];
  resolver: ResolverTier;
}

/** Descriptive fields a `work-update` may change; routing facts are not among them. */
export interface WorkItemPatch {
  title?: string;
  summary?: string;
  topicTitle?: string;
  /** Merged into the item's anchors by value. */
  anchors?: WorkItemAnchor[];
  status?: 'active' | 'blocked';
  lastDeliverable?: Dimension;
  openContext?: ContextReason[];
}

export type BoundaryKind = 'investigation-handoff' | 'execution-contract';

/**
 * Append-only branch events; the ledger is their fold in branch order. Every
 * event names the genuine user entry that caused it.
 */
export type FlatContextEvent =
  | { v: 1; op: 'work-create'; workItem: WorkItem; sourceEntryId: string }
  | { v: 1; op: 'work-update'; workItemId: WorkItemId; patch: WorkItemPatch; sourceEntryId: string }
  | { v: 1; op: 'work-close'; workItemId: WorkItemId; status: 'done' | 'superseded'; sourceEntryId: string }
  | { v: 1; op: 'activate'; workItemId: WorkItemId; sourceEntryId: string }
  | { v: 1; op: 'migration-init'; legacyHeadEntryId: string; mode: 'lazy'; sourceEntryId: string }
  | { v: 1; op: 'grounding-upsert'; workItemId: WorkItemId; artifact: GroundedArtifact; sourceEntryId: string }
  | {
      v: 1;
      op: 'served';
      workItemId: WorkItemId;
      served: { registryId: string; thinkingLevel?: string };
      sourceEntryId: string;
    }
  | { v: 1; op: 'boundary'; workItemId: WorkItemId; boundary: BoundaryKind; handoffId: string; sourceEntryId: string };

/** A ready handoff persists its selection, grounding, and boundary as one branch entry. */
export type RoutingContextEvent = FlatContextEvent | {
  v: 1;
  op: 'context-commit';
  sourceEntryId: string;
  events: FlatContextEvent[];
};

/** A bounded commit can hold one work selection, its reads, and a boundary. */
export const CONTEXT_COMMIT_EVENT_LIMIT = 32;

/**
 * Whether the active branch carries a ledger. `legacy-uninitialized` is
 * runtime-only: opening, resuming, or navigating to a branch never writes to
 * it; the first genuine user entry on it does.
 */
export type BranchState = 'tracked' | 'native-empty' | 'legacy-uninitialized';
