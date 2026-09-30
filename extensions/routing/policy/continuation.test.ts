import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from '@earendil-works/pi-agent-core';

import { getTurnClassificationInput } from './continuation.js';

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
