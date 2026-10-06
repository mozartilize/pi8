/**
 * Pi extension for an evaluation run. It makes the `read`, `write`, `edit`, and `bash`
 * tools run in a micro-VM, so the code that a model writes and runs never runs on the host.
 * Pi and the router extension stay on the host with the provider credentials.
 *
 * The VM mounts the Pi working directory at the same absolute path as on the host. The model
 * sees one path for a file, and the router tracks that path on the host. No path translation
 * is needed. The VM gets no host environment variable and no credential. The harness passes
 * the VM settings in PI8_VM_CONFIG. Without them the extension fails to load, so a run never
 * starts with host tools.
 *
 * The host built-in tools `grep`, `find`, and `ls` read the host file system. The extension
 * blocks them.
 */
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  createBashTool, createEditTool, createReadTool, createWriteTool,
  type BashOperations, type EditOperations, type ExtensionAPI, type ReadOperations, type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { VM } from '@earendil-works/gondolin';
import { bootVm } from './vm-boot.ts';
import { VM_CONFIG_ENV, type VmGuestConfig } from './vm-config.ts';

const HOST_TOOLS_TO_BLOCK = new Set(['grep', 'find', 'ls']);

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The guest path of a host path. The two are the same, and the path must stay inside the working directory. */
export function guestPathOf(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`path leaves the working directory: ${target}`);
  return path.resolve(cwd, relative);
}

function readOperations(vm: VM, cwd: string): ReadOperations {
  return {
    readFile: (target) => vm.fs.readFile(guestPathOf(cwd, target)),
    access: async (target) => {
      await vm.fs.access(guestPathOf(cwd, target), { mode: fsConstants.R_OK });
    },
    detectImageMimeType: async (target) => {
      try {
        const result = await vm.exec(['/bin/sh', '-lc', `file --mime-type -b ${quote(guestPathOf(cwd, target))}`]);
        const mime = result.stdout.trim();
        return result.ok && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime) ? (mime as 'image/png') : null;
      } catch {
        return null;
      }
    },
  };
}

function writeOperations(vm: VM, cwd: string): WriteOperations {
  return {
    writeFile: async (target, content) => {
      const guest = guestPathOf(cwd, target);
      await vm.fs.mkdir(path.posix.dirname(guest), { recursive: true });
      await vm.fs.writeFile(guest, content);
    },
    mkdir: async (directory) => {
      await vm.fs.mkdir(guestPathOf(cwd, directory), { recursive: true });
    },
  };
}

function editOperations(vm: VM, cwd: string): EditOperations {
  const read = readOperations(vm, cwd);
  return { readFile: read.readFile, access: read.access, writeFile: writeOperations(vm, cwd).writeFile };
}

function bashOperations(vm: VM, cwd: string): BashOperations {
  return {
    // Pi passes the host environment here. It is not forwarded: it can hold credentials.
    exec: async (command, workingDirectory, { onData, signal, timeout }) => {
      const guestCwd = guestPathOf(cwd, workingDirectory);
      const abort = new AbortController();
      const onAbort = (): void => abort.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = timeout && timeout > 0 ? setTimeout(() => { timedOut = true; abort.abort(); }, timeout * 1000) : undefined;
      try {
        const process = vm.exec(['/bin/sh', '-lc', command], { cwd: guestCwd, signal: abort.signal, stdout: 'pipe', stderr: 'pipe' });
        for await (const chunk of process.output()) onData(chunk.data);
        return { exitCode: (await process).exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error('aborted');
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

function readConfig(): VmGuestConfig {
  const raw = process.env[VM_CONFIG_ENV];
  if (!raw) throw new Error(`${VM_CONFIG_ENV} is not set. The VM tools need the VM settings.`);
  return JSON.parse(raw) as VmGuestConfig;
}

export default function vmTools(pi: ExtensionAPI): void {
  const config = readConfig();
  const cwd = process.cwd();
  let vm: VM | undefined;
  let starting: Promise<VM> | undefined;

  const ensureVm = (): Promise<VM> => {
    if (vm) return Promise.resolve(vm);
    starting ??= bootVm(config, { [cwd]: cwd }).then((created) => {
      vm = created;
      return created;
    });
    return starting;
  };

  pi.on('session_start', async () => {
    await ensureVm();
  });
  pi.on('session_shutdown', async () => {
    const current = vm;
    vm = undefined;
    starting = undefined;
    await current?.close();
  });
  // Fail closed: a host tool that reads the host file system must not run.
  pi.on('tool_call', (event) => (HOST_TOOLS_TO_BLOCK.has(event.toolName) ? { block: true, reason: `${event.toolName} is not available in this run` } : undefined));

  pi.registerTool({ ...createReadTool(cwd), execute: async (id, params, signal, onUpdate) => createReadTool(cwd, { operations: readOperations(await ensureVm(), cwd) }).execute(id, params, signal, onUpdate) });
  pi.registerTool({ ...createWriteTool(cwd), execute: async (id, params, signal, onUpdate) => createWriteTool(cwd, { operations: writeOperations(await ensureVm(), cwd) }).execute(id, params, signal, onUpdate) });
  pi.registerTool({ ...createEditTool(cwd), execute: async (id, params, signal, onUpdate) => createEditTool(cwd, { operations: editOperations(await ensureVm(), cwd) }).execute(id, params, signal, onUpdate) });
  pi.registerTool({ ...createBashTool(cwd), execute: async (id, params, signal, onUpdate) => createBashTool(cwd, { operations: bashOperations(await ensureVm(), cwd) }).execute(id, params, signal, onUpdate) });
}
