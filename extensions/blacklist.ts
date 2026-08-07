/**
 * Per-session model exclusions, of two kinds:
 *
 *  - concrete `provider/id`s that failed before producing content, recorded by
 *    the delegation loop;
 *  - `provider/id` glob patterns the user excluded for this session only.
 *
 * Providers are excluded separately: a provider that returned a usage-limit
 * error is unusable as a whole, because the quota/limit behind it is shared by
 * every model it serves.
 *
 * Stored in its own tiny module so both the provider orchestrator and the
 * delegation fallback loop can reference it without a circular import.
 */

/** Models that failed before producing content during this Pi session. */
const sessionBlacklistedModels = new Set<string>();

/** Providers excluded after a usage-limit error during this Pi session. */
const sessionBlacklistedProviders = new Set<string>();

/** User-supplied exclusion globs scoped to this session; insertion-ordered. */
const sessionBlacklistPatterns: string[] = [];

const normalizePattern = (pattern: string): string => pattern.trim();

const samePattern = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const blacklistModel = (registryId: string): void => {
  if (registryId) sessionBlacklistedModels.add(registryId);
};

export const removeBlacklistedModel = (registryId: string): boolean =>
  sessionBlacklistedModels.delete(registryId);

export const clearBlacklistedModels = (): void => {
  sessionBlacklistedModels.clear();
};

export const getBlacklistedModels = (): ReadonlySet<string> => sessionBlacklistedModels;

/** Exclude every model of a provider for the rest of the session. */
export const blacklistProvider = (provider: string): void => {
  if (provider) sessionBlacklistedProviders.add(provider);
};

/** Lift a session provider exclusion (e.g. after the account was topped up). */
export const removeBlacklistedProvider = (provider: string): boolean =>
  sessionBlacklistedProviders.delete(provider);

/** Wipe the runtime provider exclusions (test seam / session reset). */
export const clearBlacklistedProviders = (): void => {
  sessionBlacklistedProviders.clear();
};

export const getBlacklistedProviders = (): ReadonlySet<string> => sessionBlacklistedProviders;

/** Add exclusion globs for this session. Returns the ones that were new. */
export const addSessionBlacklistPatterns = (patterns: readonly string[]): string[] => {
  const added: string[] = [];
  for (const raw of patterns) {
    const pattern = normalizePattern(raw);
    if (!pattern) continue;
    if (sessionBlacklistPatterns.some((p) => samePattern(p, pattern))) continue;
    sessionBlacklistPatterns.push(pattern);
    added.push(pattern);
  }
  return added;
};

/** Drop exclusion globs from this session. Returns the ones that were present. */
export const removeSessionBlacklistPatterns = (patterns: readonly string[]): string[] => {
  const removed: string[] = [];
  for (const raw of patterns) {
    const pattern = normalizePattern(raw);
    const index = sessionBlacklistPatterns.findIndex((p) => samePattern(p, pattern));
    if (index === -1) continue;
    removed.push(sessionBlacklistPatterns[index]);
    sessionBlacklistPatterns.splice(index, 1);
  }
  return removed;
};

export const getSessionBlacklistPatterns = (): readonly string[] => [...sessionBlacklistPatterns];

/** Wipe every session-scoped exclusion: user globs and runtime failures alike. */
export const clearSessionBlacklist = (): void => {
  sessionBlacklistPatterns.length = 0;
  sessionBlacklistedModels.clear();
  sessionBlacklistedProviders.clear();
};
