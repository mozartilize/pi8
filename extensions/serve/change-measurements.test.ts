import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureChange } from './change-measurements.js';
import type { Exec } from './execution-contract-tool.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi8-measure-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'queue.ts'), 'a\nb\nc');
  writeFileSync(join(cwd, 'src', 'sleep.ts'), 'x');
  writeFileSync(join(cwd, 'tsconfig.json'), '{}');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const LS_FILES = ['src/queue.ts', 'src/sleep.ts', 'test/queue.test.ts', 'test/queue.hidden.test.ts', 'test/sleep.test.ts', 'docs/queue.md'].join('\n');

/** A repository whose `git` answers from fixed outputs. */
function gitExec(overrides: Partial<Record<'grep' | 'ls-files' | 'log', { stdout: string; code: number }>> = {}): Exec {
  return async (_command, args) => {
    const sub = args[0] as 'grep' | 'ls-files' | 'log';
    const fixed = {
      grep: { stdout: 'src/queue.ts\nsrc/index.ts\ntest/queue.test.ts\n', code: 0 },
      'ls-files': { stdout: LS_FILES, code: 0 },
      log: { stdout: 'fix: retry\nfeat: queue\n', code: 0 },
    };
    return overrides[sub] ?? fixed[sub];
  };
}

describe('measureChange', () => {
  it('measures the targets, the check tools, and the scout cost', async () => {
    const measured = await measureChange(gitExec(), cwd, {
      targets: { modify: ['src/queue.ts'], create: ['src/index.ts'] },
      precedent: 'src/sleep.ts',
      tools: ['read', 'bash', 'browser_screenshot'],
      scoutFiles: 3,
      scoutRequests: 5,
    });
    expect(measured).toEqual({
      scoutFiles: 3, scoutRequests: 5, visualTool: true,
      files: 2, directories: 1,
      typeChecker: true, precedentExists: true,
      existingLines: 3, missingTargets: 0, commits: 2, fixCommits: 1,
      // The target itself is not its own reference.
      fanIn: 2,
      // queue.test.ts and queue.hidden.test.ts; docs/queue.md is not a test.
      coveringTests: 2,
    });
  });

  it('leaves out targets outside the working directory and a missing precedent gets no credit', async () => {
    const measured = await measureChange(gitExec(), cwd, {
      targets: { modify: ['../outside.ts', '/etc/passwd'], create: [] },
      precedent: 'src/none.ts',
    });
    expect(measured).toMatchObject({ files: 0, directories: 0, precedentExists: false });
    expect(measured.fanIn).toBeUndefined();
    expect(measured.coveringTests).toBeUndefined();
  });

  it('does not count references to a generic or short file stem', async () => {
    const measured = await measureChange(gitExec(), cwd, { targets: { modify: ['src/index.ts', 'src/db.ts'], create: [] } });
    expect(measured.fanIn).toBeUndefined();
  });

  it('counts no references when git grep finds nothing', async () => {
    const measured = await measureChange(gitExec({ grep: { stdout: '', code: 1 } }), cwd, { targets: { modify: ['src/queue.ts'], create: [] } });
    expect(measured.fanIn).toBe(0);
  });

  it('leaves a failed git measurement unknown and keeps the others', async () => {
    const failing: Exec = async () => ({ stdout: '', code: 128 });
    const measured = await measureChange(failing, cwd, { targets: { modify: ['src/queue.ts'], create: [] } });
    expect(measured).toMatchObject({ files: 1, existingLines: 3, typeChecker: true });
    expect(measured.fanIn).toBeUndefined();
    expect(measured.coveringTests).toBeUndefined();
    expect(measured.commits).toBeUndefined();
  });

  it('returns what finished when git does not finish before the deadline', async () => {
    const hanging: Exec = () => new Promise(() => {});
    const started = Date.now();
    const measured = await measureChange(hanging, cwd, { targets: { modify: ['src/queue.ts'], create: [] }, scoutFiles: 1 }, undefined, 100);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(measured).toMatchObject({ files: 1, scoutFiles: 1, typeChecker: true });
    expect(measured.fanIn).toBeUndefined();
  });
});
