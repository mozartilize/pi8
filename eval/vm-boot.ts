import { createHttpHooks, RealFSProvider, VM, VmCheckpoint, type VMOptions } from '@earendil-works/gondolin';
import type { VmGuestConfig } from './vm-config.ts';

/** Boot a VM from the settings. `mounts` maps a guest path to a host directory. */
export async function bootVm(config: VmGuestConfig, mounts: Record<string, string>, startTimeoutMs?: number): Promise<VM> {
  const { httpHooks, env } = createHttpHooks({ allowedHosts: config.network === 'none' ? [] : config.network.allowedHosts });
  const options: VMOptions = {
    httpHooks,
    env: { ...env, ...config.env },
    ...(config.memory ? { memory: config.memory } : {}),
    ...(config.cpus ? { cpus: config.cpus } : {}),
    ...(config.scratchOnDisk ? { tmpfs: {} } : {}),
    ...(startTimeoutMs !== undefined ? { startTimeoutMs } : {}),
    vfs: { mounts: Object.fromEntries(Object.entries(mounts).map(([guest, host]) => [guest, new RealFSProvider(host)])) },
  };
  if (config.checkpoint) return VmCheckpoint.load(config.checkpoint).resume<VM>(options);
  return VM.create({ ...options, sandbox: { imagePath: config.image } });
}
