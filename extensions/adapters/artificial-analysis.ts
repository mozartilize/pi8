/**
 * Adapter for the Artificial Analysis Data API (free tier).
 *
 *   GET https://artificialanalysis.ai/api/v2/language/models/free
 *   Header: x-api-key
 *
 * The v2 payload is an envelope, not a bare array:
 *
 *   { tier, intelligence_index_version, pagination: {...}, data: [ ... ] }
 *
 * and each row nests its metrics under `evaluations` / `pricing` /
 * `performance`. An earlier version of this adapter assumed a flat top-level
 * array with flat keys, so it threw on the envelope and (had it not thrown)
 * would have read every metric as undefined.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { BenchModel } from '../types.js';

export const SOURCE = 'artificial-analysis' as const;

export const AA_ENDPOINT =
  'https://artificialanalysis.ai/api/v2/language/models/free';
/** Sync should fail and preserve the previous store rather than hang indefinitely. */
export const AA_FETCH_TIMEOUT_MS = 30_000;

/** Safety valve so a pagination bug can't spin forever. */
const MAX_PAGES = 20;

export interface AAEvaluations {
  artificial_analysis_intelligence_index?: number | null;
  artificial_analysis_coding_index?: number | null;
  artificial_analysis_agentic_index?: number | null;
}

export interface AAPricing {
  price_1m_input_tokens?: number | null;
  price_1m_output_tokens?: number | null;
  price_1m_cache_hit_tokens?: number | null;
  price_1m_cache_write_tokens?: number | null;
}

export interface AAIntelligenceIndexCost {
  /** Cost per single task at this run's quality/effort, USD. */
  cost_per_task?: { total_cost?: number | null };
}

export interface AAPerformance {
  median_output_tokens_per_second?: number | null;
  median_time_to_first_token_seconds?: number | null;
  median_time_to_first_answer_token_seconds?: number | null;
}

export interface AARawModel {
  id?: string;
  name?: string;
  slug?: string;
  release_date?: string;
  model_creator?: { id?: string; name?: string };
  evaluations?: AAEvaluations;
  pricing?: AAPricing;
  performance?: AAPerformance;
  artificial_analysis_intelligence_index_cost?: AAIntelligenceIndexCost | null;
  context_window?: number | null;
  [key: string]: unknown;
}

export interface AAPagination {
  page?: number;
  page_size?: number;
  total_pages?: number;
  has_more?: boolean;
}

export interface AAResponse {
  tier?: string;
  intelligence_index_version?: string;
  pagination?: AAPagination;
  data?: AARawModel[];
}

export interface AAConfig {
  apiKey?: string;
  /** Override for tests. */
  endpoint?: string;
}

/**
 * Accepts either the v2 envelope or a bare array, so a future shape change
 * back to a plain list does not break sync.
 */
export function unwrap(payload: unknown): { rows: AARawModel[]; pagination?: AAPagination } {
  if (Array.isArray(payload)) return { rows: payload as AARawModel[] };
  if (payload && typeof payload === 'object') {
    const env = payload as AAResponse;
    if (Array.isArray(env.data)) {
      return { rows: env.data, pagination: env.pagination };
    }
  }
  throw new Error(
    'Unexpected Artificial Analysis response shape: expected an array or an object with a `data` array',
  );
}

export async function fetchRaw(config: AAConfig): Promise<AARawModel[]> {
  if (!config.apiKey) {
    throw new Error(
      'No artificialanalysis.ai API key configured. Get a free key at https://artificialanalysis.ai/ and run `/router-sync <key>`.',
    );
  }
  const endpoint = config.endpoint || AA_ENDPOINT;
  const all: AARawModel[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(endpoint);
    if (page > 1) url.searchParams.set('page', String(page));

    const res = await fetch(url, {
      headers: { 'x-api-key': config.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(AA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `Artificial Analysis API returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const { rows, pagination } = unwrap(await res.json());
    all.push(...rows);

    const morePages =
      pagination?.has_more === true ||
      (pagination?.total_pages != null && page < pagination.total_pages);
    if (!morePages || rows.length === 0) break;
  }

  return all;
}

const EFFORT_LABELS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Parse the reasoning-effort label out of the display name's parenthetical.
 *
 * AA formats it as free text: `GPT-5.6 Luna (low)`, `Claude Opus 5 (Adaptive
 * Reasoning, Xhigh Effort)`, `DeepSeek V4 Flash (Non-reasoning)`. The parse
 * fails closed: an unrecognized label yields undefined (unknown effort, never
 * promoted) rather than a guess. Check incoming labels after each benchmark
 * re-sync so supported effort levels do not silently become unknown.
 */
export function parseEffort(name: string | undefined): ModelThinkingLevel | undefined {
  if (!name) return undefined;
  const match = /\(([^)]*)\)/.exec(name);
  if (!match) return undefined;
  const label = match[1]!.trim().toLowerCase();
  if (/^non[\s-]?reasoning$/.test(label)) return 'off';
  // Multi-part labels like "Adaptive Reasoning, Xhigh Effort" carry the effort
  // in the final comma segment. Also check the last segment for the
  // non-reasoning pattern so "(Adaptive Reasoning, Non-reasoning)" resolves.
  const segments = label.split(',').map((s) => s.trim()).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (/^non[\s-]?reasoning$/.test(last)) return 'off';
  const effort = last.replace(/\s+effort$/, '');
  return EFFORT_LABELS.has(effort) ? (effort as ModelThinkingLevel) : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function asSlug(model: AARawModel): string | undefined {
  for (const value of [model.slug, model.id, model.name]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalize(raw: AARawModel[]): Omit<BenchModel, 'registryId' | 'active'>[] {
  return raw
    .filter((m) => asSlug(m))
    .map((m) => {
      const ev = m.evaluations ?? {};
      const pricing = m.pricing ?? {};
      const perf = m.performance ?? {};
      const ttftSeconds = asNumber(perf.median_time_to_first_token_seconds);
      const ttfaSeconds = asNumber(perf.median_time_to_first_answer_token_seconds);
      const coding = asNumber(ev.artificial_analysis_coding_index);
      return {
        // AA reports a display name; the fuzzy matcher normalizes it against
        // the registry, so prefer the stable slug.
        benchSlug: asSlug(m) as string,
        quality: {
          intelligence: asNumber(ev.artificial_analysis_intelligence_index),
          coding,
          // AA's agentic index is the closest analogue to agentic coding.
          agenticCoding: asNumber(ev.artificial_analysis_agentic_index),
          // AA publishes no separate reasoning score; the scorer falls back to
          // intelligence for the `plan` dimension when this is absent.
          reasoning: undefined,
        },
        priceInputPer1M: asNumber(pricing.price_1m_input_tokens),
        priceOutputPer1M: asNumber(pricing.price_1m_output_tokens),
        outputSpeedTps: asNumber(perf.median_output_tokens_per_second),
        latencyMsTtft: ttftSeconds != null ? ttftSeconds * 1000 : undefined,
        latencyMsTtfa: ttfaSeconds != null ? ttfaSeconds * 1000 : undefined,
        effort: parseEffort(m.name),
        costPerTask: asNumber(
          m.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost,
        ),
        contextWindow: asNumber(m.context_window),
        source: SOURCE,
      };
    });
}

export async function fetchAndNormalize(
  config: AAConfig,
): Promise<Omit<BenchModel, 'registryId' | 'active'>[]> {
  return normalize(await fetchRaw(config));
}
