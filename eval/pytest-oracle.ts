/**
 * A private oracle for a Python task. The hidden tests are files. The oracle copies the artifact,
 * puts the hidden test files in the copy, and runs `pytest` in a VM that starts from a checkpoint with a
 * ready test database. The candidate code never runs on the host.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHiddenTests, type HiddenTest } from './cargo-oracle.ts';
import { copyTreeSafely } from './fs-util.ts';
import { digestOf } from './recipe.ts';
import type { SandboxFactory } from './sandbox.ts';
import type { FinalArtifact, OracleResult, PrivateOracleSpec } from './schema.ts';

export interface PytestSummary {
  passed: number;
  failed: number;
  /** A test file did not import, or a fixture raised an error. The tests did not run as written. */
  errors: number;
  infrastructureFailed: boolean;
}

/** Read the last summary line of `pytest`. */
export function summarizePytest(output: string): PytestSummary {
  const count = (word: string): number => {
    const lines = output.split('\n').filter((line) => /(\d+ (passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?))/.test(line) && /\bin \d/.test(line));
    const last = lines.at(-1) ?? '';
    return Number(new RegExp(`(\\d+) ${word}`).exec(last)?.[1] ?? 0);
  };
  const infrastructureFailed = /could not connect to server|Connection refused|No space left on device|OperationalError: connection|the database system is starting up/i.test(output);
  return { passed: count('passed'), failed: count('failed'), errors: count('errors?'), infrastructureFailed };
}

export interface PytestRun {
  summary: PytestSummary;
  timedOut: boolean;
  tail: string;
}

/** Run `pytest` for a directory in a VM from the factory. */
export async function runPytest(runIn: SandboxFactory, directory: string, pytestArgs: readonly string[], timeoutMs: number): Promise<PytestRun> {
  const sandbox = await runIn(directory);
  try {
    // `-n0` runs in one process. The test database of the checkpoint is reused.
    const result = await sandbox.run({ command: '/bin/sh', args: ['-lc', `python -m pytest -n0 -q -p no:cacheprovider --reuse-db ${pytestArgs.join(' ')} 2>&1`], timeoutMs });
    const output = `${result.stdout}${result.stderr}`;
    return { summary: summarizePytest(output), timedOut: result.timedOut, tail: output.slice(-1500) };
  } finally {
    await sandbox.destroy();
  }
}

export interface PytestOracleOptions {
  taskId: string;
  oracleVersion: string;
  hidden: readonly HiddenTest[];
  /** Test paths or `-k` filters. */
  pytestArgs: readonly string[];
  minPassed: number;
  timeoutMs?: number;
  runIn: SandboxFactory & { identity: string };
}

export function pytestOracleDigest(options: PytestOracleOptions): string {
  return digestOf({ taskId: options.taskId, version: options.oracleVersion, hidden: options.hidden, args: options.pytestArgs, minPassed: options.minPassed });
}

export function pytestGraderRuntimeDigest(runIn: { identity: string }): string {
  return digestOf({ runner: 'pytest-oracle', version: 1, sandbox: runIn.identity });
}

export function pytestOracle(options: PytestOracleOptions): PrivateOracleSpec {
  return {
    taskId: options.taskId,
    oracleVersion: options.oracleVersion,
    async evaluate(artifact: FinalArtifact): Promise<OracleResult> {
      const copy = mkdtempSync(join(tmpdir(), 'pi8-pytest-oracle-'));
      const startedAt = Date.now();
      try {
        copyTreeSafely(artifact.path, copy);
        applyHiddenTests(copy, options.hidden);
        const run = await runPytest(options.runIn, copy, options.pytestArgs, options.timeoutMs ?? 900_000);
        const elapsedMs = Date.now() - startedAt;
        if (run.timedOut) return { verdict: 'error', elapsedMs, summary: { reason: 'time-out' } };
        const { summary } = run;
        if (summary.infrastructureFailed) return { verdict: 'error', elapsedMs, summary: { reason: 'infrastructure' } };
        // A hidden test that does not import is a failed solution: the candidate removed or renamed what the test needs.
        if (summary.errors > 0) return { verdict: 'fail', elapsedMs, summary: { reason: 'errors', errors: summary.errors } };
        if (summary.passed + summary.failed === 0) return { verdict: 'error', elapsedMs, summary: { reason: 'no test result' } };
        const solved = summary.failed === 0 && summary.passed >= options.minPassed;
        return { verdict: solved ? 'pass' : 'fail', elapsedMs, summary: { passed: summary.passed, failed: summary.failed } };
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  };
}
