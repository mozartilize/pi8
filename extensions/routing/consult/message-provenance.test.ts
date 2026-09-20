import { describe, expect, it } from 'vitest';
import {
  convertToLlm,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
} from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { classifyProvenance, latestSummaryText, countToolActivity } from './message-provenance.js';

const user = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as Message;

const textOf = (message: unknown): string => {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === 'string' ? block.text : '';
};

describe('message-provenance — marker CI guard', () => {
  // The constants are imported, so a removed export fails tsc. This guards the
  // remaining risk: the export survives but stops matching what the flattener
  // emits, which would make the router silently misread summaries as requests.
  it('the imported markers still match what convertToLlm actually emits', () => {
    const now = Date.now();
    const [compaction] = convertToLlm([
      { role: 'compactionSummary', summary: 'S', tokensBefore: 0, timestamp: now },
    ] as never);
    const [branch] = convertToLlm([
      { role: 'branchSummary', summary: 'S', fromId: 'x', timestamp: now },
    ] as never);

    expect(textOf(compaction)).toBe(`${COMPACTION_SUMMARY_PREFIX}S${COMPACTION_SUMMARY_SUFFIX}`);
    expect(textOf(branch)).toBe(`${BRANCH_SUMMARY_PREFIX}S${BRANCH_SUMMARY_SUFFIX}`);
  });
});

describe('message-provenance', () => {
  it('classifies a flattened compaction summary as compaction-summary', () => {
    const msg = user(`${COMPACTION_SUMMARY_PREFIX}earlier work${COMPACTION_SUMMARY_SUFFIX}`);
    expect(classifyProvenance(msg)).toBe('compaction-summary');
  });

  it('classifies a flattened branch summary as branch-summary', () => {
    const msg = user(`${BRANCH_SUMMARY_PREFIX}branch work${BRANCH_SUMMARY_SUFFIX}`);
    expect(classifyProvenance(msg)).toBe('branch-summary');
  });

  it('classifies a genuine user message as user', () => {
    expect(classifyProvenance(user('list the main features of this file'))).toBe('user');
  });

  it('classifies assistant and toolResult roles without inspecting content', () => {
    expect(classifyProvenance({ role: 'assistant', content: 'hi' } as unknown as Message)).toBe(
      'assistant',
    );
    expect(classifyProvenance({ role: 'toolResult', content: 'out' } as unknown as Message)).toBe(
      'tool-result',
    );
  });

  it('documents that a custom message is indistinguishable from user input', () => {
    // convertToLlm drops `customType` (messages.js:70-77). A custom message
    // with user-shaped text is unrecoverable; fail open to `user`.
    const nudge = user('Continue where you left off after compaction.');
    expect(classifyProvenance(nudge)).toBe('user');
  });

  it('recognises an explicitly configured integration prefix as synthetic-known', () => {
    const nudge = user('[pi-context] resume after compaction');
    expect(classifyProvenance(nudge, ['[pi-context]'])).toBe('synthetic-known');
  });

  it('never infers synthetic-known without a configured prefix', () => {
    expect(classifyProvenance(user('[pi-context] resume after compaction'))).toBe('user');
  });

  it('fails open to user on a malformed message', () => {
    expect(classifyProvenance({} as unknown as Message)).toBe('user');
    expect(classifyProvenance(undefined as unknown as Message)).toBe('user');
  });
});

describe('latestSummaryText', () => {
  it('returns the summary body without the marker', () => {
    const msg = user(`${COMPACTION_SUMMARY_PREFIX}we refactored the scorer${COMPACTION_SUMMARY_SUFFIX}`);
    expect(latestSummaryText([msg])).toBe('we refactored the scorer');
  });

  it('returns the newest summary when several exist', () => {
    const older = user(`${COMPACTION_SUMMARY_PREFIX}older${COMPACTION_SUMMARY_SUFFIX}`);
    const newer = user(`${COMPACTION_SUMMARY_PREFIX}newer${COMPACTION_SUMMARY_SUFFIX}`);
    expect(latestSummaryText([older, newer])).toBe('newer');
  });

  it('returns undefined when no summary is present', () => {
    expect(latestSummaryText([user('hello')])).toBeUndefined();
  });
});

describe('countToolActivity', () => {
  it('counts tool names without exposing arguments or results', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: '/etc/passwd' } }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: '/tmp/x' } }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { cmd: 'ls' } }] },
    ] as never[];

    const activity = countToolActivity(messages);
    expect(activity).toEqual([
      { name: 'read', count: 2 },
      { name: 'bash', count: 1 },
    ]);
    expect(JSON.stringify(activity)).not.toContain('passwd');
  });

  it('returns an empty list for a conversation with no tool calls', () => {
    expect(countToolActivity([user('hi')])).toEqual([]);
  });
});
