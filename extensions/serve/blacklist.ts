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
 * Encapsulated inside `BlacklistState` class to avoid global state and circular imports.
 */

import { debugLog } from '../host/debuglog.js';

const debugCounterKey = Symbol.for('pi8.blacklist.debug-module-counter');
const debugGlobal = globalThis as unknown as Record<symbol, number | undefined>;
const debugModuleCounter = (debugGlobal[debugCounterKey] ?? 0) + 1;
debugGlobal[debugCounterKey] = debugModuleCounter;
const debugModuleInstance = `${process.pid}:${debugModuleCounter}`;

const normalizePattern = (pattern: string): string => pattern.trim();
const samePattern = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class BlacklistState {
  private readonly sessionBlacklistedModels = new Set<string>();
  private readonly sessionBlacklistedProviders = new Set<string>();
  private readonly sessionBlacklistPatterns: string[] = [];

  private providerDebugState(): Record<string, unknown> {
    return {
      instance: debugModuleInstance,
      pid: process.pid,
      providers: [...this.sessionBlacklistedProviders].sort(),
      models: this.sessionBlacklistedModels.size,
      patterns: this.sessionBlacklistPatterns.length,
    };
  }

  getDebugState(): Record<string, unknown> {
    return this.providerDebugState();
  }

  private debug(event: string, data: Record<string, unknown> = {}): void {
    debugLog(event, { ...this.providerDebugState(), ...data });
  }

  blacklistModel(registryId: string): void {
    if (registryId) this.sessionBlacklistedModels.add(registryId);
  }

  removeBlacklistedModel(registryId: string): boolean {
    return this.sessionBlacklistedModels.delete(registryId);
  }

  clearBlacklistedModels(): void {
    this.sessionBlacklistedModels.clear();
  }

  getBlacklistedModels(): ReadonlySet<string> {
    return this.sessionBlacklistedModels;
  }

  blacklistProvider(provider: string): void {
    const hadProvider = this.sessionBlacklistedProviders.has(provider);
    if (provider) this.sessionBlacklistedProviders.add(provider);
    this.debug('blacklist.provider.add', { provider, hadProvider });
  }

  removeBlacklistedProvider(provider: string): boolean {
    const removed = this.sessionBlacklistedProviders.delete(provider);
    this.debug('blacklist.provider.remove', { provider, removed });
    return removed;
  }

  clearBlacklistedProviders(): void {
    const before = [...this.sessionBlacklistedProviders].sort();
    this.sessionBlacklistedProviders.clear();
    this.debug('blacklist.providers.clear', { before });
  }

  getBlacklistedProviders(): ReadonlySet<string> {
    this.debug('blacklist.providers.read');
    return this.sessionBlacklistedProviders;
  }

  addSessionBlacklistPatterns(patterns: readonly string[]): string[] {
    const added: string[] = [];
    for (const raw of patterns) {
      const pattern = normalizePattern(raw);
      if (!pattern) continue;
      if (this.sessionBlacklistPatterns.some((p) => samePattern(p, pattern))) continue;
      this.sessionBlacklistPatterns.push(pattern);
      added.push(pattern);
    }
    return added;
  }

  removeSessionBlacklistPatterns(patterns: readonly string[]): string[] {
    const removed: string[] = [];
    for (const raw of patterns) {
      const pattern = normalizePattern(raw);
      const index = this.sessionBlacklistPatterns.findIndex((p) => samePattern(p, pattern));
      if (index === -1) continue;
      removed.push(this.sessionBlacklistPatterns[index]);
      this.sessionBlacklistPatterns.splice(index, 1);
    }
    return removed;
  }

  getSessionBlacklistPatterns(): readonly string[] {
    return [...this.sessionBlacklistPatterns];
  }

  clearSessionBlacklist(): void {
    const before = [...this.sessionBlacklistedProviders].sort();
    const stack = new Error().stack?.split('\n').slice(2, 6).map((line) => line.trim());
    this.sessionBlacklistPatterns.length = 0;
    this.sessionBlacklistedModels.clear();
    this.sessionBlacklistedProviders.clear();
    this.debug('blacklist.session.clear', { before, stack });
  }
}

/** Shared default instance used by top-level CLI commands and procedural adapters. */
export const defaultBlacklistState = new BlacklistState();

export const getBlacklistDebugState = (): Record<string, unknown> =>
  defaultBlacklistState.getDebugState();

export const blacklistModel = (registryId: string): void =>
  defaultBlacklistState.blacklistModel(registryId);

export const removeBlacklistedModel = (registryId: string): boolean =>
  defaultBlacklistState.removeBlacklistedModel(registryId);

export const clearBlacklistedModels = (): void =>
  defaultBlacklistState.clearBlacklistedModels();

export const getBlacklistedModels = (): ReadonlySet<string> =>
  defaultBlacklistState.getBlacklistedModels();

export const blacklistProvider = (provider: string): void =>
  defaultBlacklistState.blacklistProvider(provider);

export const removeBlacklistedProvider = (provider: string): boolean =>
  defaultBlacklistState.removeBlacklistedProvider(provider);

export const clearBlacklistedProviders = (): void =>
  defaultBlacklistState.clearBlacklistedProviders();

export const getBlacklistedProviders = (): ReadonlySet<string> =>
  defaultBlacklistState.getBlacklistedProviders();

export const addSessionBlacklistPatterns = (patterns: readonly string[]): string[] =>
  defaultBlacklistState.addSessionBlacklistPatterns(patterns);

export const removeSessionBlacklistPatterns = (patterns: readonly string[]): string[] =>
  defaultBlacklistState.removeSessionBlacklistPatterns(patterns);

export const getSessionBlacklistPatterns = (): readonly string[] =>
  defaultBlacklistState.getSessionBlacklistPatterns();

export const clearSessionBlacklist = (): void =>
  defaultBlacklistState.clearSessionBlacklist();
