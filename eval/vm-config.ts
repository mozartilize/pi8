/** The VM settings that the harness gives to the VM tools extension of a host Pi run. */
export const VM_CONFIG_ENV = 'PI8_VM_CONFIG';

/** A file that the VM tools extension writes when the VM cannot start. The harness reads it. */
export const VM_STATUS_ENV = 'PI8_VM_STATUS';

export interface VmGuestConfig {
  /** The build id of the guest image. The extension does not resolve a name. */
  image: string;
  /** `none` blocks all guest network access. A list allows only those host names. */
  network: 'none' | { allowedHosts: string[] };
  memory?: string;
  cpus?: number;
  /** Environment variables of every command in the guest. */
  env?: Record<string, string>;
  /** Host path of a disk checkpoint. Each VM starts from a new overlay of this disk. */
  checkpoint?: string;
  /** Keep the scratch paths (/tmp, /root, and others) on the root disk, not in memory. Builds need it. */
  scratchOnDisk?: boolean;
}
