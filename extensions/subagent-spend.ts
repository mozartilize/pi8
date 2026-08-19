/**
 * Spend accounting for foreground subagent children.
 *
 * pi-subagents reports each child's terminal `usage` (tokens plus its own
 * billed cost) on the `subagent` tool_result. Only the token counts are used
 * for the report: the reported `cost` is provider billing, which is zero or
 * absent for subscription providers, and mixing it with registry-priced
 * parent turns would compare two different cost bases. It is carried through
 * unchanged as a cross-check instead.
 *
 * Async spawns return before their child finishes and carry no terminal
 * usage, so they produce no record here — absent by construction rather than
 * counted as zero.
 *
 * Pure: no I/O, no registry access. The caller supplies the candidate pool.
 */
import type { Candidate, Role } from './types.js';
import { ROLE_DIMENSIONS } from './types.js';
import { pickBaseline, priceTokens } from './baseline.js';
import { stripThinkingSuffix } from './subagents.js';
import type { SubagentResultRow } from './subagent-results.js';

export interface SubagentSpendRecord {
  role?: Role;
  model: string;
  /** False for children whose model the caller pinned explicitly. */
  routerOwned: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
  routedCost?: number;
  baselineModel?: string;
  baselineSource?: 'config' | 'auto';
  baselineCost?: number;
  reportedCost?: number;
}

export interface SubagentSpendOptions {
  candidates: readonly Candidate[];
  configBaselineModel?: string;
  /** Role observed for this spawn, when exactly one is known. */
  role?: Role;
  /** Models the router itself injected for this spawn. */
  routerOwnedModels: readonly string[];
}

export function computeSubagentSpend(
  rows: readonly SubagentResultRow[],
  opts: SubagentSpendOptions,
): SubagentSpendRecord[] {
  const dimension = opts.role ? ROLE_DIMENSIONS[opts.role] : 'implement';
  const baseline = pickBaseline(opts.candidates, dimension, opts.configBaselineModel);
  const owned = new Set(opts.routerOwnedModels.map(stripThinkingSuffix));

  return rows.flatMap((row) => {
    if (!row.usage || typeof row.model !== 'string') return [];
    const model = stripThinkingSuffix(row.model);
    const usage = {
      inputTokens: row.usage.input,
      outputTokens: row.usage.output,
      cacheRead: row.usage.cacheRead,
      cacheWrite: row.usage.cacheWrite,
    };
    if (
      usage.inputTokens === 0 &&
      usage.outputTokens === 0 &&
      usage.cacheRead === 0 &&
      usage.cacheWrite === 0
    ) {
      return [];
    }
    const price = opts.candidates.find((c) => c.registryId === model)?.cost;
    return [
      {
        ...(opts.role ? { role: opts.role } : {}),
        model,
        routerOwned: owned.has(model),
        usage,
        routedCost: priceTokens(price, usage),
        ...(baseline
          ? {
              baselineModel: baseline.registryId,
              baselineSource: baseline.source,
              baselineCost: priceTokens(baseline.cost, usage),
            }
          : {}),
        reportedCost: row.usage.cost,
      },
    ];
  });
}
