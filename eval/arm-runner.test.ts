import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFixedArm, type ArmRunDeps } from './arm-runner.ts';
import { CampaignStore } from './budget.ts';
import { FileEvidenceStore } from './evidence-store.ts';
import { FileGradeStore } from './grade-store.ts';
import { nodeTestGraderRuntimeDigest, nodeTestOracle, nodeTestOracleDigest } from './oracle.ts';
import type { AgentRunInput, AgentRunner, AgentRunOutput } from './runner.ts';
import type { ActivationCampaignManifestV1, EvaluationArm, PublicTaskSpec } from './schema.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-arm-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const frozen = {
  task: { id: 't', baseRevision: 'r', publicFixtureDigest: 'f', environmentDigest: 'e' },
  runtime: {
    piRevision: 'p', pi8Commit: 'c', configDigest: 'cfg', benchmarkStoreDigest: 'b', candidateRegistryDigest: 'r',
    providerEndpointDigest: 'ep', systemPromptDigest: 's', toolsetDigest: 't', generationParametersDigest: 'g',
  },
};
const task: PublicTaskSpec = { id: 't', fixtureVersion: '1', workspace: { source: '', baseRevision: 'r', sandbox: 'os-isolated-process' }, userRequest: 'x', budget: { wallTimeMs: 1000 } };
const arm = (id: string): EvaluationArm => ({ id, policy: { kind: 'fixed-candidate', candidateKey: 'p/m' }, continuation: 'normal-policy' });

function manifest(over: Partial<ActivationCampaignManifestV1['budget']> = {}): ActivationCampaignManifestV1 {
  return {
    campaignId: 'c1', taskSetDigest: 't', repositorySplitDigest: 'r', candidatePoolDigest: 'p', policyDigests: { current: 'a', candidate: 'b' },
    repetitionsPerTask: 3, confidenceLevel: 0.95, intervalMethod: 'paired-task-bootstrap', rareEventBoundMethod: 'one-sided-clopper-pearson',
    margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.1, maxNormalizedCostRatio: 0.8 },
    minimumEvidence: { distinctTasks: 1, distinctRepositories: 1, usablePairedTasks: 1 },
    unsafeCheapGate: { mode: 'conditional-when-available', independentUnit: 'task', minimumEligibleUnits: 1, maxUnsafeCheapUnitRate: 0.2 },
    reusePolicy: { mode: 'historical-analysis' },
    evidenceSelectionPolicy: { reuse: { mode: 'historical-analysis' }, choose: 'exact-compatible', cutoffAt: '2999-01-01T00:00:00Z' },
    oracleDigest: 'o', graderRuntimeDigest: 'g', normalizedPriceDigest: 'n',
    retryPolicy: { maxProviderRetriesPerAttempt: 0, maxOperationalRerunsPerSlot: 1, retryableStatuses: ['provider-error'] },
    budget: { maxProviderInvocations: 1000, maxWallClockMs: 1e9, maxNewExecutions: 100, ...over },
  };
}

/** A stand-in for Pi. Each call writes `value.mjs` with the next planned value and one served attempt. */
class FakeRunner implements AgentRunner {
  calls = 0;
  private readonly plan: Array<{ value: number; exit?: AgentRunOutput["exit"] }>;
  constructor(plan: Array<{ value: number; exit?: AgentRunOutput["exit"] }>) {
    this.plan = plan;
  }
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const step = this.plan[Math.min(this.calls, this.plan.length - 1)]!;
    this.calls += 1;
    writeFileSync(join(input.sandbox.workDir, 'value.mjs'), `export const value = ${step.value};\n`);
    const sessions = join(input.sandbox.outDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const message = { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', usage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 } };
    writeFileSync(join(sessions, 's.jsonl'), `${JSON.stringify({ type: 'message', id: `m${this.calls}`, timestamp: '2026-01-01T00:00:00Z', message })}\n`);
    return { exit: step.exit ?? 'completed' };
  }
}

function setup(runner: FakeRunner, budget: Partial<ActivationCampaignManifestV1['budget']> = {}): ArmRunDeps {
  const environmentPath = join(dir, 'environment');
  mkdirSync(environmentPath);
  writeFileSync(join(environmentPath, 'readme.txt'), 'public');
  const privateDir = join(dir, 'private');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'hidden.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from './value.mjs'; test('v', () => assert.equal(value, 2));\n");
  const options = { taskId: 't', oracleVersion: 'v1', privateDir, testFiles: ['hidden.test.mjs'] };
  const campaign = new CampaignStore(dir, 'c1');
  campaign.freeze(manifest(budget));
  return {
    manifest: campaign.manifest(), ledger: campaign.ledger(), evidenceStore: new FileEvidenceStore(dir), gradeStore: new FileGradeStore(dir),
    runner, profile: { readOnlyPaths: [], etcEntries: [], credentialFiles: [], env: {}, network: 'none' }, environmentPath,
    oracle: nodeTestOracle(options), oracleDigest: nodeTestOracleDigest(options), graderRuntimeDigest: nodeTestGraderRuntimeDigest(),
    priceTable: { digest: 'table', prices: { 'p/m': { inputPer1M: 1, outputPer1M: 10 } } },
    priceOf: () => ({ inputPer1M: 1, outputPer1M: 10 }), evalDir: dir, runId: 'run-1',
    reservation: { providerInvocations: 5 },
  };
}

describe('fixed-arm runner', () => {
  it('runs each replicate slot once, grades it, and counts new creation cost apart from policy cost', async () => {
    const runner = new FakeRunner([{ value: 2 }, { value: 3 }, { value: 2 }]);
    const deps = setup(runner);
    const report = await runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1, 2, 3] });
    expect(runner.calls).toBe(3);
    expect(report.slots.map((slot) => slot.kind === 'evaluated' && slot.attempt.outcome)).toEqual(['verified-pass', 'verified-fail', 'verified-pass']);
    // Each execution: 1M*1 + 0.1M*10 = 2 USD.
    expect(report.newEvidenceCreationUsd).toBeCloseTo(6, 9);
    expect(report.policyExecutionUsd).toBeCloseTo(6, 9);
    expect(JSON.parse(readFileSync(report.manifestPath, 'utf8'))).toMatchObject({ armId: 'a', campaignId: 'c1', normalizedPriceDigest: 'table' });
  });

  it('reuses stored slots from another run, and another arm with the same policy, without new creation spend', async () => {
    const runner = new FakeRunner([{ value: 2 }]);
    const deps = setup(runner);
    await runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1, 2, 3] });
    const second = await runFixedArm({ ...deps, runId: 'run-2' }, { arm: arm('other-name'), task, frozen, replicates: [1, 2, 3, 4, 5] });
    expect(runner.calls).toBe(5);
    expect(second.slots.filter((slot) => slot.kind === 'evaluated' && slot.reused)).toHaveLength(3);
    expect(second.newEvidenceCreationUsd).toBeCloseTo(4, 9);
    expect(second.policyExecutionUsd).toBeCloseTo(10, 9);
  });

  it('stops with campaign-budget-exhausted and stores no evidence for the slot', async () => {
    const runner = new FakeRunner([{ value: 2 }]);
    const deps = setup(runner, { maxNewExecutions: 1 });
    const report = await runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1, 2] });
    expect(report.slots.map((slot) => slot.kind)).toEqual(['evaluated', 'campaign-budget-exhausted']);
    expect(runner.calls).toBe(1);
  });

  it('reruns a slot after an operational failure under the frozen policy and keeps the failure apart', async () => {
    const runner = new FakeRunner([{ value: 2, exit: 'provider-error' }, { value: 2 }]);
    const deps = setup(runner);
    const report = await runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1] });
    expect(runner.calls).toBe(2);
    expect(report.slots[0]).toMatchObject({ kind: 'evaluated', reused: false });
    expect(deps.ledger.operationalReruns(`${report.slots[0]!.recipeHash}#1`)).toBe(1);
    // The failed attempt spent money too.
    expect(report.newEvidenceCreationUsd).toBeCloseTo(4, 9);
  });

  it('reports an operational failure when the rerun limit is used', async () => {
    const runner = new FakeRunner([{ value: 2, exit: 'provider-error' }]);
    const deps = setup(runner);
    const report = await runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1] });
    expect(runner.calls).toBe(2);
    expect(report.slots[0]).toMatchObject({ kind: 'operational-failure', status: 'provider-error' });
  });

  it('never overwrites a run manifest', async () => {
    const deps = setup(new FakeRunner([{ value: 2 }]));
    await runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1] });
    await expect(runFixedArm(deps, { arm: arm('a'), task, frozen, replicates: [1] })).rejects.toThrow(/already exists/);
  });
});
