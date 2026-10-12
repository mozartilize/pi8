import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePreferences } from '../config.js';
import type { BenchModel } from '../types.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { benchStoreJson } from '../test-support/provider-harness.js';
import { WorkerLpAdapter } from '../routing/optimization/lp.js';
import { buildCandidate, type RegistryModelInfo } from '../routing/score/scorer.js';
import { resolveUnifiedDecision, type UnifiedTurnInput } from './unified-decision.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

const row = (registryId: string): BenchModel => ({
  registryId, benchSlug: registryId, active: true, source: 'aa', effort: 'high',
  quality: { intelligence: 50, agenticCoding: 50 },
  axisProvenance: { intelligence: 'measured', agenticCoding: 'measured' },
});
const model = (id: string, contextWindow = 200_000): RegistryModelInfo => registryModel(`test/${id}`, {
  reasoning: true, contextWindow,
  thinkingLevelMap: { off: 'off', minimal: null, low: 'low', medium: 'low', high: 'high', xhigh: null, max: null },
});

function input(models = [model('one')]): UnifiedTurnInput {
  const rows = models.map((m) => row(`${m.provider}/${m.id}`));
  return {
    state: {
      phase: 'implement', workItemId: 'work-a', estimatedContextTokens: 10_000,
      needsVision: false, boundary: 'ordinary', friction: [], nowMs: 0,
      isSubagentSpawn: false, benchmarkIndexVersion: '4.3',
    },
    authorizationScope: { boundaryId: 'entry-a', workItemId: 'work-a', phase: 'implement', assignmentId: 'attempt-a', revision: 1 },
    cause: 'execution-contract',
    candidates: models.map((m, i) => buildCandidate(m, rows[i])),
    registryModels: models, rows,
    isExcluded: () => false, isCurrent: () => true,
    ports: { lp, domains: { lookup: () => undefined } },
  };
}

const noPreparation = () => undefined;

describe('production selection adapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi8-unified-'));
    vi.stubEnv('PI8_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps estimated fixture axes estimated unless the row declares measured provenance', () => {
    const store = JSON.parse(benchStoreJson({ models: [{
      ...row('test/one'), qualityEstimated: true, axisProvenance: { intelligence: 'measured' },
    }] }));
    expect(store.models[0].axisProvenance).toEqual({ intelligence: 'measured', agenticCoding: 'estimated' });
  });

  it('enumerates supported effort actions even when expansion has only one benchmark row', async () => {
    const result = await resolveUnifiedDecision(input(), noPreparation);
    expect(result.kind).toBe('decision');
    if (result.kind !== 'decision') throw new Error('Expected a decision');
    expect(result.authorization.allowedActors).toEqual(['test/one:off', 'test/one:low', 'test/one:high']);
    expect(result.decision.unified).toMatchObject({ ranked: 3, holdingPrompt: 1, insufficientEvidence: 2 });
    expect(result.decision.chosen).toBe('test/one:high');
    expect(result.candidates.find((c) => c.effort === 'low')?.effort).toBe('low');
  });

  it('records the numbers that ordered the best actions, including the chosen action and the incumbent', async () => {
    const models = [model('one'), model('two')];
    const result = await resolveUnifiedDecision({ ...input(models), incumbentKey: 'test/two:high' }, noPreparation);
    if (result.kind !== 'decision') throw new Error('Expected a decision');
    const { top } = result.decision.unified!;
    expect(top!.map((trace) => trace.rank)).toEqual([...top!.map((trace) => trace.rank)].sort((a, b) => a - b));
    expect(top![0]!.key).toBe(result.decision.chosen);
    expect(top!.some((trace) => trace.key === 'test/two:high')).toBe(true);
    for (const trace of top!) expect(Object.keys(trace.features)).toHaveLength(10);
    // An action without evidence is ranked last and was not compared by regret.
    const compared = top!.filter((trace) => trace.maxRegret !== undefined);
    expect(compared.length).toBeGreaterThan(0);
    expect(compared[0]).toBe(top![0]);
    expect(top![0]!.maxRegret).toBeLessThanOrEqual(Math.min(...compared.map((trace) => trace.maxRegret!)));
    expect(top!.filter((trace) => trace.maxRegret === undefined).every((trace) => trace.evidenceGaps.length > 0)).toBe(true);
  });

  it('preserves an owned thinking minimum but permits an explicit lower effort at a new boundary', async () => {
    const held = await resolveUnifiedDecision({ ...input(), minimumEffort: 'high' }, noPreparation);
    expect(held.kind).toBe('decision');
    if (held.kind !== 'decision') throw new Error('Expected a decision');
    expect(held.authorization.allowedActors).toEqual(['test/one:high']);
    const explicit = await resolveUnifiedDecision({ ...input(), effortOverride: 'low' }, noPreparation);
    expect(explicit.kind).toBe('decision');
    if (explicit.kind !== 'decision') throw new Error('Expected a decision');
    expect(explicit.authorization.allowedActors).toEqual(['test/one:low']);
    expect(explicit.decision.chosen).toBe('test/one:low');
  });

  it('retains smaller windows in the ranking but dispatches only models that hold the prompt', async () => {
    const turn = input([model('small', 20_000), model('wide', 200_000)]);
    turn.state.estimatedContextTokens = 40_000;
    const prepare = vi.fn((_ranking: readonly string[]) => undefined);
    const result = await resolveUnifiedDecision(turn, prepare);
    expect(result.kind).toBe('decision');
    if (result.kind !== 'decision') throw new Error('Expected a decision');
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toEqual(expect.arrayContaining(['test/small:high', 'test/wide:high']));
    expect(result.decision.unified).toMatchObject({ ranked: 6, holdingPrompt: 1 });
    expect(result.decision.fallbackChain).toEqual(['test/wide:high']);
  });

  it('excludes every effort of a failed executor only in its work item and implementation phase', async () => {
    const turn = input([model('one'), model('two')]);
    turn.workState = {
      intentKey: 'entry-a', workItemId: 'work-a', providerInvocation: 1, observedMutationTools: 0,
      terminal: { kind: 'implement', complexity: 'moderate', scope: 'bounded' },
      terminalBand: 'standard', excludedExecutors: ['test/one:low'],
    };
    const implementation = await resolveUnifiedDecision(turn, noPreparation);
    expect(implementation.kind).toBe('decision');
    if (implementation.kind !== 'decision') throw new Error('Expected a decision');
    expect(implementation.authorization.allowedActors).toEqual(['test/two:off', 'test/two:low', 'test/two:high']);
    expect(implementation.decision.fallbackChain).toEqual(['test/two:high']);
    const planning = await resolveUnifiedDecision({
      ...turn, state: { ...turn.state, phase: 'plan' },
      authorizationScope: { ...turn.authorizationScope, phase: 'plan' },
    }, noPreparation);
    expect(planning.kind).toBe('decision');
    if (planning.kind !== 'decision') throw new Error('Expected a decision');
    expect(planning.authorization.allowedActors).toContain('test/one:low');
    const unrelated = await resolveUnifiedDecision({
      ...turn, state: { ...turn.state, workItemId: 'work-b' },
      authorizationScope: { ...turn.authorizationScope, workItemId: 'work-b' },
    }, noPreparation);
    expect(unrelated.kind).toBe('decision');
    if (unrelated.kind !== 'decision') throw new Error('Expected a decision');
    expect(unrelated.authorization.allowedActors).toContain('test/one:low');
  });

  it('rejects a result when preferences change during selection', async () => {
    savePreferences({ version: 1, settledImplementation: 'lower_cost' });
    const turn = input();
    turn.ports = { lp, domains: { lookup: () => {
      savePreferences({ version: 1, settledImplementation: 'higher_coding_capability' });
      return undefined;
    } } };
    const prepare = vi.fn(noPreparation);
    expect(await resolveUnifiedDecision(turn, prepare)).toEqual({ kind: 'stale' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns no dispatch action for a cancelled or expired assignment', async () => {
    const signal = AbortSignal.abort();
    expect(await resolveUnifiedDecision({ ...input(), signal }, noPreparation)).toEqual({ kind: 'cancelled' });
    expect(await resolveUnifiedDecision({ ...input(), isCurrent: () => false }, noPreparation)).toEqual({ kind: 'stale' });
  });
});
