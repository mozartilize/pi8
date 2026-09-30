/**
 * The embedding heads against held-out multilingual prompts, with the real
 * E5-small model. Runs only where the optional runtime and a provisioned
 * model are present (`npm i --no-save onnxruntime-node @xenova/transformers`
 * and `/router-sync embedding`, or PI8_DIR pointing at a store that has the
 * model); elsewhere it is skipped. It pins the bounds the heads' margins were
 * set to, so re-run it after changing an example, a description, or a margin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureEmbeddingEngine, readPrompt } from './embedding.js';
import { EMBEDDING_HEAD_VERSION } from './embedding-head.js';
import { DIMENSION_STRENGTH } from '../routing/classify/classifier-keywords.js';
import type { TaskKind } from '../types.js';

const calibration = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'embedding-calibration.json'), 'utf8'),
) as { headVersion: number; thin: { thin: string[]; substantive: string[] }; kind: Record<TaskKind, string[]> };

const available = await ensureEmbeddingEngine({ deadlineMs: 120_000 });

describe.skipIf(!available)('embedding heads on held-out prompts (real model)', () => {
  it('measures the version of the heads it was labelled for', () => {
    expect(calibration.headVersion).toBe(EMBEDDING_HEAD_VERSION);
  });

  it('reads no substantive prompt as thin, and at least 90% of thin prompts as thin', async () => {
    const falseThin: string[] = [];
    for (const prompt of calibration.thin.substantive) {
      if ((await readPrompt(prompt, { deadlineMs: 10_000 }))!.thin) falseThin.push(prompt);
    }
    let thin = 0;
    for (const prompt of calibration.thin.thin) {
      if ((await readPrompt(prompt, { deadlineMs: 10_000 }))!.thin) thin += 1;
    }
    expect(falseThin).toEqual([]);
    expect(thin / calibration.thin.thin.length).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  it('decides kinds that are mostly right and at most once above their label', async () => {
    let decided = 0;
    let right = 0;
    const raisedAbove: string[] = [];
    for (const [label, prompts] of Object.entries(calibration.kind) as Array<[TaskKind, string[]]>) {
      for (const prompt of prompts) {
        const reading = (await readPrompt(prompt, { deadlineMs: 10_000 }))!;
        if (!reading.kindDecided) continue;
        decided += 1;
        if (reading.kind === label) right += 1;
        if (DIMENSION_STRENGTH[reading.kind] > DIMENSION_STRENGTH[label]) raisedAbove.push(`${prompt} → ${reading.kind}`);
      }
    }
    expect(decided).toBeGreaterThan(0);
    expect(right / decided).toBeGreaterThanOrEqual(0.85);
    expect(raisedAbove.length).toBeLessThanOrEqual(1);
  }, 120_000);
});
