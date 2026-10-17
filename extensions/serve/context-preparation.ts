/**
 * Context preparation for a smaller-window action.
 *
 * Inside one provider call, Pi cannot compact without ending the run, so the
 * router serves only actions whose window holds the current prompt. When a
 * better-ranked action needs a smaller prompt, the router advertises that
 * action's window on `router/auto`. Pi then compacts against it before the
 * next request: between tool turns, or before the next user prompt.
 *
 * The advertised window is the action's window divided by the fit margin.
 * Pi compacts when its estimate exceeds the advertised window minus its
 * reserve, so a prompt that Pi leaves alone also holds by the router's rule.
 *
 * A preparation fails when the next decision finds a prompt that the window
 * still does not hold: the summary failed, compaction is disabled, or the
 * current turn alone is too large. A failed window is not advertised again in
 * the same entry. Each summary request is a paid model call, so one entry
 * permits at most MAX_COMPACTION_ATTEMPTS failed preparations.
 */
import { CONTEXT_FIT_MARGIN, holdsPrompt } from '../routing/score/scorer.js';
import type { Candidate } from '../types.js';

/** Failed preparations that one entry permits. */
const MAX_COMPACTION_ATTEMPTS = 2;

export interface PreparationRequest {
  key: string;
  contextWindow: number;
}

export class ContextPreparationState {
  private entryKey: string | undefined;
  private pending: PreparationRequest | undefined;
  private readonly failedWindows = new Set<number>();
  private failures = 0;

  /**
   * Record the result of the previous preparation against the current prompt.
   * Call once per decision, before `plan`.
   */
  observe(entryKey: string, promptTokens: number): void {
    if (entryKey !== this.entryKey) {
      this.entryKey = entryKey;
      this.failedWindows.clear();
      this.failures = 0;
      this.pending = undefined;
    }
    if (this.pending && !holdsPrompt(this.pending.contextWindow, promptTokens)) {
      this.failedWindows.add(this.pending.contextWindow);
      this.failures++;
    }
    this.pending = undefined;
  }

  /**
   * The first action ranked above `chosen` whose window does not hold the
   * prompt and has not failed in this entry. Records it as the pending
   * preparation. Undefined when no preparation is permitted or necessary.
   */
  plan(ranking: readonly string[], chosen: string, candidates: ReadonlyMap<string, Candidate>, promptTokens: number): PreparationRequest | undefined {
    if (this.failures >= MAX_COMPACTION_ATTEMPTS) return undefined;
    for (const key of ranking) {
      if (key === chosen) return undefined;
      const window = candidates.get(key)?.contextWindow;
      if (!window || holdsPrompt(window, promptTokens) || this.failedWindows.has(window)) continue;
      this.pending = { key, contextWindow: window };
      return this.pending;
    }
    return undefined;
  }

  /** The window to advertise on `router/auto`, when a preparation is pending. */
  advertisedWindow(): number | undefined {
    return this.pending ? Math.floor(this.pending.contextWindow / CONTEXT_FIT_MARGIN) : undefined;
  }

  reset(): void {
    this.entryKey = undefined;
    this.pending = undefined;
    this.failedWindows.clear();
    this.failures = 0;
  }
}
