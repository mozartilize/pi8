import { describe, expect, it } from 'vitest';

import { RequestNoteState, applyNotePlans, planRequestNote, type NotableMessage } from './request-notes.js';
import {
  ROUTER_TOOLS_OFF_NOTE,
  ROUTER_TOOLS_ON_NOTE,
  TOOLS_NOTE_ENTRY,
  planToolsNote,
} from './router-tools-note.js';
import { CONTEXT_HANDOFF_TOOL } from '../routing/policy/context-acquisition.js';
import { COMPLETE_WORK_TOOL, REOPEN_WORK_TOOL } from '../routing/policy/work-completion.js';
import { EXECUTION_CONTRACT_TOOL } from '../routing/policy/execution-contract.js';
import { ROUTING_CONTEXT_TOOL } from './routing-context-tool.js';

type Message = NotableMessage & { content: unknown };

const user = (text: string, timestamp: number): Message => ({ role: 'user', content: text, timestamp });
const assistant = (timestamp: number): Message => ({ role: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp });
const toolResult = (id: string, timestamp: number): Message =>
  ({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: `result ${id}` }], timestamp });

/** One request as the router builds it: the tools note, then the entry note on router/auto requests. */
function request(state: RequestNoteState, history: Message[], routerAuto: boolean, entry?: { key: string; note: string }): Message[] {
  const plans = [planToolsNote(state.getNotes(), history, routerAuto)];
  if (routerAuto && entry) plans.push(planRequestNote(state.getNotes(), history, entry.key, entry.note));
  return applyNotePlans(state, history, plans);
}

const texts = (message: Message | undefined) =>
  Array.isArray(message?.content) ? (message.content as Array<{ text: string }>).map((block) => block.text) : [message?.content];

describe('router tools note', () => {
  it('names every router tool in the off note', () => {
    for (const tool of [EXECUTION_CONTRACT_TOOL, CONTEXT_HANDOFF_TOOL, ROUTING_CONTEXT_TOOL, COMPLETE_WORK_TOOL, REOPEN_WORK_TOOL]) {
      expect(ROUTER_TOOLS_OFF_NOTE).toContain(tool);
    }
  });

  it('adds the needed state on the last message, then nothing while that note is in the request', () => {
    const state = new RequestNoteState();
    const history = [user('fix the bug', 1)];
    const plan = planToolsNote(state.getNotes(), history, false);
    expect(plan.record).toEqual({ anchor: 'message:1', entry: TOOLS_NOTE_ENTRY, instruction: ROUTER_TOOLS_OFF_NOTE, text: ROUTER_TOOLS_OFF_NOTE });
    state.record(plan.record!);
    expect(planToolsNote(state.getNotes(), [...history, assistant(2), user('next', 3)], false)).toEqual({});
  });

  it('adds a note when the latest tools note gives the other state', () => {
    const state = new RequestNoteState();
    state.record(planToolsNote(state.getNotes(), [user('a', 1)], false).record!);
    const plan = planToolsNote(state.getNotes(), [user('a', 1), assistant(2), user('b', 3)], true);
    expect(plan.record).toMatchObject({ anchor: 'message:3', instruction: ROUTER_TOOLS_ON_NOTE });
  });

  it('adds the note again when the message of the latest tools note is not in the request', () => {
    const state = new RequestNoteState();
    state.record(planToolsNote(state.getNotes(), [user('a', 1)], false).record!);
    // Compaction removed the message that carried the note.
    expect(planToolsNote(state.getNotes(), [user('summary', 5)], false).record).toMatchObject({ anchor: 'message:5' });
  });

  it('reads only tools notes, not entry notes', () => {
    const state = new RequestNoteState();
    state.record(planRequestNote([], [user('a', 1)], 'entry', ROUTER_TOOLS_ON_NOTE).record!);
    expect(planToolsNote(state.getNotes(), [user('a', 1)], true).record).toMatchObject({ entry: TOOLS_NOTE_ENTRY });
  });

  it('adds an unrecorded note when the last message has no anchor', () => {
    const state = new RequestNoteState();
    const sent = applyNotePlans(state, [user('a', 1), assistant(2)], [planToolsNote(state.getNotes(), [user('a', 1), assistant(2)], false)]);
    expect(texts(sent.at(-1)).at(-1)).toBe(ROUTER_TOOLS_OFF_NOTE);
    expect(state.getNotes()).toEqual([]);
  });

  it('adds a note that the session cannot record to this request only', () => {
    const state = new RequestNoteState();
    state.bindPersistence(() => { throw new Error('disk full'); });
    const sent = request(state, [user('a', 1)], false);
    expect(texts(sent[0])).toEqual(['a', ROUTER_TOOLS_OFF_NOTE]);
    expect(state.getNotes()).toEqual([]);
  });

  it('keeps every earlier request a prefix of the next one across model switches', () => {
    const state = new RequestNoteState();
    const history: Message[] = [user('refactor the cache', 1)];
    const requests: Message[][] = [];
    // router/auto collects context, a concrete model answers two requests, router/auto returns.
    const collect = (key: string) => ({ key, note: 'Router: collect context.' });
    requests.push(request(state, history, true, collect('entry-1')));
    history.push(assistant(2), toolResult('t1', 3));
    requests.push(request(state, history, true, collect('entry-1')));
    history.push(assistant(4), user('now add a TTL', 5));
    requests.push(request(state, history, false));
    history.push(assistant(6), toolResult('t2', 7));
    requests.push(request(state, history, false));
    history.push(assistant(8), user('and a size limit', 9));
    requests.push(request(state, history, true, collect('entry-3')));

    for (let i = 1; i < requests.length; i++) {
      const earlier = requests[i - 1]!;
      expect(requests[i]!.slice(0, earlier.length).map((m) => JSON.stringify(m))).toEqual(earlier.map((m) => JSON.stringify(m)));
    }
    // Each switch adds one tools note; requests without a switch add none.
    expect(state.getNotes().filter((note) => note.entry === TOOLS_NOTE_ENTRY).map((note) => [note.anchor, note.instruction])).toEqual([
      ['message:1', ROUTER_TOOLS_ON_NOTE],
      ['message:5', ROUTER_TOOLS_OFF_NOTE],
      ['message:9', ROUTER_TOOLS_ON_NOTE],
    ]);
    // On a router/auto request, the tools note comes before the entry note.
    expect(texts(requests.at(-1)!.at(-1))).toEqual(['and a size limit', ROUTER_TOOLS_ON_NOTE, expect.stringContaining('Router:')]);
  });
});
