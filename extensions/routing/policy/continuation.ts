import { isDeepStrictEqual } from 'node:util';
import type { Message } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { classifyProvenance } from '../context/message-provenance.js';
import type { MessageProvenance } from '../../types.js';

export interface TurnClassificationInput {
  key: string;
  promptText: string;
  /** How many messages of each recoverable origin the context held. */
  provenanceCounts: Record<MessageProvenance, number>;
}

/**
 * Hidden settle reminders start with this. Pi flattens them into timestamped
 * user messages, so classification always treats the prefix as synthetic.
 * A user-configured prefix list does not have to repeat it.
 */
export const ROUTER_SETTLE_PREFIX = '[pi8-settle]';

export interface TurnClassificationOptions {
  /** Opt-in literal prefixes for known integrations; never inferred. */
  syntheticPrefixes?: readonly string[];
  /** Pi's active projection retains the origin that its LLM converter removes. */
  sourceMessages?: readonly AgentMessage[];
}

const EMPTY_PROVENANCE_COUNTS = (): Record<MessageProvenance, number> => ({
  user: 0,
  'compaction-summary': 0,
  'branch-summary': 0,
  'synthetic-known': 0,
  assistant: 0,
  'tool-result': 0,
});

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

function normalizedContent(message: Message) {
  return typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content;
}

/** Match source content as well as time: a timestamp can belong to more than one message. */
function sourceOrigins(messages: readonly AgentMessage[]) {
  const origins = new Map<number, { content: ReturnType<typeof normalizedContent>; synthetic: boolean }[]>();
  for (const source of messages) {
    if (source.role !== 'user' && source.role !== 'custom' && source.role !== 'bashExecution') continue;
    for (const converted of convertToLlm([source])) {
      if (converted.role !== 'user') continue;
      const matches = origins.get(converted.timestamp) ?? [];
      matches.push({ content: normalizedContent(converted), synthetic: source.role !== 'user' });
      origins.set(converted.timestamp, matches);
    }
  }
  return origins;
}

export function getTurnClassificationInput(
  messages: readonly Message[] | undefined,
  opts: TurnClassificationOptions = {},
): TurnClassificationInput {
  const source = messages ?? [];
  const syntheticPrefixes = [ROUTER_SETTLE_PREFIX, ...(opts.syntheticPrefixes ?? [])];
  const provenanceCounts = EMPTY_PROVENANCE_COUNTS();
  const origins = sourceOrigins(opts.sourceMessages ?? []);

  // Pi flattens compaction/branch summaries into `role: "user"`, so counting
  // raw roles would let a summary both shift the cache key and impersonate the
  // request. Only provenance-`user` messages are the human speaking.
  let latestUserIndex = -1;
  let userOrdinal = 0;
  let latestAnyUserIndex = -1;
  for (let i = 0; i < source.length; i += 1) {
    const message = source[i];
    if (!message) continue;
    const matches = message.role === 'user' ? origins.get(message.timestamp) : undefined;
    const content = matches ? normalizedContent(message) : undefined;
    const matchingOrigins = matches?.filter((origin) => isDeepStrictEqual(origin.content, content));
    if (matchingOrigins?.some((origin) => origin.synthetic) && matchingOrigins.some((origin) => !origin.synthetic)) {
      const remaining = source.slice(i).filter((entry) => entry.role === 'user'
        && entry.timestamp === message.timestamp && isDeepStrictEqual(normalizedContent(entry), content)).length;
      // Missing or added identical occurrences cannot be assigned safely. Keep possible user requests.
      if (remaining !== matchingOrigins.length) for (const origin of matchingOrigins) origin.synthetic = false;
    }
    // Pi preserves projection order. Each source occurrence can classify only one message.
    const origin = matchingOrigins?.[0];
    if (origin) matches!.splice(matches!.indexOf(origin), 1);
    const provenance = origin?.synthetic ? 'synthetic-known' : classifyProvenance(message, syntheticPrefixes);
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
    provenanceCounts,
  };
}
