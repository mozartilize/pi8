/**
 * Prompt-token calibration from observed usage.
 *
 * The router estimates prompt tokens from characters. Each provider bills
 * its own tokens: a different tokenizer, and request text that the provider
 * adds. The scale of a model is its billed prompt tokens divided by the
 * estimate of the same request, as an exponential moving average. Cost
 * features multiply the estimate by this scale, so a cold switch to a model
 * that bills more tokens costs what the provider bills.
 *
 * The scales are a property of the provider, not of one session, so they
 * persist in the router directory and a new process starts with them.
 */
import { join } from 'node:path';

import { resolveStoragePath } from '../bench/store.js';
import { readJsonCached, writeJsonAtomic } from '../json-file.js';
import type { AttemptUsageEvent } from '../types.js';

export const PROMPT_TOKEN_SCALES_FILE = 'prompt-token-scales.json';
/** A smaller request is mostly fixed overhead, so its ratio does not measure the tokenizer. */
export const PROMPT_SCALE_MIN_ESTIMATE = 2000;
/** A ratio outside these bounds is a usage report that does not cover the whole prompt. */
export const PROMPT_SCALE_MIN = 0.5;
export const PROMPT_SCALE_MAX = 4;
/** Weight of one new observation in the moving average. */
export const PROMPT_SCALE_ALPHA = 0.3;
/** A relative change smaller than this does not change the cost, so it is not written. */
const WRITE_CHANGE = 0.02;

interface ScaleRecord {
  scale: number;
  /** Pi registry API of the model; models with the same API share a fallback scale. */
  api?: string;
  observedAt: number;
}

interface ScaleFile {
  version: 1;
  models: Record<string, ScaleRecord>;
}

const scalesPath = (): string => join(resolveStoragePath(), PROMPT_TOKEN_SCALES_FILE);

const validScale = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= PROMPT_SCALE_MIN && value <= PROMPT_SCALE_MAX;

/** The stored scales by `provider/id`. A missing or damaged file has none. */
export function loadPromptTokenScales(): Map<string, ScaleRecord> {
  const scales = new Map<string, ScaleRecord>();
  const parsed = readJsonCached(scalesPath())?.parsed as Partial<ScaleFile> | undefined;
  if (parsed?.version !== 1 || typeof parsed.models !== 'object' || parsed.models === null) return scales;
  for (const [registryId, record] of Object.entries(parsed.models)) {
    if (!record || !validScale(record.scale)) continue;
    scales.set(registryId, {
      scale: record.scale,
      ...(typeof record.api === 'string' ? { api: record.api } : {}),
      observedAt: Number.isFinite(record.observedAt) ? record.observedAt : 0,
    });
  }
  return scales;
}

/**
 * Record one request: its estimated and billed prompt tokens. Returns the
 * new scale, or undefined when the request does not measure the scale.
 */
export function recordPromptTokens(observation: {
  registryId: string;
  api?: string;
  estimatedTokens: number;
  billedTokens: number;
}): number | undefined {
  const { registryId, api, estimatedTokens, billedTokens } = observation;
  if (!(estimatedTokens >= PROMPT_SCALE_MIN_ESTIMATE) || !Number.isFinite(billedTokens)) return undefined;
  const ratio = billedTokens / estimatedTokens;
  if (!validScale(ratio)) return undefined;
  const scales = loadPromptTokenScales();
  const previous = scales.get(registryId);
  const scale = previous ? previous.scale + PROMPT_SCALE_ALPHA * (ratio - previous.scale) : ratio;
  if (previous && Math.abs(scale - previous.scale) < WRITE_CHANGE * previous.scale && previous.api === api) {
    return previous.scale;
  }
  scales.set(registryId, { scale, ...(api ? { api } : {}), observedAt: Date.now() });
  try {
    writeJsonAtomic(scalesPath(), { version: 1, models: Object.fromEntries(scales) } satisfies ScaleFile);
  } catch {
    // Calibration is best-effort; an unwritable directory keeps the estimate.
  }
  return scale;
}

/**
 * Record the prompt tokens of one provider attempt. Only a terminal usage
 * report counts the whole prompt: the provider input plus cache reads and
 * cache writes.
 */
export function recordAttemptPromptTokens(event: AttemptUsageEvent, estimatedTokens: number, api: string | undefined): void {
  if (!event.usageComplete || !event.usage) return;
  const { input, cacheRead, cacheWrite } = event.usage;
  recordPromptTokens({
    registryId: `${event.provider}/${event.modelId}`,
    ...(api ? { api } : {}),
    estimatedTokens,
    billedTokens: input + cacheRead + cacheWrite,
  });
}

/**
 * The scale of each model that differs from 1. A model without its own
 * observation takes the mean scale of the observed models with the same API.
 */
export function promptTokenScaleMap(models: readonly { provider: string; id: string; api?: string }[]): Map<string, number> {
  const scales = loadPromptTokenScales();
  const result = new Map<string, number>();
  if (scales.size === 0) return result;
  const byApi = new Map<string, number[]>();
  for (const record of scales.values()) {
    if (record.api) byApi.set(record.api, [...(byApi.get(record.api) ?? []), record.scale]);
  }
  for (const model of models) {
    const registryId = `${model.provider}/${model.id}`;
    const shared = model.api ? byApi.get(model.api) : undefined;
    const scale = scales.get(registryId)?.scale
      ?? (shared ? shared.reduce((sum, value) => sum + value, 0) / shared.length : 1);
    if (scale !== 1) result.set(registryId, scale);
  }
  return result;
}
