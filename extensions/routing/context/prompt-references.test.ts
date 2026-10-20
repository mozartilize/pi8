import { describe, expect, it } from 'vitest';
import { referencedSourcePaths } from './prompt-references.js';

describe('explicit prompt source references', () => {
  it('normalizes explicit paths, line suffixes, and duplicates in first-reference order', () => {
    expect(referencedSourcePaths('read @./src/a.ts:12:3, then @spec.md. and @src/a.ts', '/repo'))
      .toEqual(['src/a.ts', 'spec.md']);
  });
  it('does not turn plain paths, issue IDs, symbols, or earlier context into obligations', () => {
    expect(referencedSourcePaths('src/a.ts `spec.md` #123 ABC-45 someSymbol @current.md', '/repo'))
      .toEqual(['current.md']);
    const issues = Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(' ');
    expect(referencedSourcePaths(`${issues} @current.md`, '/repo')).toEqual(['current.md']);
  });
  it('accepts an absolute reference inside the working directory and rejects outside paths or URLs', () => {
    expect(referencedSourcePaths('@/repo/src/a.ts @../other.md @/outside/file.ts @https://example.test/x', '/repo'))
      .toEqual(['src/a.ts']);
    expect(referencedSourcePaths('@/repo/src/a.ts @../outside @./src/a.ts')).toEqual(['src/a.ts']);
  });
  it('retains the bounded source-reference policy', () => {
    const prompt = Array.from({ length: 33 }, (_, i) => `@p${i}.ts`).join(' ');
    const paths = referencedSourcePaths(prompt);
    expect(paths).toHaveLength(32);
    expect(paths.at(-1)).toBe('p31.ts');
    expect(paths).not.toContain('p32.ts');
    expect(referencedSourcePaths(`${' '.repeat(20_000)}@later.ts`)).toEqual([]);
    expect(referencedSourcePaths(`@${'x'.repeat(513)}`)).toEqual([]);
  });
});
