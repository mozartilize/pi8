/**
 * `request_planning`: the model-facing side of the investigation → planning
 * handoff.
 *
 * Registered once and always active, like `commit_execution`: a changed tool
 * list rebuilds the prompt head and loses the prompt cache on most providers.
 * It declines without state changes whenever the handoff does not apply, and
 * every entry point fails open.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from '../types.js';
import { appendInvestigationHandoffSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import {
  INVESTIGATION_HANDOFF_TOOL,
  acceptInvestigationHandoff,
} from '../routing/policy/investigation-handoff.js';
import type { RouterSession } from './router-session-state.js';

const DESCRIPTION =
  'Hand the rest of this request to a planning model. Call it during an investigation when the findings show ' +
  'that files must change: a planning model then decides the change, and makes it or hands it off. Do not call it ' +
  'to get a stronger model for reading or answering, or when the user asked only for an explanation.';

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function investigationHandoffParameters() {
  return Type.Object({
    findings: Type.String({ description: 'What the investigation established, including the files involved.' }),
    change: Type.String({ description: 'What must change and why. Leave how to the planning model.' }),
  });
}

/** Appended once per entry to the first investigation edit result without a handoff. */
export const INVESTIGATION_NUDGE =
  `Router note: this investigation is changing files. If the change needs decisions, call ` +
  `${INVESTIGATION_HANDOFF_TOOL} with your findings so a planning model decides it. Otherwise continue.`;

export interface InvestigationHandoffSubmission {
  accepted: boolean;
  text: string;
}

const REJECTIONS = {
  'not-router-auto': `${INVESTIGATION_HANDOFF_TOOL} has no effect: the session model is not router/auto.`,
  'no-task': 'Planning not requested: no routed task is in progress. Continue with the current model.',
  pinned: 'Planning not requested: a model is pinned with /router-manual. Continue with the current model.',
  'not-investigation': 'Planning not requested: the handoff applies only during an investigation. Continue with the current model.',
  'missing-findings': 'Planning not requested: describe the findings and the change. Call it again with both.',
} as const;

type RejectCode = keyof typeof REJECTIONS;

/**
 * Validate and record one request. The requester is the model that served the
 * invocation that called the tool.
 */
export function submitInvestigationHandoff(
  params: { findings?: unknown; change?: unknown } | undefined,
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
): InvestigationHandoffSubmission {
  if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) {
    return { accepted: false, text: REJECTIONS['not-router-auto'] };
  }
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  const lastServed = session.getLastServed();
  const served = lastServed ? servedKey(lastServed) : undefined;
  if (!state || !last || !served || last.intentKey !== state.intentKey) {
    return { accepted: false, text: REJECTIONS['no-task'] };
  }
  const reject = (code: RejectCode): InvestigationHandoffSubmission => {
    appendInvestigationHandoffSignal({ intentKey: state.intentKey, served, action: 'reject', rejectReason: code });
    return { accepted: false, text: REJECTIONS[code] };
  };
  if (session.getManualModel() != null) return reject('pinned');
  if (last.dimension !== 'gather') return reject('not-investigation');
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  if (!filled(params?.findings) || !filled(params?.change)) return reject('missing-findings');
  session.commitWorkPhaseState(acceptInvestigationHandoff(state));
  appendInvestigationHandoffSignal({ intentKey: state.intentKey, served, action: 'accept' });
  return {
    accepted: true,
    text: 'Planning requested. A planning model continues from the next step and decides the change.',
  };
}

export function registerInvestigationHandoffTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: INVESTIGATION_HANDOFF_TOOL,
      label: 'Request Planning',
      description: DESCRIPTION,
      promptSnippet: 'Hand an investigation whose findings require file changes to a planning model.',
      parameters: investigationHandoffParameters(),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        let result: InvestigationHandoffSubmission;
        try {
          result = submitInvestigationHandoff(params, ctx, session);
        } catch {
          result = { accepted: false, text: 'Planning not requested: internal router error. Continue with the current model.' };
        }
        debugLog('investigation-handoff.submit', { accepted: result.accepted });
        return { content: [{ type: 'text' as const, text: result.text }], details: { accepted: result.accepted } };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}

/**
 * Remind an investigation of the handoff where it matters: on the result of
 * its first native edit/write without one. Appending keeps the transcript
 * prefix and prompt cache intact; each reminder is logged as a `nudge`.
 */
export function nudgeInvestigationOnEdit(
  event: Pick<ToolResultEvent, 'toolName' | 'content'>,
  session: RouterSession,
): ToolResultEventResult | undefined {
  try {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    const state = session.getWorkPhaseState();
    const last = session.getLastDecision();
    if (!state || !last || last.intentKey !== state.intentKey || last.dimension !== 'gather') return undefined;
    if (state.planningRequested || state.investigationNudged || session.getManualModel() != null) return undefined;
    session.commitWorkPhaseState({ ...state, investigationNudged: true });
    const lastServed = session.getLastServed();
    appendInvestigationHandoffSignal({
      intentKey: state.intentKey,
      served: lastServed ? servedKey(lastServed) : 'unknown/unknown',
      action: 'nudge',
    });
    return { content: [...(event.content ?? []), { type: 'text', text: INVESTIGATION_NUDGE }] };
  } catch {
    // A reminder failure must never change the tool result.
    return undefined;
  }
}
