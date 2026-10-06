/**
 * A sandbox in a Linux micro-VM (Gondolin, with QEMU). The candidate code runs in
 * the guest. The guest sees the task directory at /work and the output directory
 * at /out, and no other host path. It has no host environment variable, no
 * credential file, and no container socket. Its network access is a list of host
 * names that the host process enforces. The guest never gets a credential.
 *
 * A guest can create a link in /work that names a host path. The link does not
 * resolve in the guest. A host reader of /work must not follow it, so use
 * `copyTreeSafely` to read the directory.
 */
import { accessSync, closeSync, constants, cpSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureImageSelector, type VM } from '@earendil-works/gondolin';
import { createHash } from 'node:crypto';
import { bootVm } from './vm-boot.ts';
import { digestOf } from './recipe.ts';
import type { VmGuestConfig } from './vm-config.ts';
import { SANDBOX_OUT, SANDBOX_WORK, type SandboxFactory, type SandboxRunOptions, type SandboxRunResult, type SecureSandbox } from './sandbox.ts';

export const DEFAULT_VM_IMAGE = 'alpine-base:latest';

export interface VmSandboxOptions {
  /** An image reference, a build id, or a path. The build id of the image is part of the sandbox identity. */
  image?: string;
  /** `none` blocks all guest network access. A list allows only those host names. */
  network: 'none' | { allowedHosts: string[] };
  memory?: string;
  cpus?: number;
  startTimeoutMs?: number;
  /** Environment variables of every command in the guest. */
  env?: Record<string, string>;
  /** Host path of a disk checkpoint with a warm build cache. Each VM starts from a new overlay of it. */
  checkpoint?: string;
  /** Keep the scratch paths on the root disk. Builds need it. */
  scratchOnDisk?: boolean;
}

/** Digest of a checkpoint file: its size and its last 64 KiB, where the metadata trailer is. */
export function checkpointDigest(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(65_536, size);
    const tail = Buffer.alloc(length);
    readSync(fd, tail, 0, length, size - length);
    return createHash('sha256').update(String(size)).update(tail).digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** True when this host can run the VM: QEMU is installed and the user can use KVM. */
export function vmSandboxAvailable(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch {
    return false;
  }
  return (process.env.PATH ?? '').split(':').some((dir) => {
    try {
      accessSync(join(dir, 'qemu-system-x86_64'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export interface VmSandboxFactory extends SandboxFactory {
  /** Digest of the image build id and the settings. */
  identity: string;
  /** The settings of a VM that a host Pi run starts for itself. They match the VMs of this factory. */
  guestConfig: VmGuestConfig;
}

/** A factory for a sandbox that boots one VM for each run. It resolves the image once. */
export async function vmSandboxFactory(options: VmSandboxOptions): Promise<VmSandboxFactory> {
  const image = await ensureImageSelector(options.image ?? DEFAULT_VM_IMAGE);
  const buildId = image.buildId ?? image.selector;
  const identity = digestOf({ kind: 'vm-isolated', imageBuildId: buildId, network: options.network, memory: options.memory ?? null, cpus: options.cpus ?? null, env: options.env ?? {}, checkpoint: options.checkpoint ? checkpointDigest(options.checkpoint) : null, scratchOnDisk: options.scratchOnDisk ?? false });
  const factory: SandboxFactory = (publicWorkspace) => createVmSandbox({ ...options, image: buildId }, identity, publicWorkspace);
  const guestConfig: VmGuestConfig = {
    image: buildId, network: options.network,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.cpus ? { cpus: options.cpus } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(options.scratchOnDisk ? { scratchOnDisk: true } : {}),
  };
  return Object.assign(factory, { identity, guestConfig });
}

export async function createVmSandbox(options: VmSandboxOptions, identity: string, publicWorkspace: string): Promise<SecureSandbox> {
  const root = mkdtempSync(join(tmpdir(), 'pi8-vm-'));
  const workDir = join(root, 'work');
  const outDir = join(root, 'out');
  const homeDir = join(root, 'home');
  for (const dir of [outDir, homeDir]) mkdirSync(dir, { recursive: true });
  // The candidate wrote nothing yet, so the public tree is the only source. Links stay as links.
  cpSync(publicWorkspace, workDir, { recursive: true, verbatimSymlinks: true });
  // The VM boots at the first command. A host Pi run starts its own VM and never runs a command here.
  const config: VmGuestConfig = {
    image: options.image ?? DEFAULT_VM_IMAGE, network: options.network,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.cpus ? { cpus: options.cpus } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(options.scratchOnDisk ? { scratchOnDisk: true } : {}),
  };
  let booting: Promise<VM> | undefined;
  const boot = (): Promise<VM> => {
    booting ??= bootVm(config, { [SANDBOX_WORK]: workDir, [SANDBOX_OUT]: outDir }, options.startTimeoutMs);
    return booting;
  };
  return {
    kind: 'vm-isolated',
    profileDigest: identity,
    workDir,
    outDir,
    homeDir,
    async run(run: SandboxRunOptions): Promise<SandboxRunResult> {
      const abort = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, run.timeoutMs);
      try {
        const result = await (await boot()).exec([run.command, ...(run.args ?? [])], { cwd: SANDBOX_WORK, env: run.env ?? {}, signal: abort.signal });
        return { code: result.exitCode, signal: null, stdout: result.stdout, stderr: result.stderr, timedOut: false };
      } catch (error) {
        return { code: null, signal: null, stdout: '', stderr: timedOut ? '' : error instanceof Error ? error.message : String(error), timedOut };
      } finally {
        clearTimeout(timer);
      }
    },
    async destroy(): Promise<void> {
      try {
        if (booting) await (await booting.catch(() => undefined))?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
