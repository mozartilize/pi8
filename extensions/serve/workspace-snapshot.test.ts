import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from './execution-contract-tool.js';
import { snapshotWorkspace } from './workspace-snapshot.js';

const exec: Exec = (command, args, options) => new Promise((resolve) => {
  execFile(command, args, { cwd: options?.cwd }, (error, stdout) => resolve({ stdout, code: error ? 1 : 0 }));
});

let cwd: string;
beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'pi8-snapshot-'));
  await exec('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'a.ts'), 'one');
  writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('snapshotWorkspace', () => {
  it('digests the files Git does not ignore, and the digest follows their content', async () => {
    const first = await snapshotWorkspace(exec, cwd);
    expect(first).toMatchObject({ status: 'measured', scope: 'git-worktree', files: 2 });
    writeFileSync(join(cwd, 'ignored.txt'), 'x');
    expect((await snapshotWorkspace(exec, cwd)).digest).toBe(first.digest);
    writeFileSync(join(cwd, 'a.ts'), 'two');
    expect((await snapshotWorkspace(exec, cwd)).digest).not.toBe(first.digest);
  });
});
