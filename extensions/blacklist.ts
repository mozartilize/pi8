/**
 * Per-session model exclusions, of two kinds:
 *
 *  - concrete `provider/id`s that failed before producing content, recorded by
 *    the delegation loop;
 *  - `provider/id` glob patterns the user excluded for this session only.
 *
 * Stored in its own tiny module so both the provider orchestrator and the
 * delegation fallback loop can reference it without a circular import.
 */

/** Models that failed before producing content during this Pi session. */
const sessionBlacklistedModels = new Set<string>();

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
};
