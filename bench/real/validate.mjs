// Validates tasks in the VM from the warm cache: the hidden tests must fail on the base tree and pass on the fix tree.
//   node bench/real/validate.mjs <repo> <sha...>      writes <root>/validation/<repo>-<sha>.json
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHiddenTests } from '../../eval/cargo-oracle.ts';
import { vmSandboxFactory } from '../../eval/vm-sandbox.ts';
import { cargoArgsFor, git, hiddenTestsFor, makeTree, REPOS, root, runTests, sandboxOptions, writeJson } from './lib.mjs';

const [repo, ...shas] = process.argv.slice(2);
const factory = await vmSandboxFactory(sandboxOptions(repo));
for (const sha of shas) {
  const { dir } = REPOS[repo];
  const fix = git(dir, ['rev-parse', sha]).trim();
  const base = git(dir, ['rev-parse', `${fix}^`]).trim();
  const { hidden, source, other } = hiddenTestsFor(repo, base, fix);
  const record = { repo, base, fix, subject: git(dir, ['show', '-s', '--format=%s', fix]).trim(), source, other, hidden: hidden.map((h) => `${h.kind}:${h.path}`) };
  if (hidden.length === 0) { console.log(sha, 'NO HIDDEN TESTS'); continue; }
  const args = cargoArgsFor(repo, fix, hidden);
  record.cargoArgs = args;
  const scratch = mkdtempSync(join(tmpdir(), 'pi8-validate-'));
  try {
    const baseTree = join(scratch, 'base');
    makeTree(repo, base, baseTree);
    applyHiddenTests(baseTree, hidden);
    const atBase = await runTests(repo, factory, baseTree, args, 1_500_000);
    const fixTree = join(scratch, 'fix');
    makeTree(repo, fix, fixTree);
    const atFix = await runTests(repo, factory, fixTree, args, 1_500_000);
    const brief = ({ passed, failed, broken, infrastructureFailed, timedOut }) => ({ passed, failed, broken, infrastructureFailed, timedOut });
    record.atBase = brief(atBase);
    record.atFix = brief(atFix);
    const failsByAssertion = !atBase.broken && !atBase.infrastructureFailed && !atBase.timedOut && atBase.failed > 0;
    const passesAtFix = !atFix.broken && !atFix.infrastructureFailed && !atFix.timedOut && atFix.failed === 0 && atFix.passed > 0;
    record.valid = failsByAssertion && passesAtFix;
    record.reason = record.valid ? 'ok' : !failsByAssertion ? (atBase.broken ? 'hidden test does not build or import at base (uses new API)' : atBase.infrastructureFailed || atBase.timedOut ? 'infrastructure' : atBase.passed + atBase.failed === 0 ? 'no test result at base' : 'tests pass at base') : (atFix.broken ? 'fix tree does not build' : atFix.passed + atFix.failed === 0 ? 'no test result at fix' : 'tests fail at fix');
    if (!record.valid) record.tails = { base: atBase.tail.slice(-600), fix: atFix.tail.slice(-600) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeJson(join(root, 'validation', `${repo}-${fix.slice(0, 10)}.json`), record);
  console.log(`${sha} valid=${record.valid} (${record.reason}) base: ${record.atBase.passed}p/${record.atBase.failed}f${record.atBase.broken ? ' BROKEN' : ''} fix: ${record.atFix.passed}p/${record.atFix.failed}f | ${record.cargoArgs.join(' ')}`);
}
