/**
 * A private oracle for a Rust task. The hidden tests are files, or the test module at the end of
 * a source file. The oracle copies the artifact, puts the hidden tests in the copy, and runs
 * `cargo test` in a VM that starts from a warm build cache. The candidate code never runs on the host.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyTreeSafely } from './fs-util.ts';
import { digestOf } from './recipe.ts';
import type { SandboxFactory } from './sandbox.ts';
import type { FinalArtifact, OracleResult, PrivateOracleSpec } from './schema.ts';

export type HiddenTest =
  /** The whole file replaces the file of the artifact. */
  | { path: string; kind: 'file'; content: string }
  /** The text from the first `#[cfg(test)]` module to the end of the file replaces the same part of the artifact file. */
  | { path: string; kind: 'rust-tests-to-eof'; content: string };

const TEST_MODULE = /^#\[cfg\(test\)\]\s*\n(?:#\[[^\n]*\]\s*\n)*(?:pub(?:\([^)]*\))? )?mod \w+ \{/m;

/** Put the hidden tests into a copy of the artifact. Throws when a source file for a module is missing. */
export function applyHiddenTests(workDir: string, tests: readonly HiddenTest[]): void {
  for (const test of tests) {
    const path = join(workDir, test.path);
    if (test.kind === 'file') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, test.content);
      continue;
    }
    if (!existsSync(path)) throw new Error(`the source file of a hidden test module is missing: ${test.path}`);
    const source = readFileSync(path, 'utf8');
    const at = TEST_MODULE.exec(source)?.index;
    writeFileSync(path, at === undefined ? `${source.trimEnd()}\n\n${test.content}` : `${source.slice(0, at)}${test.content}`);
  }
}

/** The text of a source file from its first test module to the end of the file. */
export function testTailOf(source: string): string | undefined {
  const at = TEST_MODULE.exec(source)?.index;
  return at === undefined ? undefined : source.slice(at);
}

export interface CargoTestOracleOptions {
  taskId: string;
  oracleVersion: string;
  hidden: readonly HiddenTest[];
  /** Arguments of `cargo test`, such as `['-p', 'tantivy', '--lib', 'aggregation::metric::sum']`. */
  cargoArgs: readonly string[];
  /** The oracle needs at least this many passed tests. An artifact that removes the tests cannot pass. */
  minPassed: number;
  timeoutMs?: number;
  /** The sandbox for the run. Its image has the toolchain, and its checkpoint has the warm cache. */
  runIn: SandboxFactory & { identity: string };
}

export function cargoTestOracleDigest(options: CargoTestOracleOptions): string {
  return digestOf({ taskId: options.taskId, version: options.oracleVersion, hidden: options.hidden, args: options.cargoArgs, minPassed: options.minPassed });
}

export function cargoGraderRuntimeDigest(runIn: { identity: string }): string {
  return digestOf({ runner: 'cargo-test-oracle', version: 1, sandbox: runIn.identity });
}

export interface CargoTestSummary {
  passed: number;
  failed: number;
  /** The build stopped before a test ran. */
  buildFailed: boolean;
  /** The build or the run could not use the network or the disk. It says nothing about the code. */
  infrastructureFailed: boolean;
}

/** Read the output of `cargo test`. */
export function summarizeCargoTest(output: string): CargoTestSummary {
  let passed = 0;
  let failed = 0;
  for (const match of output.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm)) {
    passed += Number(match[1]);
    failed += Number(match[2]);
  }
  const infrastructureFailed = /failed to (?:download|fetch|get|update)|Could not resolve host|spurious network error|No space left on device|unable to get packages from source/i.test(output);
  const buildFailed = /error: could not compile|error\[E\d+\]|error: failed to run custom build command/.test(output) && !infrastructureFailed;
  return { passed, failed, buildFailed, infrastructureFailed };
}

export interface CargoTestRun {
  summary: CargoTestSummary;
  timedOut: boolean;
  /** The end of the output. It is for the person who reads a failed validation, not for a verdict. */
  tail: string;
}

/** Run `cargo test` for a directory in a VM from the factory. */
export async function runCargoTest(runIn: SandboxFactory, directory: string, cargoArgs: readonly string[], timeoutMs: number): Promise<CargoTestRun> {
  const sandbox = await runIn(directory);
  try {
    const result = await sandbox.run({ command: '/bin/sh', args: ['-lc', `cargo test ${cargoArgs.join(' ')} 2>&1`], timeoutMs });
    const output = `${result.stdout}${result.stderr}`;
    return { summary: summarizeCargoTest(output), timedOut: result.timedOut, tail: output.slice(-1500) };
  } finally {
    await sandbox.destroy();
  }
}

export function cargoTestOracle(options: CargoTestOracleOptions): PrivateOracleSpec {
  return {
    taskId: options.taskId,
    oracleVersion: options.oracleVersion,
    async evaluate(artifact: FinalArtifact): Promise<OracleResult> {
      const copy = mkdtempSync(join(tmpdir(), 'pi8-cargo-oracle-'));
      const startedAt = Date.now();
      try {
        // The artifact is candidate output. The copy keeps no link that leaves the tree.
        copyTreeSafely(artifact.path, copy);
        applyHiddenTests(copy, options.hidden);
        const run = await runCargoTest(options.runIn, copy, options.cargoArgs, options.timeoutMs ?? 1_200_000);
        if (run.timedOut) return { verdict: 'error', elapsedMs: Date.now() - startedAt, summary: { reason: 'time-out' } };
        const { summary } = run;
        const elapsedMs = Date.now() - startedAt;
        if (summary.infrastructureFailed) return { verdict: 'error', elapsedMs, summary: { reason: 'infrastructure' } };
        if (summary.buildFailed) return { verdict: 'fail', elapsedMs, summary: { reason: 'build' } };
        // A run with no test result says nothing about the artifact.
        if (summary.passed + summary.failed === 0) return { verdict: 'error', elapsedMs, summary: { reason: 'no test result' } };
        const solved = summary.failed === 0 && summary.passed >= options.minPassed;
        return { verdict: solved ? 'pass' : 'fail', elapsedMs, summary: { passed: summary.passed, failed: summary.failed } };
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  };
}
