import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import type { AttemptUsageEvent } from '../types.js';
import {
  PROMPT_SCALE_ALPHA,
  PROMPT_TOKEN_SCALES_FILE,
  loadPromptTokenScales,
  promptTokenScaleMap,
  recordAttemptPromptTokens,
  recordPromptTokens,
} from './prompt-token-scale.js';

let temp: ReturnType<typeof createTempRouterDir>;
beforeEach(() => { temp = createTempRouterDir(); });
afterEach(() => temp.cleanup());

const observe = (registryId: string, estimatedTokens: number, billedTokens: number, api?: string) =>
  recordPromptTokens({ registryId, estimatedTokens, billedTokens, ...(api ? { api } : {}) });

describe('prompt-token calibration', () => {
  it('starts at the first ratio and moves by the average weight after it', () => {
    expect(observe('a/claude', 10_000, 18_000, 'anthropic-messages')).toBeCloseTo(1.8, 12);
    const next = observe('a/claude', 10_000, 12_000, 'anthropic-messages');
    expect(next).toBeCloseTo(1.8 + PROMPT_SCALE_ALPHA * (1.2 - 1.8), 12);
    expect(loadPromptTokenScales().get('a/claude')?.scale).toBeCloseTo(next!, 12);
  });

  it('ignores a small request and a ratio outside the plausible bounds', () => {
    expect(observe('a/claude', 1_999, 3_600)).toBeUndefined();
    expect(observe('a/claude', 10_000, 4_000)).toBeUndefined();
    expect(observe('a/claude', 10_000, 41_000)).toBeUndefined();
    expect(existsSync(join(temp.path, PROMPT_TOKEN_SCALES_FILE))).toBe(false);
  });

  it('persists the scale, so a new load reads it from the router directory', () => {
    observe('a/claude', 10_000, 18_000, 'anthropic-messages');
    const stored = JSON.parse(readFileSync(join(temp.path, PROMPT_TOKEN_SCALES_FILE), 'utf8'));
    expect(stored.models['a/claude']).toMatchObject({ scale: 1.8, api: 'anthropic-messages' });
  });

  it('does not write a change too small to change the cost', () => {
    observe('a/claude', 10_000, 18_000, 'anthropic-messages');
    const path = join(temp.path, PROMPT_TOKEN_SCALES_FILE);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"observedAt": ', '"observedAt": 1, "x": '), 'utf8');
    const before = readFileSync(path, 'utf8');
    expect(observe('a/claude', 10_000, 18_100, 'anthropic-messages')).toBeCloseTo(1.8, 12);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('gives an unobserved model the mean scale of its API and omits scale 1', () => {
    observe('a/claude', 10_000, 18_000, 'anthropic-messages');
    observe('b/claude', 10_000, 16_000, 'anthropic-messages');
    observe('o/gpt', 10_000, 12_000, 'openai-responses');
    const map = promptTokenScaleMap([
      { provider: 'a', id: 'claude', api: 'anthropic-messages' },
      { provider: 'c', id: 'claude', api: 'anthropic-messages' },
      { provider: 'o', id: 'gpt', api: 'openai-responses' },
      { provider: 'g', id: 'gemini', api: 'google-generative-ai' },
      { provider: 'x', id: 'plain' },
    ]);
    expect(map.get('a/claude')).toBeCloseTo(1.8, 12);
    expect(map.get('c/claude')).toBeCloseTo(1.7, 12);
    expect(map.get('o/gpt')).toBeCloseTo(1.2, 12);
    expect(map.has('g/gemini')).toBe(false);
    expect(map.has('x/plain')).toBe(false);
  });

  it('counts the whole prompt of a terminal usage report and skips a partial one', () => {
    const event = (usageComplete: boolean): AttemptUsageEvent => ({
      usageEventId: 'u', provider: 'a', modelId: 'claude', candidateKey: 'a/claude', served: true,
      usage: { input: 2_000, output: 500, cacheRead: 12_000, cacheWrite: 4_000 }, usageComplete,
    });
    recordAttemptPromptTokens(event(false), 10_000, 'anthropic-messages');
    expect(loadPromptTokenScales().size).toBe(0);
    recordAttemptPromptTokens(event(true), 10_000, 'anthropic-messages');
    expect(loadPromptTokenScales().get('a/claude')).toMatchObject({ scale: 1.8, api: 'anthropic-messages' });
  });
});
