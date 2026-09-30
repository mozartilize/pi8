/**
 * Resolve one genuine user entry's work context: a pending choice set for
 * `hand_off_context`. Identity is not written until that handoff is
 * accepted. A result from an earlier session is dropped, never written.
 */
import type { Dimension, WorkChoice, WorkContextMeta } from '../types.js';
import { extractPromptAnchors } from '../routing/context/anchors.js';
import { buildCatalog, type CatalogSnapshot } from '../routing/context/catalog.js';
import { buildLegacyIndex, findLegacyCandidates, type LegacyCandidate } from '../routing/context/legacy.js';
import { DIMENSION_STRENGTH } from '../routing/classify/classifier-keywords.js';
import { activeWorkItem, getWorkItem } from '../routing/context/ledger.js';
import {
  branchHoldsEntry,
  classifyBranchBefore,
  latestGenuineUserEntry,
  readBranch,
  type BranchReader,
} from '../routing/context/persistence.js';
import {
  planFromChoice,
  planFromLegacy,
  type ContextPlan,
  type PlanBase,
  type WorkTitles,
} from '../routing/context/resolve.js';
import type { BoundaryKind, EntryResolution } from '../routing/context/types.js';
import { carryAcrossBranch, type WorkPhaseState } from '../routing/policy/work-phase.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import type { RouterSession } from './router-session-state.js';

export interface PendingIdentity {
  /** Entry-local choice set and original request; never persisted or logged. */
  base: PlanBase;
  catalog: CatalogSnapshot;
  legacy: LegacyCandidate[];
  entryKey: string;
  generation: number;
}

export interface ResolvedEntryContext {
  resolution: EntryResolution;
  workItemId?: string;
  /** Whether the context the request owes was in hand when the entry resolved. */
  contextSatisfied: boolean;
  createdTopic: boolean;
  createdWorkItem: boolean;
  /** Placed on work found in the history from before tracking started. */
  legacy?: boolean;
}

export interface EntryContextRequest {
  session: RouterSession;
  sessionManager?: BranchReader;
  cwd?: string;
  turn: { key: string; promptText: string };
  /** Heuristic task type for this entry; unknown quality never lowers it. */
  deliverable: Dimension;
  /** Prefixes of known integrations' messages, which the history search skips. */
  syntheticPrefixes?: readonly string[];
  stillCurrent: () => boolean;
}

export type EntryContextResult =
  | { kind: 'pending'; identity: PendingIdentity }
  | { kind: 'aborted' };

/** `dimension`, raised to `floor` when the floor is stronger. */
export function atLeast(dimension: Dimension, floor: Dimension | undefined): Dimension {
  return floor && DIMENSION_STRENGTH[floor] > DIMENSION_STRENGTH[dimension] ? floor : dimension;
}

function parentOf(branch: readonly unknown[] | undefined, id: string): string | undefined {
  const entry = (branch ?? []).find((e) => (e as { id?: unknown }).id === id) as { parentId?: string | null } | undefined;
  return entry?.parentId ?? undefined;
}

/**
 * Earlier work an entry may return to, from the branch's history before
 * `headEntryId`. Items the catalog already lists are not offered again.
 * A failed search offers nothing.
 */
function legacyCandidates(
  req: EntryContextRequest,
  headEntryId: string,
  query: Parameters<typeof findLegacyCandidates>[1],
  snapshot: CatalogSnapshot,
): LegacyCandidate[] {
  try {
    const ledger = req.session.context.getLedger();
    const index = req.session.context.legacyIndexFor(headEntryId, () => buildLegacyIndex(
      readBranch(req.sessionManager, headEntryId),
      headEntryId,
      { ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.syntheticPrefixes ? { syntheticPrefixes: req.syntheticPrefixes } : {}) },
    ));
    const listed = new Set(snapshot.workItems.flatMap((item) => ledger.items.get(item.id)?.legacySourceEntryId ?? []));
    return findLegacyCandidates(index, query, listed);
  } catch (err) {
    debugLog('context.legacy-error', { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Every entry starts unresolved: its bounded choice set goes to the entry's
 * model, and identity is written only at an accepted `hand_off_context`.
 */
export async function resolveEntryContext(req: EntryContextRequest): Promise<EntryContextResult> {
  const { session, turn } = req;
  const ledger = session.context.getLedger();
  const branch = readBranch(req.sessionManager);
  const sourceEntryId = latestGenuineUserEntry(branch, turn) ?? turn.key;
  // With no ledger yet, the branch is read as it stood before this entry:
  // the state read when the session opened misses requests sent under
  // another model since, before a switch to router/auto.
  const untracked = ledger.events === 0 ? classifyBranchBefore(branch, sourceEntryId, ledger) : undefined;
  const known = [...ledger.items.values()].flatMap((item) => item.anchors);
  const anchors = extractPromptAnchors(turn.promptText, { ...(req.cwd ? { cwd: req.cwd } : {}), known });
  const base: PlanBase = {
    ledger,
    branchState: untracked ?? session.context.getBranchState(),
    sourceEntryId,
    ...(parentOf(branch, sourceEntryId) ? { legacyHeadEntryId: parentOf(branch, sourceEntryId) } : {}),
    prompt: turn.promptText,
    anchors,
    deliverable: req.deliverable,
  };
  const catalog = buildCatalog(ledger, anchors, 'normal');
  const legacyHead = ledger.migration?.legacyHeadEntryId
    ?? (untracked === 'legacy-uninitialized' ? parentOf(branch, sourceEntryId) : undefined);
  const legacy = legacyHead ? legacyCandidates(req, legacyHead, { prompt: turn.promptText, anchors }, catalog) : [];
  if (!req.stillCurrent()) return { kind: 'aborted' };
  session.context.setEntrySource(sourceEntryId);
  return {
    kind: 'pending',
    identity: { base, catalog, legacy, entryKey: turn.key, generation: session.getSessionGeneration() },
  };
}

/** Select work only from the catalog shown to this entry, or its offered legacy hits. */
export function planPendingIdentity(
  session: RouterSession,
  pending: PendingIdentity,
  choice: WorkChoice,
  deliverable: Dimension,
  titles: WorkTitles,
): ContextPlan | undefined {
  if (session.getSessionGeneration() !== pending.generation) return undefined;
  // The context the plan's request owes depends on the adopted task type and
  // the entry's anchors, never on the model's description of its findings.
  const base: PlanBase = { ...pending.base, ledger: session.context.getLedger(), deliverable };
  const legacy = pending.legacy.find((candidate) => candidate.id === choice.workItemId);
  return legacy
    ? planFromLegacy(base, pending.catalog, choice, legacy.seedEntryId, titles)
    : planFromChoice(base, pending.catalog, choice, titles);
}

/** Publish runtime identity only after the complete handoff record is durable. */
export function publishSelectedWork(session: RouterSession, plan: ContextPlan): ResolvedEntryContext {
  session.context.setEntrySource(plan.resolution.sourceEntryId);
  return {
    resolution: plan.resolution,
    ...(plan.workItemId ? { workItemId: plan.workItemId } : {}),
    contextSatisfied: true,
    createdTopic: plan.createdTopic,
    createdWorkItem: plan.createdWorkItem,
    ...(plan.legacy ? { legacy: true } : {}),
  };
}

/** The decision-log view of a resolution: categories and ids, no titles. */
export function workContextMeta(context: ResolvedEntryContext): WorkContextMeta {
  const { resolution } = context;
  return {
    resolver: resolution.resolver,
    relation: resolution.relation,
    topicId: resolution.topicId,
    workItemId: resolution.workItemId,
    contextReasons: resolution.contextReasons,
    contextSatisfied: context.contextSatisfied,
    ...(context.createdWorkItem ? { createdWorkItem: true } : {}),
    ...(context.legacy ? { legacy: true } : {}),
  };
}

/**
 * Remember which model last served the entry's work item: a resume hint for
 * later, never route authority. Written only when it changed.
 */
export function recordServedWork(session: RouterSession, workItemId: string | undefined): void {
  try {
    const served = session.getLastServed();
    const item = getWorkItem(session.context.getLedger(), workItemId);
    const source = session.context.getEntrySource();
    if (!served || !item || !source) return;
    const last = item.lastServed;
    if (last && servedKey(last) === servedKey(served)) return;
    session.context.append({
      v: 1,
      op: 'served',
      workItemId: item.id,
      served: { registryId: served.registryId, ...(served.thinkingLevel ? { thinkingLevel: served.thinkingLevel } : {}) },
      sourceEntryId: source,
    });
  } catch {
    // A resume hint is never worth failing a turn over.
  }
}

/**
 * Attach an accepted phase boundary to the entry's work item. The item
 * records that it happened, and an accepted context handoff ends the item's
 * open context. False when the branch did not record it; an entry
 * placed on no work item, or on one this branch does not hold, has nothing
 * to record.
 */
export function recordBoundary(
  session: RouterSession,
  state: WorkPhaseState,
  boundary: BoundaryKind,
  handoffId: string,
): boolean {
  try {
    const item = getWorkItem(session.context.getLedger(), state.workItemId);
    if (!item) return true;
    return session.context.append({
      v: 1,
      op: 'boundary',
      workItemId: item.id,
      boundary,
      handoffId,
      sourceEntryId: session.context.getEntrySource() ?? state.intentKey,
    });
  } catch {
    return false;
  }
}

/**
 * Pi moved to another point of the session tree. The entry state stays whole
 * while its entry is still on the new branch; otherwise it was built on work
 * this branch does not hold, so only its task type and final step are kept,
 * as minimums, with the task type raised to the restored active item's. No
 * identity or execution state crosses. Call after the ledger is restored
 * from `branch`.
 */
export function carryPhaseAcrossTree(session: RouterSession, branch: readonly unknown[] | undefined): void {
  try {
    const state = session.getWorkPhaseState();
    if (!state || branchHoldsEntry(branch, state.intentKey)) return;
    const itemDeliverable = activeWorkItem(session.context.getLedger())?.lastDeliverable;
    const deliverable = state.deliverable ? atLeast(state.deliverable, itemDeliverable) : itemDeliverable;
    session.commitWorkPhaseState(carryAcrossBranch(state, deliverable));
  } catch {
    // The next entry replaces the state either way.
  }
}
