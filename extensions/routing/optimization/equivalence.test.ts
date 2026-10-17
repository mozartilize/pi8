/**
 * Opt-in selection equivalence check on the frozen real pool.
 *
 *   PI8_EQUIVALENCE=1 npx vitest run extensions/routing/optimization/equivalence.test.ts
 *   PI8_EQUIVALENCE=record npx vitest run extensions/routing/optimization/equivalence.test.ts
 *
 * It runs `selectByRegret` on a fixed grid of preference profiles, phases,
 * context sizes and boundaries, and compares features, rankings, regrets,
 * solver status and fallback labels with `fixtures/selection-equivalence.json`.
 * A refactor must keep every case identical. An intentional behavior change
 * (a feature mapping, policy or fixture change) records a new baseline in the
 * same commit, with the classification in the commit message.
 *
 * The real pool has no exact regret ties, so this check does not cover the
 * tie order; `select.test.ts` and `minimax.test.ts` pin it.
 *
 * Opt-in because it solves 100 decisions with the real LP worker.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import type { BenchModel } from '../../types.js';
import { enumerateEffectiveActions } from '../features/actions.js';
import type { DecisionStateV1 } from '../features/state.js';
import { preferenceProfileDigest, validatePreferences, type UserRoutingPreferencesV1 } from '../preferences/schema.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import { WorkerLpAdapter } from './lp.js';
import { DomainCache, selectByRegret, type UnifiedDecision } from './select.js';

const MODE = process.env.PI8_EQUIVALENCE;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BASELINE = join(ROOT, 'fixtures/selection-equivalence.json');

const OPERATOR: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};
/** Answers that no weight vector satisfies together: the domain uses minimum slack. */
const CONFLICTING: UserRoutingPreferencesV1 = {
  version: 1, openDesignDecisions: 'lower_cost', handoffWarmCache: 'switch_for_capability',
  settledImplementation: 'higher_coding_capability', researchTasks: 'lower_cost',
};

/** Profile label, profile, compile the domain first, spike pair cap. */
const PROFILES: readonly [string, UserRoutingPreferencesV1, boolean, number | undefined][] = [
  ['empty', { version: 1 }, true, undefined],
  ['operator', OPERATOR, true, undefined],
  ['conflicting', CONFLICTING, true, undefined],
  ['operator-not-ready', OPERATOR, false, undefined],
  ['operator-pair-cap', OPERATOR, true, 10],
];
const PHASES = ['lightweight', 'gather', 'plan', 'implement', 'review'] as const;
const CONTEXTS = [30_000, 150_000] as const;
const BOUNDARIES = ['ordinary', 'rework'] as const;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

function summarize(result: UnifiedDecision) {
  return {
    solver: result.solver,
    reason: result.solverFallbackReason,
    status: result.domainStatus,
    enforced: result.constraintsEnforced,
    mode: result.domainMode,
    slack: result.totalSlack,
    chosen: result.chosen,
    top: result.ranking.slice(0, 5),
    ranking: digest(result.ranking),
    maxRegret: result.maxRegret ? digest([...result.maxRegret].sort()) : undefined,
    theta: result.theta,
    features: digest(result.actions.map((action) => action.features)),
    insufficientEvidence: digest(result.insufficientEvidence),
  };
}

describe.skipIf(MODE !== '1' && MODE !== 'record')('selection equivalence on the real pool', () => {
  const lp = new WorkerLpAdapter();
  afterAll(() => lp.close());

  it('matches the recorded baseline in every case', async () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/real-pool.json'), 'utf8')) as {
      indexVersion: string; registry: RegistryModelInfo[]; benchmarks: BenchModel[];
    };
    const pool = fixture.registry
      .filter((model) => model.provider !== 'cursor')
      .flatMap((model) => enumerateEffectiveActions(model).map((action) => ({ model, action })));
    const domains = new DomainCache(lp);
    const cases: Record<string, ReturnType<typeof summarize>> = {};
    for (const [label, profile, compile, pairCap] of PROFILES) {
      if (compile) await domains.compile(profile);
      const ports = { lp, domains: compile ? domains : new DomainCache(lp) };
      const preferences = validatePreferences(profile);
      for (const phase of PHASES) for (const estimatedContextTokens of CONTEXTS) for (const boundary of BOUNDARIES) {
        const state: DecisionStateV1 = {
          phase, estimatedContextTokens, needsVision: false, boundary, friction: [], nowMs: 1_000_000,
          benchmarkIndexVersion: fixture.indexVersion,
          ...(boundary === 'rework'
            ? { rework: { failed: { registryId: 'anthropic/claude-opus-5-5', effort: 'high' }, workItemId: 'w' }, workItemId: 'w' }
            : { incumbent: { registryId: 'anthropic/claude-sonnet-5-5', effort: 'high' } }),
        };
        const result = await selectByRegret(state, pool, fixture.benchmarks, preferences, ports, {
          expectedProfileDigest: preferenceProfileDigest(profile),
          decisionDeadlineMs: 120_000,
          ...(pairCap === undefined ? {} : { pairCap }),
        });
        expect(result.kind).toBe('decision');
        cases[`${label}/${phase}/${estimatedContextTokens}/${boundary}`] = summarize(result as UnifiedDecision);
      }
    }
    const normalized = JSON.parse(JSON.stringify(cases)) as typeof cases;
    if (MODE === 'record') {
      writeFileSync(BASELINE, `${JSON.stringify(normalized, null, 1)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as typeof cases;
    expect(Object.keys(normalized).sort()).toEqual(Object.keys(baseline).sort());
    for (const key of Object.keys(baseline)) expect(normalized[key], key).toEqual(baseline[key]);
  }, 900_000);
});
