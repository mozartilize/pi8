import type { Message } from '@earendil-works/pi-ai';
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
} from '@earendil-works/pi-agent-core';
import { classifyProvenance } from './message-provenance.js';
import type { MessageProvenance } from './types.js';

export interface TurnClassificationInput {
  key: string;
  promptText: string;
  classifyText: string;
  thin: boolean;
  contextChars: number;
  /** How many messages of each recoverable origin the context held. */
  provenanceCounts: Record<MessageProvenance, number>;
}

export interface TurnClassificationOptions {
  /** Opt-in literal prefixes for known integrations; never inferred. */
  syntheticPrefixes?: readonly string[];
}

const EMPTY_PROVENANCE_COUNTS = (): Record<MessageProvenance, number> => ({
  user: 0,
  'compaction-summary': 0,
  'branch-summary': 0,
  'synthetic-known': 0,
  assistant: 0,
  'tool-result': 0,
});

const DEFAULT_CONTEXT_CHARS = 1500;

const CONTINUATION_CUES = [
  'ok',
  'okay',
  'yes',
  'yep',
  'yeah',
  'sure',
  'continue',
  'proceed',
  'do it',
  'go ahead',
  'go for it',
  'keep going',
  'what is next',
  'what next',
  'sounds good',
] as const;

const CONTINUATION_WORDS = new Set([
  'ok',
  'okay',
  'yes',
  'yep',
  'yeah',
  'sure',
  'continue',
  'proceed',
  'do',
  'it',
  'go',
  'ahead',
  'for',
  'keep',
  'going',
  'what',
  'is',
  'next',
  'sounds',
  'good',
  'please',
  'now',
  'then',
]);

function normalizeContinuation(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/what's/g, 'what is')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isThinContinuation(text: string): boolean {
  const normalized = normalizeContinuation(text);
  if (!normalized) return false;

  const words = normalized.split(' ');
  if (words.length > 8 || words.some((word) => !CONTINUATION_WORDS.has(word))) {
    return false;
  }

  return CONTINUATION_CUES.some(
    (cue) => normalized === cue || normalized.startsWith(`${cue} `) || normalized.endsWith(` ${cue}`),
  );
}

function textFromMessage(message: Message): string {
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

type ConversationLabel = 'User' | 'Assistant' | 'Summary';

/**
 * Strip the flattener's boilerplate markers from a summary body before it is
 * labelled. The markers exist so the harness can round-trip compaction/branch
 * summaries; inside a labelled conversation they are noise that would bury the
 * actual summary content and waste the bounded character budget.
 */
function stripSummaryMarkers(provenance: MessageProvenance, text: string): string {
  if (provenance === 'compaction-summary') {
    let out = text;
    if (out.startsWith(COMPACTION_SUMMARY_PREFIX)) out = out.slice(COMPACTION_SUMMARY_PREFIX.length);
    if (out.endsWith(COMPACTION_SUMMARY_SUFFIX)) out = out.slice(0, -COMPACTION_SUMMARY_SUFFIX.length);
    return out;
  }
  if (provenance === 'branch-summary') {
    let out = text;
    if (out.startsWith(BRANCH_SUMMARY_PREFIX)) out = out.slice(BRANCH_SUMMARY_PREFIX.length);
    if (out.endsWith(BRANCH_SUMMARY_SUFFIX)) out = out.slice(0, -BRANCH_SUMMARY_SUFFIX.length);
    return out;
  }
  return text;
}

function labelFor(provenance: MessageProvenance): ConversationLabel | undefined {
  switch (provenance) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'compaction-summary':
    case 'branch-summary':
      return 'Summary';
    // synthetic-known and tool-result carry no request intent and are omitted.
    default:
      return undefined;
  }
}

/**
 * The provenance-labelled, bounded conversation view. Exported because the
 * assessment needs the same labelling rule the thin-continuation path uses —
 * one labelling rule, one place. The caller passes the inclusive end index:
 * the thin path uses the latest user entry; assessment evidence uses
 * `messages.length - 1`.
 */
export function buildRoleLabelledContext(
  messages: readonly Message[],
  endIndex: number,
  maxChars: number,
  syntheticPrefixes: readonly string[],
): string {
  const segments: Array<{ role: ConversationLabel; text: string }> = [];
  for (let i = 0; i <= endIndex; i += 1) {
    const message = messages[i];
    if (!message) continue;
    const provenance = classifyProvenance(message, syntheticPrefixes);
    const role = labelFor(provenance);
    if (!role) continue;
    const raw = textFromMessage(message);
    if (!raw) continue;
    const text = stripSummaryMarkers(provenance, raw);
    if (!text) continue;
    segments.push({ role, text });
  }

  // Truncation body below is unchanged from the previous implementation.
  let result = '';
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]!;
    const separator = result ? '\n\n' : '';
    const full = `${segment.role}: ${segment.text}`;
    const remaining = maxChars - result.length - separator.length;
    if (remaining <= 0) break;

    if (full.length <= remaining) {
      result = `${full}${separator}${result}`;
      continue;
    }

    const label = `${segment.role}: `;
    const textRoom = remaining - label.length;
    if (textRoom > 1) {
      const tail = segment.text.slice(-(textRoom - 1));
      result = `${label}…${tail}${separator}${result}`;
    }
    break;
  }
  return result;
}

export function getTurnClassificationInput(
  messages: readonly Message[] | undefined,
  maxChars = DEFAULT_CONTEXT_CHARS,
  opts: TurnClassificationOptions = {},
): TurnClassificationInput {
  const source = messages ?? [];
  const syntheticPrefixes = opts.syntheticPrefixes ?? [];
  const provenanceCounts = EMPTY_PROVENANCE_COUNTS();

  // Pi flattens compaction/branch summaries into `role: "user"`, so counting
  // raw roles would let a summary both shift the cache key and impersonate the
  // request. Only provenance-`user` messages are the human speaking.
  let latestUserIndex = -1;
  let userOrdinal = 0;
  for (let i = 0; i < source.length; i += 1) {
    const message = source[i];
    if (!message) continue;
    const provenance = classifyProvenance(message, syntheticPrefixes);
    provenanceCounts[provenance] += 1;
    if (provenance === 'user') {
      latestUserIndex = i;
      userOrdinal += 1;
    }
  }

  if (latestUserIndex < 0) {
    return {
      key: 'none',
      promptText: '',
      classifyText: '',
      thin: false,
      contextChars: 0,
      provenanceCounts,
    };
  }

  const latestUser = source[latestUserIndex]!;
  const promptText = textFromMessage(latestUser);
  const thin = isThinContinuation(promptText);
  const timestamp = typeof latestUser.timestamp === 'number' ? latestUser.timestamp : 'none';
  // The latch generation is session state bound to an intent key, not a key
  // input — see router-session-state.ts getLatchVetoIntentKey.  Keeping it
  // out of the key means a latch bump does not invalidate the cached verdict,
  // so the veto holds for the vetoed entry's whole tool loop.
  const key = `${userOrdinal}:${timestamp}:${hashText(promptText)}`;
  const classifyText = thin
    ? buildRoleLabelledContext(source, latestUserIndex, Math.max(1, maxChars), syntheticPrefixes) ||
      promptText
    : promptText;

  return {
    key,
    promptText,
    classifyText,
    thin,
    contextChars: classifyText.length,
    provenanceCounts,
  };
}
