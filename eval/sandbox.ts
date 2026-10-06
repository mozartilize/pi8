/**
 * An OS-isolated sandbox for a candidate process.
 *
 * The sandbox is a private mount namespace with a new root. The new root has
 * only the paths that the profile lists. A path that is not in the profile does
 * not exist inside the sandbox, so the candidate cannot read it even when it
 * knows the path. The profile never lists the evaluation store, an oracle, the
 * host home directory, a session history, a Git common directory, or a
 * container socket.
 *
 * The candidate gets one residual exposure: the credential files that the
 * profile copies into the sandbox home. The model provider needs them.
 *
 * A plain worktree has no read boundary. It is only for development runs of
 * public tasks. `assertActivationGrade` rejects it.
 */
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digestOf } from './recipe.ts';

export interface SandboxProfile {
  /** Host paths that appear read-only at the same path inside the sandbox. */
  readOnlyPaths: string[];
  /** Entries of /etc that appear read-only inside the sandbox. */
  etcEntries: string[];
  /** Files that the harness copies into the sandbox home. `to` is relative to the home. */
  credentialFiles: Array<{ from: string; to: string }>;
  /** The only environment variables that the candidate process gets. */
  env: Record<string, string>;
  network: 'host' | 'none';
}

export const SANDBOX_HOME = '/home/eval';
export const SANDBOX_WORK = '/work';
export const SANDBOX_OUT = '/out';

export const BASE_READ_ONLY_PATHS = ['/usr', '/bin', '/lib', '/lib64', '/sbin'];
export const BASE_ETC_ENTRIES = [
  'ssl', 'ca-certificates', 'nsswitch.conf', 'hosts', 'localtime', 'passwd', 'group',
  'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'alternatives',
];

export interface SandboxRunOptions {
  command: string;
  args?: string[];
  timeoutMs: number;
  /** Variables for this run. They add to the profile variables. */
  env?: Record<string, string>;
}

export interface SandboxRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SecureSandbox {
  kind: 'os-isolated-process';
  profileDigest: string;
  /** Host path of the writable task directory. It appears as /work inside the sandbox. */
  workDir: string;
  /** Host path of the writable output directory. It appears as /out inside the sandbox. */
  outDir: string;
  /** Host path of the sandbox home. It appears as /home/eval inside the sandbox. */
  homeDir: string;
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  destroy(): void;
}

/** A directory with a read boundary of none. Only a development run of a public task can use it. */
export interface PlainWorktree {
  kind: 'plain-worktree';
  workDir: string;
}

export function assertActivationGrade(sandbox: SecureSandbox | PlainWorktree): asserts sandbox is SecureSandbox {
  if (sandbox.kind !== 'os-isolated-process') {
    throw new Error('A plain worktree has no read boundary. A private-oracle campaign needs an isolated sandbox.');
  }
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

type MountKind = 'dir' | 'file' | 'symlink';

function kindOf(path: string): MountKind | undefined {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return 'symlink';
    return info.isDirectory() ? 'dir' : 'file';
  } catch {
    return undefined;
  }
}

/** Lines of the shell script that put one host path into the new root. `R` is the new root. */
function mountLines(source: string, target: string, writable: boolean): string[] {
  const kind = kindOf(source);
  if (!kind) return [];
  const dest = `"$R"${quote(target)}`;
  if (kind === 'symlink') return [`mkdir -p "$(dirname ${dest})"`, `ln -s ${quote(readlinkSync(source))} ${dest}`];
  const lines = [
    kind === 'dir' ? `mkdir -p ${dest}` : `mkdir -p "$(dirname ${dest})" && : > ${dest}`,
    `mount --rbind ${quote(source)} ${dest}`,
  ];
  if (!writable) lines.push(`mount -o remount,bind,ro ${dest}`);
  return lines;
}

/** The shell script that runs as the first process inside the new namespaces. */
export function buildSetupScript(profile: SandboxProfile, dirs: { newRoot: string; work: string; out: string; home: string; resolvConf: string }): string {
  const lines: string[] = ['set -eu', `R=${quote(dirs.newRoot)}`, 'mount -t tmpfs tmpfs "$R"'];
  for (const path of profile.readOnlyPaths) lines.push(...mountLines(path, path, false));
  for (const entry of profile.etcEntries) lines.push(...mountLines(`/etc/${entry}`, `/etc/${entry}`, false));
  lines.push(...mountLines(dirs.resolvConf, '/etc/resolv.conf', false));
  lines.push(...mountLines(dirs.work, SANDBOX_WORK, true));
  lines.push(...mountLines(dirs.out, SANDBOX_OUT, true));
  lines.push(...mountLines(dirs.home, SANDBOX_HOME, true));
  lines.push(
    'mkdir -p "$R/tmp" "$R/proc" "$R/dev" "$R/.old"',
    'mount -t tmpfs tmpfs "$R/tmp"',
    'mount -t proc proc "$R/proc"',
    'mount --rbind /dev "$R/dev"',
    'cd "$R"',
    'pivot_root . .old',
    'umount -l /.old',
    'rmdir /.old',
    `cd ${SANDBOX_WORK}`,
    'exec env -i "$@"',
  );
  return lines.join('\n');
}

let availability: boolean | undefined;

/** True when this host can create the namespaces that the sandbox needs. */
export async function sandboxAvailable(): Promise<boolean> {
  if (availability !== undefined) return availability;
  availability = await new Promise<boolean>((resolve) => {
    const child = spawn('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return availability;
}

export function createSandbox(profile: SandboxProfile, publicWorkspace: string): SecureSandbox {
  const root = mkdtempSync(join(tmpdir(), 'pi8-sandbox-'));
  const dirs = {
    newRoot: join(root, 'newroot'),
    work: join(root, 'work'),
    out: join(root, 'out'),
    home: join(root, 'home'),
    resolvConf: join(root, 'resolv.conf'),
  };
  for (const dir of [dirs.newRoot, dirs.out, dirs.home]) mkdirSync(dir, { recursive: true });
  cpSync(publicWorkspace, dirs.work, { recursive: true, verbatimSymlinks: true });
  // The host resolver file is often a link to a path that the sandbox does not have. Copy its text.
  writeFileSync(dirs.resolvConf, existsSync('/etc/resolv.conf') ? readFileSync('/etc/resolv.conf', 'utf8') : '');
  for (const file of profile.credentialFiles) {
    const target = join(dirs.home, file.to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file.from, target);
    chmodSync(target, 0o600);
  }
  const script = buildSetupScript(profile, dirs);
  const unshareArgs = ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', ...(profile.network === 'none' ? ['--net'] : [])];
  return {
    kind: 'os-isolated-process',
    profileDigest: digestOf(profile),
    workDir: dirs.work,
    outDir: dirs.out,
    homeDir: dirs.home,
    run: (options) =>
      new Promise((resolve) => {
        const env = { HOME: SANDBOX_HOME, ...profile.env, ...options.env };
        const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
        const child = spawn('unshare', [...unshareArgs, 'sh', '-c', script, 'sandbox', ...assignments, options.command, ...(options.args ?? [])], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr, timedOut });
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
        });
      }),
    destroy: () => rmSync(root, { recursive: true, force: true }),
  };
}
