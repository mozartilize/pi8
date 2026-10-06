#!/usr/bin/env node
// Free probe of the evaluation harness on the queue bench. No model runs.
//   node bench/queue/setup.mjs && node bench/queue/dry-run.mjs
//
// Two scripted agents stand in for a model. One writes the reference queue. The
// other writes the queue with 6 planted defects. Each runs through the real
// pipeline: environment cache, sandbox, evidence store, private oracle, grade
// store, and report. The oracle is the hidden acceptance test of the bench.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixedArm } from '../../eval/arm-runner.ts';
import { CampaignStore } from '../../eval/budget.ts';
import { EnvironmentCache } from '../../eval/environment-cache.ts';
import { FileEvidenceStore } from '../../eval/evidence-store.ts';
import { FileGradeStore } from '../../eval/grade-store.ts';
import { nodeTestGraderRuntimeDigest, nodeTestOracle, nodeTestOracleDigest } from '../../eval/oracle.ts';
import { buildReport } from '../../eval/report.ts';
import { PiAgentRunner, evaluationProfile } from '../../eval/runner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const flow = process.env.PI8_FLOW_DIR ?? '/tmp/pi8-flow';
const evalDir = process.env.PI8_EVAL_DIR ?? mkdtempSync(join(tmpdir(), 'pi8-eval-dry-'));
const nodeRoot = process.execPath.replace(/\/bin\/node$/, '');

// The hidden test imports ../src/queue.ts, so it lives in test/ of the artifact copy.
const privateDir = join(evalDir, 'private-oracle');
rmSync(privateDir, { recursive: true, force: true });
mkdirSync(join(privateDir, 'test'), { recursive: true });
cpSync(join(flow, 'hidden', 'queue.hidden.test.ts'), join(privateDir, 'test', 'queue.hidden.test.ts'));

const tasks = [
  { id: 'queue-implement', repo: 'queue', caseDir: 'case1', env: {} },
];
const frozen = (task) => ({
  task: { id: task.id, baseRevision: 'bench', publicFixtureDigest: 'bench', environmentDigest: 'bench' },
  runtime: Object.fromEntries(['piRevision', 'pi8Commit', 'configDigest', 'benchmarkStoreDigest', 'candidateRegistryDigest', 'providerEndpointDigest', 'systemPromptDigest', 'toolsetDigest', 'generationParametersDigest'].map((k) => [k, 'dry-run'])),
});

const manifest = {
  campaignId: 'queue-dry-run', taskSetDigest: 'dry', repositorySplitDigest: 'dry', candidatePoolDigest: 'dry',
  policyDigests: { current: 'buggy', candidate: 'reference' },
  repetitionsPerTask: 2, confidenceLevel: 0.95, intervalMethod: 'paired-task-bootstrap', rareEventBoundMethod: 'one-sided-clopper-pearson',
  margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.2, maxNormalizedCostRatio: 1 },
  minimumEvidence: { distinctTasks: 1, distinctRepositories: 1, usablePairedTasks: 1 },
  unsafeCheapGate: { mode: 'conditional-when-available', independentUnit: 'task', minimumEligibleUnits: 10, maxUnsafeCheapUnitRate: 0.2 },
  reusePolicy: { mode: 'historical-analysis' },
  evidenceSelectionPolicy: { reuse: { mode: 'historical-analysis' }, choose: 'exact-compatible', cutoffAt: '2999-01-01T00:00:00Z' },
  oracleDigest: 'queue-hidden-v1', graderRuntimeDigest: nodeTestGraderRuntimeDigest(), normalizedPriceDigest: 'none',
  retryPolicy: { maxProviderRetriesPerAttempt: 0, maxOperationalRerunsPerSlot: 0, retryableStatuses: [] },
  budget: { maxProviderInvocations: 100, maxWallClockMs: 3_600_000, maxNewExecutions: 20 },
};
const campaign = new CampaignStore(evalDir, manifest.campaignId);
try { campaign.freeze(manifest); } catch { /* the manifest exists from an earlier run */ }

const oracleOptions = { taskId: 'queue-implement', oracleVersion: 'queue-hidden-v1', privateDir, testFiles: ['test/queue.hidden.test.ts'] };
const reference = readFileSync(join(flow, 'ref', 'queue.ts'), 'utf8');
const buggy = readFileSync(join(flow, 'buggy-queue.ts'), 'utf8');
const agentFor = (source) => new PiAgentRunner({
  repoRoot,
  invocation: () => ({ command: 'sh', args: ['-c', 'printf %s "$1" > src/queue.ts', 'sh', source] }),
});

const task = tasks[0];
const cache = new EnvironmentCache(evalDir);
const environment = await cache.resolve(
  { baseRevision: 'bench', lockfileDigest: '', containerImageDigest: '', publicSetupDigest: 'none', toolchainDigest: process.version, sandboxProfileDigest: 'dry' },
  async (staging) => cpSync(join(flow, task.caseDir), staging, { recursive: true }),
);

const arms = [
  { id: 'scripted-buggy', source: buggy },
  { id: 'scripted-reference', source: reference },
];
const profile = evaluationProfile({ repoRoot, nodeRoot, network: 'none' });
const reports = [];
for (const arm of arms) {
  const report = await runFixedArm({
    manifest: campaign.manifest(), ledger: campaign.ledger(), evidenceStore: new FileEvidenceStore(evalDir), gradeStore: new FileGradeStore(evalDir),
    runner: agentFor(arm.source), profile, environmentPath: environment.path,
    oracle: nodeTestOracle(oracleOptions), oracleDigest: nodeTestOracleDigest(oracleOptions), graderRuntimeDigest: nodeTestGraderRuntimeDigest(),
    priceTable: { digest: 'none', prices: {} }, evalDir, runId: `dry-${Date.now()}-${arm.id}`, reservation: { providerInvocations: 1 },
  }, {
    arm: { id: arm.id, policy: { kind: 'fixed-candidate', candidateKey: `scripted/${arm.id}` }, continuation: 'normal-policy' },
    task: { id: task.id, fixtureVersion: '1', workspace: { source: '', baseRevision: 'bench', sandbox: 'os-isolated-process' }, userRequest: 'scripted', budget: { wallTimeMs: 60_000 } },
    frozen: frozen(task), replicates: [1, 2],
  });
  reports.push(report);
  console.log(arm.id, report.slots.map((s) => (s.kind === 'evaluated' ? `${s.attempt.outcome}${s.reused ? ' (reused)' : ''}` : s.kind)).join(', '));
}

const unit = {
  taskId: task.id, repositoryId: task.repo,
  current: reports[0].slots.flatMap((s) => (s.kind === 'evaluated' ? [s.attempt] : [])),
  candidate: reports[1].slots.flatMap((s) => (s.kind === 'evaluated' ? [s.attempt] : [])),
};
const report = buildReport({ manifest: campaign.manifest(), units: [unit], armReports: reports });
console.log(JSON.stringify({ verdict: report.verdict, reasons: report.reasons, solveRate: report.checks.solveRate, evidence: report.evidence }, null, 1));
console.log(`evaluation directory: ${evalDir}`);
