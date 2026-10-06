#!/usr/bin/env node
// Paid probe of the queue bench through the evaluation harness.
//
//   node bench/queue/setup.mjs
//   node bench/queue/probe.mjs            print the preflight matrix and stop
//   node bench/queue/probe.mjs --run      record the approval and run the campaign
//   node bench/queue/probe.mjs --vm ...   run pi on the host and the code of the model in a micro-VM
//                                         (a new campaign; --run then needs --approval "<text>")
//
// Arms: the current router policy (router/auto with this extension) and a fixed
// strong model. Tasks: queue-implement and queue-rename. Both have a hidden
// oracle. The review task has no executable oracle, so it is not here.
//
// Every execution starts in a fresh sandbox. The sandbox gets a copy of the
// provider credentials for the two providers that the probe uses, and a router
// config without the benchmark API key. The ledger stops the campaign when the
// new-evidence budget is spent. A running execution is not stopped, so the
// spend can pass the limit by the cost of one execution.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels } from '@earendil-works/pi-ai/compat';
import { runFixedArm } from '../../eval/arm-runner.ts';
import { CampaignStore, preflightMatrix } from '../../eval/budget.ts';
import { EnvironmentCache } from '../../eval/environment-cache.ts';
import { defaultEvalDir, FileEvidenceStore } from '../../eval/evidence-store.ts';
import { FileGradeStore } from '../../eval/grade-store.ts';
import { nodeTestGraderRuntimeDigest, nodeTestOracle, nodeTestOracleDigest } from '../../eval/oracle.ts';
import { digestOf } from '../../eval/recipe.ts';
import { buildReport } from '../../eval/report.ts';
import { HostPiAgentRunner } from '../../eval/host-pi-runner.ts';
import { PiAgentRunner, evaluationProfile, piInvocation } from '../../eval/runner.ts';
import { vmSandboxFactory } from '../../eval/vm-sandbox.ts';

const REPLICATES = [1, 2, 3];
const BUDGET_USD = 3;
const useVm = process.argv.includes('--vm');
const CAMPAIGN_ID = useVm ? 'queue-probe-vm-1' : 'queue-probe-1';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const flow = process.env.PI8_FLOW_DIR ?? '/tmp/pi8-flow';
const evalDir = defaultEvalDir();
const home = homedir();
const nodeRoot = process.execPath.replace(/\/bin\/node$/, '');
const run = process.argv.includes('--run');
const approvalAt = process.argv.indexOf('--approval');
const approval = approvalAt >= 0 ? process.argv[approvalAt + 1] : undefined;

const tasks = [
  {
    id: 'queue-implement', caseDir: 'case1', wallTimeMs: 1_200_000, oracleEnv: {}, followup: true,
    prompt: 'Read docs/queue-spec.md. Plan the design of src/queue.ts first, then implement it. Add tests in test/queue.test.ts that cover each rule in the spec, and run `npm test` until all tests pass. Do not stop to ask for approval; complete the work.',
  },
  {
    id: 'queue-rename', caseDir: 'case3', wallTimeMs: 600_000, oracleEnv: { DELAY_OPTION: 'backoffBaseMs' }, followup: false,
    prompt: 'Rename the queue option `retryDelayMs` to `backoffBaseMs` everywhere in this project: source, tests, and docs. Then add src/index.ts that re-exports `createQueue` and the types `QueueOptions`, `AddOptions`, `JobHandle`, and `Queue` from src/queue.ts. Run `npm test` and make sure it passes.',
  },
];
const arms = [
  { id: 'auto', policy: { kind: 'current-auto' }, continuation: 'normal-policy' },
  { id: 'sol', policy: { kind: 'fixed-candidate', candidateKey: 'openai-codex/gpt-6.1-sol' }, continuation: 'normal-policy' },
];

const retryPolicy = { maxProviderRetriesPerAttempt: 0, maxOperationalRerunsPerSlot: 1, retryableStatuses: ['provider-error', 'sandbox-error'] };
const matrix = preflightMatrix({ taskCount: tasks.length, wholeTaskArms: arms.length, probesPerTask: 0, repetitions: REPLICATES.length, retryPolicy, providerCallsPerExecution: 40, usdPerExecution: 0.25 });
console.log('preflight matrix', JSON.stringify(matrix, null, 1));
if (!run) {
  console.log(`\nApproved limit for new evidence: $${BUDGET_USD}. Run again with --run to start.`);
  process.exit(0);
}

if (useVm && !approval) throw new Error('A VM campaign needs its own approval: pass --approval "<who approved which arms, replicates, and limit>"');
const vm = useVm ? await vmSandboxFactory({ network: 'none' }) : undefined;

// ── Router config and credentials for the sandbox ────────────────────────
const prepared = join(evalDir, 'prepared', CAMPAIGN_ID);
rmSync(prepared, { recursive: true, force: true });
mkdirSync(join(prepared, 'pi8-template'), { recursive: true });
const store = join(home, '.pi', 'agent', 'pi8');
cpSync(join(store, 'benchmarks.json'), join(prepared, 'pi8-template', 'benchmarks.json'));
// The classifier model is large and read-only. The sandbox binds it at the same path.
symlinkSync(join(store, 'embedding'), join(prepared, 'pi8-template', 'embedding'));
const config = JSON.parse(readFileSync(join(store, 'config.json'), 'utf8'));
delete config.artificialAnalysisApiKey;
config.models = ['openai-codex/*', 'deepseek/*'];
writeFileSync(join(prepared, 'pi8-template', 'config.json'), JSON.stringify(config, null, 2));
const auth = JSON.parse(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8'));
const authFile = join(prepared, 'auth.json');
writeFileSync(authFile, JSON.stringify({ 'openai-codex': auth['openai-codex'], deepseek: auth.deepseek }));

// ── Frozen inputs. Pi gives no digest of its prompt or tools, so those are coarse. ──
const text = (command, args) => execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const models = ['openai-codex', 'deepseek'].flatMap((provider) => getModels(provider).map((model) => ({ provider, model })));
const prices = Object.fromEntries(models.map(({ provider, model }) => [`${provider}/${model.id}`, { inputPer1M: model.cost?.input, outputPer1M: model.cost?.output, cacheReadPer1M: model.cost?.cacheRead, cacheWritePer1M: model.cost?.cacheWrite }]));
const priceTable = { digest: digestOf(prices), prices };
const priceOf = (provider, modelId) => prices[`${provider}/${modelId}`];
const runtime = {
  piRevision: text('pi', ['--version']),
  pi8Commit: `${text('git', ['rev-parse', 'HEAD'])}+${digestOf(text('git', ['status', '--porcelain', '--', 'extensions', 'eval']))}`.slice(0, 80),
  configDigest: digestOf(config),
  benchmarkStoreDigest: digestOf(readFileSync(join(prepared, 'pi8-template', 'benchmarks.json'), 'utf8')),
  candidateRegistryDigest: priceTable.digest,
  providerEndpointDigest: digestOf(['openai-codex', 'deepseek']),
  systemPromptDigest: 'pi-default',
  toolsetDigest: 'pi-default',
  generationParametersDigest: 'pi-default',
};

// ── Campaign ──────────────────────────────────────────────────────────────
const campaign = new CampaignStore(evalDir, CAMPAIGN_ID);
const manifest = {
  campaignId: CAMPAIGN_ID, taskSetDigest: digestOf(tasks.map((task) => task.id)), repositorySplitDigest: 'queue', candidatePoolDigest: digestOf(arms),
  policyDigests: { current: digestOf(arms[0]), candidate: digestOf(arms[1]) },
  repetitionsPerTask: REPLICATES.length, confidenceLevel: 0.95, intervalMethod: 'paired-task-bootstrap', rareEventBoundMethod: 'one-sided-clopper-pearson',
  margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.2, maxNormalizedCostRatio: 1 },
  minimumEvidence: { distinctTasks: 2, distinctRepositories: 1, usablePairedTasks: 2 },
  unsafeCheapGate: { mode: 'conditional-when-available', independentUnit: 'task', minimumEligibleUnits: 10, maxUnsafeCheapUnitRate: 0.2 },
  reusePolicy: { mode: 'historical-analysis' },
  evidenceSelectionPolicy: { reuse: { mode: 'historical-analysis' }, choose: 'exact-compatible', cutoffAt: '2999-01-01T00:00:00Z' },
  oracleDigest: 'queue-hidden-v1', graderRuntimeDigest: nodeTestGraderRuntimeDigest(vm), normalizedPriceDigest: priceTable.digest,
  retryPolicy, budget: { maxNewEvidenceUsd: BUDGET_USD, maxProviderInvocations: 1500, maxWallClockMs: 10_800_000, maxNewExecutions: 18 },
};
if (!existsSync(join(evalDir, 'campaigns', CAMPAIGN_ID, 'manifest.json'))) campaign.freeze(manifest);
campaign.savePreflight(matrix);
campaign.approve(useVm ? `operator (${approval})` : 'operator (approved in chat: arms auto and sol, 3 replicates, $3)');
if (!campaign.isApproved()) throw new Error('the campaign is not approved');

// ── Execution ─────────────────────────────────────────────────────────────
const shell = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const evidenceStore = new FileEvidenceStore(evalDir);
const gradeStore = new FileGradeStore(evalDir);
const cache = new EnvironmentCache(evalDir);
const profile = vm ? undefined : evaluationProfile({
  repoRoot, nodeRoot, authFile, network: 'host',
  extraReadOnlyPaths: [join(store, 'embedding')],
});
const stamp = Date.now();
const results = new Map();
const armReports = [];

for (const task of tasks) {
  const privateDir = join(prepared, `oracle-${task.id}`);
  mkdirSync(join(privateDir, 'test'), { recursive: true });
  cpSync(join(flow, 'hidden', 'queue.hidden.test.ts'), join(privateDir, 'test', 'queue.hidden.test.ts'));
  task.oracleOptions = { taskId: task.id, oracleVersion: 'queue-hidden-v1', privateDir, testFiles: ['test/queue.hidden.test.ts'], env: task.oracleEnv, ...(vm ? { runIn: vm } : {}) };
  task.environment = await cache.resolve(
    { baseRevision: 'queue-bench', lockfileDigest: '', containerImageDigest: '', publicSetupDigest: task.caseDir, toolchainDigest: process.version, sandboxProfileDigest: vm?.identity ?? 'probe' },
    async (staging) => cpSync(join(flow, task.caseDir), staging, { recursive: true }),
  );
}

for (const replicate of REPLICATES) {
  for (const task of tasks) {
    for (const arm of arms) {
      const runner = vm ? new HostPiAgentRunner({
        repoRoot, vm, authFile, pi8Template: join(prepared, 'pi8-template'),
        invocation: (input, sessionDir) => piInvocation({ task: { ...input.task, userRequest: task.prompt }, arm: input.arm }, repoRoot, sessionDir),
        // A model that stops before it writes the file gets one more prompt. Earlier probes did the same.
        followUp: () => (task.followup ? { prompt: 'Continue. Implement the plan now and make `npm test` pass. Do not ask for approval.', when: (workDir) => !existsSync(join(workDir, 'src', 'queue.ts')) } : undefined),
      }) : new PiAgentRunner({
        repoRoot, pi8Template: join(prepared, 'pi8-template'),
        invocation: (input) => {
          const first = piInvocation({ task: { ...input.task, userRequest: task.prompt }, arm: input.arm }, repoRoot);
          const command = (args) => ['pi', ...args].map(shell).join(' ');
          if (!task.followup) return { command: 'sh', args: ['-c', `exec ${command(first.args)}`] };
          // A model that stops before it writes the file gets one more prompt. Earlier probes did the same.
          const at = first.args.indexOf('-p');
          const second = [...first.args.slice(0, at), '-c', '-p', 'Continue. Implement the plan now and make `npm test` pass. Do not ask for approval.'];
          return { command: 'sh', args: ['-c', `${command(first.args)}; [ -f src/queue.ts ] || ${command(second)}`] };
        },
      });
      const report = await runFixedArm({
        manifest: campaign.manifest(), ledger: campaign.ledger(), evidenceStore, gradeStore, runner, ...(profile ? { profile } : {}), ...(vm ? { sandboxFactory: vm } : {}),
        environmentPath: task.environment.path, oracle: nodeTestOracle(task.oracleOptions), oracleDigest: nodeTestOracleDigest(task.oracleOptions),
        graderRuntimeDigest: nodeTestGraderRuntimeDigest(vm), priceTable, priceOf, evalDir,
        runId: `${CAMPAIGN_ID}-${stamp}-${task.id}-${arm.id}-r${replicate}`, reservation: { usd: 0.5, providerInvocations: 40 },
      }, {
        arm, frozen: { task: { id: task.id, baseRevision: 'queue-bench', publicFixtureDigest: digestOf(task.caseDir), environmentDigest: task.environment.digest }, runtime },
        task: { id: task.id, fixtureVersion: '1', workspace: { source: '', baseRevision: 'queue-bench', sandbox: vm ? 'vm-isolated' : 'os-isolated-process' }, userRequest: task.prompt, budget: { wallTimeMs: task.wallTimeMs } },
        replicates: [replicate],
      });
      armReports.push(report);
      const slot = report.slots[0];
      const line = slot.kind === 'evaluated'
        ? `${slot.attempt.outcome} cost=$${(slot.attempt.historicalCostUsd ?? NaN).toFixed(4)} ${Math.round(slot.attempt.wallTimeMs / 1000)}s ${slot.attempt.candidateKey}${slot.reused ? ' (reused)' : ''}`
        : slot.kind;
      console.log(`r${replicate} ${task.id} ${arm.id}: ${line}`);
      const list = results.get(`${task.id}/${arm.id}`) ?? [];
      if (slot.kind === 'evaluated') list.push(slot.attempt);
      results.set(`${task.id}/${arm.id}`, list);
      if (slot.kind === 'campaign-budget-exhausted') break;
    }
  }
}

// The filtered credential copy is not needed after the last execution.
rmSync(authFile, { force: true });

const units = tasks.map((task) => ({ taskId: task.id, repositoryId: 'queue', current: results.get(`${task.id}/auto`) ?? [], candidate: results.get(`${task.id}/sol`) ?? [] }));
const report = buildReport({ manifest: campaign.manifest(), units, armReports });
const summary = {
  verdict: report.verdict, reasons: report.reasons, checks: report.checks, evidence: report.evidence, metrics: report.metrics, ledger: campaign.ledger().totals(),
  perTask: Object.fromEntries([...results].map(([key, attempts]) => [key, attempts.map((attempt) => ({ outcome: attempt.outcome, usd: attempt.historicalCostUsd, normalizedUsd: attempt.normalizedCostUsd, seconds: Math.round(attempt.wallTimeMs / 1000), served: attempt.candidateKey, fallbacks: attempt.fallbackCount, switches: attempt.modelSwitches, cacheReadShare: attempt.cacheReadShare }))])),
};
const out = join(evalDir, 'reports', `${CAMPAIGN_ID}-${stamp}.summary.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
console.log(`summary: ${out}`);
