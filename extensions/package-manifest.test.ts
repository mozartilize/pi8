import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as {
  pi?: { extensions?: string[] };
};

describe('package extension entry', () => {
  it('exposes the extension from the package root entry point', () => {
    const entry = packageJson.pi?.extensions?.[0];

    expect(resolve(repoRoot, entry ?? '')).toBe(resolve(repoRoot, 'index.ts'));
  });
});
