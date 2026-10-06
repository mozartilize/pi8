#!/usr/bin/env node
// Builds the queue bench work area in $PI8_FLOW_DIR (default /tmp/pi8-flow).
//   node bench/queue/setup.mjs
// Then: bench/queue/run.sh <auto|sol|flash> <1|2|3> <rep>, or chain.sh <arm> <rep>;
//       node bench/queue/score.cjs [run-name-filter]
//
// Cases:
//   case1  base project; the model designs and writes src/queue.ts and its tests.
//   case2  base + a queue with 6 planted defects + visible tests; the model reviews it.
//   case3  base + a correct queue + visible tests; the model renames retryDelayMs
//          to backoffBaseMs and adds src/index.ts.
// The hidden acceptance tests (hidden/) are never copied into a case.
//
// The router arm needs a pi8 template (config + benchmark store) from
// ~/.pi/agent/pi8; the config is copied with a narrower model list, and the
// copy keeps the original's secrets, so it stays outside the repository.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.PI8_FLOW_DIR ?? '/tmp/pi8-flow';
const at = (...parts) => join(root, ...parts);
const copy = (from, to) => cpSync(from, to, { recursive: true });

mkdirSync(root, { recursive: true });
for (const dir of ['base', 'ref', 'hidden', 'case1', 'case2', 'case3']) rmSync(at(dir), { recursive: true, force: true });
copy(join(here, 'base'), at('base'));
copy(join(here, 'ref'), at('ref'));
copy(join(here, 'hidden'), at('hidden'));
copy(join(here, 'visible-queue.test.ts'), at('visible-queue.test.ts'));

// The planted defects: each one is a single edit of the reference queue.
let buggy = readFileSync(at('ref', 'queue.ts'), 'utf8');
const plant = (from, to) => {
  if (buggy.split(from).length !== 2) throw new Error(`expected one occurrence of: ${from}`);
  buggy = buggy.replace(from, to);
};
// B1 retry delay exponent is off by one
plant('retryDelayMs * 2 ** (job.attempt - 1)', 'retryDelayMs * 2 ** job.attempt');
// B2 cancel during the retry delay leaves the timer
plant(
  '      clearTimeout(job.retryTimer);\n      job.retryTimer = undefined;\n      delayed.delete(job);',
  '      delayed.delete(job);',
);
// B3 the attempt timer is not cleared on success
plant('      (value) => {\n        clearTimeout(timer);\n', '      (value) => {\n');
// B4 equal priorities start in last-in first-out order
plant(
  'let index = waiting.findIndex((other) => other.priority < job.priority || (other.priority === job.priority && other.seq > job.seq));',
  'let index = waiting.findIndex((other) => other.priority <= job.priority);',
);
plant('    // Keep the array sorted: higher priority first, then lower seq first.\n', '    // Keep the array sorted: higher priority first.\n');
// B5 onIdle ignores running attempts
plant('const isIdle = () => waiting.length === 0 && delayed.size === 0 && running === 0;', 'const isIdle = () => waiting.length === 0 && delayed.size === 0;');
// B6 cancel of a running job leaks its slot
plant('    } else {\n      running -= 1;\n      job.controller?.abort(abortError());', '    } else {\n      job.controller?.abort(abortError());');
writeFileSync(at('buggy-queue.ts'), buggy);

const withQueue = (dir, queue) => {
  copy(at('base'), at(dir));
  copy(queue, at(dir, 'src', 'queue.ts'));
  copy(at('visible-queue.test.ts'), at(dir, 'test', 'queue.test.ts'));
};
copy(at('base'), at('case1'));
withQueue('case2', at('buggy-queue.ts'));
withQueue('case3', at('ref', 'queue.ts'));

mkdirSync(at('runs'), { recursive: true });

const store = join(homedir(), '.pi', 'agent', 'pi8');
if (existsSync(join(store, 'config.json')) && existsSync(join(store, 'benchmarks.json'))) {
  rmSync(at('pi8-template'), { recursive: true, force: true });
  mkdirSync(at('pi8-template'));
  copy(join(store, 'benchmarks.json'), at('pi8-template', 'benchmarks.json'));
  if (existsSync(join(store, 'embedding'))) symlinkSync(join(store, 'embedding'), at('pi8-template', 'embedding'));
  const config = JSON.parse(readFileSync(join(store, 'config.json'), 'utf8'));
  config.models = ['openai-codex/*', 'deepseek/*', 'cursor/*'];
  writeFileSync(at('pi8-template', 'config.json'), JSON.stringify(config, null, 2));
  chmodSync(at('pi8-template', 'config.json'), 0o600);
} else {
  console.warn(`no pi8 store at ${store}: the router arm has no template`);
}
console.log(`queue bench ready in ${root}`);
