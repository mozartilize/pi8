/**
 * Router notes in model requests, kept at a fixed place.
 *
 * Providers cache a request by its prefix. A note added to a message that
 * an earlier request already sent changes that prefix, and the provider
 * reprocesses everything after the message. So a note, once sent, stays on
 * the same message with the same bytes in every later request:
 *
 * - A new note goes on the last message of the request, which no earlier
 *   request contained.
 * - Each note is recorded as a session entry with the message it belongs
 *   to (its anchor). Every later request adds the recorded notes again.
 * - A note never replaces an earlier one. A different note for the same
 *   request starts by telling the model not to follow the earlier notes.
 *
 * The records are custom session entries, so they follow `/tree` and forks
 * and never reach the model by themselves. Only router/auto requests carry
 * notes.
 */
import { createHash } from 'node:crypto';

export const REQUEST_NOTE_ENTRY_TYPE = 'pi8-request-note-v1';

/** Starts a note that changes the router's instruction for the current request. */
export const SUPERSEDE_NOTE = 'Router: Do not follow the earlier router notes for this request.';

export interface RequestNote {
  /** The message the note is added to; see {@link messageAnchor}. */
  anchor: string;
  /** Opaque hash of the routed user entry the note was written for. */
  entry: string;
  /** The instruction the router chose, without the supersede line; empty for a supersede line only. */
  instruction: string;
  /** The exact text added to the message. */
  text: string;
}

/** The fields of a request message that notes read and change. */
interface NotableMessage {
  role: string;
  content?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
}

/**
 * A stable identity for a message of the request: a tool result by its
 * call id, a user message by its timestamp. Pi gives a custom message (for
 * example a settle reminder) the timestamp of its session entry when it
 * converts it to a user message, so that identity holds in later requests.
 */
export function messageAnchor(message: NotableMessage | undefined): string | undefined {
  if (!message) return undefined;
  if (message.role === 'toolResult') {
    return typeof message.toolCallId === 'string' && message.toolCallId ? `tool:${message.toolCallId}` : undefined;
  }
  if (message.role === 'user') {
    return typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? `message:${message.timestamp}`
      : undefined;
  }
  return undefined;
}

/** The note's entry key: a hash, so the session record does not repeat routing keys. */
export function noteEntryKey(intentKey: string): string {
  return createHash('sha256').update(intentKey).digest('hex').slice(0, 16);
}

function withText<M extends NotableMessage>(message: M, texts: readonly string[]): M {
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  return { ...message, content: [...blocks, ...texts.map((text) => ({ type: 'text' as const, text }))] };
}

/** Add each recorded note to its anchor message, in record order. Notes whose anchor is absent are skipped. */
export function withRequestNotes<M extends NotableMessage>(messages: readonly M[], notes: readonly RequestNote[]): M[] {
  if (notes.length === 0) return [...messages];
  const byAnchor = new Map<string, string[]>();
  for (const note of notes) {
    const texts = byAnchor.get(note.anchor) ?? [];
    texts.push(note.text);
    byAnchor.set(note.anchor, texts);
  }
  return messages.map((message) => {
    const anchor = messageAnchor(message);
    const texts = anchor ? byAnchor.get(anchor) : undefined;
    return texts ? withText(message, texts) : message;
  });
}

export interface NotePlan {
  /** A note to record and add to its anchor. */
  record?: RequestNote;
  /** A note for a request whose last message has no anchor: added to that message only, not recorded. */
  unanchored?: string;
}

/**
 * What the current request adds for `instruction`, the note the router
 * chose for this invocation of the entry (undefined for none).
 *
 * Nothing is added when the entry's latest note already gives the same
 * instruction. A different instruction, or none after an earlier note, is
 * added to the last message of the request with the supersede line first.
 */
export function planRequestNote(
  notes: readonly RequestNote[],
  messages: readonly NotableMessage[],
  intentKey: string,
  instruction: string | undefined,
): NotePlan {
  const entry = noteEntryKey(intentKey);
  const latest = notes.filter((note) => note.entry === entry).at(-1);
  const wanted = instruction ?? '';
  if ((latest?.instruction ?? '') === wanted) return {};
  const text = latest ? (wanted ? `${SUPERSEDE_NOTE}\n${wanted}` : SUPERSEDE_NOTE) : wanted;
  const anchor = messageAnchor(messages.at(-1));
  if (!anchor) return { unanchored: text };
  return { record: { anchor, entry, instruction: wanted, text } };
}

function parseNote(data: unknown): RequestNote | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const { anchor, entry, instruction, text } = data as Record<string, unknown>;
  if (typeof anchor !== 'string' || !anchor || typeof entry !== 'string' || !entry) return undefined;
  if (typeof instruction !== 'string' || typeof text !== 'string' || !text) return undefined;
  return { anchor, entry, instruction, text };
}

/** The notes recorded on a branch, in branch order. */
export function branchRequestNotes(branch: readonly unknown[] | undefined): RequestNote[] {
  const notes: RequestNote[] = [];
  for (const item of branch ?? []) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== 'custom' || entry.customType !== REQUEST_NOTE_ENTRY_TYPE) continue;
    const note = parseNote(entry.data);
    if (note) notes.push(note);
  }
  return notes;
}

/**
 * The active branch's recorded notes. The branch is the source of truth: a
 * restore replaces the list with the branch's notes. With no persistence
 * bound (tests, ephemeral hosts) the notes live in memory only.
 */
export class RequestNoteState {
  private notes: RequestNote[] = [];
  private persist: ((note: RequestNote) => void) | undefined;

  bindPersistence(persist: ((note: RequestNote) => void) | undefined): void {
    this.persist = persist;
  }

  restore(branch: readonly unknown[] | undefined): void {
    this.notes = branchRequestNotes(branch);
  }

  reset(): void {
    this.notes = [];
  }

  getNotes(): readonly RequestNote[] {
    return this.notes;
  }

  /**
   * Record a note. If the session entry cannot be written, the note is not
   * kept: a later request must not add a note that a reload would lose.
   */
  record(note: RequestNote): boolean {
    try {
      this.persist?.(note);
    } catch {
      return false;
    }
    this.notes = [...this.notes, note];
    return true;
  }
}
