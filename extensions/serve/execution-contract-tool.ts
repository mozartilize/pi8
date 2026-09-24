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
import { ROUTER_PROVIDER_ID, AUTO_MODEL_ID, type RoutingDecision } from '../types.js';
import { appendExecutionContractSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import {
  EXECUTION_CONTRACT_TOOL,
  MAX_CONTRACT_STEPS,
  acceptContract,
  breakContract,
  contractMeta,
  isDeclaredTarget,
  validateContract,
  type ExecutionStepInput,
} from '../routing/policy/execution-contract.js';
import type { RouterSession } from './router-session-state.js';

const DESCRIPTION =
  'Hand off the remaining implementation as a closed execution plan. Call it only after planning or review has ' +
  'settled every design decision, when all remaining work is concrete file edits, file creations, file deletions, ' +
  'and verification runs. The router validates the plan and chooses which model executes it. Do not call it to ask ' +
  'for help or to change models. After acceptance, editing a file that the plan does not list returns the work to ' +
  'the model that submitted the plan.';

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function executionContractParameters() {
  const path = Type.String({ description: 'File path, relative to the working directory. No glob patterns.' });
  const change = Type.String({ description: 'The exact change to make; no open decisions.' });
  return Type.Object({
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
function handoffInapplicable(last: RoutingDecision): string | undefined {
  if (last.dimension !== 'plan' && last.dimension !== 'review') return 'a handoff applies only after planning or review';
  const assessment = last.assessment;
  if (assessment?.confidence === 'high' && (assessment.kind === 'plan' || assessment.kind === 'review')) {
    return `the request asks for a ${assessment.kind}, not an implementation`;
  }
  return undefined;
}

export interface ContractSubmission {
  accepted: boolean;
  text: string;
}

function reject(intentKey: string, served: string, reason: string): ContractSubmission {
  appendExecutionContractSignal({ intentKey, served, action: 'reject', rejectReason: reason });
  return { accepted: false, text: `Execution plan not accepted: ${reason}. Continue with the current model.` };
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
  steps: readonly ExecutionStepInput[] | undefined,
  ctx: Pick<ExtensionContext, 'cwd' | 'model'> | undefined,
  session: RouterSession,
): ContractSubmission {
  if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) {
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
  if (!validation.ok) return reject(state.intentKey, served, validation.reason);

  const next = acceptContract(state, {
    submitter: served,
    submitterDimension: last.dimension,
    targets: validation.targets,
    steps: validation.steps,
    shapeBand: validation.shapeBand,
  });
  session.commitWorkPhaseState(next);
  const meta = contractMeta(next);
  appendExecutionContractSignal({ intentKey: state.intentKey, served, action: 'accept', meta });
  const contract = next.contract!;
  const header = contract.release
    ? `Execution plan accepted (${contract.band}). A model chosen for this plan executes it from the next step.`
    : 'Execution plan accepted. The current model keeps executing it.';
  return {
    accepted: true,
    text: [
      header,
      'Execute these steps in order:',
      ...stepLines(steps ?? []),
      'Editing a file that is not listed returns the work to the model that submitted this plan.',
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
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        let result: ContractSubmission;
        try {
          result = submitExecutionContract(params.steps as ExecutionStepInput[], ctx, session);
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
 * file. The call itself always proceeds: reading or running anything is
 * allowed, and even an undeclared edit only changes who serves the next
 * invocation. Bash writes are not attributed to a path and never break it.
 */
export function handleContractToolCall(
  event: Pick<ToolCallEvent, 'toolName' | 'input'>,
  ctx: Pick<ExtensionContext, 'cwd'>,
  session: RouterSession,
): void {
  try {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;
    const state = session.getWorkPhaseState();
    const contract = state?.contract;
    if (!state || contract?.status !== 'active') return;
    const target = (event.input as { path?: unknown } | undefined)?.path;
    if (typeof target !== 'string' || isDeclaredTarget(contract, ctx.cwd, target)) return;
    const lastServed = session.getLastServed();
    const served = lastServed ? servedKey(lastServed) : undefined;
    const broken = breakContract(state, served, 'undeclared-target');
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
