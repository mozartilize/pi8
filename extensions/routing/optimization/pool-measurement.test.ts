/**
 * Solver pool measurement (opt-in: `npm run measure:pool`). Measures the
 * effective-effort-expanded, guarded action pool and exact-solve latency on
 * (1) the frozen `fixtures/real-pool.json` and (2) the local Pi registry with
 * the local benchmark store, when present. Makes no provider calls. Output is
 * a report for the production budget decision, not a pass/fail gate on
 * timing.
 */
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { BenchModel, Dimension } from '../../types.js';
import { buildExcludeFilter, buildModelFilter } from '../policy/allowlist.js';
import { enumerateEffectiveActions } from '../features/actions.js';
import type { DecisionStateV1 } from '../features/state.js';
import { preferenceProfileDigest, validatePreferences, type UserRoutingPreferencesV1 } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { WorkerLpAdapter } from './lp.js';
import { DomainCache, SPIKE_SOLVER_BUDGET, selectByRegret, type SelectionCandidate } from './select.js';

const ENABLED = process.env.PI8_POOL_MEASURE === '1';
const PHASES: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
const PROVIDERS_WITHOUT_DELEGATION = new Set(['cursor']);

interface PoolSource { name: string; registry: RegistryModelInfo[]; rows: BenchModel[]; indexVersion?: string; models?: string[]; blacklist?: string[] }

function guardedPool(source: PoolSource, needsVision: boolean): SelectionCandidate[] {
  const allow = buildModelFilter(source.models);
  const deny = buildExcludeFilter(source.blacklist);
  return source.registry
    .filter((m) => !PROVIDERS_WITHOUT_DELEGATION.has(m.provider))
    .filter((m) => allow(`${m.provider}/${m.id}`) && !deny(`${m.provider}/${m.id}`))
    .filter((m) => !needsVision || (m.input ?? ['text']).includes('image'))
    .flatMap((model) => enumerateEffectiveActions(model).map((action) => ({ model, action })));
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

async function loadLiveSource(): Promise<PoolSource | undefined> {
  const agentDir = join(homedir(), '.pi', 'agent');
  const storePath = join(agentDir, 'pi8', 'benchmarks.json');
  if (!existsSync(storePath)) return undefined;
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const scratch = mkdtempSync(join(tmpdir(), 'pi8-pool-'));
  const modelsStorePath = join(scratch, 'models-store.json');
  if (existsSync(join(agentDir, 'models-store.json'))) copyFileSync(join(agentDir, 'models-store.json'), modelsStorePath);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsStorePath, refreshOnCreate: false, allowModelNetwork: false,
  } as Parameters<typeof ModelRuntime.create>[0]);
  const registry = [...await runtime.getAvailable()] as unknown as RegistryModelInfo[];
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { models: BenchModel[]; indexVersion?: string };
  const configPath = join(agentDir, 'pi8', 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) as { models?: string[]; blacklist?: string[] } : {};
  return { name: 'live local registry + store', registry, rows: store.models, indexVersion: store.indexVersion, models: config.models, blacklist: config.blacklist };
}

describe.skipIf(!ENABLED)('pool measurement', () => {
  it('reports N, pair counts, exact latency and spike-budget fallback rate', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/real-pool.json', import.meta.url), 'utf8')) as { registry: RegistryModelInfo[]; benchmarks: BenchModel[] };
    const sources: PoolSource[] = [{ name: 'fixtures/real-pool.json', registry: fixture.registry, rows: fixture.benchmarks, indexVersion: '4.3' }];
    try {
      const live = await loadLiveSource();
      if (live) sources.push(live);
    } catch (error) {
      console.log(`live source unavailable: ${(error as Error).message}`);
    }
    const lp = new WorkerLpAdapter();
    const cache = new DomainCache(lp);
    const operator: UserRoutingPreferencesV1 = {
      version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
      handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
    };
    const coldCompileStart = performance.now();
    await cache.compile(operator);
    const coldCompileMs = performance.now() - coldCompileStart;
    const lines: string[] = [];
    const reportPath = process.env.PI8_POOL_REPORT ?? join(tmpdir(), 'pi8-pool-report.txt');
    writeFileSync(reportPath, '');
    const log = (line: string) => { lines.push(line); appendFileSync(reportPath, `${line}\n`); };
    log(`domain compile (operator profile, cold worker): ${coldCompileMs.toFixed(1)} ms`);
    try {
      for (const source of sources) {
        log(`\n## ${source.name}: registry ${source.registry.length}, bench rows ${source.rows.length}`);
        for (const needsVision of [false, true]) {
          const pool = guardedPool(source, needsVision);
          const measured = pool.filter(({ action }) => source.rows.some((row) => row.active && row.registryId === action.registryId && row.effort === action.effort)).length;
          log(`vision=${needsVision}: N=${pool.length} (measured effort rows ${measured}), ordered pairs ${pool.length * (pool.length - 1)}, spike cap ${SPIKE_SOLVER_BUDGET.pairCap} -> ${pool.length * (pool.length - 1) > SPIKE_SOLVER_BUDGET.pairCap ? 'CAPPED' : 'exact'}`);
          for (const [label, profile] of [['empty', { version: 1 } as UserRoutingPreferencesV1], ['operator', operator]] as const) {
            const prefs = validatePreferences(profile);
            const times: number[] = [];
            let exact = 0;
            let fallback = 0;
            for (const phase of PHASES) {
              const state: DecisionStateV1 = {
                phase, estimatedContextTokens: phase === 'gather' ? 80_000 : 30_000, needsVision, boundary: 'ordinary',
                friction: [], nowMs: Date.now(), isSubagentSpawn: false, benchmarkIndexVersion: source.indexVersion,
              };
              for (const run of [0, 1, 2]) {
                const start = performance.now();
                const result = await selectByRegret(state, pool, source.rows, prefs, { lp, domains: cache }, {
                  expectedProfileDigest: preferenceProfileDigest(profile), decisionDeadlineMs: 60_000,
                });
                const elapsed = performance.now() - start;
                if (run > 0) times.push(elapsed);
                if (result.kind === 'decision' && result.solver === 'exact') exact++;
                else fallback++;
                if (result.kind === 'decision' && run === 0 && label === 'operator' && !needsVision) {
                  log(`  ${phase}: chosen ${result.chosen} (${result.solver})`);
                }
              }
            }
            times.sort((a, b) => a - b);
            const withinSpike = times.filter((t) => t <= SPIKE_SOLVER_BUDGET.deadlineMs).length;
            log(`  profile=${label}: exact ${exact}/${exact + fallback}; warm uncapped latency P50 ${percentile(times, 0.5).toFixed(1)} ms, P95 ${percentile(times, 0.95).toFixed(1)} ms, P99 ${percentile(times, 0.99).toFixed(1)} ms; within ${SPIKE_SOLVER_BUDGET.deadlineMs} ms: ${withinSpike}/${times.length}`);
          }
        }
      }
    } finally {
      await lp.close();
    }
    expect(sources.length).toBeGreaterThan(0);
  }, 600_000);
});
