/**
 * Recover the agent-level origin of a message that Pi's harness flattened
 * into `role: "user"`.
 *
 * `convertToLlm` collapses compactionSummary, branchSummary, custom and
 * bashExecution messages into user messages. Only the two summary kinds
 * carry a stable textual marker, so only those are generically recoverable;
 * `custom` loses `customType` in conversion and is indistinguishable from a
 * human turn with the same text.
 *
 * The markers come from Pi's public converter, not copied formatting text.
 * Tests verify both summary kinds against independently converted messages.
 */
import {
  COMPACTION_SUMMARY_PREFIX,
  BRANCH_SUMMARY_PREFIX,
} from './summary-markers.js';
import type { Message } from '@earendil-works/pi-ai';
import type { MessageProvenance } from '../../types.js';

function firstText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/**
 * @param syntheticPrefixes Opt-in list of literal prefixes belonging to known
 *  integrations. Never inferred — an unmarked user message is `user`, the
 *  only safe default.
 */
export function classifyProvenance(
  message: Message,
  syntheticPrefixes: readonly string[] = [],
): MessageProvenance {
  try {
    const role = (message as { role?: unknown } | undefined)?.role;
    if (role === 'assistant') return 'assistant';
    if (role === 'toolResult') return 'tool-result';
    if (role !== 'user') return 'user';

    const text = firstText(message);
    if (!text) return 'user';

    if (COMPACTION_SUMMARY_PREFIX && text.startsWith(COMPACTION_SUMMARY_PREFIX)) return 'compaction-summary';
    if (BRANCH_SUMMARY_PREFIX && text.startsWith(BRANCH_SUMMARY_PREFIX)) return 'branch-summary';
    for (const prefix of syntheticPrefixes) {
      if (prefix && text.startsWith(prefix)) return 'synthetic-known';
    }
    return 'user';
  } catch {
    return 'user';
  }
}

