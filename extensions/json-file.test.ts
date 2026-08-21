import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { readJsonCached, writeJsonAtomic } from './json-file.js';

describe('json-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'json-file-'));
  });

  it('atomically writes JSON and creates the parent directory', () => {
    const path = join(dir, 'nested', 'config.json');
    writeJsonAtomic(path, { enabled: true }, 0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ enabled: true });
    expect(readdirSync(dirname(path)).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('reports a missing file as undefined, a corrupt file as parsed undefined', () => {
    const path = join(dir, 'config.json');
    expect(readJsonCached(path)).toBeUndefined();
    writeFileSync(path, 'not json');
    expect(readJsonCached(path)).toEqual({ parsed: undefined });
  });

  it('invalidates the cache on write so an in-process writer never reads stale', () => {
    const path = join(dir, 'config.json');
    writeJsonAtomic(path, { v: 1 });
    expect(readJsonCached(path)?.parsed).toEqual({ v: 1 });
    // Same-path rewrite must be observed even if the filesystem clock did not
    // advance between writes: writeJsonAtomic drops the cached entry.
    writeJsonAtomic(path, { v: 2 });
    expect(readJsonCached(path)?.parsed).toEqual({ v: 2 });
  });

  it('re-reads after the file is deleted', () => {
    const path = join(dir, 'config.json');
    writeJsonAtomic(path, { v: 1 });
    expect(readJsonCached(path)?.parsed).toEqual({ v: 1 });
    rmSync(path);
    expect(readJsonCached(path)).toBeUndefined();
  });
});
