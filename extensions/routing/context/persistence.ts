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

function scanContextEvents(branch: readonly unknown[] | undefined): { events: RoutingContextEvent[]; ledger: TopicLedger } {
  const events: RoutingContextEvent[] = [];
  let ledger = emptyLedger();
  for (const entry of asEntries(branch)) {
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
 * Whether the branch holds a user request the router never routed: one sent
 * while Pi's model, as its latest `model_change` before the request records
 * it, was not `router/auto`. A request with no model recorded before it
 * counts too, since nothing shows the router saw it.
 */
function hasUnroutedRequest(branch: readonly BranchEntryLike[]): boolean {
  let routed = false;
  for (const entry of branch) {
    if (entry.type === 'model_change') {
      routed = entry.provider === ROUTER_PROVIDER_ID && entry.modelId === AUTO_MODEL_ID;
    } else if (entry.type === 'message' && entry.message?.role === 'user' && !routed) {
      return true;
    }
  }
  return false;
}

/**
 * A branch with ledger events is tracked. Without them, a branch holding a
 * request the router never routed predates tracking on it (legacy); one
 * whose requests all went to `router/auto`, or that holds none, starts fresh:
 * its entries so far simply recorded no work.
 */
export function classifyBranch(branch: readonly unknown[] | undefined, ledger: TopicLedger): BranchState {
  if (ledger.events > 0) return 'tracked';
  return hasUnroutedRequest(asEntries(branch)) ? 'legacy-uninitialized' : 'native-empty';
}

/**
 * The branch state for routing the entry `entryId`: the branch as it stood
 * before it. The entry itself is the request being routed, not history.
 */
export function classifyBranchBefore(
  branch: readonly unknown[] | undefined,
  entryId: string,
  ledger: TopicLedger,
): BranchState {
  const entries = asEntries(branch);
  const index = entries.findIndex((entry) => entry.id === entryId);
  return classifyBranch(index < 0 ? entries : entries.slice(0, index), ledger);
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
