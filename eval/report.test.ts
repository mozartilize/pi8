import { describe, expect, it } from 'vitest';
import type { ArmRunReport, EvaluatedAttempt } from './arm-runner.ts';
import { buildReport, type PairedUnit } from './report.ts';
import type { ActivationCampaignManifestV1 } from './schema.ts';

function manifest(over: Partial<ActivationCampaignManifestV1> = {}): ActivationCampaignManifestV1 {
  return {
    campaignId: 'c1', taskSetDigest: 't', repositorySplitDigest: 'r', candidatePoolDigest: 'p', policyDigests: { current: 'a', candidate: 'b' },
    repetitionsPerTask: 2, confidenceLevel: 0.95, intervalMethod: 'paired-repository-bootstrap', rareEventBoundMethod: 'one-sided-clopper-pearson',
    margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.2, maxNormalizedCostRatio: 0.8 },
    minimumEvidence: { distinctTasks: 20, distinctRepositories: 5, usablePairedTasks: 20 },
    unsafeCheapGate: { mode: 'conditional-when-available', independentUnit: 'task', minimumEligibleUnits: 10, maxUnsafeCheapUnitRate: 0.3 },
    reusePolicy: { mode: 'historical-analysis' },
    evidenceSelectionPolicy: { reuse: { mode: 'historical-analysis' }, choose: 'exact-compatible', cutoffAt: '2999-01-01T00:00:00Z' },
    oracleDigest: 'o', graderRuntimeDigest: 'g', normalizedPriceDigest: 'n',
    retryPolicy: { maxProviderRetriesPerAttempt: 0, maxOperationalRerunsPerSlot: 0, retryableStatuses: [] },
    budget: { maxProviderInvocations: 1, maxWallClockMs: 1, maxNewExecutions: 1 },
    ...over,
  };
}

let counter = 0;
function attempt(over: Partial<EvaluatedAttempt> = {}): EvaluatedAttempt {
  counter += 1;
  return { decisionEvidenceId: `d${counter}`, executionId: `e${counter}`, gradeId: `g${counter}`, candidateKey: 'p/m', outcome: 'verified-pass', normalizedCostUsd: 1, costComplete: true, wallTimeMs: 100, fallbackCount: 0, modelSwitches: 0, ...over };
}

/** Units for 25 tasks in 5 repositories. `shape` decides the attempts of each unit. */
function units(shape: (index: number) => { current: Partial<EvaluatedAttempt>[]; candidate: Partial<EvaluatedAttempt>[] }, count = 25): PairedUnit[] {
  return Array.from({ length: count }, (_, index) => {
    const { current, candidate } = shape(index);
    return { taskId: `t${index}`, repositoryId: `r${index % 5}`, current: current.map((over) => attempt(over)), candidate: candidate.map((over) => attempt(over)) };
  });
}

const report = (paired: PairedUnit[], over: Partial<ActivationCampaignManifestV1> = {}, armReports: ArmRunReport[] = []) => buildReport({ manifest: manifest(over), units: paired, armReports });
const arm = (over: Partial<ArmRunReport> = {}): ArmRunReport => ({ runId: 'r', armId: 'a', slots: [], newEvidenceCreationUsd: 0, policyExecutionUsd: 0, costIncomplete: false, manifestPath: '', ...over });

// The candidate solves one more task in every third unit and costs half as much.
const better = (index: number) => ({
  current: [{ outcome: index % 3 === 0 ? 'verified-fail' as const : 'verified-pass' as const, normalizedCostUsd: 2 }, { normalizedCostUsd: 2 }],
  candidate: [{ normalizedCostUsd: 1 }, { normalizedCostUsd: 1 }],
});

describe('activation report', () => {
  it('returns go when every required check passes, and an inapplicable boundary check does not block it', () => {
    const result = report(units(better));
    expect(result.checks.solveRate.status).toBe('pass');
    expect(result.checks.silentFailure).toMatchObject({ status: 'pass', estimate: 0 });
    expect(result.checks.silentFailure.bound).toBeGreaterThan(0);
    expect(result.checks.cost.status).toBe('pass');
    expect(result.checks.unsafeCheap.status).toBe('not-applicable');
    expect(result.verdict).toBe('go');
  });

  it('is inconclusive, not go, when every paired solve-rate difference is zero', () => {
    const result = report(units(() => ({ current: [{ normalizedCostUsd: 2 }, {}], candidate: [{}, {}] })));
    expect(result.checks.solveRate).toMatchObject({ status: 'inconclusive', degenerate: true, estimate: 0 });
    expect(result.verdict).toBe('inconclusive');
  });

  it('is no-go when the candidate solves clearly fewer tasks', () => {
    const worse = (index: number) => ({ current: [{}, {}], candidate: [{ outcome: index % 2 ? 'verified-fail' as const : 'verified-pass' as const }, { outcome: 'verified-fail' as const }] });
    const result = report(units(worse));
    expect(result.checks.solveRate.status).toBe('fail');
    expect(result.verdict).toBe('no-go');
  });

  it('does not accept zero silent failures in a small sample as a pass', () => {
    // 20 units and no event: the exact bound is 13.9 percent, which is above a margin of 10 percent.
    const result = report(units(better, 20), { margins: { maxSolveRateDrop: 0.05, maxSilentFailureHarmRate: 0.1, maxNormalizedCostRatio: 0.8 } });
    expect(result.checks.silentFailure.bound).toBeCloseTo(0.139, 3);
    expect(result.checks.silentFailure.status).toBe('inconclusive');
    expect(result.verdict).toBe('inconclusive');
  });

  it('is no-go when the candidate adds silent failures at a rate above the margin', () => {
    const harmful = (index: number) => ({ current: [{ outcome: index % 3 === 0 ? 'verified-fail' as const : 'verified-pass' as const }], candidate: [index < 15 ? { outcome: 'verified-fail' as const, silentFailure: true } : {}] });
    const result = report(units(harmful));
    expect(result.checks.silentFailure.status).toBe('fail');
    expect(result.verdict).toBe('no-go');
  });

  it('is inconclusive when cost is incomplete, when the budget ran out, or when evidence is too small', () => {
    const incomplete = report(units((index) => ({ ...better(index), candidate: [{ normalizedCostUsd: 1, costComplete: false }, {}] })));
    expect(incomplete.checks.cost.status).toBe('inconclusive');
    expect(incomplete.verdict).toBe('inconclusive');
    const exhausted = report(units(better), {}, [arm({ slots: [{ replicate: 1, kind: 'campaign-budget-exhausted', recipeHash: 'h' }] })]);
    expect(exhausted.metrics.campaignBudgetExhausted).toBe(true);
    expect(exhausted.verdict).toBe('inconclusive');
    expect(report(units(better, 6)).evidence.minimumsMet).toBe(false);
  });

  it('applies the boundary check only when enough units have an independent boundary result', () => {
    const withPairs = units(better).map((unit, index) => ({ ...unit, boundaryPairs: [{ independentlyAttributable: true, unsafeCheap: index < 12 }] }));
    const result = report(withPairs);
    expect(result.checks.unsafeCheap.status).toBe('fail');
    expect(result.verdict).toBe('no-go');
    const notIndependent = units(better).map((unit) => ({ ...unit, boundaryPairs: [{ independentlyAttributable: false, unsafeCheap: true }] }));
    expect(report(notIndependent).checks.unsafeCheap.status).toBe('not-applicable');
  });

  it('counts one execution that both arms share as one observation', () => {
    const shared = units(() => ({ current: [{}], candidate: [{}] })).map((unit) => ({ ...unit, candidate: unit.current }));
    const result = report(shared);
    expect(result.evidence.attempts).toBe(50);
    expect(result.evidence.distinctExecutions).toBe(25);
  });

  it('reports new creation cost apart from policy cost', () => {
    const result = report(units(better), {}, [arm({ newEvidenceCreationUsd: 1.5, policyExecutionUsd: 4 }), arm({ newEvidenceCreationUsd: 0.5, policyExecutionUsd: 3 })]);
    expect(result.metrics).toMatchObject({ newEvidenceCreationUsd: 2, policyExecutionUsd: 7 });
  });
});
