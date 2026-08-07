/**
 * Model allowlist.
 *
 * By default the router considers every model in Pi's registry. That is rarely
 * what a user wants: the registry carries hundreds of entries across providers,
 * including ones that are region-locked, entitlement-gated, or simply not
 * desired. The `models` config key narrows the routable set:
 *
 *   {
 *     "models": ["github-copilot/*", "opencode-go/deepseek-v4-pro"]
 *   }
 *
 * Semantics:
 *  - Patterns are matched against the canonical `provider/id` registry id.
 *  - `*` matches any run of characters (including `/`), so `github-copilot/*`
 *    selects every model of that provider.
 *  - A pattern with no `/` is treated as a bare provider name, i.e.
 *    `github-copilot` is shorthand for `github-copilot/*`.
 *  - Matching is case-insensitive.
 *  - An absent or empty list means "allow everything" (backwards compatible).
 */
import { loadConfig } from './config.js';

/** Escape regex metacharacters, then re-enable `*` as a wildcard. */
function patternToRegExp(pattern: string): RegExp {
  const normalized = pattern.includes('/') ? pattern : `${pattern}/*`;
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Build a predicate over canonical `provider/id` registry ids.
 *
 * An absent, empty, or all-blank list yields an allow-all predicate so the
 * router keeps working for users who never set `models`.
 */
export function buildModelFilter(
  patterns?: readonly string[] | null,
): (registryId: string) => boolean {
  if (!Array.isArray(patterns)) return () => true;
  const usable = patterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  if (usable.length === 0) return () => true;

  const compiled = usable.map(patternToRegExp);
  return (registryId: string) => {
    const id = registryId.trim();
    return compiled.some((re) => re.test(id));
  };
}

/** Convenience: build the filter from the persisted config. */
export function loadModelFilter(): (registryId: string) => boolean {
  try {
    return buildModelFilter(loadConfig().models);
  } catch {
    // Never let a bad config stop routing entirely.
    return () => true;
  }
}

/**
 * Build a predicate over canonical `provider/id` registry ids from a list of
 * *exclude* patterns (same glob syntax as {@link buildModelFilter}). Used for
 * the blacklist: absent/empty excludes nothing.
 */
export function buildExcludeFilter(
  patterns?: readonly string[] | null,
): (registryId: string) => boolean {
  const isListed = buildModelFilter(patterns);
  if (!Array.isArray(patterns) || patterns.filter((p) => typeof p === 'string' && p.trim() !== '').length === 0) {
    return () => false;
  }
  return isListed;
}

/** Convenience: build the exclude predicate from the persisted config blacklist. */
export function loadConfigBlacklistFilter(): (registryId: string) => boolean {
  try {
    return buildExcludeFilter(loadConfig().blacklist);
  } catch {
    return () => false;
  }
}
