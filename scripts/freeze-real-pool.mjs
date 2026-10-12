#!/usr/bin/env node
/** Freeze benchmark rows and available registry metadata together. No provider calls. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const storePath = process.env.PI8_POOL_STORE;
if (!storePath) throw new Error('Set PI8_POOL_STORE to the synchronized benchmark store.');
const store = JSON.parse(readFileSync(storePath, 'utf8'));
if (!store.indexVersion || !Array.isArray(store.models)
  || !store.models.some((row) => row.active)
  || store.models.some((row) => row.active && !row.axisProvenance)) {
  throw new Error('The benchmark store must contain an index version and per-axis provenance.');
}
const agentDir = join(homedir(), '.pi', 'agent');
const scratch = mkdtempSync(join(tmpdir(), 'pi8-freeze-'));
const selectFields = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const modelsStorePath = join(scratch, 'models-store.json');
  if (existsSync(join(agentDir, 'models-store.json'))) copyFileSync(join(agentDir, 'models-store.json'), modelsStorePath);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsStorePath,
    refreshOnCreate: false, allowModelNetwork: false,
  });
  // Exclude URLs, headers, credentials and user settings from the public fixture.
  const registry = [...await runtime.getAvailable()].map((model) => ({
    ...selectFields(model, ['provider', 'id', 'api', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'cost', 'thinkingLevelMap']),
    ...(model.compat?.supportsMidConvoEffort !== undefined ? { compat: { supportsMidConvoEffort: model.compat.supportsMidConvoEffort } } : {}),
  })).sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  if (registry.length === 0) throw new Error('The available registry is empty.');
  const benchmarks = store.models.map((row) => selectFields(row, [
    'registryId', 'benchSlug', 'active', 'effort', 'quality', 'qualityEstimated', 'axisProvenance',
    'priceInputPer1M', 'priceOutputPer1M', 'outputSpeedTps', 'latencyMsTtft', 'latencyMsTtfa',
    'costPerTask', 'timePerTaskSeconds', 'contextWindow', 'source',
  ])).sort((a, b) => `${a.registryId}:${a.effort ?? ''}:${a.benchSlug}`.localeCompare(`${b.registryId}:${b.effort ?? ''}:${b.benchSlug}`));
  const fixture = {
    source: 'Artificial Analysis API and models page with the available Pi provider registry',
    indexVersion: store.indexVersion,
    piVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies['@earendil-works/pi-ai'],
    registryDigest: digest(registry),
    benchmarkDigest: digest(benchmarks),
    registry,
    benchmarks,
  };
  writeFileSync(new URL('../fixtures/real-pool.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Frozen registry=${registry.length}, benchmark rows=${benchmarks.length}, index=${store.indexVersion}.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
