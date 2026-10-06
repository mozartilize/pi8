import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetLedger, CampaignStore, manifestProblems, mayRerun, preflightMatrix } from './budget.ts';
import type { ActivationCampaignManifestV1, CampaignRetryPolicy } from './schema.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-campaign-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const retryPolicy: CampaignRetryPolicy = { maxProviderRetriesPerAttempt: 1, maxOperationalRerunsPerSlot: 2, retryableStatuses: ['provider-error', 'sandbox-error'] };

function manifest(over: Partial<ActivationCampaignManifestV1> = {}): ActivationCampaignManifestV1 {
  return {
    campaignId: 'c1', taskSetDigest: 't', repositorySplitDigest: 'r', candidatePoolDigest: 'p',
    policyDigests: { current: 'a', candidate: 'b' },
    repetitionsPerTask: 3, confidenceLevel: 0.95, intervalMethod: 'paired-task-bootstrap', rareEventBoundMethod: 'one-sided-clopper-pearson',
    margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.1, maxNormalizedCostRatio: 0.8 },
    minimumEvidence: { distinctTasks: 20, distinctRepositories: 5, usablePairedTasks: 15 },
    unsafeCheapGate: { mode: 'conditional-when-available', independentUnit: 'task', minimumEligibleUnits: 10, maxUnsafeCheapUnitRate: 0.2 },
    reusePolicy: { mode: 'historical-analysis' },
    evidenceSelectionPolicy: { reuse: { mode: 'historical-analysis' }, choose: 'exact-compatible', cutoffAt: '2999-01-01T00:00:00Z' },
    oracleDigest: 'o', graderRuntimeDigest: 'g', normalizedPriceDigest: 'n', retryPolicy,
    budget: { maxProviderInvocations: 1000, maxWallClockMs: 1e9, maxNewExecutions: 3, maxNewEvidenceUsd: 10 },
    ...over,
  };
}

describe('campaign manifest', () => {
  it('is not activation-capable without its margins and minimum sample sizes', () => {
    expect(manifestProblems(manifest())).toEqual([]);
    const broken = manifest({ margins: {} as ActivationCampaignManifestV1['margins'], minimumEvidence: { distinctTasks: 0, distinctRepositories: 5, usablePairedTasks: 15 } });
    expect(manifestProblems(broken)).toEqual(expect.arrayContaining(['margins.maxSilentFailureHarmRate', 'margins.maxNormalizedCostRatio', 'minimumEvidence.distinctTasks']));
  });

  it('freezes once and keeps the approval inside the campaign', () => {
    const store = new CampaignStore(dir, 'c1');
    store.freeze(manifest());
    expect(() => store.freeze(manifest())).toThrow(/already frozen/);
    store.savePreflight(preflightMatrix({ taskCount: 4, wholeTaskArms: 2, probesPerTask: 0, repetitions: 3, retryPolicy, providerCallsPerExecution: 50, usdPerExecution: 0.1 }));
    expect(store.isApproved()).toBe(false);
    const approved = store.approve('operator', new Date('2026-01-01T00:00:00Z'));
    expect(approved.approval).toMatchObject({ approvedBy: 'operator' });
    expect(store.isApproved()).toBe(true);
    const other = new CampaignStore(dir, 'c2');
    expect(other.isApproved()).toBe(false);
  });

  it('computes the preflight matrix with the retry ceilings', () => {
    const matrix = preflightMatrix({ taskCount: 4, wholeTaskArms: 2, probesPerTask: 1, repetitions: 3, retryPolicy, providerCallsPerExecution: 10, usdPerExecution: 0.5 });
    expect(matrix).toMatchObject({ plannedExecutions: 36, maxExecutionsWithReruns: 108, estimatedProviderCalls: 2160, projectedMaxNewEvidenceUsd: 54 });
  });
});

describe('budget ledger', () => {
  const ledgerOf = (budget: ActivationCampaignManifestV1['budget']) => new BudgetLedger(join(dir, 'ledger.jsonl'), budget);
  const request = (id: string, usd = 1) => ({ reservationId: id, slotId: `slot-${id}`, usd, providerInvocations: 10, wallClockMs: 1000 });

  it('reserves atomically for concurrent workers and stops at the limit', async () => {
    const budget = { maxProviderInvocations: 1000, maxWallClockMs: 1e9, maxNewExecutions: 3, maxNewEvidenceUsd: 10 };
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => ledgerOf(budget).reserve(request(`r${index}`))));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: 'campaign-budget-exhausted', limit: 'maxNewExecutions' });
  });

  it('keeps its state when a new session opens the same ledger', async () => {
    const budget = { maxProviderInvocations: 1000, maxWallClockMs: 1e9, maxNewExecutions: 5, maxNewEvidenceUsd: 2.5 };
    expect((await ledgerOf(budget).reserve(request('a', 1))).ok).toBe(true);
    expect((await ledgerOf(budget).reserve(request('b', 1))).ok).toBe(true);
    const third = await ledgerOf(budget).reserve(request('c', 1));
    expect(third).toEqual({ ok: false, reason: 'campaign-budget-exhausted', limit: 'maxNewEvidenceUsd' });
  });

  it('reconciles a reservation with the actual spend and frees a released one', async () => {
    const budget = { maxProviderInvocations: 1000, maxWallClockMs: 1e9, maxNewExecutions: 5, maxNewEvidenceUsd: 5 };
    const ledger = ledgerOf(budget);
    await ledger.reserve(request('a', 3));
    await ledger.reconcile('a', { usd: 0.5, providerInvocations: 4, wallClockMs: 10 });
    expect(ledger.totals()).toMatchObject({ usd: 0.5, providerInvocations: 4, executions: 1, usdIncomplete: false });
    await ledger.reserve(request('b', 1));
    await ledger.release('b');
    expect(ledger.totals().executions).toBe(1);
    await ledger.reconcile('a', { providerInvocations: 4, wallClockMs: 10 });
    expect(ledger.totals().usdIncomplete).toBe(true);
  });

  it('counts operational reruns of a slot and applies the frozen retry policy', async () => {
    const budget = { maxProviderInvocations: 1000, maxWallClockMs: 1e9, maxNewExecutions: 9 };
    const ledger = ledgerOf(budget);
    await ledger.reserve({ ...request('a'), slotId: 's', operationalRerun: false });
    await ledger.reserve({ ...request('b'), slotId: 's', operationalRerun: true });
    expect(ledger.operationalReruns('s')).toBe(1);
    expect(mayRerun(retryPolicy, 'provider-error', 1)).toBe(true);
    expect(mayRerun(retryPolicy, 'provider-error', 2)).toBe(false);
    expect(mayRerun(retryPolicy, 'oracle-error', 0)).toBe(false);
  });
});
