/**
 * Clean whole-task runner. One execution runs in a fresh sandbox with a fresh
 * Pi session and a sandbox-local PI8_DIR, from the immutable public
 * environment. The harness then captures the final artifact, the decision
 * log, and the session. Grading is a separate step.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY_VERSION_ENV } from '../extensions/routing/policy/policy-version.ts';
import { copyTreeSafely, digestDirectory } from './fs-util.ts';
import { policyDigest } from './recipe.ts';
import { readRawUsage, type PriceSnapshotSource } from './spend.ts';
import {
  BASE_ETC_ENTRIES, BASE_READ_ONLY_PATHS, createSandbox, SANDBOX_HOME, SANDBOX_OUT,
  type SandboxFactory, type SandboxProfile, type SecureSandbox,
} from './sandbox.ts';
import type {
  CompletedExecutionV1, DeploymentProvenance, EvaluationArm, ExecutionRecipeV1, ExecutionStatus, FinalArtifact, PublicTaskSpec,
} from './schema.ts';

export type AgentExit = 'completed' | 'budget' | 'provider-error' | 'harness-error';

export interface AgentRunInput {
  sandbox: SecureSandbox;
  task: PublicTaskSpec;
  recipe: ExecutionRecipeV1;
  /** The arm that the recipe came from. Its policy digest must equal the recipe policy digest. */
  arm: EvaluationArm;
  /** Host directory for the files of this run. */
  runDir: string;
}

export interface AgentRunOutput {
  exit: AgentExit;
  sessionPath?: string;
  decisionLogPath?: string;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

export interface EvaluationProfileOptions {
  repoRoot: string;
  /** Root of the Node installation that has the `pi` command. */
  nodeRoot: string;
  /** Host path of the provider credential file. The sandbox gets a copy. */
  authFile?: string;
  /** More host paths for the sandbox, such as another extension. */
  extraReadOnlyPaths?: string[];
  network?: 'host' | 'none';
}

/** The sandbox profile for a run of the extension. It lists only the files that the extension needs. */
export function evaluationProfile(options: EvaluationProfileOptions): SandboxProfile {
  const { repoRoot, nodeRoot } = options;
  const extension = ['index.ts', 'package.json', 'extensions', 'node_modules'].map((name) => join(repoRoot, name)).filter(existsSync);
  return {
    readOnlyPaths: [...BASE_READ_ONLY_PATHS, nodeRoot, ...extension, ...(options.extraReadOnlyPaths ?? [])],
    etcEntries: BASE_ETC_ENTRIES,
    credentialFiles: options.authFile ? [{ from: options.authFile, to: '.pi/agent/auth.json' }] : [],
    env: { PATH: `${nodeRoot}/bin:/usr/bin:/bin`, TERM: 'dumb' },
    network: options.network ?? 'host',
  };
}

export interface PiInvocation {
  command: string;
  args: string[];
  /** Environment variables for the `pi` process, in addition to the ones that the runner sets. */
  env?: Record<string, string>;
}

/**
 * The `pi` command line for one arm. A router arm loads the extension. The `cheapest-sufficient` selector
 * arm also names the candidate policy in the environment. A fixed candidate does not load the extension.
 * With `userExtensions`, Pi loads the user's own settings and packages, which already name the router,
 * so the command line names no extension.
 */
export function piInvocation(input: Pick<AgentRunInput, 'task' | 'arm'>, repoRoot: string, sessionDir = `${SANDBOX_OUT}/sessions`, options: { userExtensions?: boolean } = {}): PiInvocation {
  const { policy } = input.arm;
  const base = options.userExtensions ? ['--session-dir', sessionDir] : ['-ne', '--session-dir', sessionDir];
  let model: string;
  const extensions: string[] = [];
  let env: Record<string, string> | undefined;
  if (policy.kind === 'current-auto') {
    model = 'router/auto';
    if (!options.userExtensions) extensions.push('-e', repoRoot);
  } else if (policy.kind === 'shadow-selector' && policy.selectorVersion === 'cheapest-sufficient') {
    model = 'router/auto';
    if (!options.userExtensions) extensions.push('-e', repoRoot);
    env = { [POLICY_VERSION_ENV]: policy.selectorVersion };
  } else if (policy.kind === 'fixed-candidate') {
    model = policy.candidateKey;
  } else {
    throw new Error(`the whole-task runner does not run the ${policy.kind} policy`);
  }
  return { command: 'pi', args: [...base, ...extensions, '--model', model, '-p', input.task.userRequest], ...(env ? { env } : {}) };
}

export interface PiAgentRunnerOptions {
  repoRoot: string;
  /** Host directory with the router config and benchmark store. The run gets a copy. */
  pi8Template?: string;
  /** Replaces the `pi` command line. Tests use it. */
  invocation?: (input: AgentRunInput) => PiInvocation;
}

export class PiAgentRunner implements AgentRunner {
  private readonly options: PiAgentRunnerOptions;

  constructor(options: PiAgentRunnerOptions) {
    this.options = options;
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    if (policyDigest(input.arm) !== (input.recipe.execution.kind === 'whole-task' ? input.recipe.execution.policyDigest : undefined)) {
      throw new Error('the arm does not match the recipe');
    }
    const { sandbox } = input;
    // A fresh router state: the run gets its own copy of the config and the benchmark store.
    const pi8 = join(sandbox.outDir, 'pi8');
    mkdirSync(pi8, { recursive: true });
    if (this.options.pi8Template) cpSync(this.options.pi8Template, pi8, { recursive: true });
    mkdirSync(join(sandbox.outDir, 'sessions'), { recursive: true });
    const { command, args, env } = (this.options.invocation ?? ((value) => piInvocation(value, this.options.repoRoot)))(input);
    const result = await sandbox.run({
      command,
      args,
      timeoutMs: input.task.budget.wallTimeMs,
      env: { PI8_DIR: `${SANDBOX_OUT}/pi8`, HOME: SANDBOX_HOME, ...env },
    });
    return agentOutput(result, readSessionFacts(join(sandbox.outDir, 'sessions')));
  }
}

/** The agent exit and the file paths of a finished `pi` process. */
export function agentOutput(result: { timedOut: boolean; code: number | null }, facts: SessionFacts): AgentRunOutput {
  let exit: AgentExit;
  if (result.timedOut) exit = 'budget';
  else if (result.code === 0) exit = 'completed';
  else exit = facts.lastStopReason === 'error' ? 'provider-error' : 'harness-error';
  return {
    exit,
    ...(facts.sessionPath ? { sessionPath: facts.sessionPath } : {}),
    ...(facts.decisionLogPath ? { decisionLogPath: facts.decisionLogPath } : {}),
  };
}

// ── Facts that the harness reads from the session and the decision log ───

export interface SessionFacts {
  sessionPath?: string;
  decisionLogPath?: string;
  deployments: DeploymentProvenance[];
  servedTarget?: string;
  providerFailures: number;
  fallbackCount: number;
  capabilityEscalations: number;
  lastStopReason?: string;
  /** The `policyVersion` of each routing decision record. A legacy record has none. */
  policyVersions: Array<string | undefined>;
}

function jsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export function readSessionFacts(sessionsDir: string): SessionFacts {
  const files = existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : [];
  const session = files.find((name) => name.endsWith('.jsonl') && !name.includes('.router-'));
  const log = files.find((name) => name.endsWith('.router-decisions.jsonl'));
  const facts: SessionFacts = { deployments: [], providerFailures: 0, fallbackCount: 0, capabilityEscalations: 0, policyVersions: [] };
  if (session) {
    facts.sessionPath = join(sessionsDir, session);
    const seen = new Set<string>();
    for (const entry of jsonLines(facts.sessionPath) as Array<{ type?: string; timestamp?: string; message?: Record<string, unknown> }>) {
      const message = entry.message;
      if (entry.type !== 'message' || message?.role !== 'assistant') continue;
      const provider = String(message.provider ?? '');
      const modelId = String(message.model ?? '');
      facts.servedTarget = `${provider}/${modelId}`;
      facts.lastStopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
      if (message.stopReason === 'error') facts.providerFailures += 1;
      const key = `${provider}/${modelId}`;
      if (!seen.has(key)) {
        seen.add(key);
        facts.deployments.push({ provider, modelId, observedAt: entry.timestamp ?? new Date().toISOString() });
      }
    }
  }
  if (log) {
    facts.decisionLogPath = join(sessionsDir, log);
    for (const record of jsonLines(facts.decisionLogPath) as Array<{ kind?: string; viaFallback?: boolean; cause?: string; policyVersion?: string }>) {
      if (record.kind !== undefined && record.kind !== 'decision') continue;
      facts.policyVersions.push(record.policyVersion);
      if (record.viaFallback) facts.fallbackCount += 1;
      if (record.cause === 'capability-escalation' || record.cause === 'trajectory-escalation') facts.capabilityEscalations += 1;
    }
  }
  return facts;
}

const sha256File = (path: string | undefined): string =>
  createHash('sha256').update(path && existsSync(path) ? readFileSync(path) : '').digest('hex');

/**
 * Copy the task directory to the run directory and name it by digest. Dependency directories
 * are not part of the artifact. The candidate wrote the directory, so the copy drops every
 * entry that could reach a host path or block a read.
 */
export function captureArtifact(workDir: string, runDir: string): FinalArtifact {
  const path = join(runDir, 'artifact');
  const { dropped } = copyTreeSafely(workDir, path, ['node_modules']);
  return {
    digest: digestDirectory(path), path, regradeable: true, stateKinds: ['git-worktree', 'untracked-files'],
    ...(dropped.length > 0 ? { droppedEntries: dropped } : {}),
  };
}

/**
 * True when a completed run of a router arm ran the policy that the arm names. A router arm must
 * leave at least one routing decision, and every decision must carry the version of the arm: none for
 * `current-auto`, the selector version for a selector arm. Otherwise the variable that selects the
 * policy did not reach the process, and the run measured the wrong policy.
 */
export function ranArmPolicy(arm: EvaluationArm, facts: Pick<SessionFacts, 'policyVersions'>): boolean {
  const { policy } = arm;
  const expected = policy.kind === 'current-auto' ? undefined
    : policy.kind === 'shadow-selector' ? policy.selectorVersion
      : null;
  if (expected === null) return true;
  return facts.policyVersions.length > 0 && facts.policyVersions.every((version) => version === expected);
}

const STATUS_OF_EXIT: Record<AgentExit, ExecutionStatus> = {
  completed: 'completed',
  budget: 'task-budget-exhausted',
  'provider-error': 'provider-error',
  'harness-error': 'sandbox-error',
};

export interface WholeTaskParams {
  runner: AgentRunner;
  /** The profile of a process sandbox. A run needs it when it has no sandbox factory. */
  profile?: SandboxProfile;
  /** Makes the sandbox for the run. It replaces the process sandbox that `profile` describes. */
  sandboxFactory?: SandboxFactory;
  task: PublicTaskSpec;
  recipe: ExecutionRecipeV1;
  arm: EvaluationArm;
  /** Host path of the immutable public environment. The sandbox gets a copy. */
  environmentPath: string;
  runDir: string;
  runId: string;
  /** The registry price of each model at run time. A run without the router needs it for the historical cost. */
  priceOf?: PriceSnapshotSource;
}

export interface WholeTaskOutput {
  result: CompletedExecutionV1;
  files: { trajectoryPath?: string; decisionLogPath?: string };
}

/** Run one whole-task execution in a fresh sandbox, then capture the evidence. */
export async function runWholeTask(params: WholeTaskParams): Promise<WholeTaskOutput> {
  const startedAt = new Date();
  mkdirSync(params.runDir, { recursive: true });
  const { profile, sandboxFactory } = params;
  if (!sandboxFactory && !profile) throw new Error('a run needs a sandbox profile or a sandbox factory');
  const sandbox = sandboxFactory ? await sandboxFactory(params.environmentPath) : createSandbox(profile as SandboxProfile, params.environmentPath);
  try {
    const output = await params.runner.run({ sandbox, task: params.task, recipe: params.recipe, arm: params.arm, runDir: params.runDir });
    // The candidate process and all model calls are finished. Capture the evidence from the host.
    const facts = readSessionFacts(join(sandbox.outDir, 'sessions'));
    // The sandbox is destroyed below. Keep the session and the decision log in the run directory first.
    if (facts.sessionPath) cpSync(facts.sessionPath, join(params.runDir, 'session.jsonl'));
    if (facts.decisionLogPath) cpSync(facts.decisionLogPath, join(params.runDir, 'decisions.jsonl'));
    const artifact = captureArtifact(sandbox.workDir, params.runDir);
    const endedAt = new Date();
    const result: CompletedExecutionV1 = {
      status: output.exit === 'completed' && !ranArmPolicy(params.arm, facts) ? 'sandbox-error' : STATUS_OF_EXIT[output.exit],
      provenance: { producedByRunId: params.runId, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
      deployment: facts.deployments,
      ...(facts.servedTarget ? { servedTarget: facts.servedTarget } : {}),
      finalArtifact: artifact,
      decisionLogDigest: sha256File(facts.decisionLogPath),
      realizedTrajectoryDigest: sha256File(facts.sessionPath),
      realizedWorkspaceDigest: artifact.digest,
      rawUsage: readRawUsage({
        ...(facts.decisionLogPath ? { decisionLogPath: facts.decisionLogPath } : {}),
        ...(facts.sessionPath ? { sessionPath: facts.sessionPath } : {}),
        ...(params.priceOf ? { priceOf: params.priceOf } : {}),
      }),
      wallTimeMs: endedAt.getTime() - startedAt.getTime(),
      providerFailures: facts.providerFailures,
      fallbackCount: facts.fallbackCount,
      capabilityEscalations: facts.capabilityEscalations,
    };
    return {
      result,
      files: {
        ...(facts.sessionPath ? { trajectoryPath: join(params.runDir, 'session.jsonl') } : {}),
        ...(facts.decisionLogPath ? { decisionLogPath: join(params.runDir, 'decisions.jsonl') } : {}),
      },
    };
  } finally {
    await sandbox.destroy();
  }
}
