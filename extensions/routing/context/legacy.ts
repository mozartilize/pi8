/**
 * Work from before tracking started on a branch, found again when a later
 * entry returns to it.
 *
 * The branch up to the migration boundary is the only record of that work,
 * and nothing from it enters the ledger until an entry is placed on it. Its
 * genuine user requests are indexed on demand and searched after exact anchor
 * matches, lexically: a hit only offers a short excerpt to choose
 * from, never a routing fact. Pi's tree is append-only, so the path to a given
 * boundary never changes and its index never goes stale.
 */
import MiniSearch from 'minisearch';
import type { Message } from '@earendil-works/pi-ai';
import { redactSecrets } from '../policy/secret-redact.js';
import { classifyProvenance } from './message-provenance.js';
import { extractPromptAnchors, type PromptAnchor } from './anchors.js';
import { messageText } from './persistence.js';

export const LEGACY_LIMITS = {
  /** Raw lexical hits read per search. */
  hits: 12,
  /** Candidates offered per recovery. */
  candidates: 3,
  /** A hit this many requests or fewer from a better one is the same stretch of work. */
  neighbourGap: 2,
  /** An excerpt's share of its request and of the first reply after it; labelled, under 400 together. */
  requestChars: 240,
  replyChars: 140,
  /** Characters of a request that are indexed: pasted logs repeat words without naming work. */
  indexedChars: 4000,
} as const;

interface LegacyRequest {
  entryId: string;
  /** Position among the branch's genuine user requests before the boundary. */
  ordinal: number;
  text: string;
  /** Path and issue anchors, as `kind\0value`. */
  anchorKeys: ReadonlySet<string>;
  /** The request's start and the first assistant text after it, role-labelled and scrubbed. */
  excerpt: string;
}

interface IndexedRequest {
  id: number;
  text: string;
  anchors: string;
}

export interface LegacyIndex {
  /** The last entry before tracking started; the index covers the path to it. */
  readonly headEntryId: string;
  readonly requests: readonly LegacyRequest[];
  readonly search: MiniSearch<IndexedRequest>;
}

/** A pre-tracking request offered as a catalog choice. */
export interface LegacyCandidate {
  /** `l_<rank>`: listed in one prompt, never stored. */
  id: string;
  seedEntryId: string;
  excerpt: string;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Word-like segments. Splitting on spaces and punctuation alone would index a
 * Chinese or Japanese request as one token; the segmenter reads those by word
 * and splits other scripts as before.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const segment of SEGMENTER.segment(text)) if (segment.isWordLike) tokens.push(segment.segment);
  return tokens;
}

/** Scrubbed first, so a clipped secret cannot survive as its own prefix. */
function clip(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const anchorKey = (anchor: Pick<PromptAnchor, 'kind' | 'value'>) => `${anchor.kind}\0${anchor.value}`;

interface BranchMessage {
  type?: unknown;
  id?: unknown;
  message?: { role?: unknown; content?: unknown; timestamp?: unknown };
}

/**
 * Index the genuine user requests on `branch`, the path from the root to
 * `headEntryId`. Summaries, synthetic injections, and user-role messages Pi
 * did not stamp are skipped; a reply contributes only its text, never tool
 * calls, results, or thinking.
 */
export function buildLegacyIndex(
  branch: readonly unknown[] | undefined,
  headEntryId: string,
  opts: { cwd?: string; syntheticPrefixes?: readonly string[] } = {},
): LegacyIndex {
  const found: Array<{ entryId: string; text: string; reply?: string }> = [];
  for (const raw of branch ?? []) {
    const entry = raw as BranchMessage | null;
    if (!entry || entry.type !== 'message' || typeof entry.id !== 'string' || !entry.message) continue;
    const { role, timestamp } = entry.message;
    if (role === 'user') {
      if (typeof timestamp !== 'number') continue;
      if (classifyProvenance(entry.message as Message, opts.syntheticPrefixes) !== 'user') continue;
      const text = messageText(entry.message.content).trim();
      if (text) found.push({ entryId: entry.id, text });
    } else if (role === 'assistant') {
      const last = found.at(-1);
      if (!last || last.reply != null) continue;
      const reply = messageText(entry.message.content).trim();
      if (reply) last.reply = reply;
    }
  }

  const requests: LegacyRequest[] = found.map((request, ordinal) => {
    const text = request.text.slice(0, LEGACY_LIMITS.indexedChars);
    const anchors = extractPromptAnchors(text, opts.cwd ? { cwd: opts.cwd } : {});
    const excerpt = [
      `User: ${clip(request.text, LEGACY_LIMITS.requestChars)}`,
      ...(request.reply ? [`Assistant: ${clip(request.reply, LEGACY_LIMITS.replyChars)}`] : []),
    ].join('\n');
    return { entryId: request.entryId, ordinal, text, anchorKeys: new Set(anchors.map(anchorKey)), excerpt };
  });

  const search = new MiniSearch<IndexedRequest>({
    fields: ['text', 'anchors'],
    tokenize,
    searchOptions: { boost: { anchors: 3 }, prefix: true, fuzzy: 0.2 },
  });
  search.addAll(requests.map((request) => ({
    id: request.ordinal,
    text: request.text,
    anchors: [...request.anchorKeys].map((key) => key.split('\0')[1]).join(' '),
  })));
  return { headEntryId, requests, search };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Whether a request names the anchor: paths and issues as extracted, anything else as a whole word. */
function names(request: LegacyRequest, anchor: PromptAnchor): boolean {
  if (anchor.kind === 'path' || anchor.kind === 'issue') return request.anchorKeys.has(anchorKey(anchor));
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(anchor.value)}(?![\\p{L}\\p{N}_])`, 'u').test(request.text);
}

/**
 * The pre-tracking requests an entry may return to, best first: requests that
 * name one of the prompt's anchors exactly (newest first), then lexical hits.
 * A hit near a better one is the same stretch of work and is dropped. A
 * request in `listed` already has its work item in the catalog, so it is not
 * offered again, and it still hides its neighbours.
 */
export function findLegacyCandidates(
  index: LegacyIndex,
  query: { prompt: string; anchors: readonly PromptAnchor[] },
  listed: ReadonlySet<string> = new Set(),
): LegacyCandidate[] {
  const exact = query.anchors.length === 0
    ? []
    : index.requests.filter((request) => query.anchors.some((anchor) => names(request, anchor))).reverse();
  const lexical = index.search
    .search(query.prompt.slice(0, LEGACY_LIMITS.indexedChars))
    .slice(0, LEGACY_LIMITS.hits)
    .map((hit) => index.requests[hit.id as number]!);

  const taken: LegacyRequest[] = [];
  const candidates: LegacyCandidate[] = [];
  for (const request of [...exact, ...lexical]) {
    if (candidates.length >= LEGACY_LIMITS.candidates) break;
    if (taken.some((other) => Math.abs(other.ordinal - request.ordinal) <= LEGACY_LIMITS.neighbourGap)) continue;
    taken.push(request);
    if (listed.has(request.entryId)) continue;
    candidates.push({ id: `l_${candidates.length + 1}`, seedEntryId: request.entryId, excerpt: request.excerpt });
  }
  return candidates;
}
