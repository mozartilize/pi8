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
 * The markers are imported rather than copied so that a Pi upgrade which
 * removes them fails the build instead of leaving the router matching text
 * that is no longer emitted. A round-trip test guards the case where the
 * export survives but its value drifts from what the flattener produces.
 */
import {
  COMPACTION_SUMMARY_PREFIX,
  BRANCH_SUMMARY_PREFIX,
} from '@earendil-works/pi-agent-core';
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

    if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) return 'compaction-summary';
    if (text.startsWith(BRANCH_SUMMARY_PREFIX)) return 'branch-summary';
    for (const prefix of syntheticPrefixes) {
      if (prefix && text.startsWith(prefix)) return 'synthetic-known';
    }
    return 'user';
  } catch {
    return 'user';
  }
}

