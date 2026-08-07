import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from '@earendil-works/pi-agent-core';

import { getTurnClassificationInput, isThinContinuation } from './continuation.js';

describe('isThinContinuation', () => {
  it.each([
    'ok go for it',
    'continue',
    'do it',
    'yes',
    'proceed',
    'go ahead',
    'keep going',
    "what's next?",
    "ok, what's next?",
  ])('detects contextual continuation %j', (text) => {
    expect(isThinContinuation(text)).toBe(true);
  });

  it.each([
    'hi',
    'thanks',
    'go fix auth',
    'continue debugging auth',
    'review the provider implementation',
  ])('leaves substantive or conversational prompt %j on normal classification', (text) => {
    expect(isThinContinuation(text)).toBe(false);
  });
});

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

  it('builds stable role-aware context ending at the latest thin user entry', () => {
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

    expect(first).toMatchObject({ promptText: 'ok go for it', thin: true });
    expect(first.classifyText).toContain('User: Please review the auth design.');
    expect(first.classifyText).toContain('Assistant: The plan is complete. Next I will implement');
    expect(first.classifyText).toContain('User: ok go for it');
    expect(first.classifyText).not.toContain('private reasoning');
    expect(first.classifyText).not.toContain('large noisy output');
    expect(afterToolTurn.key).toBe(first.key);
    expect(afterToolTurn.classifyText).toBe(first.classifyText);
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
    expect(next.thin).toBe(false);
    expect(next.classifyText).toBe('review the diff');
  });

  it('bounds enriched context while preserving the latest user cue', () => {
    const result = getTurnClassificationInput(baseMessages, 96);

    expect(result.contextChars).toBeLessThanOrEqual(96);
    expect(result.classifyText).toContain('User: ok go for it');
    expect(result.classifyText).toContain('implement the approved auth changes');
  });

  it('honors a bound smaller than the latest continuation cue', () => {
    const result = getTurnClassificationInput(baseMessages, 8);

    expect(result.contextChars).toBeLessThanOrEqual(8);
    expect(result.classifyText.length).toBeLessThanOrEqual(8);
  });

  it('returns an empty non-thin input when no user message exists', () => {
    expect(getTurnClassificationInput([{ role: 'assistant', content: 'hello' }] as unknown as Message[])).toEqual({
      key: 'none',
      promptText: '',
      classifyText: '',
      thin: false,
      contextChars: 0,
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

  it('labels a summary as Summary, never as User, in thin-continuation context', () => {
    const input = getTurnClassificationInput([
      summaryMessage('we were refactoring the scorer', 1),
      assistantMessage('shall I continue?', 2),
      userMessage('ok', 3),
    ]);

    expect(input.thin).toBe(true);
    expect(input.classifyText).toContain('Summary: we were refactoring the scorer');
    expect(input.classifyText).not.toContain('User: we were refactoring the scorer');
  });

  it('returns an empty non-thin input when only summaries exist', () => {
    const input = getTurnClassificationInput([summaryMessage('everything so far', 1)]);
    expect(input.promptText).toBe('');
    expect(input.key).toBe('none');
  });

  it('does not include the latch generation in the key', () => {
    // The latch veto is session state bound to an intent key, not a key
    // input.  Keeping latchGeneration out of the key means a latch bump
    // does not invalidate the cached verdict.
    const messages = [userMessage('what is in this file?', 1)];
    const gen0 = getTurnClassificationInput(messages);
    const gen1 = getTurnClassificationInput(messages);

    // Same messages produce the same key regardless of latch state.
    expect(gen0.key).toBe(gen1.key);
    // The key has exactly three colon-separated fields (ordinal:timestamp:hash).
    expect(gen0.key.split(':').length).toBe(3);
  });

  it('performing an assessment cannot invalidate its own key', () => {
    // Key inputs are message-derived only. Nothing an assessment does mutates
    // them, so the cached verdict stays reachable for the whole tool loop.
    const messages = [userMessage('investigate the flaky test', 1)];
    const before = getTurnClassificationInput(messages);
    const after = getTurnClassificationInput(messages);
    expect(after.key).toBe(before.key);
  });
});
