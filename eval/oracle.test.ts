import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileGradeStore } from './grade-store.ts';
import { gradeExecution, NotRegradeableError, nodeTestGraderRuntimeDigest, nodeTestOracle, nodeTestOracleDigest } from './oracle.ts';
import type { ExecutionEvidenceV1, PrivateOracleSpec } from './schema.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-oracle-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function evidence(artifactDir: string, over: Partial<ExecutionEvidenceV1> = {}, regradeable = true): ExecutionEvidenceV1 {
  return {
    executionId: 'exec-1', slot: { recipeHash: 'h', replicate: 1 }, recipeHash: 'h',
    recipe: {} as ExecutionEvidenceV1['recipe'],
    status: 'completed', provenance: { producedByRunId: 'r', startedAt: '', endedAt: '' }, deployment: [],
    finalArtifact: { digest: 'artifact-digest', path: artifactDir, regradeable, stateKinds: ['git-worktree'] },
    decisionLogDigest: '', realizedTrajectoryDigest: '', realizedWorkspaceDigest: '',
    rawUsage: { attempts: [], spendIncomplete: false }, wallTimeMs: 1, providerFailures: 0, fallbackCount: 0, capabilityEscalations: 0,
    ...over,
  };
}

function privateOracle(version: string, testBody: string) {
  const privateDir = join(dir, `private-${version}`);
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'hidden.test.mjs'), testBody);
  const options = { taskId: 't', oracleVersion: version, privateDir, testFiles: ['hidden.test.mjs'] };
  return { oracle: nodeTestOracle(options), digest: nodeTestOracleDigest(options) };
}

const artifactWith = (value: number): string => {
  const path = join(dir, `artifact-${value}`);
  mkdirSync(path);
  writeFileSync(join(path, 'value.mjs'), `export const value = ${value};\n`);
  return path;
};
const testExpecting = (expected: number) => `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from './value.mjs'; test('value', () => assert.equal(value, ${expected}));\n`;

describe('grading', () => {
  it('grades the artifact with a private oracle and keeps the oracle out of the artifact', async () => {
    const store = new FileGradeStore(dir);
    const { oracle, digest } = privateOracle('v1', testExpecting(2));
    const pass = await gradeExecution({ store, evidence: evidence(artifactWith(2)), oracle, oracleDigest: digest, graderRuntimeDigest: nodeTestGraderRuntimeDigest() });
    expect(pass).toMatchObject({ status: 'graded', outcome: 'verified-pass' });
    const failStore = new FileGradeStore(join(dir, 'other'));
    const fail = await gradeExecution({ store: failStore, evidence: evidence(artifactWith(3)), oracle, oracleDigest: digest, graderRuntimeDigest: nodeTestGraderRuntimeDigest() });
    expect(fail).toMatchObject({ status: 'graded', outcome: 'verified-fail' });
  });

  it('makes a distinct grade when only the oracle or only the grader runtime changes', async () => {
    const store = new FileGradeStore(dir);
    const artifact = artifactWith(2);
    const v1 = privateOracle('v1', testExpecting(2));
    const v2 = privateOracle('v2', testExpecting(2));
    const grade = (oracle: PrivateOracleSpec, oracleDigest: string, graderRuntimeDigest: string) => gradeExecution({ store, evidence: evidence(artifact), oracle, oracleDigest, graderRuntimeDigest });
    const a = await grade(v1.oracle, v1.digest, 'runtime-A');
    const sameKey = await grade(v1.oracle, v1.digest, 'runtime-A');
    const newOracle = await grade(v2.oracle, v2.digest, 'runtime-A');
    const newRuntime = await grade(v1.oracle, v1.digest, 'runtime-B');
    expect(sameKey.gradeId).toBe(a.gradeId);
    expect(new Set([a.gradeId, newOracle.gradeId, newRuntime.gradeId]).size).toBe(3);
    expect(await store.findGrade({ executionId: 'exec-1', oracleDigest: v1.digest, graderRuntimeDigest: 'runtime-C' })).toBeUndefined();
    expect(await store.listGradeKeys('exec-1')).toHaveLength(3);
  });

  it('refuses another oracle on an artifact that cannot be graded again', async () => {
    const store = new FileGradeStore(dir);
    const artifact = artifactWith(2);
    const v1 = privateOracle('v1', testExpecting(2));
    const v2 = privateOracle('v2', testExpecting(2));
    const once = await gradeExecution({ store, evidence: evidence(artifact, {}, false), oracle: v1.oracle, oracleDigest: v1.digest, graderRuntimeDigest: 'r' });
    expect(once.outcome).toBe('verified-pass');
    await expect(gradeExecution({ store, evidence: evidence(artifact, {}, false), oracle: v2.oracle, oracleDigest: v2.digest, graderRuntimeDigest: 'r' })).rejects.toBeInstanceOf(NotRegradeableError);
  });

  it('treats an oracle that cannot run as an environment error, and an exhausted budget as unsolved', async () => {
    const store = new FileGradeStore(dir);
    const artifact = artifactWith(2);
    // The named test file is missing, so the runner reports no test result.
    const broken = privateOracle('broken', testExpecting(2));
    const missing = nodeTestOracle({ taskId: 't', oracleVersion: 'missing', privateDir: join(dir, 'private-broken'), testFiles: ['absent.test.mjs'] });
    const error = await gradeExecution({ store, evidence: evidence(artifact), oracle: missing, oracleDigest: broken.digest, graderRuntimeDigest: 'r' });
    expect(error).toMatchObject({ status: 'oracle-error', outcome: 'environment-error' });
    const ran = { evaluate: () => { throw new Error('must not run'); } } as unknown as PrivateOracleSpec;
    const exhausted = await gradeExecution({ store, evidence: evidence(artifact, { executionId: 'exec-2', status: 'task-budget-exhausted' }), oracle: ran, oracleDigest: 'o', graderRuntimeDigest: 'r' });
    expect(exhausted).toMatchObject({ status: 'graded', outcome: 'verified-fail' });
  });
});
