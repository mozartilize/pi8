/**
 * Runs `pi` in a host task directory (`host-dir-sandbox.ts`) with the user's own settings and
 * extensions. The run gets its own router state (PI8_DIR) and its own session directory, so
 * routing starts fresh and the harness reads the session and the decision log of this run only.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { policyDigest } from './recipe.ts';
import { agentOutput, piInvocation, readSessionFacts, type AgentRunInput, type AgentRunner, type AgentRunOutput } from './runner.ts';

export interface HostDirPiRunnerOptions {
  repoRoot: string;
  /** Host directory with the router config and benchmark store. The run gets a copy. */
  pi8Template: string;
  /** Variables for the `pi` process, such as a build cache path. */
  env?: Record<string, string>;
}

export class HostDirPiRunner implements AgentRunner {
  private readonly options: HostDirPiRunnerOptions;

  constructor(options: HostDirPiRunnerOptions) {
    this.options = options;
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const { sandbox } = input;
    if (sandbox.kind !== 'host-directory') throw new Error('a host directory run needs a host-directory sandbox');
    if (policyDigest(input.arm) !== (input.recipe.execution.kind === 'whole-task' ? input.recipe.execution.policyDigest : undefined)) {
      throw new Error('the arm does not match the recipe');
    }
    const pi8 = join(sandbox.outDir, 'pi8');
    cpSync(this.options.pi8Template, pi8, { recursive: true });
    const sessions = join(sandbox.outDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const { command, args, env } = piInvocation(input, this.options.repoRoot, sessions, { userExtensions: true });
    const result = await sandbox.run({
      command,
      args,
      timeoutMs: input.task.budget.wallTimeMs,
      env: { PI8_DIR: pi8, PI_SKIP_VERSION_CHECK: '1', TERM: 'dumb', ...this.options.env, ...env },
    });
    return agentOutput(result, readSessionFacts(sessions));
  }
}
