/**
 * Private oracles and grading. The oracle is not part of an execution recipe.
 * One execution can have several grades, one for each oracle and grader
 * runtime. A grade runs on the host after the candidate process is finished.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskOutcome } from '../extensions/routing/policy/outcome.ts';
import { copyTreeSafely, digestDirectory } from './fs-util.ts';
import { gradeIdOf, type GradeStore } from './grade-store.ts';
import { digestOf } from './recipe.ts';
import type { SandboxFactory } from './sandbox.ts';
import type { ExecutionEvidenceV1, FinalArtifact, GradeEvidenceV1, GradeKeyV1, OracleResult, PrivateOracleSpec } from './schema.ts';

/** An oracle change needs a new execution when the artifact cannot be graded again. */
export class NotRegradeableError extends Error {}

export interface GradeParams {
  store: GradeStore;
  evidence: ExecutionEvidenceV1;
  oracle: PrivateOracleSpec;
  oracleDigest: string;
  graderRuntimeDigest: string;
}

/**
 * Grade an execution, or return the grade that the same full key already has.
 *
 * - An execution that exhausted its task budget counts as unsolved. The oracle does not run.
 * - An artifact that is not regradeable gets one grade. A grade with another oracle or grader
 *   runtime needs a new execution.
 */
export async function gradeExecution(params: GradeParams): Promise<GradeEvidenceV1> {
  const { store, evidence, oracle } = params;
  const key: GradeKeyV1 = { executionId: evidence.executionId, oracleDigest: params.oracleDigest, graderRuntimeDigest: params.graderRuntimeDigest };
  const existing = await store.findGrade(key);
  if (existing) return existing;
  if (!evidence.finalArtifact.regradeable && (await store.listGradeKeys(evidence.executionId)).length > 0) {
    throw new NotRegradeableError(`execution ${evidence.executionId} cannot be graded again with another oracle or grader runtime`);
  }
  if (evidence.status !== 'completed' && evidence.status !== 'task-budget-exhausted') {
    throw new Error(`an execution with status ${evidence.status} cannot be graded`);
  }
  let grade: GradeEvidenceV1;
  if (evidence.status === 'task-budget-exhausted') {
    grade = { gradeId: gradeIdOf(key), key, status: 'graded', outcome: 'verified-fail', summary: { reason: 'task-budget-exhausted' } };
  } else {
    const startedAt = Date.now();
    let result: OracleResult;
    try {
      result = await oracle.evaluate(evidence.finalArtifact);
    } catch {
      result = { verdict: 'error' };
    }
    const outcome: TaskOutcome = result.verdict === 'error' ? 'environment-error' : result.verdict === 'pass' ? 'verified-pass' : 'verified-fail';
    grade = {
      gradeId: gradeIdOf(key),
      key,
      status: result.verdict === 'error' ? 'oracle-error' : 'graded',
      outcome,
      oracleElapsedMs: result.elapsedMs ?? Date.now() - startedAt,
      ...(result.summary ? { summary: result.summary } : {}),
    };
  }
  await store.appendGrade(key, grade);
  return grade;
}

// ── An oracle that runs private node:test files against a copy of the artifact ──

export interface NodeTestOracleOptions {
  taskId: string;
  oracleVersion: string;
  /** Host directory with the private test files. It is copied over the artifact copy. */
  privateDir: string;
  /** Test files in the private directory, relative to it. */
  testFiles: string[];
  timeoutMs?: number;
  /** Extra variables for the test process. The host run has no other variable than PATH. */
  env?: Record<string, string>;
  /**
   * Where the artifact code runs. The default is a host process, which is only for an artifact
   * that the host may run. A factory runs the tests in the sandbox that it makes.
   */
  runIn?: SandboxFactory & { identity: string };
}

/** Digest of the private files and the version. A change of either makes a new oracle. */
export function nodeTestOracleDigest(options: NodeTestOracleOptions): string {
  return digestOf({ taskId: options.taskId, version: options.oracleVersion, files: digestDirectory(options.privateDir), tests: options.testFiles });
}

/** Digest of the runtime that runs the oracle. */
export function nodeTestGraderRuntimeDigest(runIn?: { identity: string }): string {
  return digestOf({ runner: 'node-test-oracle', version: 1, ...(runIn ? { sandbox: runIn.identity } : { node: process.version }) });
}

export function nodeTestOracle(options: NodeTestOracleOptions): PrivateOracleSpec {
  return {
    taskId: options.taskId,
    oracleVersion: options.oracleVersion,
    async evaluate(artifact: FinalArtifact): Promise<OracleResult> {
      const copy = mkdtempSync(join(tmpdir(), 'pi8-oracle-'));
      const startedAt = Date.now();
      try {
        // The artifact is candidate output. The copy keeps no link that leaves the tree, so the
        // private files below cannot be written through a link to a host path.
        copyTreeSafely(artifact.path, copy);
        cpSync(options.privateDir, copy, { recursive: true });
        const timeoutMs = options.timeoutMs ?? 120_000;
        const output = options.runIn ? await runInSandbox(options.runIn, copy, options, timeoutMs) : await runOnHost(copy, options, timeoutMs);
        const count = (name: string): number => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(output.text)?.[1] ?? Number.NaN);
        const passed = count('pass');
        const failed = count('fail');
        // A run that reports no test counts says nothing about the artifact.
        if (!Number.isFinite(passed) || !Number.isFinite(failed) || passed + failed === 0) {
          return { verdict: 'error', elapsedMs: Date.now() - startedAt, summary: { reason: 'no test result' } };
        }
        // A suite that passes in part counts as unsolved.
        return { verdict: failed === 0 ? 'pass' : 'fail', elapsedMs: Date.now() - startedAt, summary: { passed, failed } };
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  };
}

async function runInSandbox(factory: SandboxFactory, copy: string, options: NodeTestOracleOptions, timeoutMs: number): Promise<{ code: number | null; text: string }> {
  const sandbox = await factory(copy);
  try {
    const result = await sandbox.run({ command: 'node', args: ['--test', ...options.testFiles], timeoutMs, ...(options.env ? { env: options.env } : {}) });
    return { code: result.code, text: `${result.stdout}${result.stderr}` };
  } finally {
    await sandbox.destroy();
  }
}

function runOnHost(copy: string, options: NodeTestOracleOptions, timeoutMs: number): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--test', ...options.testFiles], {
      cwd: copy, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, text }); });
  });
}
