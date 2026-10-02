/** Counts-only routing history. Append-only writes let independent Pi sessions coexist. */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { identityKey } from './matcher.js';
import { resolveStoragePath } from './store.js';

const REMINDER_RULE_VERSION = 1;
const DAY = 86_400_000;
const RETENTION_MS = 90 * DAY;
const HALF_LIFE_MS = 30 * DAY;

export interface ReputationWeights {
  reminder: number;
  ignored: number;
}
export interface ModelEvent {
  kind: 'served' | 'reminder' | 'followed' | 'ignored';
  model: string;
  /** An opaque hash of a session and entry identity; never request text. */
  entry: string;
  session?: string;
  reminder?: string;
  /** Only successful serves carry prompt-head hashes and counts. */
  prefix?: string;
  prefixTokens?: number;
}
interface StoredEvent extends ModelEvent { at: number; version: number }
export interface ModelStats {
  entries: number;
  remindedEntries: number;
  reminders: number;
  followed: number;
  ignored: number;
}
export interface ModelHistory {
  collectedSince?: number;
  stats: ReadonlyMap<string, ModelStats>;
  /** Provider and effort remain part of cache identity, unlike compliance identity. */
  recentPrefixes: ReadonlyMap<string, { at: number; prefix: string; tokens: number; session?: string; entry: string }>;
}

export function modelEntryId(session: string, entry: string): string {
  return createHash('sha256').update(session).update('\0').update(entry).digest('hex');
}
export function reputationKey(model: string): string {
  // Effort is a call option, not different model weights.
  return identityKey(model.replace(/:(minimal|low|medium|high|xhigh|max|off)$/, ''));
}

/** Log failures must never block a turn, tool call or notification. */
export function appendModelEvent(event: ModelEvent, storageBase?: string): void {
  if (!event.model || event.model === 'unknown/unknown') return;
  try {
    const path = join(resolveStoragePath(storageBase), 'model-events.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    // A small, complete JSON line is one append, not a read-modify-write.
    appendFileSync(path, `${JSON.stringify({ ...event, at: Date.now(), version: REMINDER_RULE_VERSION })}\n`, 'utf8');
  } catch { /* Telemetry is best-effort. */ }
}

/** Old rule versions and unfinished reminder episodes do not become penalties. */
export function loadModelHistory(storageBase?: string, now = Date.now()): ModelHistory {
  const stats = new Map<string, ModelStats>();
  const recentPrefixes = new Map<string, { at: number; prefix: string; tokens: number; session?: string; entry: string }>();
  const events: StoredEvent[] = [];
  try {
    const text = readFileSync(join(resolveStoragePath(storageBase), 'model-events.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      try {
        const event: StoredEvent = JSON.parse(line);
        if (event.version !== REMINDER_RULE_VERSION || !Number.isFinite(event.at)
          || event.at > now || now - event.at > RETENTION_MS || typeof event.model !== 'string'
          || typeof event.entry !== 'string' || !/^[a-f0-9]{64}$/.test(event.entry)
          || !['served', 'reminder', 'followed', 'ignored'].includes(event.kind)) continue;
        events.push(event);
      } catch { /* A damaged or partial append does not erase valid records. */ }
    }
  } catch { return { stats, recentPrefixes }; }
  events.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const reminders = new Map<string, { model: string; resolved: boolean }>();
  const remindedEntries = new Set<string>();
  let collectedSince: number | undefined;
  for (const event of events) {
    const model = reputationKey(event.model);
    if (!model || event.model === 'unknown/unknown') continue;
    collectedSince ??= event.at;
    const weight = 2 ** (-(now - event.at) / HALF_LIFE_MS);
    const stat = stats.get(model) ?? { entries: 0, remindedEntries: 0, reminders: 0, followed: 0, ignored: 0 };
    stats.set(model, stat);
    const entryKey = `${model}\0${event.entry}`;
    const episode = `${event.entry}\0${event.reminder ?? ''}`;
    if (event.kind === 'served') {
      if (!seen.has(entryKey)) { stat.entries += weight; seen.add(entryKey); }
      if (typeof event.prefix === 'string' && /^[a-f0-9]{64}$/.test(event.prefix)
        && Number.isFinite(event.prefixTokens) && event.prefixTokens! > 0) {
        recentPrefixes.set(event.model, { at: event.at, prefix: event.prefix, tokens: event.prefixTokens!, entry: event.entry, session: event.session });
      }
    } else if (event.kind === 'reminder') {
      if (reminders.has(episode)) continue;
      reminders.set(episode, { model, resolved: false });
      stat.reminders += weight;
      if (!remindedEntries.has(entryKey)) { stat.remindedEntries += weight; remindedEntries.add(entryKey); }
    } else {
      const reminder = reminders.get(episode);
      // Another model taking over is not proof the original model ignored a reminder.
      if (!reminder || reminder.resolved || reminder.model !== model) continue;
      reminder.resolved = true;
      stat[event.kind] += weight;
    }
  }
  return { stats, recentPrefixes, collectedSince };
}

/** Collection spans two weeks before it affects global routing preferences. */
export function modelHistoryReady(history: ModelHistory, now = Date.now()): boolean {
  return history.collectedSince != null && now - history.collectedSince >= 14 * DAY;
}

function wilsonLower(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  const p = Math.min(1, successes / trials), z2 = 1.96 ** 2;
  return Math.max(0, (p + z2 / (2 * trials) - Math.sqrt(z2 * (p * (1 - p) / trials + z2 / (4 * trials ** 2)))) / (1 + z2 / trials));
}

/** Unset weights mean collection only; fit weights from collected outcomes before enabling. */
export function compliancePenalties(history: ModelHistory, weights: ReputationWeights | undefined, cap: number): Map<string, number> {
  const penalties = new Map<string, number>();
  if (!weights || !modelHistoryReady(history)) return penalties;
  for (const [model, stats] of history.stats) {
    const completed = stats.followed + stats.ignored;
    const reminder = stats.entries >= 30 ? wilsonLower(stats.remindedEntries, stats.entries) * weights.reminder : 0;
    const ignored = completed >= 10 ? wilsonLower(stats.ignored, completed) * weights.ignored : 0;
    penalties.set(model, Math.min(Math.max(0, cap), reminder + ignored));
  }
  return penalties;
}

/** Cross-session cache credit requires an identical prompt head, never just model popularity. */
export function sharedPrefixCredits(history: ModelHistory, prefix: string, tokens: number, ownSession: string, now = Date.now()): Map<string, number> {
  const credits = new Map<string, number>();
  if (!modelHistoryReady(history, now)) return credits;
  for (const [key, last] of history.recentPrefixes) {
    const gap = now - last.at;
    if (last.prefix !== prefix || typeof last.session !== 'string' || !last.session
      || last.session === ownSession || gap < 0 || gap > 3_600_000) continue;
    // Conservative incremental hit chances above the observed background rate.
    const probability = gap <= 300_000 ? 0.40 : 0.30;
    credits.set(key, Math.min(Math.max(0, tokens), last.tokens) * probability);
  }
  return credits;
}
