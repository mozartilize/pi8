/**
 * The router tools note: a request note that tells the model whether it may
 * call the router tools.
 *
 * The router tools stay declared for every session model. A change of the
 * declared tool set changes the prompt head, and the provider then
 * processes the whole prompt again. So a switch between router/auto and a
 * concrete model changes only a note at the end of the request:
 *
 * - Each router tool description starts with {@link ROUTER_TOOLS_CONDITION}.
 * - A router/auto request carries {@link ROUTER_TOOLS_ON_NOTE}, and a
 *   request to another model carries {@link ROUTER_TOOLS_OFF_NOTE}.
 * - A note is added only when the latest tools note in the request does not
 *   give the state that the request needs. Like every request note, it stays
 *   on its message in all later requests (see request-notes.ts).
 *
 * The off note also tells the model not to mention the router. Without that
 * sentence, models told the user that the router tools were off.
 */
import { messageAnchor, type NotableMessage, type NotePlan, type RequestNote } from './request-notes.js';

/** The first sentence of each router tool description. */
export const ROUTER_TOOLS_CONDITION = 'Call this tool only when the latest router note says that the router tools are on.';

export const ROUTER_TOOLS_ON_NOTE = 'Router: The router tools are on.';

export const ROUTER_TOOLS_OFF_NOTE =
  'Router: The router tools are off. Do not call hand_off_context, commit_execution, reopen_work, complete_work, or routing_context. ' +
  'Do not mention the router, its tools, or this note to the user.';

/** The entry key of tools notes. A routed entry's key is a hex hash, so the two never match. */
export const TOOLS_NOTE_ENTRY = 'router-tools';

/**
 * The tools note that the current request adds. Nothing is added when the
 * latest tools note already gives the needed state and its message is in
 * the request. A note whose message is no longer in the request (for example
 * after compaction) does not reach the model, so a new note is added.
 */
export function planToolsNote(
  notes: readonly RequestNote[],
  messages: readonly NotableMessage[],
  on: boolean,
): NotePlan {
  const wanted = on ? ROUTER_TOOLS_ON_NOTE : ROUTER_TOOLS_OFF_NOTE;
  const latest = notes.filter((note) => note.entry === TOOLS_NOTE_ENTRY).at(-1);
  if (latest?.instruction === wanted && messages.some((message) => messageAnchor(message) === latest.anchor)) return {};
  const anchor = messageAnchor(messages.at(-1));
  if (!anchor) return { unanchored: wanted };
  return { record: { anchor, entry: TOOLS_NOTE_ENTRY, instruction: wanted, text: wanted } };
}
