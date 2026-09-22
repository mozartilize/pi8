/**
 * Streaming reasoning-loop detector. Comparison state is hashes and counts.
 * The only retained text is the bounded streaming tail used to assemble the
 * next 128-character exact block and the token window needed to emit the next
 * hashed shingle — both are dropped as soon as they are consumed. Reflection
 * markers confirm repetition; they never escalate on their own.
 */
import type { StruggleSeverity } from './types.js';
import { fingerprint } from './fingerprints.js';

export const RL_MIN_TOKENS = 768;
export const RL_WINDOW = 64;
export const RL_STRIDE = 32;
export const RL_SHINGLE = 5;
export const RL_NEAR_DUPLICATE = 0.85;
export const RL_WARNING_SHARE = 0.3;
export const RL_WARNING_RESETS = 3;
export const RL_SEVERE_SHARE = 0.45;
export const RL_SEVERE_RESETS = 4;
export const RL_EXACT_BLOCK_CHARS = 128;
export const RL_EXACT_BLOCK_REPEAT = 3;
const MAX_WINDOWS = 24;
const MAX_EXACT_HASHES = 512;

const REFLECTION_MARKERS = [
  'wait',
  'actually',
  'but',
  'however',
  'alternatively',
  'instead',
  'hmm',
  'let me reconsider',
  "that's not right",
  'thats not right',
];

function shingles(tokens: string[]): Set<string> {
  const out = new Set<string>();
  if (tokens.length < RL_SHINGLE) {
    if (tokens.length > 0) out.add(fingerprint([tokens.join(' ')]));
    return out;
  }
  for (let i = 0; i <= tokens.length - RL_SHINGLE; i += 1) {
    out.add(fingerprint([tokens.slice(i, i + RL_SHINGLE).join(' ')]));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function countNewMarkers(text: string, completeBefore = 0): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const marker of REFLECTION_MARKERS) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(marker, from);
      if (at < 0) break;
      const before = at === 0 ? ' ' : lower[at - 1];
      const after = lower[at + marker.length] ?? ' ';
      if (/\W/.test(before) && /\W/.test(after) && at + marker.length > completeBefore) {
        count += 1;
      }
      from = at + marker.length;
    }
  }
  return count;
}

function splitCompleteTokens(text: string): { tokens: string[]; carry: string } {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const endsIncomplete = /[a-z0-9]$/.test(normalized);
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { tokens: [], carry: '' };
  if (endsIncomplete) {
    const carry = parts.pop()!;
    return { tokens: parts, carry };
  }
  return { tokens: parts, carry: '' };
}

export interface ReasoningLoopSnapshot {
  tokenCount: number;
  windowCount: number;
  repeatedWindowCount: number;
  reflectionTransitions: number;
  maxSimilarity: number;
  severity: StruggleSeverity;
}

interface ReasoningWindow {
  shingles: Set<string>;
  repeated: boolean;
}

export class ReasoningLoopDetector {
  private tokens: string[] = [];
  private tokenCount = 0;
  /**
   * Numerator and denominator of the repeat share must live on the same
   * retention scope. A lifetime repeat count over a rolling window count
   * inflates the share as old windows age out, and can exceed 1 outright —
   * which would abort a still-pre-output attempt on arithmetic alone.
   */
  private windows: ReasoningWindow[] = [];
  private repeatedWindowCount = 0;
  private reflectionTransitions = 0;
  private maxSimilarity = 0;
  private exactCounts = new Map<string, number>();
  private exactRepeat = 0;
  private normTail = '';
  private cursor = 0;
  private tokenCarry = '';
  private markerCarry = '';

  update(delta: string): void {
    if (!delta) return;
    const markerMax = REFLECTION_MARKERS.reduce((max, marker) => Math.max(max, marker.length), 1);
    const markerWindow = this.markerCarry + delta;
    this.reflectionTransitions += countNewMarkers(markerWindow, this.markerCarry.length);
    this.markerCarry = markerWindow.slice(-(markerMax - 1));

    const { tokens: added, carry } = splitCompleteTokens(this.tokenCarry + delta);
    this.tokenCarry = carry;
    this.tokens.push(...added);
    this.tokenCount += added.length;

    this.normTail += delta.toLowerCase().replace(/\s+/g, ' ');
    // Slide one character at a time so identical 128-char blocks still match
    // when a leftover shifts the non-overlapping cut, or when the same text
    // arrives as many tiny deltas. Refresh hashes on access and retain only the
    // most recent bounded set; losing an old count is safer than unbounded state.
    while (this.normTail.length >= RL_EXACT_BLOCK_CHARS) {
      const block = this.normTail.slice(0, RL_EXACT_BLOCK_CHARS);
      this.normTail = this.normTail.slice(1);
      const hashed = fingerprint([block]);
      const next = (this.exactCounts.get(hashed) ?? 0) + 1;
      this.exactCounts.delete(hashed);
      this.exactCounts.set(hashed, next);
      while (this.exactCounts.size > MAX_EXACT_HASHES) {
        const oldest = this.exactCounts.keys().next().value;
        if (oldest == null) break;
        this.exactCounts.delete(oldest);
      }
      if (next > this.exactRepeat) this.exactRepeat = next;
    }

    while (this.tokens.length - this.cursor >= RL_WINDOW) {
      const windowTokens = this.tokens.slice(this.cursor, this.cursor + RL_WINDOW);
      const set = shingles(windowTokens);
      let repeated = false;
      for (let i = 0; i < this.windows.length - 1; i += 1) {
        const similarity = jaccard(set, this.windows[i]!.shingles);
        if (similarity > this.maxSimilarity) this.maxSimilarity = similarity;
        if (similarity >= RL_NEAR_DUPLICATE) {
          repeated = true;
          break;
        }
      }
      this.windows.push({ shingles: set, repeated });
      if (repeated) this.repeatedWindowCount += 1;
      if (this.windows.length > MAX_WINDOWS) {
        const evicted = this.windows.shift();
        if (evicted?.repeated) this.repeatedWindowCount -= 1;
      }
      this.cursor += RL_STRIDE;
    }
    if (this.tokens.length > RL_WINDOW + RL_STRIDE * 2) {
      const drop = this.tokens.length - (RL_WINDOW + RL_STRIDE);
      this.tokens.splice(0, drop);
      this.cursor = Math.max(0, this.cursor - drop);
    }
  }

  severity(): StruggleSeverity {
    // An in-progress token still counts toward volume: streaming splits leave
    // the last alphanumeric run in `tokenCarry`, and excluding it would miss
    // the floor by one after a delimiter-free filler.
    const countedTokens = this.tokenCount + (this.tokenCarry ? 1 : 0);
    if (this.exactRepeat >= RL_EXACT_BLOCK_REPEAT && countedTokens >= RL_MIN_TOKENS) {
      return 'severe';
    }
    if (countedTokens < RL_MIN_TOKENS || this.windows.length === 0) return 'none';
    const share = this.repeatedWindowCount / this.windows.length;
    if (share >= RL_SEVERE_SHARE && this.reflectionTransitions >= RL_SEVERE_RESETS) return 'severe';
    if (share >= RL_WARNING_SHARE && this.reflectionTransitions >= RL_WARNING_RESETS) return 'warning';
    return 'none';
  }

  snapshot(): ReasoningLoopSnapshot {
    return {
      tokenCount: this.tokenCount,
      windowCount: this.windows.length,
      repeatedWindowCount: this.repeatedWindowCount,
      reflectionTransitions: this.reflectionTransitions,
      maxSimilarity: this.maxSimilarity,
      severity: this.severity(),
    };
  }

  reset(): void {
    this.tokens = [];
    this.tokenCount = 0;
    this.windows = [];
    this.repeatedWindowCount = 0;
    this.reflectionTransitions = 0;
    this.maxSimilarity = 0;
    this.exactCounts.clear();
    this.exactRepeat = 0;
    this.normTail = '';
    this.cursor = 0;
    this.tokenCarry = '';
    this.markerCarry = '';
  }
}
