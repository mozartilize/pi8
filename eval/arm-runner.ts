/**
 * Run one fixed policy arm over the replicate slots of a task. For each slot
 * the runner selects stored evidence under the frozen selection policy. When
 * the slot is empty, it reserves campaign budget, runs the task once in a
 * clean sandbox, stores the execution, and grades it on the host. A stored
 * execution costs no new evidence-creation spend, but the arm still owns its
 * policy cost. The runner writes one immutable manifest of the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BudgetLedger, mayRerun } from './budget.ts';
import { getOrExecute, type ExecutionEvidenceStore, type ExecutionFiles } from './evidence-store.ts';
import { gradeExecution } from './oracle.ts';
import type { GradeStore } from './grade-store.ts';
import { slotKey, wholeTaskRecipe } from './recipe.ts';
import { runWholeTask, type AgentRunner } from './runner.ts';
import type { SandboxFactory, SandboxProfile } from './sandbox.ts';
import { historicalCost, normalizedCost, type PriceSnapshotSource, type PriceTable } from './spend.ts';
import type {
  ActivationCampaignManifestV1, CompletedExecutionV1, EvaluationArm, ExecutionEvidenceV1, ExecutionRecipeV1, ExecutionRequestV1,
  GradeEvidenceV1, PrivateOracleSpec, PublicTaskSpec,
} from './schema.ts';
import type { TaskOutcome } from '../extensions/routing/policy/outcome.ts';

export interface ArmRunDeps {
  manifest: ActivationCampaignManifestV1;
  ledger: BudgetLedger;
  evidenceStore: ExecutionEvidenceStore;
  gradeStore: GradeStore;
  runner: AgentRunner;
  /** The profile of a process sandbox. A run needs it when it has no sandbox factory. */
  profile?: SandboxProfile;
  /** Makes the sandbox for each run. It replaces the process sandbox that `profile` describes. */
  sandboxFactory?: SandboxFactory;
  /** Host path of the immutable public environment. */
  environmentPath: string;
  oracle: PrivateOracleSpec;
  oracleDigest: string;
  graderRuntimeDigest: string;
  priceTable: PriceTable;
  /** The registry price of each model at run time. */
  priceOf?: PriceSnapshotSource;
  /** Host directory for the run files and the run manifest. */
  evalDir: string;
  /** Names this run. It is provenance and is not in a recipe. */
  runId: string;
  /** Planned reservation for one new execution. */
  reservation: { usd?: number; providerInvocations: number };
  now?: () => Date;
}

export interface ArmRunRequest {
  arm: EvaluationArm;
  task: PublicTaskSpec;
  frozen: Pick<ExecutionRecipeV1, 'task' | 'runtime'>;
  replicates: number[];
}

/** An evaluated attempt. It refers to the stored execution and grade. It does not copy them. */
export interface EvaluatedAttempt {
  decisionEvidenceId: string;
  executionId: string;
  gradeId: string;
  candidateKey: string;
  outcome: TaskOutcome;
  historicalCostUsd?: number;
  normalizedCostUsd?: number;
  costComplete: boolean;
  wallTimeMs: number;
  providerFailure?: boolean;
  /** The run ended as completed and the oracle failed it. Nothing showed the failure to the user. */
  silentFailure?: boolean;
  fallbackCount: number;
}

export type SlotResult =
  | { replicate: number; kind: 'evaluated'; reused: boolean; recipeHash: string; attempt: EvaluatedAttempt; selectedGeneration: string }
  | { replicate: number; kind: 'campaign-budget-exhausted'; recipeHash: string }
  | { replicate: number; kind: 'operational-failure'; recipeHash: string; status: string };

export interface ArmRunReport {
  runId: string;
  armId: string;
  slots: SlotResult[];
  /** Money that this run spent now to create missing evidence. */
  newEvidenceCreationUsd: number;
  /** Money that the used evidence cost the policy, whether the run created it or reused it. */
  policyExecutionUsd: number;
  /** True when a cost above is a lower bound because some usage or price is missing. */
  costIncomplete: boolean;
  manifestPath: string;
}

class BudgetExhausted extends Error {}
class OperationalFailure extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status);
    this.status = status;
  }
}

export async function runFixedArm(deps: ArmRunDeps, request: ArmRunRequest): Promise<ArmRunReport> {
  const { arm, task, frozen } = request;
  const recipe = wholeTaskRecipe(arm, frozen);
  const slots: SlotResult[] = [];
  let newEvidenceCreationUsd = 0;
  let policyExecutionUsd = 0;
  let costIncomplete = false;

  for (const replicate of request.replicates) {
    const slot = slotKey(recipe, replicate);
    const executeRecipe = async (executionRequest: ExecutionRequestV1): Promise<{ result: CompletedExecutionV1; files: ExecutionFiles }> => {
      const slotId = `${slot.recipeHash}#${replicate}`;
      for (let rerun = 0; ; rerun++) {
        const reservationId = `${deps.runId}:${slotId}:${rerun}`;
        const reserved = await deps.ledger.reserve({
          reservationId,
          slotId,
          providerInvocations: deps.reservation.providerInvocations,
          wallClockMs: task.budget.wallTimeMs,
          ...(deps.reservation.usd !== undefined ? { usd: deps.reservation.usd } : {}),
          operationalRerun: rerun > 0,
        });
        if (!reserved.ok) throw new BudgetExhausted(reserved.limit);
        const runDir = join(deps.evalDir, 'runs', deps.runId, `${slot.recipeHash.slice(0, 12)}-${replicate}-${rerun}`);
        const output = await runWholeTask({
          runner: deps.runner, ...(deps.profile ? { profile: deps.profile } : {}), ...(deps.sandboxFactory ? { sandboxFactory: deps.sandboxFactory } : {}), task, recipe: executionRequest.recipe, arm,
          environmentPath: deps.environmentPath, runDir, runId: deps.runId,
          ...(deps.priceOf ? { priceOf: deps.priceOf } : {}),
        });
        const cost = historicalCost(output.result.rawUsage.attempts);
        await deps.ledger.reconcile(reservationId, {
          providerInvocations: output.result.rawUsage.attempts.length,
          wallClockMs: output.result.wallTimeMs,
          ...(cost.complete && cost.computedUsd !== undefined ? { usd: cost.computedUsd } : {}),
        });
        // Every attempt that this run starts is new creation spend, a failed attempt included.
        newEvidenceCreationUsd += cost.computedUsd ?? 0;
        if (!cost.complete) costIncomplete = true;
        const status = output.result.status;
        if (status !== 'provider-error' && status !== 'sandbox-error') return output;
        await deps.evidenceStore.recordOperationalAttempt(slot, output.result);
        if (!mayRerun(deps.manifest.retryPolicy, status, rerun)) throw new OperationalFailure(status);
      }
    };

    let evidence: ExecutionEvidenceV1;
    let reused: boolean;
    try {
      ({ evidence, reused } = await getOrExecute(deps.evidenceStore, { recipe, replicate }, deps.manifest.evidenceSelectionPolicy, executeRecipe));
    } catch (error) {
      if (error instanceof BudgetExhausted) slots.push({ replicate, kind: 'campaign-budget-exhausted', recipeHash: slot.recipeHash });
      else if (error instanceof OperationalFailure) slots.push({ replicate, kind: 'operational-failure', recipeHash: slot.recipeHash, status: error.status });
      else throw error;
      continue;
    }
    const grade: GradeEvidenceV1 = await gradeExecution({
      store: deps.gradeStore, evidence, oracle: deps.oracle, oracleDigest: deps.oracleDigest, graderRuntimeDigest: deps.graderRuntimeDigest,
    });
    const historical = historicalCost(evidence.rawUsage.attempts);
    const normalized = normalizedCost(evidence.rawUsage.attempts, deps.priceTable);
    policyExecutionUsd += historical.computedUsd ?? 0;
    if (!historical.complete) costIncomplete = true;
    slots.push({
      replicate, kind: 'evaluated', reused, recipeHash: slot.recipeHash, selectedGeneration: evidence.executionId,
      attempt: {
        decisionEvidenceId: evidence.decisionLogDigest,
        executionId: evidence.executionId,
        gradeId: grade.gradeId,
        candidateKey: evidence.servedTarget ?? arm.id,
        outcome: grade.outcome,
        ...(historical.computedUsd !== undefined ? { historicalCostUsd: historical.computedUsd } : {}),
        ...(normalized.computedUsd !== undefined ? { normalizedCostUsd: normalized.computedUsd } : {}),
        costComplete: historical.complete && normalized.complete,
        wallTimeMs: evidence.wallTimeMs,
        ...(evidence.providerFailures > 0 ? { providerFailure: true } : {}),
        ...(evidence.status === 'completed' && grade.outcome === 'verified-fail' ? { silentFailure: true } : {}),
        fallbackCount: evidence.fallbackCount,
      },
    });
  }

  const manifestPath = join(deps.evalDir, 'reports', deps.runId, `${arm.id}.run-manifest.json`);
  mkdirSync(join(deps.evalDir, 'reports', deps.runId), { recursive: true });
  if (existsSync(manifestPath)) throw new Error('the run manifest already exists');
  const report: ArmRunReport = { runId: deps.runId, armId: arm.id, slots, newEvidenceCreationUsd, policyExecutionUsd, costIncomplete, manifestPath };
  writeFileSync(manifestPath, `${JSON.stringify({
    ...report,
    campaignId: deps.manifest.campaignId,
    selectionPolicy: deps.manifest.evidenceSelectionPolicy,
    oracleDigest: deps.oracleDigest,
    graderRuntimeDigest: deps.graderRuntimeDigest,
    normalizedPriceDigest: deps.priceTable.digest,
    recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
  }, null, 2)}\n`, { flag: 'wx' });
  return report;
}
