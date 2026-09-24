/**
 * `commit_execution`: the model-facing side of the execution contract.
 *
 * The tool is registered once and stays active for the whole session, so the
 * provider tool list never changes mid-conversation (a changed list rebuilds
 * the prompt head and loses the prompt cache on most providers). It declines
 * without state changes whenever a handoff does not apply.
 *
 * Every entry point fails open: a router error rejects the submission or
 * ignores the tool call, and never fails the user's turn.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  ROUTER_PROVIDER_ID,
  AUTO_MODEL_ID,
  type ContractOutcome,
  type MeasuredFeatures,
  type RoutingDecision,
} from '../types.js';
import { appendExecutionContractSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import {
  EXECUTION_CONTRACT_TOOL,
  MAX_CONTRACT_STEPS,
  acceptContract,
  attributeExecutor,
  breakContract,
  contractMeta,
  entryEndOutcome,
  isDeclaredTarget,
  noteContractEdit,
  noteContractVerifier,
  resolveToolPath,
  reworkContract,
  validateContract,
  type ContractRejection,
  type ExecutionStepInput,
} from '../routing/policy/execution-contract.js';
import { parseRubric } from '../routing/policy/execution-difficulty.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { actionFromTool, cycleFromToolResult, isVerifier } from '../routing/struggle/fingerprints.js';
import { parseCandidateKey } from '../routing/score/scorer.js';
import { classifyMutationCall } from '../routing/policy/mutation-detector.js';
import type { RouterSession } from './router-session-state.js';

const DESCRIPTION =
  'Hand off the remaining implementation as a closed execution plan. Call it only after planning or review has ' +
  'settled every design decision, when all remaining work is concrete file edits, file creations, file deletions, ' +
  'and verification runs. The router validates the plan and chooses which model executes it. Do not call it to ask ' +
  'for help or to change models. Rate the remaining work honestly: the router combines the ratings with its own ' +
  'measurements to choose the executor, and a finished plan returns to you for review. After acceptance, editing a ' +
  'file that the plan does not list, or writing files from a shell command, returns the work to the model that ' +
  'submitted the plan.';

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function executionContractParameters() {
  const path = Type.String({ description: 'File path, relative to the working directory. No glob patterns.' });
  const change = Type.String({ description: 'The exact change to make; no open decisions.' });
  const level = (description: string) => Type.Integer({ minimum: 1, maximum: 5, description });
  return Type.Object({
    remainingWork: Type.Object({
      openDecisions: level(
        'What the executor must still decide. 1: every change is specified down to the code; 2: only naming or ' +
        'formatting choices; 3: local implementation choices, no behavior choices; 4: some behavior or interface ' +
        'choices; 5: design choices.',
      ),
      spread: level(
        'Where the changes are. 1: one function; 2: one file; 3: a few files in one module; 4: several modules; ' +
        '5: across the codebase.',
      ),
      verification: level(
        'How the result can be checked. 1: an existing test or type check proves it; 2: one small new test; ' +
        '3: new tests for several cases; 4: edge cases that tests cover poorly; 5: hard to check (timing, ' +
        'concurrency, environment).',
      ),
      knowledge: level(
        'Code the executor must understand beyond the listed files. 1: none; 2: nearby code; 3: one ' +
        'subsystem\'s conventions; 4: invariants across modules; 5: the whole codebase or external systems.',
      ),
      coupling: level(
        'What else the change can affect. 1: nothing outside the change; 2: a few local callers; 3: a shared ' +
        'helper with several callers; 4: a public interface or shared state; 5: cross-cutting behavior ' +
        '(concurrency, persistence, security).',
      ),
    }, {
      description: 'What the executor still has to work out, rated 1 (easiest) to 5 (hardest) per criterion. ' +
        'Describe the work; the router decides who executes it.',
    }),
    steps: Type.Array(
      Type.Union([
        Type.Object({ kind: Type.Literal('edit'), path, change }),
        Type.Object({ kind: Type.Literal('create'), path, change }),
        Type.Object({ kind: Type.Literal('delete'), path }),
        Type.Object({
          kind: Type.Literal('verify'),
          verifier: Type.Union([
            Type.Literal('test'),
            Type.Literal('typecheck'),
            Type.Literal('lint'),
            Type.Literal('build'),
          ]),
          scope: Type.Optional(Type.String({ description: 'What to run, e.g. a test file or package.' })),
        }),
      ]),
      { minItems: 1, maxItems: MAX_CONTRACT_STEPS },
    ),
  });
}

/** Appended once per entry to the first plan/review edit result without a plan. */
export const CONTRACT_NUDGE =
  `Router note: if the remaining work is fully decided, call ${EXECUTION_CONTRACT_TOOL} with the remaining ` +
  'steps so the router can choose the executor. Otherwise continue.';

/** Why a handoff does not apply to this decision, or undefined when it does. */
function handoffInapplicable(last: RoutingDecision): ContractRejection | undefined {
  if (last.dimension !== 'plan' && last.dimension !== 'review') {
    return { ok: false, code: 'not-plan-or-review', reason: 'a handoff applies only after planning or review' };
  }
  const assessment = last.assessment;
  if (assessment?.confidence === 'high' && (assessment.kind === 'plan' || assessment.kind === 'review')) {
    return {
      ok: false,
      code: `${assessment.kind}-deliverable`,
      reason: `the request asks for a ${assessment.kind}, not an implementation`,
    };
  }
  return undefined;
}

function isRouterAuto(ctx: Pick<ExtensionContext, 'model'> | undefined): boolean {
  return ctx?.model?.provider === ROUTER_PROVIDER_ID && ctx.model.id === AUTO_MODEL_ID;
}

/**
 * Whether a submission can be accepted, checked before measuring its targets:
 * a submission that will be rejected or that breaks an active plan needs no
 * file reads or `git log`.
 */
export function contractSubmissionOpen(ctx: Pick<ExtensionContext, 'model'> | undefined, session: RouterSession): boolean {
  if (!isRouterAuto(ctx)) return false;
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  if (!state || !last || !session.getLastServed() || last.intentKey !== state.intentKey) return false;
  return state.contract?.status !== 'active' && handoffInapplicable(last) == null;
}

export interface ContractSubmission {
  accepted: boolean;
  text: string;
}

export interface ContractParams {
  steps?: ExecutionStepInput[];
  remainingWork?: unknown;
}

/** Router-measured target facts that need I/O; the rest come from validation. */
export type TargetObservations = Pick<MeasuredFeatures, 'existingLines' | 'missingTargets' | 'commits' | 'fixCommits'>;

type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; code: number }>;

/** Target history window, as `git log --since`. */
const HISTORY_WINDOW = '180.days';
const HISTORY_TIMEOUT_MS = 2000;
/** Larger files are sized from bytes instead of read. */
const MAX_READ_BYTES = 4_000_000;
const BYTES_PER_LINE = 40;
const FIX_SUBJECT = /\b(fix(e[sd]|ing)?|bug(fix)?|bugs|hotfix|revert(s|ed)?)\b/i;

/** Every target measurement together, `git log` included, finishes within this. */
const OBSERVE_DEADLINE_MS = 3000;

/** Thrown for a target that exists but is not a regular file. */
class NotRegularFile extends Error {}

/**
 * Count a regular file's lines. The path comes from the model, so it may name
 * a device, FIFO, or socket that never reaches EOF or blocks on open: the file
 * is opened non-blocking and checked on the open handle before reading.
 */
async function countLines(path: string): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NotRegularFile();
    if (info.size > MAX_READ_BYTES) return Math.round(info.size / BYTES_PER_LINE);
    const text = await handle.readFile('utf8');
    return text.length === 0 ? 0 : text.split('\n').length;
  } finally {
    await handle.close();
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Measure the plan's targets: existing size, targets that should exist but do
 * not, and recent commit history. Each measurement that fails — including a
 * target that is not a regular file, and anything past the deadline — is left
 * undefined, which the requirement treats as the hardest value.
 */
export function observeTargets(
  exec: Exec,
  cwd: string,
  steps: readonly ExecutionStepInput[] | undefined,
  signal?: AbortSignal,
  deadlineMs = OBSERVE_DEADLINE_MS,
): Promise<TargetObservations> {
  return withDeadline(measureTargets(exec, cwd, steps, signal), deadlineMs, {});
}

async function measureTargets(
  exec: Exec,
  cwd: string,
  steps: readonly ExecutionStepInput[] | undefined,
  signal?: AbortSignal,
): Promise<TargetObservations> {
  const validation = validateContract(steps, cwd);
  if (!validation.ok) return {};
  const existing = [...new Set((steps ?? [])
    .filter((step) => (step.kind === 'edit' || step.kind === 'delete') && typeof step.path === 'string')
    .map((step) => resolveToolPath(cwd, step.path!.trim())))];
  const observed: TargetObservations = {};
  let lines = 0;
  let missing = 0;
  let sized = true;
  for (const path of existing) {
    try {
      lines += await countLines(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing += 1;
      else sized = false;
    }
  }
  if (sized) observed.existingLines = lines;
  observed.missingTargets = missing;
  try {
    const result = await exec(
      'git',
      ['log', `--since=${HISTORY_WINDOW}`, '--format=%s', '--', ...validation.targets],
      { cwd, timeout: HISTORY_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    if (result.code === 0) {
      const subjects = result.stdout.split('\n').filter((line) => line.trim());
      observed.commits = subjects.length;
      observed.fixCommits = subjects.filter((subject) => FIX_SUBJECT.test(subject)).length;
    }
  } catch {
    // No repository or no git: the history stays unmeasured.
  }
  return observed;
}

/** Log how a contract ended, with the rubric and measurements it was valued on. */
export function appendContractOutcome(state: WorkPhaseState, outcome: ContractOutcome): void {
  const meta = contractMeta(state);
  if (!meta) return;
  appendExecutionContractSignal({
    intentKey: state.intentKey,
    served: meta.executor ?? meta.submitter,
    action: 'outcome',
    outcome,
    meta,
  });
}

/**
 * End the entry's contract: log its outcome and drop it. Strikes and
 * exclusions stay for the task. `served` is the model that served the entry's
 * last invocation; it is the executor when an executor ended the entry with
 * text alone.
 */
export function closeContractEntry(state: WorkPhaseState, served: string | undefined): WorkPhaseState {
  if (!state.contract) return state;
  const attributed = attributeExecutor(state, served);
  appendContractOutcome(attributed, entryEndOutcome(attributed.contract!));
  return { ...attributed, contract: undefined };
}

/**
 * Close the contract once Pi's run has settled (no retry, compaction, or
 * queued message will run), so the last entry of a session is logged too.
 */
export function closeContractOnSettle(session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    if (!state?.contract) return;
    const lastServed = session.getLastServed();
    session.commitWorkPhaseState(closeContractEntry(state, lastServed ? servedKey(lastServed) : undefined));
  } catch {
    // Contract bookkeeping must never fail the end of a run.
  }
}

const KEEP_REASONS = {
  size: 'the plan is too large to hand off',
  difficulty: 'the remaining work needs a model at the current level',
  excluded: 'earlier executors broke plans in this task',
  'unknown-target': 'a file the plan edits or deletes does not exist',
} as const;

function reject(intentKey: string, served: string, rejection: ContractRejection): ContractSubmission {
  appendExecutionContractSignal({ intentKey, served, action: 'reject', rejectReason: rejection.code });
  return { accepted: false, text: `Execution plan not accepted: ${rejection.reason}. Continue with the current model.` };
}

function stepLines(steps: readonly ExecutionStepInput[]): string[] {
  return steps.map((step, index) => {
    const target = step.kind === 'verify'
      ? `${step.verifier ?? 'check'}${step.scope ? ` ${step.scope}` : ''}`
      : `${step.path ?? ''}${step.change ? ` — ${step.change}` : ''}`;
    return `${index + 1}. ${step.kind} ${target}`;
  });
}

/**
 * Validate and record one submission. The submitter is the model that served
 * the invocation that called the tool.
 */
export function submitExecutionContract(
  params: ContractParams | undefined,
  ctx: Pick<ExtensionContext, 'cwd' | 'model'> | undefined,
  session: RouterSession,
  observed: TargetObservations = {},
): ContractSubmission {
  const steps = params?.steps;
  if (!ctx || !isRouterAuto(ctx)) {
    return { accepted: false, text: `${EXECUTION_CONTRACT_TOOL} has no effect: the session model is not router/auto.` };
  }
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  const lastServed = session.getLastServed();
  const served = lastServed ? servedKey(lastServed) : undefined;
  if (!state || !last || !served || last.intentKey !== state.intentKey) {
    return { accepted: false, text: 'Execution plan not accepted: no routed task is in progress. Continue with the current model.' };
  }
  if (state.contract?.status === 'active') {
    // A second submission during execution means an open decision appeared.
    const broken = breakContract(state, served, 'replan');
    session.commitWorkPhaseState(broken);
    appendExecutionContractSignal({ intentKey: state.intentKey, served, action: 'break', meta: contractMeta(broken) });
    return {
      accepted: false,
      text: 'Execution plan not accepted: a plan is already being executed. The work returns to the model that ' +
        'submitted it, which may submit a revised plan.',
    };
  }
  const inapplicable = handoffInapplicable(last);
  if (inapplicable) return reject(state.intentKey, served, inapplicable);
  const validation = validateContract(steps, ctx.cwd);
  if (!validation.ok) return reject(state.intentKey, served, validation);

  // A new plan while reviewing an executed one means the executed work
  // needs rework: that counts against its executor. The revised plan keeps
  // the original task type, so a later break restores the submitter's
  // thinking level rather than the review's.
  let base = state;
  const previous = state.contract?.status === 'executed' ? state.contract : undefined;
  if (previous) {
    base = reworkContract(state);
    appendContractOutcome(base, 'rework');
  } else if (state.contract?.status === 'broken') {
    // The revised plan replaces a broken one whose handback has not been consumed yet.
    appendContractOutcome(state, 'broken');
  }
  const next = acceptContract(base, {
    submitter: served,
    submitterDimension: previous?.submitterDimension ?? last.dimension,
    validation,
    rubric: parseRubric(params?.remainingWork),
    measured: { ...validation.structural, ...observed },
  });
  session.commitWorkPhaseState(next);
  const meta = contractMeta(next);
  appendExecutionContractSignal({ intentKey: state.intentKey, served, action: 'accept', meta });
  const contract = next.contract!;
  const header = contract.release
    ? `Execution plan accepted (${contract.band}, executor minimum ${contract.minimum!.toFixed(2)}). A model ` +
      'chosen for this plan executes it from the next step. When every listed file is edited, the work returns ' +
      'to the submitting model for review.'
    : `Execution plan accepted. The current model keeps executing it: ${KEEP_REASONS[contract.keepReason ?? 'difficulty']}.`;
  return {
    accepted: true,
    text: [
      header,
      'Execute these steps in order:',
      ...stepLines(steps ?? []),
      'Use edit/write for the listed files. Editing a file that is not listed, or writing files from a shell ' +
        'command, returns the work to the model that submitted this plan.',
    ].join('\n'),
  };
}

export function registerExecutionContractTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: EXECUTION_CONTRACT_TOOL,
      label: 'Commit Execution',
      description: DESCRIPTION,
      promptSnippet: 'Hand off a fully decided implementation plan so the router can pick its executor.',
      parameters: executionContractParameters(),
      execute: async (_id, params, signal, _onUpdate, ctx) => {
        let result: ContractSubmission;
        try {
          const steps = params.steps as ExecutionStepInput[];
          const observed = contractSubmissionOpen(ctx, session)
            ? await observeTargets((command, args, options) => pi.exec(command, args, options), ctx.cwd, steps, signal)
            : {};
          result = submitExecutionContract({ steps, remainingWork: params.remainingWork }, ctx, session, observed);
        } catch {
          result = { accepted: false, text: 'Execution plan not accepted: internal router error. Continue with the current model.' };
        }
        debugLog('execution-contract.submit', { accepted: result.accepted, steps: params.steps?.length ?? 0 });
        return { content: [{ type: 'text' as const, text: result.text }], details: { accepted: result.accepted } };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}

/**
 * Break the active contract when a native edit/write targets an undeclared
 * file, or when an executor of a released plan runs a shell command that
 * writes files with high confidence: such a write has no path the router can
 * check, and the released plan dropped the incumbent minimums. The call
 * itself always proceeds; a break only changes who serves the next invocation.
 */
export function handleContractToolCall(
  event: Pick<ToolCallEvent, 'toolName' | 'input'>,
  ctx: Pick<ExtensionContext, 'cwd'>,
  session: RouterSession,
): void {
  try {
    const state = session.getWorkPhaseState();
    const contract = state?.contract;
    if (!state || contract?.status !== 'active') return;
    const lastServed = session.getLastServed();
    const served = lastServed ? servedKey(lastServed) : undefined;
    let reason: 'undeclared-target' | 'unattributed-mutation';
    if (event.toolName === 'edit' || event.toolName === 'write') {
      const target = (event.input as { path?: unknown } | undefined)?.path;
      if (typeof target !== 'string' || isDeclaredTarget(contract, ctx.cwd, target)) return;
      reason = 'undeclared-target';
    } else if (event.toolName === 'bash') {
      if (!contract.release || !served || parseCandidateKey(served).id === parseCandidateKey(contract.submitter).id) return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      if (classifyMutationCall('bash', input).confidence !== 'high') return;
      reason = 'unattributed-mutation';
    } else {
      return;
    }
    const broken = breakContract(state, served, reason);
    session.commitWorkPhaseState(broken);
    appendExecutionContractSignal({
      intentKey: state.intentKey,
      served: served ?? 'unknown/unknown',
      action: 'break',
      meta: contractMeta(broken),
    });
  } catch {
    // Contract bookkeeping must never fail a tool call.
  }
}

/**
 * Follow a contract through tool results: a successful native edit/write of a
 * declared edit/create target counts toward completion (the last one executes
 * the plan), an edit during review marks the executed work as fixed, and the
 * first verifier run after execution records whether the executed work passes.
 */
export function trackContractToolResult(
  event: { toolName: string; toolCallId: string; input?: unknown; content?: unknown; details?: unknown; isError?: boolean },
  ctx: Pick<ExtensionContext, 'cwd'>,
  session: RouterSession,
): void {
  try {
    const state = session.getWorkPhaseState();
    const contract = state?.contract;
    if (!state || !contract || contract.status === 'broken') return;
    if (event.toolName === 'edit' || event.toolName === 'write') {
      const path = (event.input as { path?: unknown } | undefined)?.path;
      if (event.isError === true || typeof path !== 'string') return;
      const lastServed = session.getLastServed();
      const served = lastServed ? servedKey(lastServed) : undefined;
      const next = noteContractEdit(state, ctx.cwd, path, served);
      if (next === state) return;
      session.commitWorkPhaseState(next);
      if (contract.status === 'active' && next.contract?.status === 'executed') {
        appendExecutionContractSignal({
          intentKey: state.intentKey,
          served: served ?? 'unknown/unknown',
          action: 'execute',
          meta: contractMeta(next),
        });
      }
      return;
    }
    if (contract.status !== 'executed' || contract.reviewVerifier) return;
    // Classify the call before touching its output: only a verifier's result is read.
    const action = actionFromTool(event.toolName, event.input);
    if (!isVerifier(action)) return;
    const cycle = cycleFromToolResult(event, state.providerInvocation);
    const passed = !cycle.progressHint.isError && !cycle.progressHint.failureSignature;
    session.commitWorkPhaseState(noteContractVerifier(state, passed));
  } catch {
    // Contract bookkeeping must never change a tool result.
  }
}

/**
 * Remind the model of the handoff where it matters: on the result of the first
 * native edit/write in a plan/review entry that has no plan. The note is
 * appended to the tool result, so the transcript prefix and prompt cache stay
 * intact, and it is logged as a `nudge` so missed handoffs can be counted.
 */
export function nudgeContractOnEdit(
  event: Pick<ToolResultEvent, 'toolName' | 'content'>,
  session: RouterSession,
): ToolResultEventResult | undefined {
  try {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    const state = session.getWorkPhaseState();
    const last = session.getLastDecision();
    if (!state || !last || last.intentKey !== state.intentKey) return undefined;
    if (state.contract || state.contractNudged || handoffInapplicable(last)) return undefined;
    session.commitWorkPhaseState({ ...state, contractNudged: true });
    const lastServed = session.getLastServed();
    appendExecutionContractSignal({
      intentKey: state.intentKey,
      served: lastServed ? servedKey(lastServed) : 'unknown/unknown',
      action: 'nudge',
    });
    return { content: [...(event.content ?? []), { type: 'text', text: CONTRACT_NUDGE }] };
  } catch {
    // A reminder failure must never change the tool result.
    return undefined;
  }
}
