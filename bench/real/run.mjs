#!/usr/bin/env node
// Campaign driver for the real-repository bench (tantivy, saleor, wealthfolio).
//
//   node bench/real/run.mjs                              print the task list and the preflight matrix
//   node bench/real/run.mjs --dry                        free: scripted agents (the true fix, and no change)
//   node bench/real/run.mjs --run --baseline <model> --approval "<text>" [--limit-usd N] [--replicates N] [--tasks a,b]
//                                                        paid: router/auto (candidate) against a fixed baseline
//   node bench/real/run.mjs --run --candidate-policy cheapest-sufficient --approval "<text>" [...]
//                                                        paid: the candidate routing policy against router/auto
//
// Every run uses a micro-VM: the agent tools and the hidden tests run in a guest with no
// credentials, and only a Rust run can reach the crate registry hosts. Tasks come from the
// validation files that `validate.mjs` writes: the hidden tests fail on the base and pass on the fix.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels } from '@earendil-works/pi-ai/compat';
import { runFixedArm } from '../../eval/arm-runner.ts';
import { CampaignStore, preflightMatrix } from '../../eval/budget.ts';
import { cargoGraderRuntimeDigest, cargoTestOracle, cargoTestOracleDigest } from '../../eval/cargo-oracle.ts';
import { EnvironmentCache } from '../../eval/environment-cache.ts';
import { FileEvidenceStore } from '../../eval/evidence-store.ts';
import { FileGradeStore } from '../../eval/grade-store.ts';
import { HostPiAgentRunner } from '../../eval/host-pi-runner.ts';
import { digestOf } from '../../eval/recipe.ts';
import { buildReport } from '../../eval/report.ts';
import { piInvocation } from '../../eval/runner.ts';
import { pytestGraderRuntimeDigest, pytestOracle, pytestOracleDigest } from '../../eval/pytest-oracle.ts';
import { vmSandboxFactory } from '../../eval/vm-sandbox.ts';
import { evalDir, git, hiddenTestsFor, makeTree, REPOS, root, sandboxOptions } from './lib.mjs';

const arg = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const dry = process.argv.includes('--dry');
const run = process.argv.includes('--run');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const replicateCount = Number(arg('--replicates') ?? (dry ? 1 : 3));
if (!Number.isInteger(replicateCount) || replicateCount < 1) throw new Error('--replicates must be a positive integer');
const replicates = Array.from({ length: replicateCount }, (_, i) => i + 1);
const only = arg('--tasks')?.split(',');
const text = (command, args) => execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const workingTreeIdentity = () => {
  const untracked = text('git', ['ls-files', '--others', '--exclude-standard', '--', 'extensions', 'eval']).split('\n').filter(Boolean);
  const content = untracked.map((path) => `${path}\0${readFileSync(join(repoRoot, path))}`).join('\0');
  return `${text('git', ['rev-parse', 'HEAD'])}+${digestOf(text('git', ['diff', 'HEAD', '--', 'extensions', 'eval']) + content)}`.slice(0, 80);
};

// ── Tasks from the validation files ────────────────────────────────────────
const validationDir = join(root, 'validation');
const tasks = readdirSync(validationDir).filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(validationDir, name), 'utf8')))
  .filter((record) => record.valid && (!only || only.includes(`${record.repo}-${record.fix.slice(0, 10)}`)))
  .sort((a, b) => `${a.repo}${a.fix}`.localeCompare(`${b.repo}${b.fix}`))
  .map((record) => ({
    ...record,
    id: `${record.repo}-${record.fix.slice(0, 10)}`,
    prompt: `Bug report: ${record.subject.replace(/\s*\(#\d+\)(\s*\(#\d+\))*\s*$/, '')}\n\nFind the cause in the source code and fix it. Add a regression test that fails before your fix. Run the tests that you changed or added, and make sure they pass. Do not ask for approval; complete the work.`,
    wallTimeMs: 1_500_000,
  }));
console.log(`${tasks.length} tasks: ${Object.entries(Object.groupBy(tasks, (t) => t.repo)).map(([repo, list]) => `${repo}=${list.length}`).join(' ')}`);
if (tasks.length === 0) throw new Error('the task selection is empty');

const baseline = arg('--baseline');
const candidatePolicy = arg('--candidate-policy');
const budgetUsd = Number(arg('--limit-usd') ?? 0);
if (candidatePolicy && candidatePolicy !== 'cheapest-sufficient') throw new Error(`unknown candidate policy: ${candidatePolicy}`);
// arms[0] is the candidate and arms[1] the current policy of the report.
const arms = dry
  ? [
    { id: 'scripted-truefix', policy: { kind: 'fixed-candidate', candidateKey: 'scripted/truefix' }, continuation: 'normal-policy' },
    { id: 'scripted-nochange', policy: { kind: 'fixed-candidate', candidateKey: 'scripted/nochange' }, continuation: 'normal-policy' },
  ]
  : candidatePolicy
    ? [
      { id: candidatePolicy, policy: { kind: 'shadow-selector', selectorVersion: candidatePolicy }, continuation: 'normal-policy' },
      { id: 'auto', policy: { kind: 'current-auto' }, continuation: 'normal-policy' },
    ]
    : [
      { id: 'auto', policy: { kind: 'current-auto' }, continuation: 'normal-policy' },
      { id: 'baseline', policy: { kind: 'fixed-candidate', candidateKey: baseline ?? 'unset/unset' }, continuation: 'normal-policy' },
    ];
const retryPolicy = { maxProviderRetriesPerAttempt: 0, maxOperationalRerunsPerSlot: 1, retryableStatuses: ['provider-error', 'sandbox-error'] };
const armOrder = (taskIndex, replicate) => (taskIndex + replicate) % 2 === 0 ? arms : [...arms].reverse();
const plannedRunOrder = replicates.flatMap((replicate) => tasks.flatMap((task, taskIndex) => armOrder(taskIndex, replicate).map((arm) => ({ task: task.id, replicate, arm: arm.id }))));
const matrix = preflightMatrix({ taskCount: tasks.length, wholeTaskArms: arms.length, probesPerTask: 0, repetitions: replicates.length, retryPolicy, providerCallsPerExecution: 60, usdPerExecution: 0.4 });
console.log('preflight matrix', JSON.stringify(matrix));
if (!dry && !run) process.exit(0);
if (run && ((!baseline && !candidatePolicy) || !arg('--approval'))) {
  throw new Error('A paid run needs --baseline <provider/model> or --candidate-policy <name>, and --approval "<who approved which arms, replicates, and limit>"');
}
if (run && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new Error('A paid run needs --limit-usd greater than zero');
if (run) {
  const relevantStatus = text('git', ['status', '--porcelain', '--', 'extensions', 'eval', 'bench/real', 'package.json', 'tsconfig.eval.json']);
  if (relevantStatus) throw new Error(`A paid run needs a clean routing and evaluation tree. Commit or revert:\n${relevantStatus}`);
}

// ── Sandboxes: one factory for each repository ─────────────────────────────
const factories = {};
for (const repo of new Set(tasks.map((task) => task.repo))) factories[repo] = await vmSandboxFactory(sandboxOptions(repo));

// ── Oracles ────────────────────────────────────────────────────────────────
for (const task of tasks) {
  const factory = factories[task.repo];
  const { dir } = REPOS[task.repo];
  task.hiddenTests = hiddenTestsFor(task.repo, task.base, task.fix).hidden;
  const common = { taskId: task.id, oracleVersion: 'real-bench-v1', hidden: task.hiddenTests, runIn: factory, minPassed: Math.max(1, task.atFix.passed) };
  if (REPOS[task.repo].lang === 'python') {
    const options = { ...common, pytestArgs: task.cargoArgs };
    Object.assign(task, { oracle: pytestOracle(options), oracleDigest: pytestOracleDigest(options), graderDigest: pytestGraderRuntimeDigest(factory) });
  } else {
    const options = { ...common, cargoArgs: task.cargoArgs };
    Object.assign(task, { oracle: cargoTestOracle(options), oracleDigest: cargoTestOracleDigest(options), graderDigest: cargoGraderRuntimeDigest(factory) });
  }
  task.fixFiles = task.source.map((path) => ({ path, content: git(dir, ['show', `${task.fix}:${path}`]) }));
}

// ── Campaign ───────────────────────────────────────────────────────────────
const CAMPAIGN_ID = arg('--campaign') ?? (dry ? 'real-dry-1' : 'real-probe-1');
const manifest = {
  campaignId: CAMPAIGN_ID, taskSetDigest: digestOf(tasks.map((task) => ({ id: task.id, repository: task.repo, baseRevision: task.base, fixRevision: task.fix, prompt: task.prompt, oracleDigest: task.oracleDigest, graderRuntimeDigest: task.graderDigest }))), repositorySplitDigest: digestOf(tasks.map((task) => task.repo)), candidatePoolDigest: digestOf(arms), executionOrderDigest: digestOf(plannedRunOrder),
  policyDigests: { current: digestOf(arms[1]), candidate: digestOf(arms[0]) },
  repetitionsPerTask: replicates.length, confidenceLevel: 0.95, intervalMethod: 'paired-task-bootstrap', rareEventBoundMethod: 'one-sided-clopper-pearson',
  margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.2, maxNormalizedCostRatio: 1 },
  minimumEvidence: { distinctTasks: 10, distinctRepositories: 2, usablePairedTasks: 10 },
  unsafeCheapGate: { mode: 'conditional-when-available', independentUnit: 'task', minimumEligibleUnits: 10, maxUnsafeCheapUnitRate: 0.2 },
  reusePolicy: { mode: 'opaque-model-max-age', maxAgeMs: 24 * 3600_000 },
  evidenceSelectionPolicy: { reuse: { mode: 'opaque-model-max-age', maxAgeMs: 24 * 3600_000 }, choose: 'freshest-compatible', cutoffAt: '2999-01-01T00:00:00Z' },
  oracleDigest: digestOf(tasks.map((task) => task.oracleDigest)), graderRuntimeDigest: digestOf(tasks.map((task) => task.graderDigest)), normalizedPriceDigest: 'see-price-table',
  retryPolicy, budget: { ...(budgetUsd > 0 ? { maxNewEvidenceUsd: budgetUsd } : {}), maxProviderInvocations: 20_000, maxWallClockMs: 86_400_000, maxNewExecutions: matrix.maxExecutionsWithReruns + 10 },
};
const campaign = new CampaignStore(evalDir, CAMPAIGN_ID);
let priceTable = { digest: 'none', prices: {} };
let priceOf;
let runtime = Object.fromEntries(['piRevision', 'pi8Commit', 'configDigest', 'benchmarkStoreDigest', 'candidateRegistryDigest', 'providerEndpointDigest', 'systemPromptDigest', 'toolsetDigest', 'generationParametersDigest'].map((key) => [key, 'dry-run']));
let prepared;
let snapshotDir;
let authFile;
if (run) {
  const home = homedir();
  prepared = join(evalDir, 'prepared', CAMPAIGN_ID);
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(join(prepared, 'pi8-template'), { recursive: true });
  const store = join(home, '.pi', 'agent', 'pi8');
  cpSync(join(store, 'benchmarks.json'), join(prepared, 'pi8-template', 'benchmarks.json'));
  cpSync(join(store, 'embedding'), join(prepared, 'pi8-template', 'embedding'), { recursive: true });
  const config = JSON.parse(readFileSync(join(store, 'config.json'), 'utf8'));
  delete config.artificialAnalysisApiKey;
  config.models = ['openai-codex/*', 'deepseek/*'];
  writeFileSync(join(prepared, 'pi8-template', 'config.json'), JSON.stringify(config, null, 2));
  const models = ['openai-codex', 'deepseek'].flatMap((provider) => getModels(provider).map((model) => ({ provider, model })));
  const prices = Object.fromEntries(models.map(({ provider, model }) => [`${provider}/${model.id}`, { inputPer1M: model.cost?.input, outputPer1M: model.cost?.output, cacheReadPer1M: model.cost?.cacheRead, cacheWritePer1M: model.cost?.cacheWrite }]));
  priceTable = { digest: digestOf(prices), prices };
  priceOf = (provider, modelId) => prices[`${provider}/${modelId}`];
  manifest.normalizedPriceDigest = priceTable.digest;
  runtime = {
    piRevision: text('pi', ['--version']),
    // Uncommitted changes count by content, so two different edits of one file never share an identity.
    pi8Commit: workingTreeIdentity(),
    configDigest: digestOf(config), benchmarkStoreDigest: digestOf(readFileSync(join(prepared, 'pi8-template', 'benchmarks.json'), 'utf8')),
    candidateRegistryDigest: digestOf(models), providerEndpointDigest: digestOf(['openai-codex', 'deepseek']),
    systemPromptDigest: 'pi-default', toolsetDigest: 'pi-default+vm-tools', generationParametersDigest: 'pi-default',
  };
  // A later analysis reads the model qualities that routing saw. The prepared directory is rebuilt on each
  // start, so the snapshot is kept apart under its digest and never removed.
  snapshotDir = join(evalDir, 'snapshots', digestOf({ benchmark: runtime.benchmarkStoreDigest, config: runtime.configDigest, registry: runtime.candidateRegistryDigest }));
  mkdirSync(snapshotDir, { recursive: true });
  cpSync(join(prepared, 'pi8-template', 'benchmarks.json'), join(snapshotDir, 'benchmarks.json'));
  cpSync(join(prepared, 'pi8-template', 'config.json'), join(snapshotDir, 'config.json'));
  writeFileSync(join(snapshotDir, 'registry.json'), `${JSON.stringify(models, null, 2)}\n`);
  writeFileSync(join(snapshotDir, 'normalized-prices.json'), `${JSON.stringify(priceTable, null, 2)}\n`);
}
try {
  campaign.freeze(manifest);
} catch (error) {
  // Resume only the exact frozen campaign. A reused id with changed arms, tasks, prices, or limits
  // must stop before it can spend money under the old manifest.
  if (digestOf(campaign.manifest()) !== digestOf(manifest)) throw error;
}
campaign.savePreflight(matrix);
campaign.approve(dry ? 'operator (free dry run with scripted agents)' : `operator (${arg('--approval')})`);
if (run) {
  const auth = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8'));
  authFile = join(prepared, 'auth.json');
  writeFileSync(authFile, JSON.stringify({ 'openai-codex': auth['openai-codex'], deepseek: auth.deepseek }), { mode: 0o600 });
  process.once('exit', () => rmSync(authFile, { force: true }));
}

// ── Execution ──────────────────────────────────────────────────────────────
const evidenceStore = new FileEvidenceStore(evalDir);
const gradeStore = new FileGradeStore(evalDir);
const cache = new EnvironmentCache(evalDir);
for (const task of tasks) {
  task.environment = await cache.resolve(
    { baseRevision: task.base, lockfileDigest: '', containerImageDigest: factories[task.repo].identity, publicSetupDigest: task.id, toolchainDigest: 'vm', sandboxProfileDigest: factories[task.repo].identity },
    async (staging) => makeTree(task.repo, task.base, staging),
  );
}

const scriptedRunner = (task, arm) => ({
  async run(input) {
    if (arm.policy.candidateKey === 'scripted/truefix') for (const file of task.fixFiles) writeFileSync(join(input.sandbox.workDir, file.path), file.content);
    return { exit: 'completed' };
  },
});

const stamp = Date.now();
const results = new Map();
const armReports = [];
const runOrder = [];
for (const replicate of replicates) {
  for (const [taskIndex, task] of tasks.entries()) {
    // Counterbalance arm order. Provider drift or machine load must not always favor one arm.
    const orderedArms = armOrder(taskIndex, replicate);
    for (const arm of orderedArms) {
      runOrder.push({ task: task.id, replicate, arm: arm.id });
      const runner = dry
        ? scriptedRunner(task, arm)
        : new HostPiAgentRunner({
          repoRoot, vm: factories[task.repo], authFile, pi8Template: join(prepared, 'pi8-template'),
          invocation: (input, sessionDir) => piInvocation({ task: { ...input.task, userRequest: task.prompt }, arm: input.arm }, repoRoot, sessionDir),
        });
      const report = await runFixedArm({
        manifest: campaign.manifest(), ledger: campaign.ledger(), evidenceStore, gradeStore, runner, sandboxFactory: factories[task.repo],
        environmentPath: task.environment.path, oracle: task.oracle, oracleDigest: task.oracleDigest, graderRuntimeDigest: task.graderDigest,
        priceTable, ...(priceOf ? { priceOf } : {}), evalDir,
        runId: `${CAMPAIGN_ID}-${stamp}-${task.id}-${arm.id}-r${replicate}`, reservation: { ...(run ? { usd: 1.5 } : {}), providerInvocations: 100 },
      }, {
        arm, frozen: { task: { id: task.id, baseRevision: task.base, publicFixtureDigest: digestOf(task.id), environmentDigest: task.environment.digest }, runtime },
        task: { id: task.id, fixtureVersion: '1', workspace: { source: '', baseRevision: task.base, sandbox: 'vm-isolated' }, userRequest: task.prompt, budget: { wallTimeMs: task.wallTimeMs } },
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
if (authFile) rmSync(authFile, { force: true });
if (digestOf(runOrder) !== digestOf(plannedRunOrder)) throw new Error('execution order did not match the frozen campaign order');

const units = tasks.map((task) => ({ taskId: task.id, repositoryId: task.repo, current: results.get(`${task.id}/${arms[1].id}`) ?? [], candidate: results.get(`${task.id}/${arms[0].id}`) ?? [] }));
const report = buildReport({ manifest: campaign.manifest(), units, armReports });
const summary = {
  purpose: candidatePolicy ? 'development' : dry ? 'harness-check' : 'fixed-baseline-probe',
  diagnosticVerdict: report.verdict,
  activationVerdict: candidatePolicy ? null : report.verdict,
  reasons: report.reasons, checks: report.checks, evidence: report.evidence, metrics: report.metrics, ledger: campaign.ledger().totals(),
  arms: { candidate: arms[0].id, current: arms[1].id }, runtime, ...(snapshotDir ? { snapshotDir } : {}), runOrder,
  taskSet: tasks.map((task) => ({ id: task.id, repository: task.repo, baseRevision: task.base, fixRevision: task.fix, subject: task.subject, prompt: task.prompt, oracleDigest: task.oracleDigest, graderRuntimeDigest: task.graderDigest })),
  perTask: Object.fromEntries([...results].map(([key, attempts]) => [key, attempts.map((a) => ({ outcome: a.outcome, usd: a.historicalCostUsd, normalizedUsd: a.normalizedCostUsd, seconds: Math.round(a.wallTimeMs / 1000), served: a.candidateKey, fallbacks: a.fallbackCount, escalations: a.capabilityEscalations, switches: a.modelSwitches, cacheReadShare: a.cacheReadShare, servedModels: a.servedModels }))])),
};
const out = join(evalDir, 'reports', `${CAMPAIGN_ID}-${stamp}.summary.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ purpose: summary.purpose, diagnosticVerdict: summary.diagnosticVerdict, activationVerdict: summary.activationVerdict, reasons: summary.reasons, checks: summary.checks, evidence: summary.evidence }, null, 1));
console.log(`summary: ${out}`);
