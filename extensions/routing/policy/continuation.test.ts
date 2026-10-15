import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { convertToLlm, SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from '../context/summary-markers.js';

import { ROUTER_SETTLE_PREFIX, getTurnClassificationInput } from './continuation.js';

describe('getTurnClassificationInput', () => {
  const baseMessages = [
    { role: 'user', content: 'Please review the auth design.', timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning about a plan' },
        { type: 'text', text: 'The plan is complete. Next I will implement the approved auth changes.' },
      ],
      timestamp: 2,
    },
    { role: 'user', content: [{ type: 'text', text: 'ok go for it' }], timestamp: 3 },
  ] as unknown as Message[];

  it('keys an entry the same across its tool loop', () => {
    const first = getTurnClassificationInput(baseMessages);
    const afterToolTurn = getTurnClassificationInput([
      ...baseMessages,
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't', name: 'read', arguments: {} }],
        timestamp: 4,
      },
      {
        role: 'toolResult',
        toolCallId: 't',
        toolName: 'read',
        content: [{ type: 'text', text: 'large noisy output' }],
        timestamp: 5,
      },
    ] as unknown as Message[]);

    expect(first).toMatchObject({ promptText: 'ok go for it' });
    expect(afterToolTurn).toMatchObject({ key: first.key, promptText: 'ok go for it' });
  });

  it('changes the key when a new user entry arrives', () => {
    const first = getTurnClassificationInput(baseMessages);
    const next = getTurnClassificationInput([
      ...baseMessages,
      { role: 'assistant', content: 'Implementation finished.', timestamp: 4 },
      { role: 'user', content: 'review the diff', timestamp: 5 },
    ] as unknown as Message[]);

    expect(next.key).not.toBe(first.key);
    expect(next.promptText).toBe('review the diff');
  });

    it('keeps the entry key when a settle reminder arrives as a timestamped user message', () => {
      const first = getTurnClassificationInput(baseMessages);
      const reminded = getTurnClassificationInput([
        ...baseMessages,
        {
          role: 'user',
          content: [{ type: 'text', text: `${ROUTER_SETTLE_PREFIX}\nRouter: this work item is still open.` }],
          timestamp: 99,
        },
      ] as unknown as Message[]);

      expect(reminded.key).toBe(first.key);
      expect(reminded.promptText).toBe('ok go for it');
      expect(reminded.provenanceCounts['synthetic-known']).toBe(1);
    });

    it('ignores an ephemeral no-timestamp user injection for the key and ordinal', () => {
    // A hook/reminder injected as a user-role message with no timestamp appears
    // and vanishes mid tool-loop. It must not shift the intent key, or a
    // post-tool re-invocation would miss the cache and re-route from scratch.
    const withReminder = getTurnClassificationInput([
      ...baseMessages,
      { role: 'user', content: [{ type: 'text', text: 'SYSTEM REMINDER: mode active' }] },
    ] as unknown as Message[]);
    const first = getTurnClassificationInput(baseMessages);

    expect(withReminder.key).toBe(first.key);
    expect(withReminder.promptText).toBe('ok go for it');
  });

  it('returns an empty input when no user message exists', () => {
    expect(getTurnClassificationInput([{ role: 'assistant', content: 'hello' }] as unknown as Message[])).toEqual({
      key: 'none',
      promptText: '',
      provenanceCounts: {
        user: 0,
        'compaction-summary': 0,
        'branch-summary': 0,
        'synthetic-known': 0,
        assistant: 1,
        'tool-result': 0,
      },
    });
  });
});

const summaryMessage = (text: string, timestamp: number) =>
  ({
    role: 'user',
    content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}${text}${COMPACTION_SUMMARY_SUFFIX}` }],
    timestamp,
  }) as never;

const userMessage = (text: string, timestamp: number) =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp }) as never;

const assistantMessage = (text: string, timestamp: number) =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp }) as never;

describe('getTurnClassificationInput — source provenance', () => {
  it.each([
    ['context-prune-summary', '<context-prune-summary>Tool output was summarized.</context-prune-summary>'],
    ['pi-context', 'Compaction finished. Continue the current task.'],
    ['integration-event', 'Unmarked integration content'],
  ])('keeps the entry when Pi converts a %s custom message to user role', (customType, content) => {
    const request = userMessage('find the active handlers', 1);
    const event: AgentMessage = { role: 'custom', customType, content, display: false, timestamp: 2 };
    const sourceMessages: AgentMessage[] = [request, event];
    const messages = convertToLlm(sourceMessages);
    expect(messages[1]?.role).toBe('user');

    const before = getTurnClassificationInput([request]);
    const after = getTurnClassificationInput(messages, { sourceMessages });
    expect(after).toMatchObject({ key: before.key, promptText: before.promptText });
    expect(after.provenanceCounts).toMatchObject({ user: 1, 'synthetic-known': 1 });
    expect(messages).toHaveLength(2);
  });

  it('keeps genuine user text even when a custom message has the same text or timestamp', () => {
    const event: AgentMessage = { role: 'custom', customType: 'integration', content: 'review the diff', display: false, timestamp: 2 };
    const sourceMessages: AgentMessage[] = [userMessage('find handlers', 1), event];
    const original = getTurnClassificationInput(convertToLlm(sourceMessages), { sourceMessages });
    for (const [text, timestamp] of [['review the diff', 3], ['implement the fix', 2]] as const) {
      const request = userMessage(text, timestamp);
      const source = [...sourceMessages, request];
      const next = getTurnClassificationInput(convertToLlm(source), { sourceMessages: source });
      expect(next.key).not.toBe(original.key);
      expect(next.promptText).toBe(text);
      expect(next.provenanceCounts.user).toBe(2);
    }
  });

  it('uses the projected content of a custom event after a context edit', () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: 'user', content: 'find the active handlers', timestamp: 1 });
    const eventId = manager.appendCustomMessageEntry('integration', 'unpruned output', false);
    manager.appendContextEdit(eventId, { content: 'summarized output' });
    const { messages: sourceMessages } = manager.buildSessionProjection();
    const input = getTurnClassificationInput(convertToLlm(sourceMessages), { sourceMessages });
    expect(input.promptText).toBe('find the active handlers');
    expect(input.provenanceCounts).toMatchObject({ user: 1, 'synthetic-known': 1 });
  });

  it('keeps shell results in context without starting a user entry', () => {
    const request = userMessage('find the active handlers', 1);
    const sourceMessages: AgentMessage[] = [request, {
      role: 'bashExecution', command: 'pwd', output: '/project', exitCode: 0,
      cancelled: false, truncated: false, timestamp: 2,
    }];
    const input = getTurnClassificationInput(convertToLlm(sourceMessages), { sourceMessages });
    expect(input.key).toBe(getTurnClassificationInput([request]).key);
    expect(input.provenanceCounts).toMatchObject({ user: 1, 'synthetic-known': 1 });
  });

  it('does not classify unmarked text as synthetic without its source message', () => {
    const event: AgentMessage = { role: 'custom', customType: 'integration', content: 'Continue work.', display: false, timestamp: 2 };
    const messages = convertToLlm([event]);
    expect(getTurnClassificationInput(messages, { sourceMessages: [event] }).key).toBe('none');
    expect(getTurnClassificationInput(messages).promptText).toBe('Continue work.');
  });

  it.each([
    { roles: ['user', 'custom'] },
    { roles: ['custom', 'user'] },
    { roles: ['user', 'custom', 'user', 'custom'] },
  ] as const)('counts each colliding source occurrence once: $roles', ({ roles }) => {
    const sourceMessages: AgentMessage[] = roles.map((role) => role === 'user'
      ? { role, content: 'review the diff', timestamp: 2 }
      : { role, customType: 'integration', content: 'review the diff', display: false, timestamp: 2 });
    const requests = sourceMessages.filter((message) => message.role === 'user');
    const expected = getTurnClassificationInput(convertToLlm(requests));
    const input = getTurnClassificationInput(convertToLlm(sourceMessages), { sourceMessages });
    expect(input.key).toBe(expected.key);
    expect(input.promptText).toBe('review the diff');
    expect(input.provenanceCounts).toMatchObject({ user: requests.length, 'synthetic-known': roles.length - requests.length });
  });

  it('does not hide a user when a colliding custom occurrence is absent from context', () => {
    const sourceMessages: AgentMessage[] = [
      { role: 'custom', customType: 'integration', content: 'review the diff', display: false, timestamp: 2 },
      { role: 'user', content: 'review the diff', timestamp: 2 },
    ];
    const messages = convertToLlm(sourceMessages).slice(1);
    const input = getTurnClassificationInput(messages, { sourceMessages });
    expect(input.key).toBe(getTurnClassificationInput(messages).key);
    expect(input.provenanceCounts.user).toBe(1);
  });

  it('keeps extra identical occurrences as possible user requests', () => {
    const sourceMessages: AgentMessage[] = [
      { role: 'custom', customType: 'integration', content: 'review the diff', display: false, timestamp: 2 },
      { role: 'user', content: 'review the diff', timestamp: 2 },
    ];
    const messages = [...convertToLlm(sourceMessages), userMessage('review the diff', 2)];
    const input = getTurnClassificationInput(messages, { sourceMessages });
    expect(input.key).toBe(getTurnClassificationInput(messages).key);
    expect(input.provenanceCounts.user).toBe(3);
  });

  it('does not match different images that accompany the same text', () => {
    const sourceMessages: AgentMessage[] = [{
      role: 'custom', customType: 'integration', display: false, timestamp: 2,
      content: [{ type: 'text', text: 'review this' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    }];
    const request: Message = {
      role: 'user', timestamp: 2,
      content: [{ type: 'text', text: 'review this' }, { type: 'image', mimeType: 'image/png', data: 'BBBB' }],
    };
    const input = getTurnClassificationInput([request], { sourceMessages });
    expect(input.key).toBe(getTurnClassificationInput([request]).key);
    expect(input.provenanceCounts.user).toBe(1);
  });

  it('matches reconstructed content blocks regardless of property order', () => {
    const sourceMessages: AgentMessage[] = [
      userMessage('find handlers', 1),
      { role: 'custom', customType: 'integration', content: [{ type: 'text', text: 'Summary.' }], display: false, timestamp: 2 },
    ];
    const messages = convertToLlm(sourceMessages);
    const expected = getTurnClassificationInput(messages, { sourceMessages });
    messages[1] = { role: 'user', content: [{ text: 'Summary.', type: 'text' }], timestamp: 2 };
    expect(getTurnClassificationInput(messages, { sourceMessages })).toEqual(expected);
  });

  it('does not count a timestamped system message as a user request', () => {
    const request = userMessage('find the active handlers', 1);
    const before = getTurnClassificationInput([request]);
    const after = getTurnClassificationInput([
      request,
      { role: 'system', content: 'Updated tool declarations.', timestamp: 2 },
    ]);
    expect(after).toMatchObject({ key: before.key, promptText: before.promptText });
    expect(after.provenanceCounts).toMatchObject({ user: 1, 'synthetic-known': 1 });
  });
});

describe('getTurnClassificationInput — provenance', () => {
  it('does not treat a compaction summary as the latest user entry', () => {
    const input = getTurnClassificationInput([
      userMessage('add retry logic to the fetch helper', 1),
      assistantMessage('done', 2),
      summaryMessage('the user asked for retries and we added them', 3),
    ]);

    expect(input.promptText).toBe('add retry logic to the fetch helper');
    expect(input.provenanceCounts['compaction-summary']).toBe(1);
    expect(input.provenanceCounts.user).toBe(1);
  });

  it('does not let a compaction summary inflate the user ordinal in the key', () => {
    const withoutSummary = getTurnClassificationInput([userMessage('ok', 1)]);
    const withSummary = getTurnClassificationInput([
      summaryMessage('earlier work', 0),
      userMessage('ok', 1),
    ]);

    expect(withSummary.key).toBe(withoutSummary.key);
  });

  it('reads an entry after a summary as the user speaking, not the summary', () => {
    const input = getTurnClassificationInput([
      summaryMessage('we were refactoring the scorer', 1),
      assistantMessage('shall I continue?', 2),
      userMessage('ok', 3),
    ]);

    expect(input).toMatchObject({ promptText: 'ok' });
  });

  it('returns an empty input when only summaries exist', () => {
    const input = getTurnClassificationInput([summaryMessage('everything so far', 1)]);
    expect(input.promptText).toBe('');
    expect(input.key).toBe('none');
  });

  it('keys an entry only by its messages', () => {
    const messages = [userMessage('what is in this file?', 1)];
    const gen0 = getTurnClassificationInput(messages);
    const gen1 = getTurnClassificationInput(messages);

    expect(gen0.key).toBe(gen1.key);
    // The key has exactly three colon-separated fields (ordinal:timestamp:hash).
    expect(gen0.key.split(':').length).toBe(3);
  });
});
