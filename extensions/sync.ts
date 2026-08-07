/**
 * Benchmark sync orchestration.
 */
import type { BenchModel, ExtensionContext, SyncResult } from './types.js';
import {
  loadStore,
  saveStore,
  emptyStore,
  mergeBenchRows,
  registryModelsFromCtx,
} from './store.js';
import { resolveRows } from './matcher.js';
import { loadConfig } from './config.js';
import { getEnabledAdapters, buildAdapterConfig, type AdapterName } from './adapters/index.js';

export async function syncBenchmarks(
  ctx: ExtensionContext,
  opts: {
    sources?: AdapterName[];
    apiKey?: string;
    onProgress?: (result: SyncResult) => void;
  } = {},
): Promise<SyncResult[]> {
  const config = buildAdapterConfig(ctx);
  if (opts.apiKey) {
    config['artificial-analysis'].apiKey = opts.apiKey;
  }
  const sourceNames = opts.sources ?? (loadConfig().sources as AdapterName[]);
  const adapters = getEnabledAdapters(sourceNames as AdapterName[], config);
  if (adapters.length === 0) {
    return [
      {
        source: sourceNames.join(', ') || 'none',
        ok: false,
        fetched: 0,
        matched: 0,
        unresolved: 0,
        error:
          'No benchmark source is usable. Set an Artificial Analysis API key (free at https://artificialanalysis.ai/) via ARTIFICIAL_ANALYSIS_API_KEY or `/router-sync <key>`.',
      },
    ];
  }
  const registryModels = registryModelsFromCtx(ctx);

  const store = loadStore() ?? emptyStore();
  let combinedRows: Omit<BenchModel, 'registryId' | 'active'>[] = [];
  const results: SyncResult[] = [];

  for (const adapter of adapters) {
    let fetched = 0;
    let matched = 0;
    let error: string | undefined;
    try {
      const rows = await adapter.fetch(config);
      fetched = rows.length;
      combinedRows = combinedRows.concat(rows);
      const resolved = resolveRows(rows, registryModels, store.aliases);
      matched = resolved.filter((r) => r.active).length;
      const unresolved = fetched - matched;
      results.push({
        source: adapter.name,
        ok: true,
        fetched,
        matched,
        unresolved,
      });
      opts.onProgress?.(results[results.length - 1]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      results.push({
        source: adapter.name,
        ok: false,
        fetched: 0,
        matched: 0,
        unresolved: 0,
        error,
      });
      opts.onProgress?.(results[results.length - 1]);
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    results.push({
      source: 'store',
      ok: false,
      fetched: combinedRows.length,
      matched: 0,
      unresolved: combinedRows.length,
      error: `Sync was partial; keeping the previous ${store.models.filter((m) => m.active).length} active rows.`,
    });
    return results;
  }

  const resolved = resolveRows(combinedRows, registryModels, store.aliases);
  const merged = mergeBenchRows(resolved);

  // Never replace usable data with nothing: a source outage would otherwise
  // silently wipe the store and drop the router back into price-only mode.
  const activeCount = merged.filter((m) => m.active).length;
  const previousActive = store.models.filter((m) => m.active).length;
  if (activeCount === 0 && previousActive > 0) {
    results.push({
      source: 'store',
      ok: false,
      fetched: combinedRows.length,
      matched: 0,
      unresolved: combinedRows.length,
      error: `Sync matched 0 registry models; keeping the previous ${previousActive} to avoid wiping the store.`,
    });
    return results;
  }

  const nextStore: typeof store = {
    ...store,
    version: 2,
    syncedAt: Date.now(),
    models: merged,
  };
  saveStore(nextStore);

  // Sync refreshes the benchmark store only; role models are injected per
  // spawn (see subagents.ts / index.ts tool_call handler).
  return results;
}

export function syncSummary(results: SyncResult[]): string {
  const lines = results.map((r) => {
    const status = r.ok ? 'ok' : 'failed';
    const extra = r.error ? ` (${r.error})` : '';
    return `${r.source}: ${status}, fetched ${r.fetched}, matched ${r.matched}, unresolved ${r.unresolved}${extra}`;
  });
  return lines.join('\n');
}
