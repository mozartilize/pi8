/**
 * The paired report and the activation verdict. The report compares the
 * candidate policy with the current policy on the same tasks. A task is the
 * independent unit. A repository is a cluster when several tasks share it.
 * Replicates repeat the measure of one task. They are not more tasks.
 *
 * A check that lacks enough evidence is `inconclusive`. It is never `pass`,
 * and never a failure of the candidate. A boundary-attribution check that has
 * no eligible unit is `not-applicable`, not zero errors.
 */
import type { ArmRunReport, EvaluatedAttempt } from './arm-runner.ts';
import { bootstrap, clopperPearsonLower, clopperPearsonUpper, isDegenerate, percentile, seedFromText } from './statistics.ts';
import { digestOf } from './recipe.ts';
import type { ActivationCampaignManifestV1, ActivationCheckStatus, ActivationVerdict } from './schema.ts';

/** One result of boundary attribution. A pair counts only when an independent oracle attributes it. */
export interface BoundaryPair {
  independentlyAttributable: boolean;
  unsafeCheap: boolean;
}

export interface PairedUnit {
  taskId: string;
  repositoryId: string;
  /** One attempt for each replicate slot of the current policy. */
  current: EvaluatedAttempt[];
  /** One attempt for each replicate slot of the candidate policy. */
  candidate: EvaluatedAttempt[];
  boundaryPairs?: BoundaryPair[];
}

export interface ReportInput {
  manifest: ActivationCampaignManifestV1;
  units: PairedUnit[];
  /** The run reports of both policy arms. They give the spend and the reuse. */
  armReports: ArmRunReport[];
}

export interface CheckResult {
  status: ActivationCheckStatus;
  /** Why the check is not `pass`. */
  reason?: string;
  estimate?: number;
  /** The bound that the check compared with its margin. */
  bound?: number;
  margin?: number;
  /** True when every paired difference was zero. */
  degenerate?: boolean;
  units?: number;
}

export interface ActivationReport {
  verdict: ActivationVerdict;
  reasons: string[];
  checks: { solveRate: CheckResult; silentFailure: CheckResult; cost: CheckResult; unsafeCheap: CheckResult };
  evidence: {
    tasks: number;
    repositories: number;
    usablePairedTasks: number;
    minimumsMet: boolean;
    /** Executions that the report refers to. An execution that two arms share counts one time. */
    distinctExecutions: number;
    attempts: number;
  };
  metrics: {
    latencyMsMean: Record<'current' | 'candidate', number | undefined>;
    latencyMsP95: Record<'current' | 'candidate', number | undefined>;
    fallbackRate: Record<'current' | 'candidate', number | undefined>;
    evidenceReuseRate?: number;
    newEvidenceCreationUsd: number;
    policyExecutionUsd: number;
    campaignBudgetExhausted: boolean;
    costIncomplete: boolean;
  };
}

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const solveRate = (attempts: readonly EvaluatedAttempt[]): number => mean(attempts.map((attempt) => (attempt.outcome === 'verified-pass' ? 1 : 0)));
const unusable = (unit: PairedUnit): boolean => unit.current.length === 0 || unit.candidate.length === 0
  || [...unit.current, ...unit.candidate].some((attempt) => attempt.outcome === 'environment-error');

export function buildReport(input: ReportInput): ActivationReport {
  const { manifest } = input;
  const reasons: string[] = [];
  const confidence = manifest.confidenceLevel;
  const seed = seedFromText(digestOf({ campaignId: manifest.campaignId, taskSet: manifest.taskSetDigest }));
  const clustered = manifest.intervalMethod === 'paired-repository-bootstrap';
  const usable = input.units.filter((unit) => !unusable(unit));
  const cluster = (unit: PairedUnit): string => (clustered ? unit.repositoryId : unit.taskId);

  const allAttempts = input.units.flatMap((unit) => [...unit.current, ...unit.candidate]);
  const evidence = {
    tasks: new Set(usable.map((unit) => unit.taskId)).size,
    repositories: new Set(usable.map((unit) => unit.repositoryId)).size,
    usablePairedTasks: usable.length,
    minimumsMet: false,
    distinctExecutions: new Set(allAttempts.map((attempt) => attempt.executionId)).size,
    attempts: allAttempts.length,
  };
  const minimum = manifest.minimumEvidence;
  evidence.minimumsMet = evidence.tasks >= minimum.distinctTasks && evidence.repositories >= minimum.distinctRepositories && evidence.usablePairedTasks >= minimum.usablePairedTasks;
  if (!evidence.minimumsMet) reasons.push('minimum evidence not met');

  const slots = input.armReports.flatMap((report) => report.slots);
  const budgetExhausted = slots.some((slot) => slot.kind === 'campaign-budget-exhausted');
  const costIncomplete = input.armReports.some((report) => report.costIncomplete) || allAttempts.some((attempt) => !attempt.costComplete);
  if (budgetExhausted) reasons.push('campaign budget exhausted');

  // ── Solve rate: paired bootstrap of the difference of the solve rates ──
  const solve: CheckResult = { status: 'inconclusive', margin: -manifest.margins.maxSolveRateDrop, units: usable.length };
  if (usable.length > 0) {
    const differences = usable.map((unit) => ({ cluster: cluster(unit), value: solveRate(unit.candidate) - solveRate(unit.current) }));
    const values = differences.map((item) => item.value);
    const result = bootstrap(differences, mean, { confidence, seed, clustered });
    solve.estimate = result.estimate;
    if (isDegenerate(values)) {
      solve.degenerate = true;
      solve.reason = 'every paired difference is zero, so a bootstrap interval would show nothing';
    } else {
      solve.bound = result.lower;
      if (result.lower >= solve.margin!) solve.status = 'pass';
      else if (result.upper < solve.margin!) solve.status = 'fail';
      else solve.reason = 'the bound crosses the margin';
    }
  } else solve.reason = 'no usable paired task';

  // ── Silent failure: exact one-sided bound on the rate of harmful units ──
  const silent: CheckResult = { status: 'inconclusive', margin: manifest.margins.maxSilentFailureHarmRate, units: usable.length };
  if (usable.length >= minimum.usablePairedTasks && usable.length > 0) {
    // A unit is harmful when the candidate has a silent failure that the current policy does not have in that unit.
    const harmful = usable.filter((unit) => unit.candidate.some((attempt) => attempt.silentFailure) && !unit.current.some((attempt) => attempt.silentFailure)).length;
    silent.estimate = harmful / usable.length;
    silent.bound = clopperPearsonUpper(harmful, usable.length, confidence);
    if (silent.bound <= silent.margin!) silent.status = 'pass';
    else if (clopperPearsonLower(harmful, usable.length, confidence) > silent.margin!) silent.status = 'fail';
    else silent.reason = 'the exact bound crosses the margin';
  } else silent.reason = 'too few independent units for an exact bound';

  // ── Cost: ratio of the all-in normalized cost, with every attempt counted ──
  const cost: CheckResult = { status: 'inconclusive', margin: manifest.margins.maxNormalizedCostRatio, units: usable.length };
  const total = (attempts: readonly EvaluatedAttempt[]): number => attempts.reduce((sum, attempt) => sum + (attempt.normalizedCostUsd ?? 0), 0);
  if (costIncomplete) cost.reason = 'cost attribution is incomplete';
  else if (usable.length === 0) cost.reason = 'no usable paired task';
  else {
    const pairs = usable.map((unit) => ({ cluster: cluster(unit), value: { current: total(unit.current), candidate: total(unit.candidate) } }));
    const ratio = (sample: ReadonlyArray<{ current: number; candidate: number }>): number => {
      const current = sample.reduce((sum, item) => sum + item.current, 0);
      return current === 0 ? Number.NaN : sample.reduce((sum, item) => sum + item.candidate, 0) / current;
    };
    const result = bootstrap(pairs, ratio, { confidence, seed, clustered });
    cost.estimate = result.estimate;
    if (Number.isNaN(result.estimate) || Number.isNaN(result.upper)) cost.reason = 'the current policy has no cost to compare with';
    else {
      cost.bound = result.upper;
      if (result.upper <= cost.margin!) cost.status = 'pass';
      else if (result.lower > cost.margin!) cost.status = 'fail';
      else cost.reason = 'the bound crosses the margin';
    }
  }

  // ── Unsafe cheap: conditional on boundary attribution ──
  const gate = manifest.unsafeCheapGate;
  const eligible = usable.filter((unit) => unit.boundaryPairs?.some((pair) => pair.independentlyAttributable));
  const unsafe: CheckResult = { status: 'not-applicable', margin: gate.maxUnsafeCheapUnitRate, units: eligible.length };
  if (eligible.length >= gate.minimumEligibleUnits) {
    const events = eligible.filter((unit) => unit.boundaryPairs?.some((pair) => pair.independentlyAttributable && pair.unsafeCheap)).length;
    unsafe.estimate = events / eligible.length;
    unsafe.bound = clopperPearsonUpper(events, eligible.length, confidence);
    if (unsafe.bound <= gate.maxUnsafeCheapUnitRate) unsafe.status = 'pass';
    else if (clopperPearsonLower(events, eligible.length, confidence) > gate.maxUnsafeCheapUnitRate) unsafe.status = 'fail';
    else {
      unsafe.status = 'inconclusive';
      unsafe.reason = 'the exact bound crosses the margin';
    }
  } else unsafe.reason = 'too few units with an independent boundary result';

  const checks = { solveRate: solve, silentFailure: silent, cost, unsafeCheap: unsafe };
  for (const [name, check] of Object.entries(checks)) {
    if (check.status === 'inconclusive' || check.degenerate) reasons.push(`${name}: ${check.reason ?? 'inconclusive'}`);
  }

  const failed = Object.values(checks).some((check) => check.status === 'fail');
  const required = [solve, silent, cost];
  const allRequiredPass = required.every((check) => check.status === 'pass');
  const unsafeBlocks = unsafe.status === 'inconclusive';
  let verdict: ActivationVerdict;
  if (failed) verdict = 'no-go';
  else if (!evidence.minimumsMet || budgetExhausted || costIncomplete || solve.degenerate || !allRequiredPass || unsafeBlocks) verdict = 'inconclusive';
  else verdict = 'go';

  const lanes = (key: 'current' | 'candidate'): EvaluatedAttempt[] => input.units.flatMap((unit) => unit[key]);
  const latencies = (key: 'current' | 'candidate'): number[] => lanes(key).map((attempt) => attempt.wallTimeMs);
  const fallbackRate = (key: 'current' | 'candidate'): number | undefined => (lanes(key).length === 0 ? undefined : lanes(key).filter((attempt) => attempt.fallbackCount > 0).length / lanes(key).length);
  const evaluated = slots.filter((slot) => slot.kind === 'evaluated');
  return {
    verdict,
    reasons,
    checks,
    evidence,
    metrics: {
      latencyMsMean: { current: latencies('current').length ? mean(latencies('current')) : undefined, candidate: latencies('candidate').length ? mean(latencies('candidate')) : undefined },
      latencyMsP95: { current: percentile(latencies('current'), 0.95), candidate: percentile(latencies('candidate'), 0.95) },
      fallbackRate: { current: fallbackRate('current'), candidate: fallbackRate('candidate') },
      ...(evaluated.length > 0 ? { evidenceReuseRate: evaluated.filter((slot) => slot.reused).length / evaluated.length } : {}),
      newEvidenceCreationUsd: input.armReports.reduce((sum, report) => sum + report.newEvidenceCreationUsd, 0),
      policyExecutionUsd: input.armReports.reduce((sum, report) => sum + report.policyExecutionUsd, 0),
      campaignBudgetExhausted: budgetExhausted,
      costIncomplete,
    },
  };
}
