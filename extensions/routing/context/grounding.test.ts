import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROUNDING_MAX_BYTES,
  ReadCoverage,
  fingerprintFile,
  contentLineCount,
  isFresh,
  matchedLineRanges,
  readLineRange,
  referencedArtifactsFresh,
  unmetArtifactPaths,
} from './grounding.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('grounding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi8-grounding-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fingerprints a regular file by SHA-256 of its bytes', async () => {
    writeFileSync(join(dir, 'a.md'), 'hello\n');
    expect(await fingerprintFile(join(dir, 'a.md'))).toEqual({ sha256: sha('hello\n'), text: 'hello\n' });
  });

  it('never fingerprints a file above the size cap, a directory, or a missing path', async () => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(GROUNDING_MAX_BYTES + 1));
    mkdirSync(join(dir, 'sub'));
    expect(await fingerprintFile(join(dir, 'big.md'))).toBeUndefined();
    expect(await fingerprintFile(join(dir, 'sub'))).toBeUndefined();
    expect(await fingerprintFile(join(dir, 'missing.md'))).toBeUndefined();
    // A regular file in place of a directory fails at once (ENOTDIR).
    writeFileSync(join(dir, 'blocker.txt'), '');
    expect(await fingerprintFile(join(dir, 'blocker.txt', 'x.md'))).toBeUndefined();
  });

  it('detects a changed or missing file', async () => {
    writeFileSync(join(dir, 'req.md'), 'v1');
    const artifact = { anchorValue: 'req.md', sha256: sha('v1'), observedAtEntryId: 'u', observedBy: 'read' as const };
    expect(await isFresh(dir, artifact)).toBe(true);
    writeFileSync(join(dir, 'req.md'), 'v2');
    expect(await isFresh(dir, artifact)).toBe(false);
    rmSync(join(dir, 'req.md'));
    expect(await isFresh(dir, artifact)).toBe(false);
  });

  it('owes no read for a referenced path that does not exist', async () => {
    writeFileSync(join(dir, 'req.md'), 'v1');
    const item = { grounding: [], openContext: [] };
    // A request names a file that it asks to create; no read can meet it.
    expect(await unmetArtifactPaths(dir, item, ['src/new.ts', 'req.md'])).toEqual(['req.md']);
    expect(await unmetArtifactPaths(dir, item, ['req.md/child'])).toEqual([]);
    // A file read and then deleted owes no read either.
    const read = { grounding: [{ anchorValue: 'req.md', sha256: sha('v1'), observedAtEntryId: 'u', observedBy: 'read' as const }], openContext: [] };
    rmSync(join(dir, 'req.md'));
    expect(await unmetArtifactPaths(dir, read, ['req.md'])).toEqual([]);
    // A missing path proves no context in hand.
    expect(await referencedArtifactsFresh(dir, item, ['src/new.ts'])).toBe(false);
  });

  it('requires an accepted context handoff for a directory without treating it as a grounded file', async () => {
    mkdirSync(join(dir, 'src'));
    expect(await referencedArtifactsFresh(dir, { grounding: [] }, ['src'])).toBe(false);
    expect(await referencedArtifactsFresh(dir, { grounding: [], openContext: ['referenced-artifact'] }, ['src'])).toBe(false);
    expect(await referencedArtifactsFresh(dir, { grounding: [], openContext: [] }, ['src'])).toBe(true);
  });

  it('never lets a directory investigation substitute for fresh file evidence', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'req.md'), 'v1');
    const item = {
      openContext: [],
      grounding: [{ anchorValue: 'req.md', sha256: sha('v1'), observedAtEntryId: 'u', observedBy: 'read' as const }],
    };
    expect(await referencedArtifactsFresh(dir, item, ['src', 'req.md'])).toBe(true);
    expect(await referencedArtifactsFresh(dir, { ...item, openContext: ['referenced-artifact'] }, ['src', 'req.md'])).toBe(false);
    expect(await referencedArtifactsFresh(dir, { ...item, grounding: [] }, ['src', 'req.md'])).toBe(false);
    writeFileSync(join(dir, 'req.md'), 'v2');
    expect(await referencedArtifactsFresh(dir, item, ['src', 'req.md'])).toBe(false);
    expect(await referencedArtifactsFresh(dir, item, ['missing'])).toBe(false);
    rmSync(join(dir, 'req.md'));
    mkdirSync(join(dir, 'req.md'));
    expect(await referencedArtifactsFresh(dir, item, ['req.md'])).toBe(false);
    // No read can meet a file above the size cap, so it owes none.
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(GROUNDING_MAX_BYTES + 1));
    expect(await referencedArtifactsFresh(dir, item, ['big.md'])).toBe(true);
    // A path that becomes a file owes its exact content even after a directory investigation.
    rmSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src'), 'file');
    expect(await referencedArtifactsFresh(dir, item, ['src'])).toBe(false);
  });

  it('owes a referenced artifact until every referenced path is grounded and fresh', async () => {
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'b.md'), 'b');
    const item = { grounding: [{ anchorValue: 'a.md', sha256: sha('a'), observedAtEntryId: 'u', observedBy: 'read' as const }] };
    expect(await referencedArtifactsFresh(dir, item, ['a.md'])).toBe(true);
    expect(await referencedArtifactsFresh(dir, item, ['a.md', 'b.md'])).toBe(false);
    expect(await referencedArtifactsFresh(dir, item, [])).toBe(false);
  });
});

describe('readLineRange', () => {
  const file = 'one\ntwo\nthree';
  it('reads the lines a whole-file read returned', () => {
    expect(readLineRange({}, undefined, file, file)).toEqual({ start: 0, end: 3 });
    expect(readLineRange({ offset: 1, limit: 3 }, undefined, file, file)).toEqual({ start: 0, end: 3 });
  });

  it('reads a chunk from its offset, without Pi\'s continuation notice', () => {
    expect(readLineRange({ offset: 2 }, undefined, 'two\nthree', file)).toEqual({ start: 1, end: 3 });
    expect(readLineRange({ limit: 2 }, undefined, 'one\ntwo\n\n[1 more lines in file. Use offset=3 to continue.]', file))
      .toEqual({ start: 0, end: 2 });
    expect(readLineRange({}, { truncation: { truncated: true } }, 'one\ntwo\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]', file))
      .toEqual({ start: 0, end: 2 });
    expect(readLineRange({}, { truncation: { truncated: true } }, 'one\n\n[Showing lines 1-1 of 3 (50.0KB limit). Use offset=2 to continue.]', file))
      .toEqual({ start: 0, end: 1 });
  });

  it('rejects text that is not those lines of the file now, or a line too long to return', () => {
    expect(readLineRange({}, undefined, 'one\ntwo!', file)).toBeUndefined();
    expect(readLineRange({ offset: 2 }, undefined, 'one\ntwo', file)).toBeUndefined();
    expect(readLineRange({ offset: 9 }, undefined, '', file)).toBeUndefined();
    expect(readLineRange({}, { truncation: { firstLineExceedsLimit: true } }, '', file)).toBeUndefined();
    expect(readLineRange({}, undefined, undefined, file)).toBeUndefined();
  });
});

describe('matchedLineRanges', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`);
  const file = `${lines.join('\n')}\n`;

  it('counts content lines, not the empty string after a final newline', () => {
    expect(contentLineCount(file)).toBe(12);
    expect(contentLineCount('a\nb')).toBe(2);
    expect(contentLineCount('')).toBe(0);
  });

  it('places a whole file wherever it sits in the result, around any header or footer', () => {
    expect(matchedLineRanges(`# /abs/f.ts (13 lines, ~40 tokens) [full]\n\n${file}`, file)).toEqual([{ start: 0, end: 12 }]);
  });

  it('covers only the lines a cut-short result reproduces', () => {
    const cut = `# /abs/f.ts (13 lines) [full]\n\n${lines.slice(0, 7).join('\n')}\n\n... truncated (80 tokens omitted, budget: 200)`;
    expect(matchedLineRanges(cut, file)).toEqual([{ start: 0, end: 7 }]);
  });

  it('reads lines behind a line-number gutter, in several sections', () => {
    const gutter = (from: number, to: number) =>
      lines.slice(from, to).map((line, i) => `${String(from + i + 1).padStart(3)}  ${line}`).join('\n');
    const result = `# /abs/f.ts [section]\n\n─── lines 2-5 ───\n${gutter(1, 5)}\n\n─── lines 9-12 ───\n${gutter(8, 12)}`;
    expect(matchedLineRanges(result, file)).toEqual([{ start: 1, end: 5 }, { start: 8, end: 12 }]);
    expect(matchedLineRanges(lines.slice(3, 6).map((l, i) => `${i + 4}\t${l}`).join('\n'), file)).toEqual([{ start: 3, end: 6 }]);
  });

  it('matches nothing in a summary, an outline, or fewer lines than a run needs', () => {
    expect(matchedLineRanges('12 constants, v0 through v11', file)).toEqual([]);
    expect(matchedLineRanges(`${lines[4]}\n${lines[5]}`, file)).toEqual([]);
    expect(matchedLineRanges(`${lines[4]}\nsomething else\n${lines[6]}`, file)).toEqual([]);
  });

  it('accepts a short file only when the run is the whole file', () => {
    expect(matchedLineRanges('path=/abs/f.md\nCSV with a header row', 'CSV with a header row\n')).toEqual([{ start: 0, end: 1 }]);
    expect(matchedLineRanges('a\nb', 'a\nb\nc\n')).toEqual([]);
  });

  it('never places a run that sits in more than one place in the file', () => {
    const block = ['alpha();', 'beta();', 'gamma();', 'delta();'];
    const twice = `${[...block, 'mid();', ...block].join('\n')}\n`;
    expect(matchedLineRanges(block.join('\n'), twice)).toEqual([]);
    // Reaching into the unique line between the copies places the run.
    expect(matchedLineRanges([...block, 'mid();'].join('\n'), twice)).toEqual([{ start: 0, end: 5 }]);
  });

  it('does not count runs of blank lines', () => {
    const sparse = `a\n\n\n\n\nb\n`;
    expect(matchedLineRanges('\n\n\n', sparse)).toEqual([]);
  });
});

describe('ReadCoverage', () => {
  it('completes once the ranges read cover every line, in any order and with overlap', () => {
    const coverage = new ReadCoverage('x', 5);
    expect(coverage.add({ start: 3, end: 5 })).toBe(false);
    expect(coverage.add({ start: 0, end: 2 })).toBe(false);
    expect(coverage.add({ start: 1, end: 3 })).toBe(true);
  });
});
