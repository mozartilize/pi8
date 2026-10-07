/**
 * A task directory on the host for a development run. Pi runs on the host with the user's own
 * home, settings, extensions, credentials, and network, so every provider and every tool works
 * as in daily use. It has no read boundary for credentials, so it is never activation evidence:
 * `assertActivationGrade` rejects it.
 *
 * Each command runs in a private mount namespace (`unshare -Urm`). An empty tmpfs covers each
 * hidden path, so the candidate cannot read the evaluation store, the hidden tests, the clones
 * that hold the fix commits, or the session history. The namespace maps the user to root, so the
 * files that a command writes belong to the user on the host. A blocked host name resolves to an
 * address that nothing listens on, because the namespace sees its own copy of `/etc/hosts`. Every
 * other host and every other path are the same as on the host.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from './recipe.ts';
import type { SandboxFactory, SandboxRunOptions, SandboxRunResult, SecureSandbox } from './sandbox.ts';

/** The output that a run keeps for each stream. Cargo prints much, and a verdict reads the whole run. */
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
/** Time between the stop request and the forced stop of the process group. */
const STOP_GRACE_MS = 5000;

export interface HostDirSandboxOptions {
  /** Host directory for the run directories. It must not be under a hidden path. */
  workRoot: string;
  /** Host paths that a command cannot read. Each gets an empty, writable tmpfs in the namespace. */
  hiddenPaths: string[];
  /**
   * Host directories that a command sees at a path of its run directory, such as a build cache.
   * The key is the name in the run directory. The mount happens before the hidden paths are covered,
   * so a source can be under a hidden path.
   */
  binds?: Record<string, string>;
  /** Variables for every command. They add to the host environment. */
  env?: Record<string, string>;
  /** Variables that name a path of the run directory, such as the mount point of a bind. The key is the variable. */
  runDirEnv?: Record<string, string>;
  /**
   * Host names that a command cannot reach, such as the host of the upstream repository. The block is
   * by name only: an address or a host name that is not in the list still works.
   */
  blockedHosts?: readonly string[];
}

export interface HostDirSandboxFactory extends SandboxFactory {
  identity: string;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The shell script that runs first in the namespace. It prepares the mounts and starts the command. */
export function namespaceScript(runDir: string, workDir: string, options: Pick<HostDirSandboxOptions, 'hiddenPaths' | 'binds' | 'blockedHosts'>): string {
  const lines = ['set -e'];
  if (options.blockedHosts?.length) lines.push(`mount --bind ${quote(join(runDir, 'hosts'))} /etc/hosts`);
  for (const [name, source] of Object.entries(options.binds ?? {})) {
    lines.push(`mount --bind ${quote(source)} ${quote(join(runDir, name))}`);
  }
  for (const path of options.hiddenPaths) lines.push(`if [ -d ${quote(path)} ]; then mount -t tmpfs none ${quote(path)}; fi`);
  lines.push(`cd ${quote(workDir)}`, 'exec "$@"');
  return lines.join('\n');
}

export function hostDirSandboxFactory(options: HostDirSandboxOptions): HostDirSandboxFactory {
  const identity = digestOf({ kind: 'host-directory', hiddenPaths: options.hiddenPaths, binds: Object.keys(options.binds ?? {}), env: options.env ?? {}, runDirEnv: options.runDirEnv ?? {}, blockedHosts: options.blockedHosts ?? [] });
  const factory: SandboxFactory = async (publicWorkspace) => {
    mkdirSync(options.workRoot, { recursive: true });
    const runDir = mkdtempSync(join(options.workRoot, 'run-'));
    // The directory name is the name of a normal checkout. It says nothing about the evaluation.
    const workDir = join(runDir, 'repo');
    const outDir = join(runDir, 'out');
    cpSync(publicWorkspace, workDir, { recursive: true });
    mkdirSync(outDir);
    for (const [name, source] of Object.entries(options.binds ?? {})) {
      mkdirSync(source, { recursive: true });
      mkdirSync(join(runDir, name));
    }
    if (options.blockedHosts?.length) {
      const blocked = options.blockedHosts.flatMap((host) => [`0.0.0.0 ${host}`, `:: ${host}`]);
      writeFileSync(join(runDir, 'hosts'), `${readFileSync('/etc/hosts', 'utf8').trimEnd()}\n${blocked.join('\n')}\n`);
    }
    const script = namespaceScript(runDir, workDir, options);
    const runEnv = Object.fromEntries(Object.entries(options.runDirEnv ?? {}).map(([name, relative]) => [name, join(runDir, relative)]));
    const sandbox: SecureSandbox = {
      kind: 'host-directory',
      profileDigest: identity,
      workDir,
      outDir,
      homeDir: homedir(),
      run: (run) => runInNamespace(script, run, { ...options.env, ...runEnv, ...run.env }),
      destroy: () => rmSync(runDir, { recursive: true, force: true }),
    };
    return sandbox;
  };
  return Object.assign(factory, { identity });
}

function runInNamespace(script: string, run: SandboxRunOptions, env: Record<string, string>): Promise<SandboxRunResult> {
  return new Promise((resolve) => {
    // Claude Code refuses to skip its permission prompts as root unless the process states that it runs in a sandbox.
    const child = spawn('unshare', ['-Urm', 'sh', '-c', script, 'sh', run.command, ...(run.args ?? [])], {
      env: { ...process.env, ...env, IS_SANDBOX: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT_CHARS); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT_CHARS); });
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
    }, run.timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forced);
      // A process of the group can outlive the leader. Stop it.
      signalGroup('SIGKILL');
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forced);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
  });
}

/** True when this host can make the namespace of a run. */
export function hostDirSandboxAvailable(): boolean {
  return existsSync('/usr/bin/unshare') || existsSync('/bin/unshare');
}
