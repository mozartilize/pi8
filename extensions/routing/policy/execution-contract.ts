/**
 * Execution contract: the explicit plan/review → implement handoff.
 *
 * A planning or reviewing model submits the remaining work as a closed list
 * of file changes and verification runs. The router, not the model, decides
 * what the contract is worth: its shape sets a capability band, the band sets
 * the implement-axis minimum an executor must clear, and anything larger than
 * the `standard` shape keeps the submitting model. A contract is broken when
 * its executor edits an undeclared file, re-plans, or struggles; the next
 * invocation returns to the submitter at its task type and thinking level.
 * An executor model that breaks contracts `CONTRACT_STRIKE_LIMIT` times in one
 * task is excluded, and every later contract in that task must be served by a
 * strictly stronger model one band higher, so repeated handoffs terminate at
 * the submitter.
 *
 * Pure state transitions only: no I/O, no registry or session access.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CapabilityBand, Dimension, ExecutionContractMeta } from '../../types.js';
import { parseCandidateKey } from '../score/scorer.js';
import { floorForBand, type WorkPhaseState } from './work-phase.js';

export const EXECUTION_CONTRACT_TOOL = 'commit_execution';

/** Breaks by one executor model before it is excluded for the task. */
export const CONTRACT_STRIKE_LIMIT = 2;

/** Upper bound on steps; anything longer is still a plan, not a program. */
export const MAX_CONTRACT_STEPS = 12;

/**
 * Implement-axis minimum for an `economy` contract. The multi-work band table
 * has no economy minimum because it never engages below `strong`; a contract
 * still needs one, or the scorer would fall back to its frontier ratio.
 */
export const ECONOMY_EXECUTION_MINIMUM = 0.30;

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
  status: 'active' | 'broken';
  /** Served candidate key (`provider/id[:effort]`) that submitted the plan. */
  submitter: string;
  /** The submitter's routed task type, restored when the contract breaks. */
  submitterDimension: Dimension;
  band: CapabilityBand;
  /** False when only the submitter's capability satisfies the band. */
  release: boolean;
  /** Absolute paths of every declared edit/create/delete target. */
  targets: string[];
  steps: number;
  breakReason?: ContractBreakReason;
  breaker?: string;
}

export type ContractValidation =
  | { ok: true; targets: string[]; steps: number; shapeBand: CapabilityBand | undefined }
  | { ok: false; reason: string };

/**
 * Band implied by the contract's shape. Undefined means the plan is too large
 * to hand off; the submitter keeps executing it.
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

/** Implement-axis ratio an executor must reach; undefined keeps the submitter. */
export function executionMinimum(band: CapabilityBand): number | undefined {
  if (band === 'frontier') return undefined;
  return band === 'economy' ? ECONOMY_EXECUTION_MINIMUM : floorForBand(band);
}

export function validateContract(steps: readonly ExecutionStepInput[] | undefined, cwd: string): ContractValidation {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'the plan has no steps' };
  if (steps.length > MAX_CONTRACT_STEPS) {
    return { ok: false, reason: `the plan has more than ${MAX_CONTRACT_STEPS} steps` };
  }
  const targets = new Set<string>();
  for (const step of steps) {
    if (step.kind === 'verify') continue;
    if (!FILE_STEPS.has(step.kind)) return { ok: false, reason: `unsupported step kind "${String(step.kind)}"` };
    const path = typeof step.path === 'string' ? step.path.trim() : '';
    if (!path) return { ok: false, reason: `a ${step.kind} step has no path` };
    if (PATTERN.test(path)) return { ok: false, reason: `"${path}" is a pattern, not a file` };
    if (step.kind !== 'delete' && !(typeof step.change === 'string' && step.change.trim())) {
      return { ok: false, reason: `${step.kind} ${path} does not describe the change` };
    }
    targets.add(resolveToolPath(cwd, path));
  }
  if (targets.size === 0) return { ok: false, reason: 'the plan changes no files' };
  return { ok: true, targets: [...targets], steps: steps.length, shapeBand: contractShapeBand(targets.size, steps.length) };
}

export function acceptContract(
  state: WorkPhaseState,
  input: {
    submitter: string;
    submitterDimension: Dimension;
    targets: string[];
    steps: number;
    shapeBand: CapabilityBand | undefined;
  },
): WorkPhaseState {
  const excluded = state.excludedExecutors?.length ?? 0;
  const band = input.shapeBand == null ? 'frontier' : raiseBand(input.shapeBand, excluded);
  const contract: ExecutionContract = {
    status: 'active',
    submitter: input.submitter,
    submitterDimension: input.submitterDimension,
    band,
    release: executionMinimum(band) != null,
    targets: input.targets,
    steps: input.steps,
  };
  return { ...state, contract };
}

function sameModel(a: string, b: string): boolean {
  return parseCandidateKey(a).id === parseCandidateKey(b).id;
}

/**
 * Break the active contract. Only a different executor model earns a strike:
 * a submitter that breaks its own plan just returns to planning.
 */
export function breakContract(
  state: WorkPhaseState,
  breaker: string | undefined,
  reason: ContractBreakReason,
): WorkPhaseState {
  const contract = state.contract;
  if (contract?.status !== 'active') return state;
  let contractStrikes = state.contractStrikes;
  let excludedExecutors = state.excludedExecutors;
  if (breaker && !sameModel(breaker, contract.submitter)) {
    const model = parseCandidateKey(breaker).id;
    const strikes = (contractStrikes?.[model] ?? 0) + 1;
    contractStrikes = { ...contractStrikes, [model]: strikes };
    if (strikes >= CONTRACT_STRIKE_LIMIT && !excludedExecutors?.some((key) => sameModel(key, breaker))) {
      excludedExecutors = [...(excludedExecutors ?? []), breaker];
    }
  }
  return {
    ...state,
    contractStrikes,
    excludedExecutors,
    contract: {
      ...contract,
      status: 'broken',
      breakReason: reason,
      ...(breaker ? { breaker } : {}),
    },
  };
}

export function isDeclaredTarget(contract: ExecutionContract, cwd: string, path: string): boolean {
  return contract.targets.includes(resolveToolPath(cwd, path));
}

/** Whether `key` names a model excluded from executing this task. */
export function isExcludedExecutor(state: WorkPhaseState | undefined, key: string): boolean {
  return state?.excludedExecutors?.some((excluded) => sameModel(excluded, key)) ?? false;
}

export function contractMeta(state: WorkPhaseState): ExecutionContractMeta | undefined {
  const contract = state.contract;
  if (!contract) return undefined;
  return {
    status: contract.status,
    band: contract.band,
    release: contract.release,
    submitter: contract.submitter,
    targets: contract.targets.length,
    steps: contract.steps,
    ...(contract.breakReason ? { breakReason: contract.breakReason } : {}),
    ...(contract.breaker ? { breaker: contract.breaker } : {}),
    ...(state.excludedExecutors?.length ? { excludedExecutors: [...state.excludedExecutors] } : {}),
  };
}
