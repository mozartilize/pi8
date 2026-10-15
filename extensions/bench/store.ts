/**
 * Benchmark store lifecycle.
 *
 * Pure functions for validation/defaults; I/O lives in the exported helpers.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

import { OUTPUT_TOKENS_STATUSES, PROVENANCE_AXES, type BenchModel, type OutputTokensProvenance, type BenchmarkStore, type ExtensionContext, type ProvenanceAxis } from '../types.js';
import type { AxisProvenance } from '../routing/features/schema.js';
import { canonicalJson } from '../routing/digest.js';
import { CONFIG_FILE, STORE_FILE, STALE_MS, STORAGE_DIR } from '../constants.js';
import { readJsonCached, writeJsonAtomic } from '../json-file.js';

/**
 * Resolve the storage directory.
 *
 * `PI8_DIR` overrides the default location. Tests must set it:
 * without an override the suite writes its fixtures into the real
 * ~/.pi/agent/pi8/benchmarks.json and corrupts live routing data.
 */
export const resolveStoragePath = (base?: string): string => {
  const resolved = base ?? process.env.PI8_DIR ?? STORAGE_DIR;
  if (resolved.startsWith('~/')) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
};

export const getStorePath = (base?: string): string =>
  join(resolveStoragePath(base), STORE_FILE);

export const getConfigPath = (base?: string): string =>
  join(resolveStoragePath(base), CONFIG_FILE);

/** Provider-specific registry variants that cannot be normalized safely. */
export const DEFAULT_BENCHMARK_ALIASES: Readonly<Record<string, string>> = {
  'gpt-5-1-codex': 'opencode/gpt-5.1-codex-max',
  'mimo-v2-5-pro': 'opencode-go/mimo-v2.5',
  'gpt-5-3-codex': 'openai-codex/gpt-5.3-codex-spark',
  // Word order differs from the registry (`claude-sonnet-4`). The matcher
  // binds every provider copy of the target identity, so the anchor provider
  // is arbitrary.
  'claude-4-sonnet': 'opencode/claude-sonnet-4',
};

/** All levels a bench row may be measured at, for load-time validation. */
const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const isModelThinkingLevel = (v: unknown): v is ModelThinkingLevel =>
  typeof v === 'string' && (MODEL_THINKING_LEVELS as readonly string[]).includes(v);

export const emptyStore = (): BenchmarkStore => ({
  version: 2,
  syncedAt: 0,
  models: [],
  aliases: { ...DEFAULT_BENCHMARK_ALIASES },
});

export const isStale = (store: BenchmarkStore, now = Date.now()): boolean => {
  if (!store.syncedAt) return true;
  return now - store.syncedAt > STALE_MS;
};

export const isValidStore = (value: unknown): value is BenchmarkStore => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 2 &&
    typeof v.syncedAt === 'number' &&
    Array.isArray(v.models) &&
    typeof v.aliases === 'object' &&
    v.aliases !== null
  );
};

/** True for a store from before effort identity existed (v1). */
const isV1Store = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).version === 1;
};

const optionalFinite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonnegativeFinite = (value: unknown): number | undefined => {
  const finite = optionalFinite(value);
  return finite !== undefined && finite >= 0 ? finite : undefined;
};

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

const AXIS_PROVENANCE_VALUES: readonly AxisProvenance[] = ['measured', 'source-estimated', 'regression-bridge', 'effort-stepdown', 'missing'];

/** Keep only known axes with known provenance values; anything else gives no evidence. */
function sanitizeAxisProvenance(value: unknown): Partial<Record<ProvenanceAxis, AxisProvenance>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: Partial<Record<ProvenanceAxis, AxisProvenance>> = {};
  for (const axis of PROVENANCE_AXES) {
    const provenance = record[axis];
    if (typeof provenance === 'string' && (AXIS_PROVENANCE_VALUES as readonly string[]).includes(provenance)) {
      result[axis] = provenance as AxisProvenance;
    }
  }
  return result;
}

function sanitizeOutputTokensProvenance(value: unknown): OutputTokensProvenance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!(OUTPUT_TOKENS_STATUSES as readonly unknown[]).includes(record.status)) return undefined;
  const status = record.status as OutputTokensProvenance['status'];
  return typeof record.indexVersion === 'string' && record.indexVersion
    ? { status, indexVersion: record.indexVersion }
    : { status };
}

function sanitizeBenchModel(value: unknown): BenchModel | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.registryId !== 'string' ||
    typeof row.benchSlug !== 'string' || !row.benchSlug ||
    typeof row.active !== 'boolean' ||
    typeof row.source !== 'string' || !row.source ||
    !row.quality || typeof row.quality !== 'object' || Array.isArray(row.quality)
  ) return undefined;
  const quality = row.quality as Record<string, unknown>;
  const cleanedQuality = withoutUndefined({
    intelligence: optionalFinite(quality.intelligence),
    coding: optionalFinite(quality.coding),
    agenticCoding: optionalFinite(quality.agenticCoding),
    agenticIndex: optionalFinite(quality.agenticIndex),
    knowledge: optionalFinite(quality.knowledge),
    research: optionalFinite(quality.research),
    longContext: optionalFinite(quality.longContext),
    visionReasoning: optionalFinite(quality.visionReasoning),
  });
  const base: Omit<BenchModel, 'quality'> & { quality: BenchModel['quality'] } = {
    registryId: row.registryId,
    benchSlug: row.benchSlug,
    active: row.active,
    quality: cleanedQuality,
    source: row.source,
  };
  return {
    ...base,
    ...withoutUndefined({
      priceInputPer1M: optionalFinite(row.priceInputPer1M),
      priceOutputPer1M: optionalFinite(row.priceOutputPer1M),
      outputSpeedTps: optionalFinite(row.outputSpeedTps),
      latencyMsTtft: optionalFinite(row.latencyMsTtft),
      latencyMsTtfa: optionalFinite(row.latencyMsTtfa),
      effort: isModelThinkingLevel(row.effort) ? row.effort : undefined,
      qualityEstimated: row.qualityEstimated === true ? true : undefined,
      axisProvenance: sanitizeAxisProvenance(row.axisProvenance),
      costPerTask: optionalFinite(row.costPerTask),
      timePerTaskSeconds: optionalFinite(row.timePerTaskSeconds),
      outputTokensPerTask: nonnegativeFinite(row.outputTokensPerTask),
      outputTokensProvenance: sanitizeOutputTokensProvenance(row.outputTokensProvenance),
      contextWindow: optionalFinite(row.contextWindow),
    }),
  };
}

function sanitizeAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof val !== 'string' || !val.trim() || !val.includes('/')) continue;
    result[key.trim()] = val.trim();
  }
  return result;
}

export const loadStore = (base?: string): BenchmarkStore | undefined => {
  const path = getStorePath(base);
  const cached = readJsonCached(path);
  if (!cached) return undefined;
  const parsed = cached.parsed;
  if (isV1Store(parsed)) {
    // v1 rows lost the effort level they were measured at, so the store
    // cannot be upgraded — only discarded. The store is derived data, so
    // dropping it is safe; the empty result forces a resync.
    console.warn(
      '[pi8] benchmark store v1 predates effort identity and cannot be upgraded; discarding it. Run /router-sync to rebuild.',
    );
    return emptyStore();
  }
  if (!isValidStore(parsed)) return undefined;
  try {
    // Re-shape on every call so the shared cached parse is never handed out for
    // mutation, and normalize arrays/objects defensively.
    return {
      ...parsed,
      models: Array.isArray(parsed.models)
        ? parsed.models.map(sanitizeBenchModel).filter((m): m is BenchModel => m !== undefined)
        : [],
      aliases: { ...DEFAULT_BENCHMARK_ALIASES, ...sanitizeAliases(parsed.aliases) },
    };
  } catch {
    return undefined;
  }
};

export const saveStore = (store: BenchmarkStore, base?: string): void => {
  writeJsonAtomic(getStorePath(base), store);
};

export const isActive = (m: BenchModel): boolean => m.active;

export const activeModels = (store: BenchmarkStore): BenchModel[] =>
  store.models.filter(isActive);

export type BenchmarkCheck = { ready: true } | { ready: false; message: string };

/**
 * `router/auto` serves only from synced benchmark data that includes the
 * models-page measurements. Plan/review minimums need them, and registry
 * metadata alone gives no capability measurement. Chromium is needed only
 * to sync: a previous store stays usable when the browser is missing.
 */
export function checkBenchmarkStore(store: BenchmarkStore | undefined = loadStore()): BenchmarkCheck {
  const active = store ? activeModels(store) : [];
  if (!store?.syncedAt || active.length === 0) {
    return {
      ready: false,
      message: 'router/auto has no benchmark data. Run /router-sync <key> with a free key from https://artificialanalysis.ai/.',
    };
  }
  // Briefcase and LCR come only from the models page.
  if (!active.some((m) => m.quality.research !== undefined || m.quality.longContext !== undefined)) {
    return {
      ready: false,
      message: 'The benchmark data has no Artificial Analysis models-page measurements. Run /router-sync.',
    };
  }
  // The selector uses a quality value only with its axis provenance; without
  // any, every model compares on price alone.
  if (!active.some((m) => m.axisProvenance && Object.keys(m.axisProvenance).length > 0)) {
    return {
      ready: false,
      message: 'The benchmark data has no per-axis provenance. Run /router-sync to refresh it.',
    };
  }
  return { ready: true };
}

/** Value present and its axis provenance in the given set. */
const countAxes = (row: BenchModel, accepted: readonly AxisProvenance[]): number =>
  PROVENANCE_AXES.filter((axis) => {
    const provenance = row.axisProvenance?.[axis];
    return row.quality[axis] !== undefined && provenance !== undefined && accepted.includes(provenance);
  }).length;

/**
 * Whole-row merge precedence: more measured axes, then more eligible axes
 * (measured or source-estimated), then the smaller source key, then the
 * smaller canonical row text. Regression, step-down, missing and unknown
 * provenance do not count. The row-level `qualityEstimated` flag does not
 * rank rows. The result does not depend on input order.
 */
export function compareMergeRows(a: BenchModel, b: BenchModel): number {
  const measured = countAxes(b, ['measured']) - countAxes(a, ['measured']);
  if (measured !== 0) return measured;
  const eligible = countAxes(b, ['measured', 'source-estimated']) - countAxes(a, ['measured', 'source-estimated']);
  if (eligible !== 0) return eligible;
  const sourceA = `${a.source}\u0000${a.benchSlug}`;
  const sourceB = `${b.source}\u0000${b.benchSlug}`;
  if (sourceA !== sourceB) return sourceA < sourceB ? -1 : 1;
  const rowA = canonicalJson(withoutOutputTokens(a));
  const rowB = canonicalJson(withoutOutputTokens(b));
  return rowA < rowB ? -1 : rowA > rowB ? 1 : 0;
}

/**
 * Output-token fields do not rank rows: a token count must not select which
 * quality, speed and price measurement a model uses.
 */
function withoutOutputTokens(row: BenchModel): Omit<BenchModel, 'outputTokensPerTask' | 'outputTokensProvenance'> {
  const { outputTokensPerTask: _value, outputTokensProvenance: _provenance, ...rest } = row;
  return rest;
}

/**
 * The first row under `compareMergeRows`. When another row ties with it but
 * has a different output-token observation, the result has a `conflict`
 * observation: no input order selects a token measurement.
 */
export function selectMergeRow(rows: readonly BenchModel[]): BenchModel | undefined {
  if (rows.length === 0) return undefined;
  const best = rows.reduce((kept, row) => (compareMergeRows(row, kept) < 0 ? row : kept));
  const tokens = (row: BenchModel) => canonicalJson([row.outputTokensPerTask, row.outputTokensProvenance]);
  const conflict = rows.some((row) => compareMergeRows(row, best) === 0 && tokens(row) !== tokens(best));
  if (!conflict) return best;
  const { outputTokensPerTask: _value, ...rest } = best;
  const indexVersion = best.outputTokensProvenance?.indexVersion;
  return { ...rest, outputTokensProvenance: indexVersion ? { status: 'conflict', indexVersion } : { status: 'conflict' } };
}

/**
 * Group active models by registryId *and* effort and keep one whole row per
 * group. Two rows in one group are different AA models (for example a preview
 * and its release) that resolve to one registry model. Taking each axis from
 * a different row would describe a model nobody measured. The kept row is the
 * first under `compareMergeRows`.
 * Effort variants of one model are separate rows — each is a distinct
 * (model, effort) measurement pair.
 * Only active rows are merged; inactive (unresolved) rows must be passed in
 * separately if the caller wants to retain them.
 */
export const mergeActiveBenchRows = (models: BenchModel[]): BenchModel[] => {
  const byKey = new Map<string, BenchModel[]>();
  for (const m of models) {
    if (!m.active) continue;
    const key = `${m.registryId}\u0000${m.effort ?? ''}`;
    const list = byKey.get(key) ?? [];
    list.push(m);
    byKey.set(key, list);
  }
  const result: BenchModel[] = [];
  for (const [, rows] of byKey) {
    result.push(selectMergeRow(rows)!);
  }
  return result;
};

/**
 * Merge active rows and preserve every inactive (unresolved) row so that
 * `/router-status` and `/router-fix` can surface/report them.
 */
export const mergeBenchRows = (models: BenchModel[]): BenchModel[] => {
  const active = models.filter(isActive);
  const inactive = models.filter((m) => !isActive(m));
  return [...mergeActiveBenchRows(active), ...inactive];
};

/**
 * Mutable helper for storing an alias locally in the benchmark store.
 */
export const addAlias = (
  store: BenchmarkStore,
  benchSlug: string,
  registryId: string,
): BenchmarkStore => {
  return {
    ...store,
    aliases: { ...store.aliases, [benchSlug]: registryId },
  };
};

/**
 * Get available models from the extension context registry.
 * Defensive: extension contexts may expose modelRegistry differently or not at all.
 */
export const getAvailableRegistryModels = (
  ctx?: ExtensionContext | Pick<ExtensionContext, 'modelRegistry'>,
): Array<{ provider: string; id: string; contextWindow?: number; vision?: boolean }> => {
  if (!ctx) return [];
  const registry = 'modelRegistry' in ctx ? ctx.modelRegistry : undefined;
  if (!registry || typeof registry.getAvailable !== 'function') return [];
  try {
    return (registry.getAvailable() as Array<{ provider: string; id: string }>).map((m) => ({
      provider: m.provider,
      id: m.id,
    }));
  } catch {
    return [];
  }
};

export const registryModelsFromCtx = (
  ctx?: ExtensionContext,
): Array<{ provider: string; id: string }> => getAvailableRegistryModels(ctx);

