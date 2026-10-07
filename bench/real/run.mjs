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
// Each execution runs `pi` on the host in a new task directory, with the user's own settings,
// extensions, and credentials (`eval/host-dir-sandbox.ts`). A private mount namespace hides the
// evaluation store, the session history, and the Claude Code history, so the agent cannot read the
// hidden tests or the clones that hold the fix commits. The host grades each artifact with the hidden
// tests. This is a development run: it is never activation evidence. Tasks come from the validation
// files that `validate.mjs` writes: the hidden tests fail on the base and pass on the fix. A Python task
// needs a database on the host, so only `--include-python` selects one.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixedArm } from '../../eval/arm-runner.ts';
import { CampaignStore, preflightMatrix } from '../../eval/budget.ts';
import { cargoGraderRuntimeDigest, cargoTestOracle, cargoTestOracleDigest } from '../../eval/cargo-oracle.ts';
import { EnvironmentCache } from '../../eval/environment-cache.ts';
import { FileEvidenceStore } from '../../eval/evidence-store.ts';
import { FileGradeStore } from '../../eval/grade-store.ts';
import { HostDirPiRunner } from '../../eval/host-dir-runner.ts';
import { hostDirSandboxFactory } from '../../eval/host-dir-sandbox.ts';
import { digestOf } from '../../eval/recipe.ts';
import { REGISTRY_SNAPSHOT_ENV } from '../../eval/registry-snapshot-extension.ts';
import { buildReport } from '../../eval/report.ts';
import { pytestGraderRuntimeDigest, pytestOracle, pytestOracleDigest } from '../../eval/pytest-oracle.ts';
import { evalDir, git, hiddenTestsFor, makeTree, REPOS, root } from './lib.mjs';

const arg = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const dry = process.argv.includes('--dry');
const run = process.argv.includes('--run');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const replicateCount = Number(arg('--replicates') ?? (dry ? 1 : 3));
if (!Number.isInteger(replicateCount) || replicateCount < 1) throw new Error('--replicates must be a positive integer');
const replicates = Array.from({ length: replicateCount }, (_, i) => i + 1);
const only = arg('--tasks')?.split(',');
const includePython = process.argv.includes('--include-python');
const home = homedir();
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
  .filter((record) => record.valid && (includePython || REPOS[record.repo].lang !== 'python') && (!only || only.includes(`${record.repo}-${record.fix.slice(0, 10)}`)))
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

// ── Task directories ───────────────────────────────────────────────────────
const CAMPAIGN_ID = arg('--campaign') ?? (dry ? 'real-dry-1' : 'real-probe-1');
const workRoot = join(home, '.cache', 'pi8-work', CAMPAIGN_ID);
// A run that stopped early can leave a task directory. It must not be readable by a later run.
rmSync(workRoot, { recursive: true, force: true });
// The agent cannot read these paths: the evaluation store has the hidden tests and the clones with the
// fix commits, and the two histories have the sessions of earlier runs.
const hiddenPaths = [evalDir, join(home, '.pi', 'agent', 'sessions'), join(home, '.claude', 'projects')];
// The agent cannot reach these hosts: they serve the upstream repositories, the fix commits, and the
// source of published crates. Cargo still needs crates.io, so the leak scan watches that host.
const BLOCKED_HOSTS = [
  'github.com', 'www.github.com', 'api.github.com', 'codeload.github.com', 'gist.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'gist.githubusercontent.com', 'docs.rs', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'sourcegraph.com',
];
const graders = {};
for (const repo of new Set(tasks.map((task) => task.repo))) {
  // The build cache of the grader holds the hidden tests, so it stays in the evaluation store.
  graders[repo] = hostDirSandboxFactory({ workRoot: join(workRoot, 'grade'), hiddenPaths: [], env: { CARGO_TARGET_DIR: join(evalDir, 'cache', 'grade-target', repo), CARGO_TERM_COLOR: 'never' } });
}
// One build cache for each arm and repository: an arm never reads the build output of the other arm.
const agentFactories = new Map();
const agentFactory = (arm, repo) => {
  const key = `${arm.id}/${repo}`;
  if (!agentFactories.has(key)) {
    agentFactories.set(key, hostDirSandboxFactory({
      workRoot: join(workRoot, 'agent'), hiddenPaths, blockedHosts: BLOCKED_HOSTS,
      binds: { target: join(evalDir, 'cache', 'agent-target', CAMPAIGN_ID, arm.id, repo) },
      runDirEnv: { CARGO_TARGET_DIR: 'target' },
    }));
  }
  return agentFactories.get(key);
};

// ── Oracles ────────────────────────────────────────────────────────────────
for (const task of tasks) {
  const factory = graders[task.repo];
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
/** The providers and models that both router arms can serve. The user's blacklist still applies. */
const MODEL_POOL = ['openai-codex/*', 'deepseek/*', 'github-copilot/gemini*', 'claude-bridge/*', 'cursor/grok*'];
const inPool = (registryId) => MODEL_POOL.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 'i').test(registryId));
if (run) {
  prepared = join(evalDir, 'prepared', CAMPAIGN_ID);
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(join(prepared, 'pi8-template'), { recursive: true });
  const store = join(home, '.pi', 'agent', 'pi8');
  cpSync(join(store, 'benchmarks.json'), join(prepared, 'pi8-template', 'benchmarks.json'));
  // The embedding model is large and read-only. Each run gets a link, not a copy.
  symlinkSync(join(store, 'embedding'), join(prepared, 'pi8-template', 'embedding'));
  const config = JSON.parse(readFileSync(join(store, 'config.json'), 'utf8'));
  delete config.artificialAnalysisApiKey;
  config.models = MODEL_POOL;
  config.blacklist = (config.blacklist ?? []).filter((pattern) => pattern !== '*/gemini*');
  writeFileSync(join(prepared, 'pi8-template', 'config.json'), JSON.stringify(config, null, 2));

  // The registry of a Pi process with the provider extensions. pi-ai alone does not list Claude Bridge or Cursor.
  const snapshotFile = join(mkdtempSync(join(tmpdir(), 'pi8-registry-')), 'registry.json');
  const packages = join(home, '.pi', 'agent', 'git', 'github.com');
  execFileSync('pi', ['--no-extensions', '--no-tools', '--no-session',
    '-e', join(packages, 'fitchmultz', 'pi-cursor-sdk'), '-e', join(packages, 'elidickinson', 'pi-claude-bridge'),
    '-e', join(repoRoot, 'eval', 'registry-snapshot-extension.ts'), '--print', 'registry snapshot'],
  { env: { ...process.env, [REGISTRY_SNAPSHOT_ENV]: snapshotFile }, stdio: 'ignore', timeout: 120_000 });
  const models = JSON.parse(readFileSync(snapshotFile, 'utf8')).filter((model) => inPool(`${model.provider}/${model.id}`));
  rmSync(dirname(snapshotFile), { recursive: true, force: true });

  // Normalized prices. A subscription provider (Claude Bridge, Cursor) reports a price of zero. It gets the
  // list price of its benchmark row, so that the cost of the two arms stays comparable. Claude Bridge also
  // gets the cache multipliers that Anthropic publishes (read 0.1, write 1.25 of input). Another provider
  // without a cache price pays the input price for cache tokens, which is an upper bound.
  const rows = JSON.parse(readFileSync(join(store, 'benchmarks.json'), 'utf8')).models ?? [];
  const listRow = (registryId) => rows.find((row) => row.registryId === registryId && Number.isFinite(row.priceInputPer1M) && Number.isFinite(row.priceOutputPer1M));
  const baseId = (id) => id.replace(/:(fast|slow)$/, '').replace(/@[^:]*$/, '');
  const prices = {};
  const priceSources = {};
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    const cost = model.cost ?? {};
    if ((cost.input ?? 0) > 0 || (cost.output ?? 0) > 0) {
      prices[key] = { inputPer1M: cost.input, outputPer1M: cost.output, cacheReadPer1M: cost.cacheRead, cacheWritePer1M: cost.cacheWrite };
      priceSources[key] = 'registry';
      continue;
    }
    const row = listRow(`${model.provider}/${baseId(model.id)}`);
    if (!row) { priceSources[key] = 'none'; continue; }
    prices[key] = {
      inputPer1M: row.priceInputPer1M, outputPer1M: row.priceOutputPer1M,
      ...(model.provider === 'claude-bridge' ? { cacheReadPer1M: row.priceInputPer1M * 0.1, cacheWritePer1M: row.priceInputPer1M * 1.25 } : {}),
    };
    priceSources[key] = 'benchmark-list-price';
  }
  priceTable = { digest: digestOf(prices), prices };
  manifest.normalizedPriceDigest = priceTable.digest;
  // The agent cannot reach api.github.com, so Pi cannot get a new GitHub Copilot token during the campaign.
  // An execution takes about 7 minutes on average. 10 minutes for each execution leaves a margin.
  const copilot = JSON.parse(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8'))['github-copilot'];
  const plannedMs = tasks.length * replicates.length * arms.length * 10 * 60_000;
  if (copilot && (copilot.expires ?? 0) - Date.now() < plannedMs) {
    throw new Error(`the GitHub Copilot token expires before the planned end of the campaign: start Pi once with a GitHub Copilot model, then start the campaign again`);
  }
  const settings = JSON.parse(readFileSync(join(home, '.pi', 'agent', 'settings.json'), 'utf8'));
  runtime = {
    piRevision: text('pi', ['--version']),
    // Uncommitted changes count by content, so two different edits of one file never share an identity.
    pi8Commit: workingTreeIdentity(),
    configDigest: digestOf(config), benchmarkStoreDigest: digestOf(readFileSync(join(prepared, 'pi8-template', 'benchmarks.json'), 'utf8')),
    candidateRegistryDigest: digestOf(models), providerEndpointDigest: digestOf([...new Set(models.map((model) => model.provider))].sort()),
    systemPromptDigest: 'pi-default', toolsetDigest: digestOf({ packages: settings.packages ?? [], extensions: settings.extensions ?? [] }), generationParametersDigest: 'pi-default',
  };
  // A later analysis reads the model qualities that routing saw. The prepared directory is rebuilt on each
  // start, so the snapshot is kept apart under its digest and never removed.
  snapshotDir = join(evalDir, 'snapshots', digestOf({ benchmark: runtime.benchmarkStoreDigest, config: runtime.configDigest, registry: runtime.candidateRegistryDigest }));
  mkdirSync(snapshotDir, { recursive: true });
  cpSync(join(prepared, 'pi8-template', 'benchmarks.json'), join(snapshotDir, 'benchmarks.json'));
  cpSync(join(prepared, 'pi8-template', 'config.json'), join(snapshotDir, 'config.json'));
  writeFileSync(join(snapshotDir, 'registry.json'), `${JSON.stringify(models, null, 2)}\n`);
  writeFileSync(join(snapshotDir, 'normalized-prices.json'), `${JSON.stringify({ ...priceTable, sources: priceSources }, null, 2)}\n`);
  console.log(`pool: ${models.length} models, ${Object.values(priceSources).filter((source) => source === 'none').length} without a price`);
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

// ── Execution ──────────────────────────────────────────────────────────────
const evidenceStore = new FileEvidenceStore(evalDir);
const gradeStore = new FileGradeStore(evalDir);
const cache = new EnvironmentCache(evalDir);
for (const task of tasks) {
  task.environment = await cache.resolve(
    { baseRevision: task.base, lockfileDigest: '', containerImageDigest: 'host-directory', publicSetupDigest: task.id, toolchainDigest: 'host', sandboxProfileDigest: 'host-directory' },
    async (staging) => makeTree(task.repo, task.base, staging),
  );
}

const scriptedRunner = (task, arm) => ({
  async run(input) {
    if (arm.policy.candidateKey === 'scripted/truefix') for (const file of task.fixFiles) writeFileSync(join(input.sandbox.workDir, file.path), file.content);
    return { exit: 'completed' };
  },
});

/**
 * The agent cannot use these tools. The web tools and the MCP gateways can download the upstream fix. A subagent runs in a
 * child process: its tool calls are not in the session file, and its usage has no price.
 */
const EXCLUDED_TOOLS = ['*web_search*', 'fetch_content', 'get_search_content', 'source_check', '*fetch_and_index*', 'mcp', 'mcp__context_mode', 'subagent', 'subagent_supervisor', 'bg_wait', 'intercom'];
/**
 * Signs in the tool call arguments that an agent looked for the fix outside its task directory: the
 * evaluation store, the upstream repository, a published copy of the crate, or the fix commit. The
 * namespace hides the store, but bash can still reach the network. Only the arguments count: a tool
 * result can show an upstream URL that the source code contains.
 */
const leakPatterns = (task) => [
  /pi8-eval/, /real-bench/, new RegExp(task.fix.slice(0, 7)), /\bgit\b[^"]*\b(?:fetch|clone|pull|remote add)\b/,
  /(?:github\.com|githubusercontent\.com|api\.github\.com\/repos)\/[\w.-]+\/(?:tantivy|wealthfolio|saleor)/i, /\.cargo\/registry\/src\/[^"]*\/tantivy-/,
  /crates\.io\/(?:api\/v1\/)?crates\/tantivy|static\.crates\.io\/crates\/tantivy|\bcargo (?:add|install|download)\b[^"]*\btantivy/,
];
const findSessions = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('session.jsonl')).map((name) => join(dir, String(name))) : []);
/** A tool result that shows that the blocked host refused the connection. Such a call got nothing. */
const REFUSED = /Connection refused|Errno 111|ECONNREFUSED|Failed to connect|curl: \(7\)/;
const toolCallText = (path) => {
  const calls = new Map();
  const refused = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const message = JSON.parse(line).message;
    if (!Array.isArray(message?.content)) continue;
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') calls.set(part.id, `${part.name} ${JSON.stringify(part.arguments)}`);
    } else if (message.role === 'toolResult' && REFUSED.test(JSON.stringify(message.content))) {
      refused.add(message.toolCallId);
    }
  }
  return [...calls].filter(([id]) => !refused.has(id)).map(([, text]) => text).join('\n');
};
const leakHits = (task, runId) => {
  const text = findSessions(join(evalDir, 'runs', runId)).map(toolCallText).join('\n');
  return leakPatterns(task).filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
};

const stamp = Date.now();
const leaks = {};
const results = new Map();
const armReports = [];
const runOrder = [];
for (const replicate of replicates) {
  for (const [taskIndex, task] of tasks.entries()) {
    // Counterbalance arm order. Provider drift or machine load must not always favor one arm.
    const orderedArms = armOrder(taskIndex, replicate);
    for (const arm of orderedArms) {
      runOrder.push({ task: task.id, replicate, arm: arm.id });
      const runner = dry ? scriptedRunner(task, arm) : new HostDirPiRunner({ repoRoot, pi8Template: join(prepared, 'pi8-template'), excludeTools: EXCLUDED_TOOLS });
      const runId = `${CAMPAIGN_ID}-${stamp}-${task.id}-${arm.id}-r${replicate}`;
      const report = await runFixedArm({
        manifest: campaign.manifest(), ledger: campaign.ledger(), evidenceStore, gradeStore, runner, sandboxFactory: agentFactory(arm, task.repo),
        environmentPath: task.environment.path, oracle: task.oracle, oracleDigest: task.oracleDigest, graderRuntimeDigest: task.graderDigest,
        priceTable, ...(priceOf ? { priceOf } : {}), evalDir,
        runId, reservation: { ...(run ? { usd: 1.5 } : {}), providerInvocations: 100 },
      }, {
        arm, frozen: { task: { id: task.id, baseRevision: task.base, publicFixtureDigest: digestOf(task.id), environmentDigest: task.environment.digest }, runtime },
        task: { id: task.id, fixtureVersion: '1', workspace: { source: '', baseRevision: task.base, sandbox: 'host-directory' }, userRequest: task.prompt, budget: { wallTimeMs: task.wallTimeMs } },
        replicates: [replicate],
      });
      armReports.push(report);
      const slot = report.slots[0];
      const line = slot.kind === 'evaluated'
        ? `${slot.attempt.outcome} cost=$${(slot.attempt.historicalCostUsd ?? NaN).toFixed(4)} ${Math.round(slot.attempt.wallTimeMs / 1000)}s ${slot.attempt.candidateKey}${slot.reused ? ' (reused)' : ''}`
        : slot.kind;
      const hits = dry ? [] : leakHits(task, runId);
      if (hits.length > 0) leaks[`${task.id}/${arm.id}/r${replicate}`] = hits;
      console.log(`r${replicate} ${task.id} ${arm.id}: ${line}${hits.length > 0 ? ` LEAK? ${hits.join(',')}` : ''}`);
      const list = results.get(`${task.id}/${arm.id}`) ?? [];
      if (slot.kind === 'evaluated') list.push(slot.attempt);
      results.set(`${task.id}/${arm.id}`, list);
      if (slot.kind === 'campaign-budget-exhausted') break;
    }
  }
}
if (digestOf(runOrder) !== digestOf(plannedRunOrder)) throw new Error('execution order did not match the frozen campaign order');

const units = tasks.map((task) => ({ taskId: task.id, repositoryId: task.repo, current: results.get(`${task.id}/${arms[1].id}`) ?? [], candidate: results.get(`${task.id}/${arms[0].id}`) ?? [] }));
// A task with a leak in any execution leaves the comparison in both arms, so the pairs stay matched.
const excludedTasks = [...new Set(Object.keys(leaks).map((key) => key.split('/')[0]))].sort();
const report = buildReport({ manifest: campaign.manifest(), units: units.filter((unit) => !excludedTasks.includes(unit.taskId)), armReports });
const allTasksReport = excludedTasks.length > 0 ? buildReport({ manifest: campaign.manifest(), units, armReports }) : report;
const summary = {
  purpose: candidatePolicy ? 'development' : dry ? 'harness-check' : 'fixed-baseline-probe',
  diagnosticVerdict: report.verdict,
  activationVerdict: candidatePolicy ? null : report.verdict,
  reasons: report.reasons, checks: report.checks, evidence: report.evidence, metrics: report.metrics, ledger: campaign.ledger().totals(),
  arms: { candidate: arms[0].id, current: arms[1].id }, runtime, ...(snapshotDir ? { snapshotDir } : {}), runOrder, leaks, excludedTasks,
  allTasks: { verdict: allTasksReport.verdict, reasons: allTasksReport.reasons, checks: allTasksReport.checks, evidence: allTasksReport.evidence },
  taskSet: tasks.map((task) => ({ id: task.id, repository: task.repo, baseRevision: task.base, fixRevision: task.fix, subject: task.subject, prompt: task.prompt, oracleDigest: task.oracleDigest, graderRuntimeDigest: task.graderDigest })),
  perTask: Object.fromEntries([...results].map(([key, attempts]) => [key, attempts.map((a) => ({ outcome: a.outcome, usd: a.historicalCostUsd, normalizedUsd: a.normalizedCostUsd, seconds: Math.round(a.wallTimeMs / 1000), served: a.candidateKey, fallbacks: a.fallbackCount, escalations: a.capabilityEscalations, switches: a.modelSwitches, cacheReadShare: a.cacheReadShare, servedModels: a.servedModels }))])),
};
const out = join(evalDir, 'reports', `${CAMPAIGN_ID}-${stamp}.summary.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ purpose: summary.purpose, diagnosticVerdict: summary.diagnosticVerdict, activationVerdict: summary.activationVerdict, reasons: summary.reasons, checks: summary.checks, evidence: summary.evidence }, null, 1));
console.log(`summary: ${out}`);
