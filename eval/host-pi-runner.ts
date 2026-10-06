/**
 * Runs `pi` on the host and the code of the model in a VM. Pi, the router extension, and
 * the provider credentials stay on the host, outside the candidate boundary. The VM tools
 * extension (`vm-tools.ts`) makes the file and shell tools of the model run in a VM that
 * mounts only the task directory. This runner needs a `vm-isolated` sandbox: with another
 * sandbox the tools would run on the host.
 *
 * The host process reads the task directory, which the candidate wrote. The environment
 * of the process turns off the Git settings that a repository can use to run a command.
 */
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyDigest } from './recipe.ts';
import { agentOutput, piInvocation, readSessionFacts, type AgentRunInput, type AgentRunner, type AgentRunOutput, type PiInvocation } from './runner.ts';
import { VM_CONFIG_ENV, type VmGuestConfig } from './vm-config.ts';

const VM_TOOLS = join(dirname(fileURLToPath(import.meta.url)), 'vm-tools.ts');

/** Time between the stop request and the forced stop of a `pi` process group. */
const STOP_GRACE_MS = 5000;

export interface HostPiAgentRunnerOptions {
  repoRoot: string;
  /** The settings of the VM that the run starts. Use the `guestConfig` of the sandbox factory. */
  vm: { guestConfig: VmGuestConfig };
  /** Host path of the provider credential file. The run gets a copy in its own home directory. */
  authFile?: string;
  /** Host directory with the router config and benchmark store. The run gets a copy. */
  pi8Template?: string;
  /** The `pi` command. The default is `pi` from PATH. */
  piCommand?: string;
  /** More extensions for the run, such as a scripted model in a test. */
  extraExtensions?: string[];
  /**
   * A second prompt for the same session. The run sends it when the first process has ended in time
   * and `when` is true for the host path of the task directory. A model that stops before it writes
   * the files gets one more prompt this way. The second process has the time that is left.
   */
  followUp?: (input: AgentRunInput) => { prompt: string; when: (workDir: string) => boolean } | undefined;
  /** Replaces the `pi` arguments. It gets the host path of the session directory. Tests use it. */
  invocation?: (input: AgentRunInput, sessionDir: string) => PiInvocation;
}

export class HostPiAgentRunner implements AgentRunner {
  private readonly options: HostPiAgentRunnerOptions;

  constructor(options: HostPiAgentRunnerOptions) {
    this.options = options;
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const { sandbox } = input;
    if (sandbox.kind !== 'vm-isolated') throw new Error('a host Pi run needs a VM sandbox: its tools would run on the host');
    if (policyDigest(input.arm) !== (input.recipe.execution.kind === 'whole-task' ? input.recipe.execution.policyDigest : undefined)) {
      throw new Error('the arm does not match the recipe');
    }
    const pi8 = join(sandbox.outDir, 'pi8');
    mkdirSync(pi8, { recursive: true });
    if (this.options.pi8Template) cpSync(this.options.pi8Template, pi8, { recursive: true });
    const sessions = join(sandbox.outDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    // The home directory exists only on the host. The VM does not mount it.
    if (this.options.authFile) {
      const target = join(sandbox.homeDir, '.pi', 'agent', 'auth.json');
      mkdirSync(dirname(target), { recursive: true });
      cpSync(this.options.authFile, target);
      chmodSync(target, 0o600);
    }
    const { args } = (this.options.invocation ?? ((value, dir) => piInvocation(value, this.options.repoRoot, dir)))(input, sessions);
    const extensions = [VM_TOOLS, ...(this.options.extraExtensions ?? [])].flatMap((path) => ['-e', path]);
    const command = this.options.piCommand ?? 'pi';
    const totalMs = input.task.budget.wallTimeMs;
    const startedAt = Date.now();
    const spawnOptions = {
      cwd: sandbox.workDir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: sandbox.homeDir,
        TERM: 'dumb',
        PI8_DIR: pi8,
        PI_SKIP_VERSION_CHECK: '1',
        [VM_CONFIG_ENV]: JSON.stringify(this.options.vm.guestConfig),
        // A repository can name a command in its Git settings. These values come first.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'core.hooksPath',
        GIT_CONFIG_VALUE_1: '/dev/null',
      },
    };
    let result = await spawnPi(command, [...extensions, ...args], { ...spawnOptions, timeoutMs: totalMs });
    const followUp = this.options.followUp?.(input);
    if (followUp && !result.timedOut && followUp.when(sandbox.workDir)) {
      const at = args.indexOf('-p');
      if (at < 0) throw new Error('the follow-up needs a -p argument');
      const remainingMs = totalMs - (Date.now() - startedAt);
      result = remainingMs > 0
        ? await spawnPi(command, [...extensions, ...args.slice(0, at), '-c', '-p', followUp.prompt], { ...spawnOptions, timeoutMs: remainingMs })
        : { ...result, timedOut: true };
    }
    return agentOutput(result, readSessionFacts(sessions));
  }
}

interface SpawnResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

/** Run a command in its own process group. The stop request reaches the VM process that `pi` starts. */
function spawnPi(command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    let forced: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      forced = setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
    }, options.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forced);
      // A process of the group can outlive the leader. Stop it.
      signalGroup('SIGKILL');
      resolve({ code, timedOut, output });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forced);
      resolve({ code: null, timedOut, output: `${output}${error.message}` });
    });
  });
}
