/**
 * Execution contract: the explicit plan/review → implement handoff.
 *
 * A planning or reviewing model submits the remaining work as a closed list
 * of file changes and verification runs, plus a rubric describing what the
 * executor still has to work out. The router, not the model, decides what the
 * contract is worth: the rubric and the router's own measurements set the
 * implement-axis minimum an executor must clear, the plan's shape sets the
 * lowest band that minimum may fall in, and a requirement at the frontier
 * ratio keeps the submitting model.
 *
 * A contract ends in one of three ways:
 * - broken: its executor edits an undeclared file, re-plans, or struggles; the
 *   next invocation returns to the submitter at its task type and thinking level;
 * - executed: every declared edit/create target was edited, or the invocation
 *   budget ran out; a released plan then returns to the submitter for review,
 *   because a finished plan can still be wrong in ways no break detects;
 * - dropped at the end of the user entry.
 *
 * An executor model that breaks contracts, or whose executed work the
 * submitter replaces with a new plan, `CONTRACT_STRIKE_LIMIT` times in one task
 * is excluded, and every later contract in that task must be served by a
 * strictly stronger model one band higher, so repeated handoffs terminate at
 * the submitter.
 *
 * Pure state transitions only: no I/O, no registry or session access.
 */
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type {
  CapabilityBand,
  ContractKeepReason,
  ContractOutcome,
  Dimension,
  ExecutionContractMeta,
  ExecutionRubric,
  MeasuredFeatures,
} from '../../types.js';
import { parseCandidateKey } from '../score/scorer.js';
import { floorForBand, type WorkPhaseState } from './work-phase.js';
import {
  BASE_REQUIREMENT,
  bandForRequirement,
  executionRequirement,
  isTestPath,
} from './execution-difficulty.js';

export const EXECUTION_CONTRACT_TOOL = 'commit_execution';

/** Strikes (breaks or reworks) by one executor model before it is excluded for the task. */
export const CONTRACT_STRIKE_LIMIT = 2;

/** Upper bound on steps; anything longer is still a plan, not a program. */
export const MAX_CONTRACT_STEPS = 12;

const BAND_ORDER: CapabilityBand[] = ['economy', 'standard', 'strong', 'frontier'];
const FILE_STEPS = new Set(['edit', 'create', 'delete']);
const PATTERN = /[*?[\]{}]/;

/**
 * Resolve a tool path the way Pi's file tools do for the cases a model writes:
 * a leading `@` mention and `~` expansion. Declared targets and edit calls go
 * through the same function, so the comparison stays symmetric.
 */
export function resolveToolPath(cwd: string, path: string): string {
  const bare = path.startsWith('@') ? path.slice(1) : path;
  const expanded = bare === '~' ? homedir() : bare.startsWith('~/') ? `${homedir()}${bare.slice(1)}` : bare;
  return resolve(cwd, expanded);
}

export type ContractBreakReason = NonNullable<ExecutionContractMeta['breakReason']>;

export interface ExecutionStepInput {
  kind: string;
  path?: string;
  change?: string;
  verifier?: string;
  scope?: string;
}

export interface ExecutionContract {
  status: ExecutionContractMeta['status'];
  /** Served candidate key (`provider/id[:effort]`) that submitted the plan. */
  submitter: string;
  /** The submitter's routed task type, restored when the contract breaks. */
  submitterDimension: Dimension;
  band: CapabilityBand;
  /** False when only the submitter executes the plan. */
  release: boolean;
  /** Implement-axis ratio the executor must reach; undefined when not released. */
  minimum?: number;
  /**
   * A released plan still releases the incumbent minimums: no invocation has
   * served it yet. The first invocation that serves the plan owns it.
   */
  releasePending?: boolean;
  requirement: number;
  keepReason?: ContractKeepReason;
  rubric: ExecutionRubric;
  measured: MeasuredFeatures;
  /** Absolute paths of every declared edit/create/delete target. */
  targets: string[];
  /** Declared edit/create targets not yet edited successfully. */
  pending: string[];
  steps: number;
  /** The intent's provider invocation that accepted the plan. */
  acceptedAt: number;
  executor?: string;
  executedReason?: ExecutionContractMeta['executedReason'];
  reviewEdited?: boolean;
  reviewVerifier?: ExecutionContractMeta['reviewVerifier'];
  breakReason?: ContractBreakReason;
  breaker?: string;
}

export interface ValidatedContract {
  ok: true;
  targets: string[];
  /** Targets of edit/create steps: the ones whose edits complete the plan. */
  editTargets: string[];
  steps: number;
  /** Lowest band the plan's shape allows; undefined keeps the submitter. */
  shapeBand: CapabilityBand | undefined;
  /** The plan deletes a file. */
  deletes: boolean;
  structural: Pick<MeasuredFeatures, 'files' | 'directories' | 'steps' | 'testTargets'>;
}

/** Why a submission was rejected: logged in place of the reason text, which can quote plan paths. */
export type ContractRejectCode =
  | 'no-steps'
  | 'too-many-steps'
  | 'unsupported-step'
  | 'missing-path'
  | 'pattern-path'
  | 'missing-change'
  | 'no-files'
  | 'not-plan-or-review'
  | 'plan-deliverable'
  | 'review-deliverable'
  | 'handoff-pending';

export interface ContractRejection {
  ok: false;
  code: ContractRejectCode;
  reason: string;
}

export type ContractValidation = ValidatedContract | ContractRejection;

/**
 * Lowest band the contract's shape allows. Undefined means the plan is too
 * large to hand off; the submitter keeps executing it.
 */
export function contractShapeBand(targets: number, steps: number): CapabilityBand | undefined {
  if (targets <= 2 && steps <= 4) return 'economy';
  if (targets <= 5 && steps <= 8) return 'standard';
  return undefined;
}

export function raiseBand(band: CapabilityBand, steps: number): CapabilityBand {
  const index = Math.min(BAND_ORDER.length - 1, BAND_ORDER.indexOf(band) + Math.max(0, steps));
  return BAND_ORDER[index]!;
}

function maxBand(a: CapabilityBand, b: CapabilityBand): CapabilityBand {
  return BAND_ORDER[Math.max(BAND_ORDER.indexOf(a), BAND_ORDER.indexOf(b))]!;
}

/**
 * Lowest implement-axis ratio a band admits; undefined keeps the submitter.
 * The band table has no economy minimum; a contract still needs one, or the
 * scorer would fall back to its frontier ratio.
 */
export function executionMinimum(band: CapabilityBand): number | undefined {
  if (band === 'frontier') return undefined;
  return band === 'economy' ? BASE_REQUIREMENT : floorForBand(band);
}

/** Provider invocations an executor gets before the plan counts as executed. */
export function contractBudget(steps: number): number {
  return 2 * steps + 4;
}

export function validateContract(steps: readonly ExecutionStepInput[] | undefined, cwd: string): ContractValidation {
  const fail = (code: ContractRejectCode, reason: string): ContractRejection => ({ ok: false, code, reason });
  if (!Array.isArray(steps) || steps.length === 0) return fail('no-steps', 'the plan has no steps');
  if (steps.length > MAX_CONTRACT_STEPS) {
    return fail('too-many-steps', `the plan has more than ${MAX_CONTRACT_STEPS} steps`);
  }
  const targets = new Set<string>();
  const editTargets = new Set<string>();
  const testTargets = new Set<string>();
  let deletes = false;
  for (const step of steps) {
    if (step.kind === 'verify') continue;
    if (!FILE_STEPS.has(step.kind)) return fail('unsupported-step', `unsupported step kind "${String(step.kind)}"`);
    const path = typeof step.path === 'string' ? step.path.trim() : '';
    if (!path) return fail('missing-path', `a ${step.kind} step has no path`);
    if (PATTERN.test(path)) return fail('pattern-path', `"${path}" is a pattern, not a file`);
    if (step.kind !== 'delete' && !(typeof step.change === 'string' && step.change.trim())) {
      return fail('missing-change', `${step.kind} ${path} does not describe the change`);
    }
    const target = resolveToolPath(cwd, path);
    targets.add(target);
    if (step.kind !== 'delete') editTargets.add(target);
    else deletes = true;
    if (isTestPath(path)) testTargets.add(target);
  }
  if (targets.size === 0) return fail('no-files', 'the plan changes no files');
  const all = [...targets];
  return {
    ok: true,
    targets: all,
    editTargets: [...editTargets],
    steps: steps.length,
    shapeBand: contractShapeBand(targets.size, steps.length),
    deletes,
    structural: {
      files: targets.size,
      directories: new Set(all.map((target) => dirname(target))).size,
      steps: steps.length,
      testTargets: testTargets.size,
    },
  };
}

export function acceptContract(
  state: WorkPhaseState,
  input: {
    submitter: string;
    submitterDimension: Dimension;
    validation: ValidatedContract;
    rubric: ExecutionRubric;
    measured: MeasuredFeatures;
  },
): WorkPhaseState {
  const { validation, rubric, measured } = input;
  const requirement = executionRequirement(rubric, measured);
  const assessed = bandForRequirement(requirement);
  const excluded = state.excludedExecutors?.length ?? 0;
  const band = raiseBand(maxBand(assessed, validation.shapeBand ?? 'frontier'), excluded);
  // A target whose existence was not measured is as unknown as a missing one.
  // A deleted file never completes a plan through an edit, and deleting it
  // from a shell breaks the plan, so only the submitter can finish it.
  const keepReason: ContractKeepReason | undefined = measured.missingTargets == null || measured.missingTargets > 0
    ? 'unknown-target'
    : validation.deletes
      ? 'delete'
      : validation.shapeBand == null
        ? 'size'
        : assessed === 'frontier'
          ? 'difficulty'
          : band === 'frontier' ? 'excluded' : undefined;
  const bandMinimum = keepReason == null ? executionMinimum(band) : undefined;
  const contract: ExecutionContract = {
    status: 'active',
    submitter: input.submitter,
    submitterDimension: input.submitterDimension,
    band: bandMinimum != null ? band : 'frontier',
    release: bandMinimum != null,
    ...(bandMinimum != null ? { minimum: Math.max(requirement, bandMinimum), releasePending: true } : {}),
    requirement,
    ...(keepReason ? { keepReason } : {}),
    rubric,
    measured,
    targets: validation.targets,
    pending: validation.editTargets,
    steps: validation.steps,
    acceptedAt: state.providerInvocation,
  };
  return { ...state, contract };
}

function sameModel(a: string, b: string): boolean {
  return parseCandidateKey(a).id === parseCandidateKey(b).id;
}

/** Count one strike against `model`; a model other than the submitter only. */
function strike(state: WorkPhaseState, model: string, submitter: string): WorkPhaseState {
  if (sameModel(model, submitter)) return state;
  const id = parseCandidateKey(model).id;
  const strikes = (state.contractStrikes?.[id] ?? 0) + 1;
  const excludedExecutors = strikes >= CONTRACT_STRIKE_LIMIT && !state.excludedExecutors?.some((key) => sameModel(key, model))
    ? [...(state.excludedExecutors ?? []), model]
    : state.excludedExecutors;
  return { ...state, contractStrikes: { ...state.contractStrikes, [id]: strikes }, excludedExecutors };
}

/**
 * Break the active contract. Only a different executor model earns a strike:
 * a submitter that breaks its own plan just returns to planning. A shell
 * write earns none either: the router cannot tell whether it left the plan.
 */
export function breakContract(
  state: WorkPhaseState,
  breaker: string | undefined,
  reason: ContractBreakReason,
): WorkPhaseState {
  const contract = state.contract;
  if (contract?.status !== 'active') return state;
  const struck = breaker && reason !== 'unattributed-mutation' ? strike(state, breaker, contract.submitter) : state;
  return {
    ...struck,
    contract: {
      ...contract,
      status: 'broken',
      breakReason: reason,
      ...(breaker ? { breaker } : {}),
    },
  };
}

/**
 * The submitter replaced an executed plan with a new one: the executed work
 * needed rework, which strikes its executor like a break.
 */
export function reworkContract(state: WorkPhaseState): WorkPhaseState {
  const contract = state.contract;
  if (contract?.status !== 'executed' || !contract.executor) return state;
  return strike(state, contract.executor, contract.submitter);
}

/**
 * Record `served` as the executor when it is a model other than the submitter
 * serving a released plan. A released plan can still be served by its
 * submitter (it may win on score, or serve as a fallback); only another model
 * makes the plan's outcome evidence about an executor.
 */
export function attributeExecutor(state: WorkPhaseState, served: string | undefined): WorkPhaseState {
  const contract = state.contract;
  if (!contract?.release || contract.executor || contract.status === 'broken') return state;
  if (!served || sameModel(served, contract.submitter)) return state;
  return { ...state, contract: { ...contract, executor: served } };
}

/**
 * Whether the submitter is reviewing the plan: another model executed it.
 * A plan only its submitter served continues as implementation.
 */
/** The plan's release boundary has been served: its executor keeps it from here. */
export function serveContractRelease(state: WorkPhaseState): WorkPhaseState {
  const contract = state.contract;
  if (!contract?.releasePending) return state;
  return { ...state, contract: { ...contract, releasePending: false } };
}

export function isUnderReview(contract: ExecutionContract): boolean {
  return contract.status === 'executed' && contract.release && contract.executor != null;
}

/**
 * Record a successful native edit/write. A declared edit/create target counts
 * toward completion; editing the last one executes the plan. During review,
 * any edit marks the executed work as fixed; without a review, later edits
 * are not fixes.
 */
export function noteContractEdit(state: WorkPhaseState, cwd: string, path: string, served: string | undefined): WorkPhaseState {
  const contract = state.contract;
  if (contract?.status === 'executed') {
    return !isUnderReview(contract) || contract.reviewEdited ? state : { ...state, contract: { ...contract, reviewEdited: true } };
  }
  if (contract?.status !== 'active') return state;
  const target = resolveToolPath(cwd, path);
  if (!contract.pending.includes(target)) return state;
  const pending = contract.pending.filter((entry) => entry !== target);
  const attributed = attributeExecutor(state, served);
  return {
    ...attributed,
    contract: {
      ...attributed.contract!,
      pending,
      ...(pending.length === 0 ? { status: 'executed' as const, executedReason: 'complete' as const } : {}),
    },
  };
}

/** Record the first verifier result after execution. */
export function noteContractVerifier(state: WorkPhaseState, passed: boolean): WorkPhaseState {
  const contract = state.contract;
  if (contract?.status !== 'executed' || contract.reviewVerifier) return state;
  return { ...state, contract: { ...contract, reviewVerifier: passed ? 'pass' : 'fail' } };
}

/**
 * Execute an active plan whose executor used up its invocation budget. Edits
 * the router cannot attribute (Bash writes, deletions) never complete a plan
 * on their own, so the budget is what ends such a plan.
 */
export function expireContract(state: WorkPhaseState): WorkPhaseState {
  const contract = state.contract;
  if (contract?.status !== 'active') return state;
  if (state.providerInvocation - contract.acceptedAt <= contractBudget(contract.steps)) return state;
  return { ...state, contract: { ...contract, status: 'executed', executedReason: 'budget' } };
}

/** Outcome of a contract still present when its user entry ends. */
export function entryEndOutcome(contract: ExecutionContract): ContractOutcome {
  if (contract.status === 'broken') return 'broken';
  if (contract.status === 'active') return 'unfinished';
  return contract.reviewEdited ? 'fixed' : 'clean';
}

export function isDeclaredTarget(contract: ExecutionContract, cwd: string, path: string): boolean {
  return contract.targets.includes(resolveToolPath(cwd, path));
}

/** Whether the submitter's model, at any effort, served `served`. */
export function servedBySubmitter(contract: ExecutionContract, served: string): boolean {
  return sameModel(served, contract.submitter);
}

/** Whether `key` names a model excluded from executing this task. */
export function isExcludedExecutor(state: WorkPhaseState | undefined, key: string): boolean {
  return state?.excludedExecutors?.some((excluded) => sameModel(excluded, key)) ?? false;
}

export function contractMeta(state: WorkPhaseState): ExecutionContractMeta | undefined {
  const contract = state.contract;
  if (!contract) return undefined;
  // A plan made from a handed-off investigation, in this entry or the one
  // after it, joins its outcome to that handoff.
  const handoffId = state.reasoningHandoff?.id ?? state.previousHandoffId;
  return {
    status: contract.status,
    band: contract.band,
    release: contract.release,
    ...(contract.minimum != null ? { minimum: contract.minimum } : {}),
    requirement: contract.requirement,
    ...(contract.keepReason ? { keepReason: contract.keepReason } : {}),
    rubric: contract.rubric,
    measured: contract.measured,
    submitter: contract.submitter,
    targets: contract.targets.length,
    steps: contract.steps,
    ...(contract.executor ? { executor: contract.executor } : {}),
    ...(contract.executedReason ? { executedReason: contract.executedReason } : {}),
    ...(contract.reviewEdited ? { reviewEdited: true } : {}),
    ...(contract.reviewVerifier ? { reviewVerifier: contract.reviewVerifier } : {}),
    ...(contract.breakReason ? { breakReason: contract.breakReason } : {}),
    ...(contract.breaker ? { breaker: contract.breaker } : {}),
    ...(state.excludedExecutors?.length ? { excludedExecutors: [...state.excludedExecutors] } : {}),
    ...(handoffId ? { handoffId } : {}),
  };
}
