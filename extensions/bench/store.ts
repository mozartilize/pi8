/**
 * Benchmark store lifecycle.
 *
 * Pure functions for validation/defaults; I/O lives in the exported helpers.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

import type { BenchModel, BenchmarkStore, ExtensionContext } from '../types.js';
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

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
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
      costPerTask: optionalFinite(row.costPerTask),
      timePerTaskSeconds: optionalFinite(row.timePerTaskSeconds),
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
  return { ready: true };
}

/**
 * Group active models by registryId *and* effort and keep one whole row per
 * group. Two rows in one group are different AA models (for example a preview
 * and its release) that resolve to one registry model. Taking each axis from
 * a different row would describe a model nobody measured. The kept row is
 * measured rather than estimated, then has the most quality axes.
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
  const axes = (row: BenchModel): number => Object.values(row.quality).filter((v) => v !== undefined).length;
  for (const [, rows] of byKey) {
    result.push(rows.reduce((best, row) => {
      if (!!row.qualityEstimated !== !!best.qualityEstimated) return row.qualityEstimated ? best : row;
      return axes(row) > axes(best) ? row : best;
    }));
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

