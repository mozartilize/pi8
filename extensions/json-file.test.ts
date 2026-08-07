import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { writeJsonAtomic } from './json-file.js';

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
});
