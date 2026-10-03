/**
 * The ledger's home in Pi's session tree.
 *
 * Every work-context event is a `custom` session entry on the active branch.
 * Pi's tree owns branching: `/tree` to a point before an event drops it from
 * `getBranch()`, and going back restores it, so the ledger is rebuilt by
 * folding the branch and nothing is rolled back by hand. Custom entries never
 * reach the model.
 */
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from '../../types.js';
import type { BranchState, RoutingContextEvent } from './types.js';
import { applyEvent, emptyLedger, parseContextEvent, type TopicLedger } from './ledger.js';

export const CONTEXT_ENTRY_TYPE = 'pi8-routing-context-v1';

/**
 * The router's record of the session model, written before a request only
 * when Pi recorded none: Pi writes `model_change` for `/model`, but not when
 * a session resumes with `--model` or `/tree` moves to a branch recorded
 * with another model. Read exactly like `model_change`.
 */
export const SELECTION_ENTRY_TYPE = 'pi8-model-selection-v1';

/** The slice of a Pi session entry this module reads. */
export interface BranchEntryLike {
  type: string;
  id: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown; timestamp?: unknown };
  /** On a `model_change` entry: the model Pi sends later requests to. */
  provider?: string;
  modelId?: string;
}

/** The slice of Pi's read-only session manager this module reads. */
export interface BranchReader {
  getBranch?: (fromId?: string) => readonly unknown[];
  getLeafId?: () => string | null;
}

function asEntries(branch: readonly unknown[] | undefined): BranchEntryLike[] {
  return (branch ?? []).filter((entry): entry is BranchEntryLike =>
    entry != null && typeof entry === 'object' && typeof (entry as BranchEntryLike).type === 'string'
    && typeof (entry as BranchEntryLike).id === 'string');
}

const isRouterAuto = (provider: unknown, modelId: unknown): boolean =>
  provider === ROUTER_PROVIDER_ID && modelId === AUTO_MODEL_ID;

/** The model selection an entry records, true for router/auto; undefined when it records none. */
function recordedSelection(entry: BranchEntryLike): boolean | undefined {
  if (entry.type === 'model_change') return isRouterAuto(entry.provider, entry.modelId);
  if (entry.type !== 'custom' || entry.customType !== SELECTION_ENTRY_TYPE) return undefined;
  if (!entry.data || typeof entry.data !== 'object') return undefined;
  const data = entry.data as { provider?: unknown; modelId?: unknown };
  return isRouterAuto(data.provider, data.modelId);
}

const isUserMessage = (entry: BranchEntryLike): boolean => entry.type === 'message' && entry.message?.role === 'user';

export interface RequestRouting {
  /** Entry ids of the user requests the router did not serve. */
  unrouted: ReadonlySet<string>;
  /** Whether a request sent after the branch's last entry goes to router/auto, as the branch records it. */
  routedAtEnd: boolean;
}

/**
 * Which user requests on the branch the router served. A request is served
 * when the latest model selection recorded before it is router/auto, or
 * when a router event names it as its source. A router event also shows
 * that router/auto was the selection from there on, for history in which
 * neither Pi nor the router recorded it. A request with no selection
 * recorded before it counts as not served: nothing shows the router saw it.
 */
export function requestRouting(branch: readonly unknown[] | undefined): RequestRouting {
  const entries = asEntries(branch);
  const named = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== CONTEXT_ENTRY_TYPE) continue;
    const event = parseContextEvent(entry.data);
    if (!event) continue;
    for (const inner of event.op === 'context-commit' ? event.events : [event]) named.add(inner.sourceEntryId);
  }
  const unrouted = new Set<string>();
  let routed = false;
  for (const entry of entries) {
    const selected = recordedSelection(entry);
    if (selected !== undefined) routed = selected;
    else if (entry.type === 'custom' && entry.customType === CONTEXT_ENTRY_TYPE) routed = true;
    else if (isUserMessage(entry) && !routed && !named.has(entry.id)) unrouted.add(entry.id);
  }
  return { unrouted, routedAtEnd: routed };
}

function scanContextEvents(branch: readonly unknown[] | undefined): { events: RoutingContextEvent[]; ledger: TopicLedger } {
  const events: RoutingContextEvent[] = [];
  const { unrouted } = requestRouting(branch);
  let ledger = emptyLedger();
  for (const entry of asEntries(branch)) {
    // A switch to another model ends the incumbent; a switch back to
    // router/auto starts without one until the router chooses again.
    const selected = recordedSelection(entry);
    if (selected !== undefined) {
      if (!selected && ledger.incumbent) {
        const { incumbent: _ended, ...rest } = ledger;
        ledger = rest;
      }
      continue;
    }
    // A request the router did not serve may have started other work, so
    // the active item is not continued by default: the next routed entry
    // collects context and chooses again. The item stays open.
    if (isUserMessage(entry)) {
      if (unrouted.has(entry.id) && ledger.activeWorkItemId) {
        const { activeWorkItemId: _dropped, ...rest } = ledger;
        ledger = rest;
      }
      continue;
    }
    if (entry.type !== 'custom' || entry.customType !== CONTEXT_ENTRY_TYPE) continue;
    const event = parseContextEvent(entry.data);
    if (!event) continue;
    if (event.op === 'context-commit') {
      let next = ledger;
      for (const inner of event.events) {
        const applied = applyEvent(next, inner);
        if (applied === next) { next = ledger; break; }
        next = applied;
      }
      // A damaged or inapplicable subevent cannot publish a partial handoff.
      if (next === ledger) continue;
      ledger = next;
      events.push(...event.events);
    } else {
      events.push(event);
      ledger = applyEvent(ledger, event);
    }
  }
  return { events, ledger };
}

/** Readers see flat events, including only complete ready handoffs. */
export function branchEvents(branch: readonly unknown[] | undefined): RoutingContextEvent[] {
  return scanContextEvents(branch).events;
}

export function rebuildLedger(branch: readonly unknown[] | undefined): TopicLedger {
  return scanContextEvents(branch).ledger;
}

/**
 * A branch with ledger events is tracked. Without them, a branch holding a
 * request the router did not serve has untracked history (legacy); one
 * whose requests all went to `router/auto`, or that holds none, starts fresh:
 * its entries so far simply recorded no work.
 */
export function classifyBranch(branch: readonly unknown[] | undefined, ledger: TopicLedger): BranchState {
  if (ledger.events > 0) return 'tracked';
  return requestRouting(branch).unrouted.size > 0 ? 'legacy-uninitialized' : 'native-empty';
}

/**
 * The last request the router did not serve before the entry `entryId`.
 * The legacy index covers the path to it; requests after it went to the
 * router, so the index stays the same until another such request is sent.
 */
export function lastUnroutedRequest(branch: readonly unknown[] | undefined, entryId: string): string | undefined {
  const { unrouted } = requestRouting(branch);
  let last: string | undefined;
  for (const entry of asEntries(branch)) {
    if (entry.id === entryId) break;
    if (unrouted.has(entry.id)) last = entry.id;
  }
  return last;
}

/** Read the active branch, or the path to `fromId`; undefined when the session exposes none. */
export function readBranch(reader: BranchReader | undefined, fromId?: string): readonly unknown[] | undefined {
  try {
    if (typeof reader?.getBranch !== 'function') return undefined;
    return fromId == null ? reader.getBranch() : reader.getBranch(fromId);
  } catch {
    return undefined;
  }
}

/** The text blocks of a session message's content, joined; thinking, tool calls, and images are left out. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('\n');
}

/** Whether the branch holds the user entry an intent key names, by its exact message timestamp. */
export function branchHoldsEntry(branch: readonly unknown[] | undefined, key: string): boolean {
  const timestamp = Number(key.split(':')[1]);
  if (!Number.isFinite(timestamp)) return false;
  return asEntries(branch).some((entry) =>
    entry.type === 'message' && entry.message?.role === 'user' && entry.message.timestamp === timestamp);
}

/**
 * The session entry id of the genuine user entry being routed. Matched by
 * the exact message timestamp in the intent key first, then by its text,
 * then by the newest user message on the branch. Never by array position.
 */
export function latestGenuineUserEntry(
  branch: readonly unknown[] | undefined,
  turn: { key?: string; promptText?: string } = {},
): string | undefined {
  const entries = asEntries(branch).filter((entry) => entry.type === 'message' && entry.message?.role === 'user');
  if (entries.length === 0) return undefined;
  const timestamp = turn.key ? Number(turn.key.split(':')[1]) : Number.NaN;
  if (Number.isFinite(timestamp)) {
    const byTime = entries.findLast((entry) => entry.message?.timestamp === timestamp);
    if (byTime) return byTime.id;
  }
  if (turn.promptText) {
    const byText = entries.findLast((entry) => messageText(entry.message?.content).trim() === turn.promptText);
    if (byText) return byText.id;
  }
  return entries.at(-1)!.id;
}
