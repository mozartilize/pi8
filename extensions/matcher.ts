/**
 * Matching from benchmark slugs (e.g. "claude-opus-4-6") to Pi registry IDs
 * (e.g. "anthropic/claude-opus-4-6-20260115").
 *
 * Two properties matter here, and the original implementation had neither:
 *
 * 1. **One-to-many.** The same model is served by many providers, so one
 *    benchmark row must bind to *every* matching registry entry. Returning a
 *    single "most specific" match meant a row for Claude Opus 4.6 landed on
 *    whichever provider happened to sort first, and users routing through a
 *    different provider saw no benchmark data at all.
 *
 * 2. **Identity-preserving.** Loose substring containment matched
 *    `gpt-4-1-nano` onto `gpt-4.1` and `claude-sonnet-4-6-non-reasoning` onto
 *    `claude-sonnet-4`, i.e. it attached a small model's scores to a large one
 *    and vice versa. Size/tier tokens (nano, mini, pro, max, flash, …) are part
 *    of a model's identity and must never be discarded.
 */

import type { BenchModel } from './types.js';

/**
 * Trailing tokens describing *how* a model was run rather than *which* model
 * it is. Benchmarks publish one row per effort level; the registry exposes one
 * entry for the model itself. The effort axis is off/minimal/low/medium/high/
 * xhigh/max, but `max` is deliberately absent: it is a real tier token in
 * model identities (e.g. `qwen3.7-max`, `gpt-5.1-codex-max`), and AA names
 * max-effort rows with the bare base slug anyway. The parsed effort level is
 * carried on the row itself (`BenchModel.effort`), so stripping it here for
 * matching loses nothing.
 */
const EFFORT_SUFFIXES = new Set([
  'thinking',
  'nonreasoning',
  'reasoning',
  'non',
  'adaptive',
  'xhigh',
  'minimal',
  'low',
  'medium',
  'high',
  'off',
  'effort',
  'default',
]);

/**
 * Release-stage, pricing-tier, and format noise that appears on one side
 * or the other. Deliberately small: anything ambiguous belongs in neither list.
 */
const FILLER_TOKENS = new Set([
  'preview',
  'latest',
  'stable',
  'chat',
  'instruct',
  'it',
  'free',
]);

/** `20260115`, or a trailing `05-06` style date pair. */
const isLongDate = (t: string): boolean => /^\d{6,8}$/.test(t);
const isDatePart = (t: string): boolean => /^\d{2}$/.test(t);

/**
 * Benchmark rows known to describe a run configuration rather than a distinct
 * model. Entries are full slug units, not tokens: `deepseek-v4-flash-0420`
 * and `deepseek-v4-flash-0420-high` are a date-stamped run family, and
 * `o3-mini-high` is kept whole because AA publishes o3-mini only at that
 * single effort — the slug names the run, not a model with sibling effort
 * rows. Other `-high` slugs are ordinary effort variants, stripped by
 * {@link EFFORT_SUFFIXES} with the level carried on the row.
 *
 * Keep this source-backed: a generic four-digit suffix may be part of a
 * registry model's identity. A stale list is not benign — every unrecognized
 * variant produces an unmatched row, which lands in tier 1 (quality-unknown)
 * instead of tier 0. Every benchmark re-sync reviewer must check new rows for
 * date-stamp (`-<4 digits>`) run variants and add them here; effort labels
 * are handled by the adapter parse.
 */
const BENCHMARK_RUN_VARIANTS = new Set([
  'deepseek-v4-flash-0420',
  'deepseek-v4-flash-0420-high',
  'o3-mini-high',
]);

/**
 * Split on every separator *including* dots, so the registry's `claude-4.5`
 * and a benchmark's `claude-4-5` produce the same token sequence.
 */
const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[-/_\s.:]+/)
    .map((t) => t.replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean);

/**
 * Reduce a slug or registry id to its identity tokens: strip provider prefix,
 * trailing effort suffixes, trailing date stamps and filler.
 */
export function identityKey(raw: string, normalizeBenchmarkRunVariant = false): string {
  const withoutProvider = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  let tokens = tokenize(withoutProvider);

  // Trailing date stamp: either one long number, or >=2 two-digit groups.
  while (tokens.length > 1 && isLongDate(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  while (
    tokens.length > 2 &&
    isDatePart(tokens[tokens.length - 1]) &&
    isDatePart(tokens[tokens.length - 2])
  ) {
    tokens = tokens.slice(0, -2);
  }
  if (normalizeBenchmarkRunVariant) {
    while (tokens.length > 1 && BENCHMARK_RUN_VARIANTS.has(tokens.join('-'))) {
      tokens = tokens.slice(0, -1);
    }
  }

  // Trailing effort suffixes, applied repeatedly ("non", "reasoning", "low",
  // "effort" all trail off `-non-reasoning-low-effort`).
  while (tokens.length > 1 && EFFORT_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }

  tokens = tokens.filter((t) => !FILLER_TOKENS.has(t));
  return tokens.join('-');
}

export interface RegistryModelRef {
  provider: string;
  id: string;
}

export const buildRefVariants = (models: RegistryModelRef[]): Map<string, RegistryModelRef> => {
  const map = new Map<string, RegistryModelRef>();
  for (const m of models) {
    map.set(`${m.provider}/${m.id}`, m);
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return map;
};

/**
 * Resolve a benchSlug to every registry model that is the same underlying
 * model. Returns canonical "provider/id" strings, deduped and sorted.
 */
export function resolveSlugAll(
  slug: string,
  registryModels: RegistryModelRef[],
  aliases: Record<string, string> = {},
): string[] {
  // 1. An alias names a model the identity matcher cannot infer. It adds that
  // binding rather than replacing the slug's other bindings, because the same
  // benchmark row usually describes a model several providers serve: a
  // single-target alias would silently strip measured quality from the
  // siblings that already matched, demoting them to the unknown-quality tier.
  const bindings: string[] = [];
  const aliasTarget = aliases[slug];
  if (aliasTarget) {
    const variants = buildRefVariants(registryModels);
    const m = variants.get(aliasTarget) ?? variants.get(aliasTarget.split('/').pop() ?? '');
    if (m) bindings.push(`${m.provider}/${m.id}`);
  }

  // 2. Exact "provider/id" reference pins to that one entry.
  if (slug.includes('/')) {
    const exact = registryModels.find((m) => `${m.provider}/${m.id}` === slug);
    if (exact) return [...new Set([...bindings, `${exact.provider}/${exact.id}`])].sort();
  }

  // 3. Identity-key equality, across every provider.
  const key = identityKey(slug, true);
  if (!key) return [...new Set(bindings)].sort();

  for (const m of registryModels) {
    if (identityKey(m.id) === key) bindings.push(`${m.provider}/${m.id}`);
  }

  return [...new Set(bindings)].sort();
}


/**
 * Resolve raw benchmark rows against the registry.
 *
 * A row matching N registry models produces N active rows (one per provider);
 * a row matching nothing produces a single inactive row so `/router-status`
 * can report it as unresolved.
 */
export function resolveRows(
  rows: Omit<BenchModel, 'registryId' | 'active'>[],
  registryModels: RegistryModelRef[],
  aliases: Record<string, string> = {},
): BenchModel[] {
  const out: BenchModel[] = [];
  for (const row of rows) {
    const targets = resolveSlugAll(row.benchSlug, registryModels, aliases);
    if (targets.length === 0) {
      out.push({ ...row, registryId: '', active: false });
      continue;
    }
    for (const registryId of targets) {
      out.push({ ...row, registryId, active: true });
    }
  }
  return out;
}
