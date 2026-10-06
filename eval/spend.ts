/**
 * Attempt-level usage and its price. The harness reads one record for each
 * provider attempt, so a failed attempt, a retry, and a fallback keep their
 * own model. Historical cost prices each attempt with the price that was
 * current for that attempt. Normalized cost prices each attempt with one
 * frozen table, so two runs compare on the same prices.
 *
 * Usage that is missing is never zero. A report that needs an exact cost must
 * check `complete`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { PriceView, RawExecutionUsage, UsageAttemptV1 } from './schema.ts';

interface AttemptUsageRecord {
  usageEventId: string;
  provider: string;
  modelId: string;
  candidateKey: string;
  servedEffort?: string;
  served: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  usageComplete: boolean;
  providerReportedUsd?: number;
  price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface LogRecord {
  kind?: string;
  ts?: number;
  attemptUsage?: AttemptUsageRecord;
  chosen?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number };
  subagentSpend?: { role?: string; reportedCost?: number };
}

const REGISTRY_SOURCE = 'registry';

function readLines(path: string): LogRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as LogRecord];
    } catch {
      return [];
    }
  });
}

/** Split `provider/model:effort` into the model key and the effort. */
function splitCandidateKey(candidateKey: string): { model: string; effort?: string } {
  const colon = candidateKey.lastIndexOf(':');
  return colon > candidateKey.indexOf('/') ? { model: candidateKey.slice(0, colon), effort: candidateKey.slice(colon + 1) } : { model: candidateKey };
}

/**
 * Attempts from a router decision log. An `attempt-usage` record is a main-agent
 * attempt. A `subagent-spend` record is a foreground subagent. A failed attempt
 * is a retry when the next attempt uses the same candidate. It is a fallback
 * when the next attempt uses another candidate. The last failed attempt, with
 * no attempt after it, is a provider failure.
 */
export function attemptsFromDecisionLog(path: string): UsageAttemptV1[] {
  const records = readLines(path);
  const attempts: UsageAttemptV1[] = [];
  const mainRecords = records.filter((record) => record.kind === 'attempt-usage' && record.attemptUsage);
  mainRecords.forEach((record, index) => {
    const usage = record.attemptUsage as AttemptUsageRecord;
    const next = mainRecords[index + 1]?.attemptUsage;
    const outcome: UsageAttemptV1['outcome'] = usage.served ? 'served'
      : !next ? 'provider-failure'
      : next.candidateKey === usage.candidateKey ? 'retry' : 'fallback';
    const { model, effort } = splitCandidateKey(usage.candidateKey);
    attempts.push({
      usageEventId: usage.usageEventId,
      attemptId: usage.usageEventId,
      sequence: 0,
      source: 'main-agent',
      provider: usage.provider,
      modelId: usage.modelId,
      candidateKey: usage.candidateKey || model,
      ...((usage.servedEffort ?? effort) ? { servedEffort: usage.servedEffort ?? effort } : {}),
      outcome,
      ...(usage.usage ? {
        inputTokens: usage.usage.input,
        outputTokens: usage.usage.output,
        cacheReadTokens: usage.usage.cacheRead,
        cacheWriteTokens: usage.usage.cacheWrite,
      } : {}),
      usageComplete: usage.usageComplete,
      ...(usage.providerReportedUsd !== undefined ? { providerReportedUsd: usage.providerReportedUsd } : {}),
      ...(usage.price ? {
        executionPriceSnapshot: {
          source: REGISTRY_SOURCE,
          ...(usage.price.input !== undefined ? { inputPer1M: usage.price.input } : {}),
          ...(usage.price.output !== undefined ? { outputPer1M: usage.price.output } : {}),
          ...(usage.price.cacheRead !== undefined ? { cacheReadPer1M: usage.price.cacheRead } : {}),
          ...(usage.price.cacheWrite !== undefined ? { cacheWritePer1M: usage.price.cacheWrite } : {}),
        },
      } : {}),
    });
  });
  for (const record of records) {
    if (record.kind !== 'subagent-spend' || !record.chosen) continue;
    const [provider = '', ...rest] = record.chosen.split('/');
    const modelId = rest.join('/');
    const id = `subagent-${createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16)}`;
    attempts.push({
      usageEventId: id,
      attemptId: id,
      sequence: 0,
      source: 'subagent',
      provider,
      modelId,
      candidateKey: record.chosen,
      outcome: 'served',
      ...(record.usage ? {
        inputTokens: record.usage.inputTokens ?? 0,
        outputTokens: record.usage.outputTokens ?? 0,
        cacheReadTokens: record.usage.cacheRead ?? 0,
        cacheWriteTokens: record.usage.cacheWrite ?? 0,
      } : {}),
      usageComplete: record.usage !== undefined,
      ...(record.subagentSpend?.reportedCost !== undefined ? { providerReportedUsd: record.subagentSpend.reportedCost } : {}),
    });
  }
  return attempts;
}

/** The price of a model at the time of a run, in USD per 1M tokens. The registry gives it. */
export type PriceSnapshotSource = (provider: string, modelId: string) => Omit<NonNullable<UsageAttemptV1['executionPriceSnapshot']>, 'source'> | undefined;

/**
 * Attempts from a Pi session file. A run without the router has no decision
 * log, so each assistant message is one served attempt. The session has no
 * price, so the caller gives the registry price of each model.
 */
export function attemptsFromSession(path: string, priceOf?: PriceSnapshotSource): UsageAttemptV1[] {
  const attempts: UsageAttemptV1[] = [];
  for (const line of existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []) {
    let entry: { type?: string; id?: string; message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const message = entry.message;
    if (entry.type !== 'message' || message?.role !== 'assistant') continue;
    const usage = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
    const provider = String(message.provider ?? '');
    const modelId = String(message.model ?? '');
    const id = `session-${entry.id ?? createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
    attempts.push({
      usageEventId: id,
      attemptId: id,
      sequence: 0,
      source: 'main-agent',
      provider,
      modelId,
      candidateKey: `${provider}/${modelId}`,
      outcome: message.stopReason === 'error' ? 'provider-failure' : 'served',
      ...(usage?.input !== undefined ? { inputTokens: usage.input } : {}),
      ...(usage?.output !== undefined ? { outputTokens: usage.output } : {}),
      ...(usage?.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(usage?.cacheWrite !== undefined ? { cacheWriteTokens: usage.cacheWrite } : {}),
      usageComplete: usage?.input !== undefined && usage?.output !== undefined,
      ...(usage?.cost?.total !== undefined ? { providerReportedUsd: usage.cost.total } : {}),
      ...(priceOf?.(provider, modelId) ? { executionPriceSnapshot: { source: REGISTRY_SOURCE, ...priceOf(provider, modelId) } } : {}),
    });
  }
  return attempts;
}

/**
 * Keep one attempt for each `usageEventId`. Two attempts of the same model in
 * the same turn stay apart, because their ids differ.
 */
export function dedupeAttempts(attempts: readonly UsageAttemptV1[]): UsageAttemptV1[] {
  const seen = new Set<string>();
  const kept: UsageAttemptV1[] = [];
  for (const attempt of attempts) {
    if (seen.has(attempt.usageEventId)) continue;
    seen.add(attempt.usageEventId);
    kept.push({ ...attempt, sequence: kept.length });
  }
  return kept;
}

export function rawUsage(attempts: readonly UsageAttemptV1[]): RawExecutionUsage {
  const kept = dedupeAttempts(attempts);
  return { attempts: kept, spendIncomplete: kept.length === 0 || kept.some((attempt) => !attempt.usageComplete) };
}

/** Raw usage of a run: the decision log when it has attempt records, else the session. */
export function readRawUsage(paths: { decisionLogPath?: string; sessionPath?: string; priceOf?: PriceSnapshotSource }): RawExecutionUsage {
  const fromLog = paths.decisionLogPath ? attemptsFromDecisionLog(paths.decisionLogPath) : [];
  if (fromLog.some((attempt) => attempt.source === 'main-agent')) return rawUsage(fromLog);
  const fromSession = paths.sessionPath ? attemptsFromSession(paths.sessionPath, paths.priceOf) : [];
  return rawUsage([...fromSession, ...fromLog.filter((attempt) => attempt.source === 'subagent')]);
}

// ── Price ────────────────────────────────────────────────────────────────

type Price = NonNullable<UsageAttemptV1['executionPriceSnapshot']>;

/** One frozen table of prices in USD per 1M tokens, keyed by `provider/model` without the effort. */
export interface PriceTable {
  digest: string;
  prices: Record<string, Omit<Price, 'source'>>;
}

function costOf(attempt: UsageAttemptV1, price: Omit<Price, 'source'> | undefined): number | undefined {
  if (!price || !attempt.usageComplete) return undefined;
  const input = attempt.inputTokens ?? 0;
  const output = attempt.outputTokens ?? 0;
  const cacheRead = attempt.cacheReadTokens ?? 0;
  const cacheWrite = attempt.cacheWriteTokens ?? 0;
  if (price.inputPer1M === undefined && input > 0) return undefined;
  if (price.outputPer1M === undefined && output > 0) return undefined;
  return (
    (price.inputPer1M ?? 0) * input +
    (price.outputPer1M ?? 0) * output +
    (price.cacheReadPer1M ?? price.inputPer1M ?? 0) * cacheRead +
    (price.cacheWritePer1M ?? price.inputPer1M ?? 0) * cacheWrite
  ) / 1_000_000;
}

function sumView(registryPriceDigest: string, attempts: readonly UsageAttemptV1[], pick: (attempt: UsageAttemptV1) => Omit<Price, 'source'> | undefined): PriceView {
  let total = 0;
  let priced = 0;
  for (const attempt of attempts) {
    const cost = costOf(attempt, pick(attempt));
    if (cost === undefined) continue;
    total += cost;
    priced += 1;
  }
  // When an attempt has no usage or no price, the sum is a lower bound and the view is not complete.
  return {
    registryPriceDigest,
    ...(priced > 0 ? { computedUsd: total } : {}),
    complete: attempts.length > 0 && priced === attempts.length,
  };
}

/** Each attempt at the price that the attempt itself recorded. */
export function historicalCost(attempts: readonly UsageAttemptV1[]): PriceView {
  const digest = createHash('sha256').update(JSON.stringify(attempts.map((attempt) => attempt.executionPriceSnapshot ?? null))).digest('hex');
  return sumView(digest, attempts, (attempt) => attempt.executionPriceSnapshot);
}

/** Each attempt at the price of one frozen table. */
export function normalizedCost(attempts: readonly UsageAttemptV1[], table: PriceTable): PriceView {
  return sumView(table.digest, attempts, (attempt) => table.prices[`${attempt.provider}/${attempt.modelId}`]);
}

export interface CacheFacts {
  /** Main-agent attempts that served on a different model than the attempt before. */
  modelSwitches: number;
  /** Cached prompt tokens over all prompt tokens. Undefined when an attempt has no token counts. */
  cacheReadShare?: number;
}

/**
 * Model switches and cache reuse of one execution, from its attempt usage. A switch loses the prompt
 * cache of the model before it, so the two values show the cost of a policy that switches often.
 * A change of effort on the same model is not a switch here.
 */
export function cacheFacts(usage: RawExecutionUsage): CacheFacts {
  const main = usage.attempts
    .filter((attempt) => attempt.source === 'main-agent' && attempt.outcome === 'served')
    .sort((a, b) => a.sequence - b.sequence);
  let modelSwitches = 0;
  for (let index = 1; index < main.length; index += 1) {
    const before = main[index - 1]!;
    const after = main[index]!;
    if (before.provider !== after.provider || before.modelId !== after.modelId) modelSwitches += 1;
  }
  let cached = 0;
  let total = 0;
  for (const attempt of usage.attempts) {
    if (attempt.inputTokens === undefined) return { modelSwitches };
    const read = attempt.cacheReadTokens ?? 0;
    cached += read;
    total += attempt.inputTokens + read + (attempt.cacheWriteTokens ?? 0);
  }
  return { modelSwitches, ...(total > 0 ? { cacheReadShare: cached / total } : {}) };
}
