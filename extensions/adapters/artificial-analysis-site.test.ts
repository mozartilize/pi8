import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSiteModels, playwrightSetupText } from './artificial-analysis-site.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(join(__dirname, '../../fixtures/aa-site-sample.json'), 'utf8')) as unknown[];

describe('artificial-analysis models page', () => {
  it('reads the recorded payload, keeping only finite metrics', () => {
    const rows = parseSiteModels(recorded);
    expect(rows).toHaveLength(110);
    expect(rows.find((row) => row.slug === 'gpt-5-6-luna')).toMatchObject({
      slug: 'gpt-5-6-luna',
      name: 'GPT-5.6 Luna (max)',
      intelligenceIndexIsEstimated: false,
      omniscience: -10.283333333333333,
      briefcaseRubricPassRate: 0.3797979797979798,
      intelligenceIndexTimePerTask: 324.8913272822246,
      terminalBench40: 0.116161616161616,
    });
    const glm = rows.find((row) => row.slug === 'glm-4-5v');
    expect(glm?.briefcaseRubricPassRate).toBeUndefined();
    expect(glm?.intelligenceIndexIsEstimated).toBe(true);
  });

  it('fails closed when the payload is too small to be the models list', () => {
    expect(() => parseSiteModels(recorded.slice(0, 20))).toThrow(/changed shape/);
    expect(() => parseSiteModels({ models: recorded })).toThrow(/changed shape/);
  });

  it('fails closed and names the field when a read field disappears', () => {
    const renamed = recorded.map((row) => ({ ...(row as object), briefcaseRubricPassRate: undefined }));
    expect(() => parseSiteModels(renamed)).toThrow(/no values for briefcaseRubricPassRate/);
  });

  it('fails closed when Terminal-Bench 4.0 disappears or leaves the [0, 1] scale', () => {
    expect(() => parseSiteModels(recorded.map((row) => ({ ...(row as object), terminalBench40: undefined })))).toThrow(/no values for terminalBench40/);
    expect(() => parseSiteModels(recorded.map((row) => ({ ...(row as object), terminalBench40: 55 })))).toThrow(/terminalBench40 must be in \[0, 1\]/);
  });

  it('gives an install command for the browser', () => {
    expect(playwrightSetupText()).toMatch(/install --no-shell chromium/);
    expect(playwrightSetupText()).toMatch(/\/router-sync/);
  });
});
