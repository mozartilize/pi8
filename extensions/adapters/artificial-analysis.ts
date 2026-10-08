/**
 * Artificial Analysis benchmark rows: the Data API (free tier) joined with the
 * models page (artificial-analysis-site.ts).
 *
 *   GET https://artificialanalysis.ai/api/v2/language/models/free
 *   Header: x-api-key
 *
 * The v2 payload is an envelope, not a bare array:
 *
 *   { tier, intelligence_index_version, pagination: {...}, data: [ ... ] }
 *
 * and each row nests its metrics under `evaluations` / `pricing` /
 * `performance`. The API carries the indexes, prices, and speed; the page
 * adds Omniscience, AA-Briefcase, time per task, Terminal-Bench 4.0, and
 * whether AA estimated the index. Both sides share the slug and the effort
 * label in the display name. The agentic coding score comes from
 * Terminal-Bench 4.0 (agentic-estimate.ts).
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { BenchModel } from '../types.js';
import { agenticCodingScores } from './agentic-estimate.js';
import { fetchSiteModels, type AASiteModel } from './artificial-analysis-site.js';

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
  /** A string or a number (`4.1`) in observed payloads. */
  intelligence_index_version?: string | number;
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
export function unwrap(payload: unknown): { rows: AARawModel[]; pagination?: AAPagination; indexVersion?: string } {
  if (Array.isArray(payload)) return { rows: payload as AARawModel[] };
  if (payload && typeof payload === 'object') {
    const env = payload as AAResponse;
    if (Array.isArray(env.data)) {
      const version = env.intelligence_index_version;
      return {
        rows: env.data,
        pagination: env.pagination,
        ...(typeof version === 'string' || typeof version === 'number' ? { indexVersion: String(version) } : {}),
      };
    }
  }
  throw new Error(
    'Unexpected Artificial Analysis response shape: expected an array or an object with a `data` array',
  );
}

export async function fetchRaw(config: AAConfig): Promise<AARawModel[] & { indexVersion?: string }> {
  if (!config.apiKey) {
    throw new Error(
      'No artificialanalysis.ai API key configured. Get a free key at https://artificialanalysis.ai/ and run `/router-sync <key>`.',
    );
  }
  const endpoint = config.endpoint || AA_ENDPOINT;
  const all: AARawModel[] = [];
  let indexVersion: string | undefined;

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
    const { rows, pagination, indexVersion: pageVersion } = unwrap(await res.json());
    indexVersion ??= pageVersion;
    all.push(...rows);

    const morePages =
      pagination?.has_more === true ||
      (pagination?.total_pages != null && page < pagination.total_pages);
    if (!morePages || rows.length === 0) break;
  }

  return Object.assign(all, indexVersion ? { indexVersion } : {});
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
 * Reasoning, Xhigh Effort)`, `DeepSeek V4 Flash (Non-reasoning)`, `Claude
 * Opus 5.5 (Adaptive Reasoning, Max Effort, Default Fallback)`, `HyperNova
 * 60B (high, based on gpt-oss-120b)`. The effort can sit in any comma
 * segment, so the first segment that is a non-reasoning label or
 * `<level>[ effort]` wins. The parse fails closed: no such segment yields
 * undefined (unknown effort, never inferred) rather than a guess.
 */
export function parseEffort(name: string | undefined): ModelThinkingLevel | undefined {
  const label = name && /\(([^)]*)\)/.exec(name)?.[1];
  if (!label) return undefined;
  for (const segment of label.toLowerCase().split(',')) {
    const text = segment.trim();
    if (/^non[\s-]?reasoning$/.test(text)) return 'off';
    const effort = text.replace(/\s+effort$/, '');
    if (EFFORT_LABELS.has(effort)) return effort as ModelThinkingLevel;
  }
  return undefined;
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

const joinKey = (slug: string, name: string | undefined): string =>
  `${slug}\u0000${parseEffort(name) ?? ''}`;

export function normalize(
  raw: AARawModel[],
  site: readonly AASiteModel[] = [],
): Omit<BenchModel, 'registryId' | 'active'>[] {
  const siteByKey = new Map(site.map((row) => [joinKey(row.slug, row.name), row]));
  const rows = raw.filter((m) => asSlug(m));
  const agentic = agenticCodingScores(rows.map((m) => {
    const ev = m.evaluations ?? {};
    return {
      terminalBench: siteByKey.get(joinKey(asSlug(m) as string, m.name))?.terminalBench40,
      agenticIndex: asNumber(ev.artificial_analysis_agentic_index),
      codingIndex: asNumber(ev.artificial_analysis_coding_index),
      intelligenceIndex: asNumber(ev.artificial_analysis_intelligence_index),
    };
  }));
  return rows
    .map((m, index) => {
      const ev = m.evaluations ?? {};
      const pricing = m.pricing ?? {};
      const perf = m.performance ?? {};
      const ttftSeconds = asNumber(perf.median_time_to_first_token_seconds);
      const ttfaSeconds = asNumber(perf.median_time_to_first_answer_token_seconds);
      const slug = asSlug(m) as string;
      const page = siteByKey.get(joinKey(slug, m.name));
      return {
        // AA reports a display name; the fuzzy matcher normalizes it against
        // the registry, so prefer the stable slug.
        benchSlug: slug,
        quality: {
          intelligence: asNumber(ev.artificial_analysis_intelligence_index),
          coding: asNumber(ev.artificial_analysis_coding_index),
          agenticCoding: agentic[index]?.value,
          knowledge: page?.omniscience,
          research: page?.briefcaseRubricPassRate,
          longContext: page?.lcr,
          visionReasoning: page?.mmmuPro,
        },
        ...(page?.intelligenceIndexIsEstimated !== false || agentic[index]?.estimated ? { qualityEstimated: true } : {}),
        priceInputPer1M: asNumber(pricing.price_1m_input_tokens),
        priceOutputPer1M: asNumber(pricing.price_1m_output_tokens),
        outputSpeedTps: asNumber(perf.median_output_tokens_per_second),
        latencyMsTtft: ttftSeconds != null ? ttftSeconds * 1000 : undefined,
        latencyMsTtfa: ttfaSeconds != null ? ttfaSeconds * 1000 : undefined,
        effort: parseEffort(m.name),
        costPerTask: asNumber(
          m.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost,
        ),
        timePerTaskSeconds: page?.intelligenceIndexTimePerTask,
        contextWindow: asNumber(m.context_window),
        source: SOURCE,
      };
    });
}

/** Both halves are required: a missing page fails the sync like a failed API call. */
export async function fetchAndNormalize(
  config: AAConfig,
): Promise<Array<Omit<BenchModel, 'registryId' | 'active'>> & { indexVersion?: string }> {
  const [raw, site] = await Promise.all([fetchRaw(config), fetchSiteModels()]);
  return Object.assign(normalize(raw, site), { indexVersion: raw.indexVersion });
}
