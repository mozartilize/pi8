import { describe, expect, it } from 'vitest';
import { convertToLlm } from '@earendil-works/pi-coding-agent';

import {
  REQUEST_NOTE_ENTRY_TYPE,
  RequestNoteState,
  SUPERSEDE_NOTE,
  branchRequestNotes,
  messageAnchor,
  planRequestNote,
  withRequestNotes,
  type RequestNote,
} from './request-notes.js';

type Message = { role: string; content: unknown; timestamp?: number; toolCallId?: string };

const user = (text: string, timestamp: number): Message => ({ role: 'user', content: text, timestamp });
const assistant = (timestamp: number): Message => ({ role: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp });
const toolResult = (id: string, timestamp: number): Message =>
  ({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: `result ${id}` }], timestamp });

/** One router invocation: plan the note, record it, and build the request as the provider does. */
function invoke(state: RequestNoteState, history: Message[], intentKey: string, instruction: string | undefined): Message[] {
  const plan = planRequestNote(state.getNotes(), history, intentKey, instruction);
  if (plan.record) state.record(plan.record);
  return withRequestNotes(history, state.getNotes());
}

describe('request notes', () => {
  it('keeps every earlier request a prefix of the next one across phases and entries', () => {
    const state = new RequestNoteState();
    const history: Message[] = [user('first request', 1)];
    const requests: Message[][] = [];

    requests.push(invoke(state, history, 'entry-1', 'GATHER'));
    history.push(assistant(2), toolResult('t1', 3));
    requests.push(invoke(state, history, 'entry-1', 'GATHER'));
    // The handoff is accepted: the entry's instruction changes mid-entry.
    history.push(assistant(4), toolResult('t2', 5));
    requests.push(invoke(state, history, 'entry-1', 'WORK'));
    history.push(assistant(6), toolResult('t3', 7));
    requests.push(invoke(state, history, 'entry-1', 'WORK'));
    history.push(assistant(8), user('second request', 9));
    requests.push(invoke(state, history, 'entry-2', 'WORK'));
    history.push(assistant(10), user('third request', 11));
    requests.push(invoke(state, history, 'entry-3', undefined));

    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.slice(0, requests[i - 1]!.length)).toEqual(requests[i - 1]);
    }
    const last = requests.at(-1)!;
    expect(last[0]!.content).toEqual([{ type: 'text', text: 'first request' }, { type: 'text', text: 'GATHER' }]);
    expect(last[4]!.content).toEqual([
      { type: 'text', text: 'result t2' },
      { type: 'text', text: `${SUPERSEDE_NOTE}\nWORK` },
    ]);
    expect(last[8]!.content).toEqual([{ type: 'text', text: 'second request' }, { type: 'text', text: 'WORK' }]);
    // An entry with no instruction and no earlier note adds nothing.
    expect(last[10]).toEqual(user('third request', 11));
  });

  it('tells the model to stop following an earlier note when the entry no longer has one', () => {
    const state = new RequestNoteState();
    invoke(state, [user('q', 1)], 'entry', 'GATHER');
    const request = invoke(state, [user('q', 1), assistant(2), toolResult('t', 3)], 'entry', undefined);
    expect(request[2]!.content).toEqual([{ type: 'text', text: 'result t' }, { type: 'text', text: SUPERSEDE_NOTE }]);
    expect(planRequestNote(state.getNotes(), request, 'entry', undefined)).toEqual({});
  });

  it('anchors a settle reminder by the timestamp Pi gives its converted user message', () => {
    // Pi converts the custom settle message to a user message with the entry's timestamp.
    const agentHistory = [
      { role: 'user', content: 'do it', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp: 2 },
      { role: 'custom', customType: 'pi8-settle', content: '[pi8-settle] remind', display: false, timestamp: 3 },
    ];
    const llmHistory = convertToLlm(agentHistory as never) as unknown as Message[];
    const state = new RequestNoteState();
    invoke(state, llmHistory, 'entry', 'WORK');
    const later = invoke(state, [...llmHistory, assistant(4), toolResult('t', 5)], 'entry', 'WORK');
    expect(later[2]!.content).toEqual([{ type: 'text', text: '[pi8-settle] remind' }, { type: 'text', text: 'WORK' }]);
  });

  it('adds a note without an anchor to the current request only', () => {
    const state = new RequestNoteState();
    const plan = planRequestNote(state.getNotes(), [{ role: 'user', content: 'no timestamp' }], 'entry', 'GATHER');
    expect(plan).toEqual({ unanchored: 'GATHER' });
    expect(messageAnchor({ role: 'assistant', content: [], timestamp: 1 })).toBeUndefined();
  });

  it('keeps no note whose session entry could not be written', () => {
    const state = new RequestNoteState();
    state.bindPersistence(() => { throw new Error('disk full'); });
    const note: RequestNote = { anchor: 'message:1', entry: 'e', instruction: 'X', text: 'X' };
    expect(state.record(note)).toBe(false);
    expect(state.getNotes()).toEqual([]);
  });

  it('restores the notes of the active branch and ignores malformed entries', () => {
    const note: RequestNote = { anchor: 'tool:t1', entry: 'e', instruction: 'WORK', text: 'WORK' };
    const branch = [
      { type: 'message', id: '1' },
      { type: 'custom', id: '2', customType: REQUEST_NOTE_ENTRY_TYPE, data: note },
      { type: 'custom', id: '3', customType: REQUEST_NOTE_ENTRY_TYPE, data: { anchor: 'tool:t2' } },
      { type: 'custom', id: '4', customType: 'other', data: note },
    ];
    expect(branchRequestNotes(branch)).toEqual([note]);
    const state = new RequestNoteState();
    state.restore(branch);
    expect(state.getNotes()).toEqual([note]);
    state.restore([]);
    expect(state.getNotes()).toEqual([]);
  });
});
