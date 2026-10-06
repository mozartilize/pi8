/**
 * Campaign state outside every Pi session: the frozen manifest, the preflight
 * matrix, and a budget ledger. Several workers and several sessions share one
 * ledger. Before a new paid execution, the runner reserves budget in one
 * atomic step. After the execution, it reconciles the reservation with the
 * actual spend. A budget that runs out makes the campaign inconclusive. It is
 * never a result about a candidate.
 *
 *   campaigns/<campaign-id>/manifest.json
 *   campaigns/<campaign-id>/preflight.json
 *   campaigns/<campaign-id>/budget-ledger.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeJsonAtomic } from './fs-util.ts';
import { digestOf } from './recipe.ts';
import type { ActivationCampaignManifestV1, CampaignBudget, CampaignRetryPolicy } from './schema.ts';

// ── Manifest ─────────────────────────────────────────────────────────────

const isFraction = (value: unknown): boolean => typeof value === 'number' && value > 0 && value < 1;
const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * The problems that stop a campaign from being activation-capable. The margins
 * and the minimum sample sizes come from development data and a power analysis
 * before the holdout. A campaign without them cannot decide activation.
 */
export function manifestProblems(manifest: ActivationCampaignManifestV1): string[] {
  const problems: string[] = [];
  if (!isFraction(manifest.confidenceLevel)) problems.push('confidenceLevel');
  if (!isCount(manifest.repetitionsPerTask)) problems.push('repetitionsPerTask');
  const { margins, minimumEvidence, unsafeCheapGate, budget } = manifest;
  if (!(typeof margins?.maxSolveRateDrop === 'number' && margins.maxSolveRateDrop >= 0)) problems.push('margins.maxSolveRateDrop');
  if (!isFraction(margins?.maxSilentFailureHarmRate)) problems.push('margins.maxSilentFailureHarmRate');
  if (!(typeof margins?.maxNormalizedCostRatio === 'number' && margins.maxNormalizedCostRatio > 0)) problems.push('margins.maxNormalizedCostRatio');
  for (const name of ['distinctTasks', 'distinctRepositories', 'usablePairedTasks'] as const) {
    if (!isCount(minimumEvidence?.[name])) problems.push(`minimumEvidence.${name}`);
  }
  if (!isCount(unsafeCheapGate?.minimumEligibleUnits)) problems.push('unsafeCheapGate.minimumEligibleUnits');
  if (!isFraction(unsafeCheapGate?.maxUnsafeCheapUnitRate)) problems.push('unsafeCheapGate.maxUnsafeCheapUnitRate');
  if (!isCount(budget?.maxProviderInvocations) || !isCount(budget?.maxNewExecutions) || !isCount(budget?.maxWallClockMs)) problems.push('budget');
  if (!manifest.retryPolicy) problems.push('retryPolicy');
  return problems;
}

export interface PreflightInput {
  taskCount: number;
  wholeTaskArms: number;
  /** Planned boundary-attribution probes for each task. */
  probesPerTask: number;
  repetitions: number;
  retryPolicy: CampaignRetryPolicy;
  /** Planned provider calls for one execution. */
  providerCallsPerExecution: number;
  /** Planned cost of one execution, when the prices allow an estimate. */
  usdPerExecution?: number;
}

export interface PreflightMatrix extends PreflightInput {
  plannedExecutions: number;
  maxExecutionsWithReruns: number;
  estimatedProviderCalls: number;
  /** An upper bound of the new evidence spend. Absent when no price is known. */
  projectedMaxNewEvidenceUsd?: number;
}

export function preflightMatrix(input: PreflightInput): PreflightMatrix {
  const plannedExecutions = input.taskCount * (input.wholeTaskArms + input.probesPerTask) * input.repetitions;
  const maxExecutionsWithReruns = plannedExecutions * (1 + input.retryPolicy.maxOperationalRerunsPerSlot);
  const estimatedProviderCalls = maxExecutionsWithReruns * input.providerCallsPerExecution * (1 + input.retryPolicy.maxProviderRetriesPerAttempt);
  return {
    ...input,
    plannedExecutions,
    maxExecutionsWithReruns,
    estimatedProviderCalls,
    ...(input.usdPerExecution !== undefined ? { projectedMaxNewEvidenceUsd: maxExecutionsWithReruns * input.usdPerExecution } : {}),
  };
}

export class CampaignStore {
  readonly campaignId: string;
  private readonly dir: string;

  constructor(evalDir: string, campaignId: string) {
    this.campaignId = campaignId;
    this.dir = join(evalDir, 'campaigns', campaignId);
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  /** Freeze the manifest. A frozen manifest cannot change. */
  freeze(manifest: ActivationCampaignManifestV1): void {
    if (manifest.campaignId !== this.campaignId) throw new Error('manifest belongs to another campaign');
    if (existsSync(this.file('manifest.json'))) throw new Error('the manifest is already frozen');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file('manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }

  manifest(): ActivationCampaignManifestV1 {
    return JSON.parse(readFileSync(this.file('manifest.json'), 'utf8')) as ActivationCampaignManifestV1;
  }

  savePreflight(matrix: PreflightMatrix): string {
    writeJsonAtomic(this.file('preflight.json'), matrix);
    return digestOf(matrix);
  }

  preflight(): PreflightMatrix {
    return JSON.parse(readFileSync(this.file('preflight.json'), 'utf8')) as PreflightMatrix;
  }

  /**
   * Record the user approval of the budget and the matrix. The approval is in
   * the campaign directory, so it does not carry over to another campaign.
   */
  approve(approvedBy: string, now: Date = new Date()): ActivationCampaignManifestV1 {
    const manifest = this.manifest();
    const approved: ActivationCampaignManifestV1 = {
      ...manifest,
      approval: { approvedAt: now.toISOString(), approvedBy, budgetDigest: digestOf(manifest.budget), matrixDigest: digestOf(this.preflight()) },
    };
    writeJsonAtomic(this.file('approval.json'), approved.approval);
    return approved;
  }

  /** True when an approval exists for this exact budget and matrix. */
  isApproved(): boolean {
    try {
      const approval = JSON.parse(readFileSync(this.file('approval.json'), 'utf8')) as ActivationCampaignManifestV1['approval'];
      return approval?.budgetDigest === digestOf(this.manifest().budget) && approval?.matrixDigest === digestOf(this.preflight());
    } catch {
      return false;
    }
  }

  ledger(): BudgetLedger {
    return new BudgetLedger(this.file('budget-ledger.jsonl'), this.manifest().budget);
  }
}

// ── Budget ledger ────────────────────────────────────────────────────────

export interface BudgetRequest {
  reservationId: string;
  /** The slot that the paid execution fills. An operational rerun uses the same slot. */
  slotId: string;
  usd?: number;
  providerInvocations: number;
  wallClockMs: number;
  /** True when this reservation reruns a slot after an operational failure. */
  operationalRerun?: boolean;
}

export interface BudgetActual {
  usd?: number;
  providerInvocations: number;
  wallClockMs: number;
}

type LedgerEvent =
  | { type: 'reserve'; at: number; request: BudgetRequest }
  | { type: 'reconcile'; at: number; reservationId: string; actual: BudgetActual }
  | { type: 'release'; at: number; reservationId: string };

export interface BudgetTotals {
  usd: number;
  providerInvocations: number;
  wallClockMs: number;
  executions: number;
  /** True when a paid execution has no known cost. The usd total is then a lower bound. */
  usdIncomplete: boolean;
}

export type ReserveResult = { ok: true } | { ok: false; reason: 'campaign-budget-exhausted'; limit: keyof CampaignBudget };

export class BudgetLedger {
  private readonly path: string;
  private readonly budget: CampaignBudget;

  constructor(path: string, budget: CampaignBudget) {
    this.path = path;
    this.budget = budget;
  }

  private events(): LedgerEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEvent);
  }

  /** The spend so far. A reconciled reservation counts at its actual value. An open one counts at its reserved value. */
  totals(): BudgetTotals {
    const open = new Map<string, BudgetRequest>();
    const actual = new Map<string, BudgetActual>();
    for (const event of this.events()) {
      if (event.type === 'reserve') open.set(event.request.reservationId, event.request);
      else if (event.type === 'reconcile') actual.set(event.reservationId, event.actual);
      else open.delete(event.reservationId);
    }
    const totals: BudgetTotals = { usd: 0, providerInvocations: 0, wallClockMs: 0, executions: open.size, usdIncomplete: false };
    for (const [id, request] of open) {
      const spent = actual.get(id) ?? request;
      if (spent.usd === undefined) totals.usdIncomplete = true;
      totals.usd += spent.usd ?? 0;
      totals.providerInvocations += spent.providerInvocations;
      totals.wallClockMs += spent.wallClockMs;
    }
    return totals;
  }

  private append(event: LedgerEvent): void {
    mkdirSync(join(this.path, '..'), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  /** Check the limits and reserve in one locked step. Several workers cannot reserve the same budget twice. */
  reserve(request: BudgetRequest, now: number = Date.now()): Promise<ReserveResult> {
    return withFileLock(`${this.path}.lock`, (): ReserveResult => {
      const totals = this.totals();
      const { budget } = this;
      if (totals.executions + 1 > budget.maxNewExecutions) return { ok: false, reason: 'campaign-budget-exhausted', limit: 'maxNewExecutions' };
      if (totals.providerInvocations + request.providerInvocations > budget.maxProviderInvocations) return { ok: false, reason: 'campaign-budget-exhausted', limit: 'maxProviderInvocations' };
      if (totals.wallClockMs + request.wallClockMs > budget.maxWallClockMs) return { ok: false, reason: 'campaign-budget-exhausted', limit: 'maxWallClockMs' };
      if (budget.maxNewEvidenceUsd !== undefined) {
        // A reservation without a price cannot be checked against a money limit.
        if (request.usd === undefined) return { ok: false, reason: 'campaign-budget-exhausted', limit: 'maxNewEvidenceUsd' };
        if (totals.usd + request.usd > budget.maxNewEvidenceUsd) return { ok: false, reason: 'campaign-budget-exhausted', limit: 'maxNewEvidenceUsd' };
      }
      this.append({ type: 'reserve', at: now, request });
      return { ok: true };
    });
  }

  /** Replace a reservation with the actual spend. */
  reconcile(reservationId: string, actual: BudgetActual, now: number = Date.now()): Promise<void> {
    return withFileLock(`${this.path}.lock`, () => this.append({ type: 'reconcile', at: now, reservationId, actual }));
  }

  /** Cancel a reservation of an execution that never started. */
  release(reservationId: string, now: number = Date.now()): Promise<void> {
    return withFileLock(`${this.path}.lock`, () => this.append({ type: 'release', at: now, reservationId }));
  }

  /** The number of operational reruns that a slot has used. */
  operationalReruns(slotId: string): number {
    return this.events().filter((event) => event.type === 'reserve' && event.request.slotId === slotId && event.request.operationalRerun).length;
  }
}

/** True when the frozen retry policy allows another operational rerun of a slot. */
export function mayRerun(policy: CampaignRetryPolicy, status: CampaignRetryPolicy['retryableStatuses'][number], rerunsUsed: number): boolean {
  return policy.retryableStatuses.includes(status) && rerunsUsed < policy.maxOperationalRerunsPerSlot;
}
