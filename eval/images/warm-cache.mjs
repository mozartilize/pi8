#!/usr/bin/env node
// Builds a warm cache in a VM and stores the root disk as a checkpoint.
//   node eval/images/warm-cache.mjs <image-build-id> <tree> <checkpoint-path> <hosts,comma> <memory> -- <shell command>
// The tree is a source tree of one task. The VM mounts it at /work and may reach only the listed hosts.
// The command runs in /work. When it prints a line `PI8-STOP`, nothing else is needed. The checkpoint
// is saved after the command ends with exit code 0.
import { bootVm } from '../vm-boot.ts';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const [image, tree, checkpoint, hosts, memory] = args.slice(0, split);
const command = args.slice(split + 1).join(' ');
const config = { image, network: { allowedHosts: hosts.split(',').filter(Boolean) }, memory, cpus: 8, scratchOnDisk: true,
  env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', DATABASE_URL: 'postgres://saleor:saleor@127.0.0.1:5432/saleor', SECRET_KEY: 'test', PYTHONDONTWRITEBYTECODE: '1' } };
const vm = await bootVm(config, { '/work': tree });
const started = Date.now();
const running = vm.exec(['/bin/sh', '-lc', `cd /work && ${command}`], { stdout: 'pipe', stderr: 'pipe' });
for await (const chunk of running.output()) process.stdout.write(chunk.data);
const result = await running;
console.log(`command exit=${result.exitCode} in ${Math.round((Date.now() - started) / 1000)}s`);
if (result.exitCode !== 0) { await vm.close(); process.exit(1); }
const saved = await vm.checkpoint(checkpoint);
console.log('checkpoint', saved.path);
await vm.close();
