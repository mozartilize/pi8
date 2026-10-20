/**
 * Execution contract: the explicit plan/review → implement handoff.
 *
 * A planning or reviewing model submits the remaining work as a closed list
 * of file changes and verification runs, plus a rubric describing what the
 * executor still has to work out. The router, not the model, decides whether
 * the plan is released: a closed plan of a delegatable shape is released, and
 * the selector values its executor with the rubric.
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
 * is excluded from executing that task's later plans.
 *
 * Pure state transitions only: no I/O, no registry or session access.
 */
import { homedir } from 'node:os';
import type { FactsLog } from './change-facts.js';
import { dirname, resolve } from 'node:path';
import type {
  ContractKeepReason,
  ContractOutcome,
  ExecutionContractMeta,
  ExecutionRubric,
  MeasuredFeatures,
} from '../../types.js';
import { parseCandidateKey } from '../score/scorer.js';
import type { EntryRoutingState } from './entry-routing-state.js';
import { isTestPath } from './execution-difficulty.js';

export const EXECUTION_CONTRACT_TOOL = 'commit_execution';

/** Strikes (breaks or reworks) by one executor model before it is excluded for the task. */
export const CONTRACT_STRIKE_LIMIT = 2;

/** Upper bound on steps; anything longer is still a plan, not a program. */
export const MAX_CONTRACT_STEPS = 12;

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
  /**
   * Served candidate key (`provider/id[:effort]`) that submitted the plan.
   * A broken or reviewed plan returns to this model at this effort or higher.
   */
  submitter: string;
  /**
   * True when the submitter served only because of an escalation or a
   * fallback. Its plan does not return to it for review: the review gets its
   * own decision.
   */
  submitterTemporary?: boolean;
  /** False when only the submitter executes the plan. */
  release: boolean;
  /**
   * A released plan still releases the incumbent minimums: no invocation has
   * served it yet. The first invocation that serves the plan owns it.
   */
  releasePending?: boolean;
  keepReason?: ContractKeepReason;
  /** Undefined when the submitter scored no criterion. */
  rubric?: ExecutionRubric;
  measured: MeasuredFeatures;
  /** Declared facts as codes, router measurements, and the shadow requirement. */
  facts?: FactsLog;
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
  /** The plan is small enough for another model to execute: up to five files and eight steps. */
  delegatable: boolean;
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

/** A plan with more files or steps stays with its submitter. */
export function delegatableShape(targets: number, steps: number): boolean {
  return targets <= 5 && steps <= 8;
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
    delegatable: delegatableShape(targets.size, steps.length),
    deletes,
    structural: {
      files: targets.size,
      directories: new Set(all.map((target) => dirname(target))).size,
      steps: steps.length,
      testTargets: testTargets.size,
    },
  };
}

interface AcceptInput {
  submitter: string;
  submitterTemporary?: boolean;
  validation: ValidatedContract;
  rubric: ExecutionRubric | undefined;
  measured: MeasuredFeatures;
}

/**
 * Lowest `openDecisions` level that names a behavior, interface, or design
 * choice that is still open. A plan with an open choice is not closed, so its
 * submitter keeps it.
 */
const OPEN_DECISION_LEVEL = 4;

/**
 * Accept a closed plan. A plan is released to the model the selector chooses
 * unless it is unsafe or unfinished for another model: an unmeasured or
 * missing target, a deleted file, too many files or steps, or an open
 * behavior, interface, or design choice. Benchmark quality and task
 * difficulty do not keep a plan: the selector values the executor with the
 * plan's rubric.
 */
export function acceptContract(state: EntryRoutingState, input: AcceptInput): EntryRoutingState {
  const { validation, rubric, measured } = input;
  const keepReason: ContractKeepReason | undefined = measured.missingTargets == null || measured.missingTargets > 0
    ? 'unknown-target'
    : validation.deletes ? 'delete' : !validation.delegatable ? 'size'
        : (rubric?.openDecisions ?? 0) >= OPEN_DECISION_LEVEL ? 'open-decisions' : undefined;
  return {
    ...state,
    contract: {
      status: 'active', submitter: input.submitter,
      ...(input.submitterTemporary ? { submitterTemporary: true } : {}),
      release: keepReason === undefined,
      ...(keepReason ? { keepReason } : { releasePending: true }),
      ...(rubric ? { rubric } : {}), measured,
      targets: validation.targets, pending: validation.editTargets,
      steps: validation.steps, acceptedAt: state.providerInvocation,
    },
  };
}

/**
 * Canonical `provider/model` identity of a candidate key, without effort. The
 * same model id on another provider is another model: it has its own
 * strikes, and a submitter does not shield it.
 */
function modelIdentity(key: string): string {
  const parsed = parseCandidateKey(key);
  return `${parsed.provider}/${parsed.id}`;
}

function sameModel(a: string, b: string): boolean {
  return modelIdentity(a) === modelIdentity(b);
}

/**
 * Count one strike against `model` in the entry's execution flow; a model
 * other than the submitter only. Without a flow there is no strike scope:
 * only an accepted implement handoff starts one.
 */
function strike(state: EntryRoutingState, model: string, submitter: string): EntryRoutingState {
  const flow = state.executionFlow;
  if (!flow || sameModel(model, submitter)) return state;
  const id = modelIdentity(model);
  const strikes = (flow.strikesByModel[id] ?? 0) + 1;
  const excludedModels = strikes >= CONTRACT_STRIKE_LIMIT && !flow.excludedModels.some((key) => sameModel(key, model))
    ? [...flow.excludedModels, id]
    : flow.excludedModels;
  return { ...state, executionFlow: { ...flow, strikesByModel: { ...flow.strikesByModel, [id]: strikes }, excludedModels } };
}

/**
 * Break the active contract. Only a different executor model earns a strike:
 * a submitter that breaks its own plan just returns to planning. A shell
 * write earns none either: the router cannot tell whether it left the plan.
 */
export function breakContract(
  state: EntryRoutingState,
  breaker: string | undefined,
  reason: ContractBreakReason,
): EntryRoutingState {
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
export function reworkContract(state: EntryRoutingState): EntryRoutingState {
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
export function attributeExecutor(state: EntryRoutingState, served: string | undefined): EntryRoutingState {
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
export function serveContractRelease(state: EntryRoutingState): EntryRoutingState {
  const contract = state.contract;
  if (!contract?.releasePending) return state;
  return { ...state, contract: { ...contract, releasePending: false } };
}

export function isUnderReview(contract: ExecutionContract): boolean {
  return contract.status === 'executed' && contract.release && contract.executor != null;
}

/**
 * The contract whose submitter serves the next invocation. A broken plan
 * returns to its submitter. A plan another model executed returns to its
 * submitter for review, unless the submitter served only because of an
 * escalation or a fallback: then the review gets its own decision.
 */
export function handBackContract(contract: ExecutionContract | undefined): ExecutionContract | undefined {
  if (!contract) return undefined;
  if (contract.status === 'broken') return contract;
  return isUnderReview(contract) && !contract.submitterTemporary ? contract : undefined;
}

/**
 * Record a successful native edit/write. A declared edit/create target counts
 * toward completion; editing the last one executes the plan. During review,
 * any edit marks the executed work as fixed; without a review, later edits
 * are not fixes.
 */
export function noteContractEdit(state: EntryRoutingState, cwd: string, path: string, served: string | undefined): EntryRoutingState {
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
export function noteContractVerifier(state: EntryRoutingState, passed: boolean): EntryRoutingState {
  const contract = state.contract;
  if (contract?.status !== 'executed' || contract.reviewVerifier) return state;
  return { ...state, contract: { ...contract, reviewVerifier: passed ? 'pass' : 'fail' } };
}

/**
 * Execute an active plan whose executor used up its invocation budget. Edits
 * the router cannot attribute (Bash writes, deletions) never complete a plan
 * on their own, so the budget is what ends such a plan.
 */
export function expireContract(state: EntryRoutingState): EntryRoutingState {
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

/** Whether `key` names a model that the entry's execution flow excluded from executing. */
export function isExcludedExecutor(state: EntryRoutingState | undefined, key: string): boolean {
  return state?.executionFlow?.excludedModels.some((excluded) => sameModel(excluded, key)) ?? false;
}

export function contractMeta(state: EntryRoutingState): ExecutionContractMeta | undefined {
  const contract = state.contract;
  if (!contract) return undefined;
  // A plan made from a context handoff, in this entry or the one
  // after it, joins its outcome to that handoff.
  const handoffId = state.reasoningHandoff?.id;
  return {
    status: contract.status,
    release: contract.release,
    ...(contract.keepReason ? { keepReason: contract.keepReason } : {}),
    rubric: contract.rubric,
    measured: contract.measured,
    ...(contract.facts ? { facts: contract.facts } : {}),
    submitter: contract.submitter,
    targets: contract.targets.length,
    steps: contract.steps,
    ...(contract.executor ? { executor: contract.executor } : {}),
    ...(contract.executedReason ? { executedReason: contract.executedReason } : {}),
    ...(contract.reviewEdited ? { reviewEdited: true } : {}),
    ...(contract.reviewVerifier ? { reviewVerifier: contract.reviewVerifier } : {}),
    ...(contract.breakReason ? { breakReason: contract.breakReason } : {}),
    ...(contract.breaker ? { breaker: contract.breaker } : {}),
    ...(state.executionFlow?.excludedModels.length ? { excludedExecutors: [...state.executionFlow.excludedModels] } : {}),
    ...(state.executionFlow ? { flowId: state.executionFlow.flowId } : {}),
    ...(handoffId ? { handoffId } : {}),
  };
}
