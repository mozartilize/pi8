/**
 * Benchmark sync: fetch the Artificial Analysis rows, bind them to registry
 * models, and replace the store. A failed fetch, or a sync that binds no
 * registry model, keeps the previous store.
 */
import { AXIS_REFERENCE } from '../routing/score/scorer.js';
import type { ExtensionContext, SyncResult } from '../types.js';
import {
  loadStore,
  saveStore,
  emptyStore,
  mergeBenchRows,
  registryModelsFromCtx,
} from './store.js';
import { resolveRows } from './matcher.js';
import { loadConfig } from '../config.js';
import { SOURCE, fetchAndNormalize } from '../adapters/artificial-analysis.js';

/** Precedence: explicit argument > environment > persisted config. */
function resolveApiKey(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  if (process.env.ARTIFICIAL_ANALYSIS_API_KEY) return process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  try {
    return loadConfig().artificialAnalysisApiKey;
  } catch {
    // An unreadable config reads as a missing key, which the result reports.
    return undefined;
  }
}

const failure = (source: string, error: string, fetched = 0): SyncResult =>
  ({ source, ok: false, fetched, matched: 0, unresolved: fetched, error });

export async function syncBenchmarks(
  ctx: ExtensionContext,
  opts: { apiKey?: string } = {},
): Promise<SyncResult[]> {
  const apiKey = resolveApiKey(opts.apiKey);
  if (!apiKey) {
    return [failure(
      SOURCE,
      'No Artificial Analysis API key. Get a free key at https://artificialanalysis.ai/ and run `/router-sync <key>`, or set ARTIFICIAL_ANALYSIS_API_KEY.',
    )];
  }
  const store = loadStore() ?? emptyStore();
  const previousActive = store.models.filter((m) => m.active).length;

  let rows;
  try {
    rows = await fetchAndNormalize({ apiKey });
  } catch (error) {
    return [
      failure(SOURCE, error instanceof Error ? error.message : String(error)),
      failure('store', `Sync failed; keeping the previous ${previousActive} active rows.`),
    ];
  }

  const merged = mergeBenchRows(resolveRows(rows, registryModelsFromCtx(ctx), store.aliases));
  const matched = merged.filter((m) => m.active).length;
  const fetched: SyncResult = {
    source: SOURCE,
    ok: true,
    fetched: rows.length,
    matched,
    unresolved: merged.length - matched,
  };
  // Never replace usable data with nothing: a source change that binds no
  // registry model would otherwise wipe the store.
  if (matched === 0 && previousActive > 0) {
    return [
      fetched,
      failure('store', `Sync matched 0 registry models; keeping the previous ${previousActive} to avoid wiping the store.`, rows.length),
    ];
  }

  const max = Math.max(0, ...merged.filter(row => row.active).map(row => row.quality.intelligence ?? 0));
  const notices: string[] = [];
  if (max > 0 && Math.abs(max / AXIS_REFERENCE.intelligence - 1) > 0.15) notices.push('intelligence maximum differs by over 15% from calibration; review capability minimums');
  if (rows.indexVersion && rows.indexVersion.replace(/^v/, '') !== '4.3') notices.push(`AA index version ${rows.indexVersion} differs from calibration 4.3`);
  if (notices.length) fetched.error = `Notice: ${notices.join('; ')}`;
  saveStore({ ...store, version: 2, indexVersion: rows.indexVersion, syncedAt: Date.now(), models: merged });
  return [fetched];
}

export function syncSummary(results: SyncResult[]): string {
  const lines = results.map((r) => {
    const status = r.ok ? 'ok' : 'failed';
    const extra = r.error ? ` (${r.error})` : '';
    return `${r.source}: ${status}, fetched ${r.fetched}, matched ${r.matched}, unresolved ${r.unresolved}${extra}`;
  });
  return lines.join('\n');
}
