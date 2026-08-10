/**
 * Adapter for BenchLM's AA-Omniscience Index leaderboard page.
 *
 *   GET https://benchlm.ai/benchmarks/aaomniscienceindex
 *
 * BenchLM mirrors Artificial Analysis's Omniscience Index — a display-only
 * factual-knowledge index, explicitly not used by BenchLM to rank models
 * overall — on a server-rendered Next.js page. The full leaderboard is
 * embedded in the page's `__NEXT_DATA__` script as
 * `props.pageProps.leaderboard`, a JSON array rather than HTML to scrape:
 *
 *   { model, slug, creator, score, sourceModelId, ... }
 *
 * `score` is 100 * (correct - incorrect) / questions, bounded to [-100, 100].
 * Negative values mean wrong answers outnumber correct ones; abstentions and
 * partial answers contribute zero. The adapter publishes it as the separate
 * `quality.knowledge` axis, never blended into intelligence/coding ratios.
 * Reasoning-effort labels appear only in the
 * display name's parenthetical ("DeepSeek V4 Pro (Max)"), parsed by the same
 * rule as the Artificial Analysis adapter.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { BenchModel } from '../types.js';
import { parseEffort } from './artificial-analysis.js';

export const SOURCE = 'benchlm' as const;

export const BENCHLM_ENDPOINT =
  'https://benchlm.ai/benchmarks/aaomniscienceindex';
/** Sync should fail and preserve the previous store rather than hang indefinitely. */
export const BENCHLM_FETCH_TIMEOUT_MS = 30_000;

export interface BenchlmLeaderboardRow {
  model?: string;
  slug?: string;
  creator?: string;
  /** Omniscience index percentage; relative scale, may be negative. */
  score?: number | null;
  sourceModelId?: string | null;
  [key: string]: unknown;
}

export interface BenchlmConfig {
  /** Override for tests. */
  endpoint?: string;
}

/**
 * Next.js embeds page props in a `<script id="__NEXT_DATA__">` JSON block.
 * Extraction fails closed: a changed page structure throws instead of
 * producing a partial leaderboard, so sync keeps the previous store.
 */
export function extractNextData(html: string): string {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) {
    throw new Error('BenchLM page changed shape: no __NEXT_DATA__ script found');
  }
  return match[1]!;
}

export function unwrap(payload: unknown): { rows: BenchlmLeaderboardRow[] } {
  const leaderboard =
    (payload as { props?: { pageProps?: { leaderboard?: unknown } } })
      ?.props?.pageProps?.leaderboard;
  if (!Array.isArray(leaderboard)) {
    throw new Error(
      'Unexpected BenchLM response shape: expected props.pageProps.leaderboard to be an array',
    );
  }
  return { rows: leaderboard as BenchlmLeaderboardRow[] };
}

export async function fetchRaw(config: BenchlmConfig): Promise<BenchlmLeaderboardRow[]> {
  const endpoint = config.endpoint || BENCHLM_ENDPOINT;
  const res = await fetch(endpoint, {
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(BENCHLM_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`BenchLM returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return unwrap(JSON.parse(extractNextData(await res.text()))).rows;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function asSlug(row: BenchlmLeaderboardRow): string | undefined {
  if (typeof row.slug === 'string' && row.slug.trim()) return row.slug.trim();
  return undefined;
}

export function normalize(
  raw: BenchlmLeaderboardRow[],
): Omit<BenchModel, 'registryId' | 'active'>[] {
  return raw
    .filter((m) => asSlug(m) && asNumber(m.score) != null)
    .map((m) => {
      const effort: ModelThinkingLevel | undefined = parseEffort(m.model);
      return {
        benchSlug: asSlug(m) as string,
        quality: {
          // The benchlm page labels the index display-only; a factuality
          // signal on its own relative scale, never blended with the headline
          // axes.
          knowledge: asNumber(m.score),
        },
        effort,
        source: SOURCE,
      };
    });
}

export async function fetchAndNormalize(
  config: BenchlmConfig,
): Promise<Omit<BenchModel, 'registryId' | 'active'>[]> {
  return normalize(await fetchRaw(config));
}
