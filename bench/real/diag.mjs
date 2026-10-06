// Runs a command in a VM of a repository checkpoint on the tree of a revision. For debugging.
//   node bench/real/diag.mjs <repo> <sha> '<shell command>'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vmSandboxFactory } from '../../eval/vm-sandbox.ts';
import { makeTree, sandboxOptions } from './lib.mjs';

const [repo, sha, command] = process.argv.slice(2);
const scratch = mkdtempSync(join(tmpdir(), 'pi8-diag-'));
try {
  makeTree(repo, sha, join(scratch, 'tree'));
  const factory = await vmSandboxFactory(sandboxOptions(repo));
  const sandbox = await factory(join(scratch, 'tree'));
  const result = await sandbox.run({ command: '/bin/sh', args: ['-lc', command], timeoutMs: 900_000 });
  console.log(`exit=${result.code}\n${(result.stdout + result.stderr).slice(-3500)}`);
  await sandbox.destroy();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
