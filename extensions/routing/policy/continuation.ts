import type { Message } from '@earendil-works/pi-ai';
import { classifyProvenance } from '../context/message-provenance.js';
import type { MessageProvenance } from '../../types.js';

export interface TurnClassificationInput {
  key: string;
  promptText: string;
  /** The prompt points back at the conversation instead of naming work of its own. */
  thin: boolean;
  /**
   * The embedding reader, not the keyword rules, found it thin. Such an
   * entry raises routing like any thin entry but never takes the fast path.
   */
  thinByEmbedding?: boolean;
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

function isThinContinuation(text: string): boolean {
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

const REFERENCE_FILLER_WORDS = new Set([
  'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'continue', 'proceed', 'go', 'ahead', 'keep', 'going',
  'please', 'now', 'then', 'and', 'also', 'too', 'lets', "let's", 'do',
]);
const DELIVERABLE_VERBS = new Set([
  'implement', 'fix', 'review', 'plan', 'finish', 'apply', 'build', 'write', 'test', 'run', 'commit', 'make',
  'continue', 'proceed', 'do', 'start',
]);
const REFERENTS = new Set([
  'it', 'this', 'that', 'them', 'these', 'those', 'the', 'rest', 'remaining', 'next', 'step', 'steps',
  'change', 'changes', 'one', 'same',
]);
const MAX_REFERENCE_WORDS = 8;

/**
 * A short prompt that points back at the conversation instead of naming new
 * work: continuation words, a deliverable verb, and referents only.
 */
function isThinReference(prompt: string): boolean {
  const words = prompt
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > MAX_REFERENCE_WORDS) return false;
  if (!words.some((word) => DELIVERABLE_VERBS.has(word))) return false;
  return words.every((word) => REFERENCE_FILLER_WORDS.has(word) || DELIVERABLE_VERBS.has(word) || REFERENTS.has(word));
}

/**
 * Whether the prompt carries nothing of its own beyond pointing back: an
 * approval or transition ("ok go for it", "what's next?") or a deliverable
 * verb on a referent ("implement it"). The one definition of a thin entry.
 */
export function isThinPrompt(prompt: string): boolean {
  return isThinContinuation(prompt) || isThinReference(prompt);
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

export function getTurnClassificationInput(
  messages: readonly Message[] | undefined,
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
  let latestAnyUserIndex = -1;
  for (let i = 0; i < source.length; i += 1) {
    const message = source[i];
    if (!message) continue;
    const provenance = classifyProvenance(message, syntheticPrefixes);
    provenanceCounts[provenance] += 1;
    if (provenance === 'user') {
      latestAnyUserIndex = i;
      // Ephemeral hook/reminder injections arrive as user-role messages with no
      // numeric timestamp; pi-core stamps every genuine user turn. Excluding
      // them from the intent key and ordinal keeps the key stable across a tool
      // loop, so a post-tool re-invocation reuses the entry's cached routing
      // instead of re-classifying a transient reminder that appears and then
      // vanishes mid-loop.
      if (typeof message.timestamp === 'number') {
        latestUserIndex = i;
        userOrdinal += 1;
      }
    }
  }
  // Fallback: a conversation whose only user-provenance messages lack a
  // timestamp still routes on its latest one rather than degrading to "no user".
  if (latestUserIndex < 0) latestUserIndex = latestAnyUserIndex;

  if (latestUserIndex < 0) {
    return {
      key: 'none',
      promptText: '',
      thin: false,
      provenanceCounts,
    };
  }

  const latestUser = source[latestUserIndex]!;
  const promptText = textFromMessage(latestUser);
  const timestamp = typeof latestUser.timestamp === 'number' ? latestUser.timestamp : 'none';
  const key = `${userOrdinal}:${timestamp}:${hashText(promptText)}`;

  return {
    key,
    promptText,
    thin: isThinPrompt(promptText),
    provenanceCounts,
  };
}
