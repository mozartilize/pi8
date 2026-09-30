import { describe, it, expect } from 'vitest';
import { extractPromptAnchors, normalizeAnchorPath } from './anchors.js';

const values = (prompt: string, opts?: Parameters<typeof extractPromptAnchors>[1]) =>
  extractPromptAnchors(prompt, opts).map((a) => `${a.kind}:${a.value}`);

describe('extractPromptAnchors', () => {
  it('reads @-mentions, backtick paths, and plain paths', () => {
    expect(extractPromptAnchors('@requirements/foo.md implement this')).toEqual([
      { kind: 'path', value: 'requirements/foo.md', mention: 'at' },
    ]);
    expect(values('see `src/auth.ts` and fix README.md, then docs/a/b')).toEqual([
      'path:src/auth.ts', 'path:README.md', 'path:docs/a/b',
    ]);
    expect(values('back to docs/auth.md: finish the token refresh part')).toEqual(['path:docs/auth.md']);
  });

  it('ignores slash words, URLs, versions, and abbreviations', () => {
    expect(values('rework topic/session routing and/or TCP/IP, e.g. v2.3 at https://x.dev/a/b.md')).toEqual([]);
  });

  it('strips decoration and line suffixes', () => {
    expect(values('check (src/a.ts:42), then "lib/b.py".')).toEqual(['path:src/a.ts', 'path:lib/b.py']);
  });

  it('reads issue ids without a path for the repository', () => {
    expect(values('fix #12, octo/repo#34 and PROJ-7')).toEqual(['issue:#12', 'issue:octo/repo#34', 'issue:PROJ-7']);
  });

  it('matches strings the ledger already knows only as whole words', () => {
    const known = [{ kind: 'symbol' as const, value: 'pickBest' }, { kind: 'other' as const, value: 'churn' }];
    expect(values('tune pickBest for churn signals', { known })).toEqual(['symbol:pickBest', 'other:churn']);
    expect(values('tune pickBestOf and churning', { known })).toEqual([]);
  });

  it('deduplicates by kind and value, keeping first appearance', () => {
    expect(values('@a/b.ts then `a/b.ts` then a/b.ts')).toEqual(['path:a/b.ts']);
  });
});

describe('normalizeAnchorPath', () => {
  it('makes paths relative to the working directory and drops ones outside it', () => {
    expect(normalizeAnchorPath('./src/x.ts', '/repo')).toBe('src/x.ts');
    expect(normalizeAnchorPath('/repo/src/x.ts', '/repo')).toBe('src/x.ts');
    expect(normalizeAnchorPath('@src/x.ts', '/repo')).toBe('src/x.ts');
    expect(normalizeAnchorPath('../other/x.ts', '/repo')).toBeUndefined();
    expect(normalizeAnchorPath('/etc/passwd', '/repo')).toBeUndefined();
    expect(normalizeAnchorPath('/repo', '/repo')).toBeUndefined();
  });

  it('normalizes lexically without a working directory', () => {
    expect(normalizeAnchorPath('src/../lib/x.ts')).toBe('lib/x.ts');
    expect(normalizeAnchorPath('/abs/x.ts')).toBeUndefined();
    expect(normalizeAnchorPath('~/x.ts')).toBeUndefined();
  });
});
