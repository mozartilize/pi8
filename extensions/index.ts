/**
 * pi8 extension entry point.
 *
 * Register commands and the `router/auto` provider immediately at extension
 * init (synchronously, with no session ctx) so the model is available before
 * Pi resolves the session's default model. session_start / turn_start then
 * re-register with the live registry to refresh capacities (idempotent).
 * This extension never writes to settings.json.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelChangeEntry,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnStartEvent,
} from '@earendil-works/pi-coding-agent';

/**
 * The installed Pi package does not export a `model_select` event type, so the
 * fields this extension reads are declared structurally rather than widened to
 * `any`.
 */
interface ModelSelectEventLike {
  source?: string;
  model: { provider: string; id: string };
  previousModel?: { provider: string; id: string };
}

import {
  registerCommands,
  type ManualModelCompletionUpdater,
} from './host/commands.js';
import { adoptPiThinkingLevel, registerAutoRouterProvider } from './serve/provider.js';
import { closeSelectorPorts } from './serve/unified-decision.js';

import { loadConfig } from './config.js';
import { setSessionFile } from './sessionpaths.js';
import { debugLog, setConfigDebug, setDebugUiSink } from './host/debuglog.js';
import { indexVersionWarning } from './routing/score/scorer.js';
import { loadStore } from './bench/store.js';
import { checkPlaywright } from './adapters/artificial-analysis-site.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from './types.js';
import {
  resetModelEventSession,
} from './host/decisionlog.js';
import { clearRouterStatus, DEBUG_ENTRY_TYPE, renderDebugEntry, renderRouterStatus } from './host/ui.js';
import {
  gateContractMutation,
  handleContractToolCall,
  remindContractOnEdit,
  registerExecutionContractTool,
  closeContractOnSettle,
  trackContractToolResult,
} from './serve/execution-contract-tool.js';
import {
  RouterSession,
  RuntimeBindings,
  defaultRouterSession,
  defaultRuntimeBindings,
} from './serve/router-session-state.js';
import { isMutationCall } from './routing/policy/mutation-detector.js';
import { CONTEXT_ENTRY_TYPE, SELECTION_ENTRY_TYPE, readBranch, requestRouting } from './routing/context/persistence.js';
import { REQUEST_NOTE_ENTRY_TYPE, applyNotePlans, type NotableMessage } from './serve/request-notes.js';
import { planToolsNote } from './serve/router-tools-note.js';
import { CONTEXT_HANDOFF_TOOL } from './routing/policy/context-acquisition.js';
import { COMPLETE_WORK_TOOL, REOPEN_WORK_TOOL } from './routing/policy/work-completion.js';
import { EXECUTION_CONTRACT_TOOL } from './routing/policy/execution-contract.js';
import { ROUTING_CONTEXT_TOOL } from './serve/routing-context-tool.js';
import { observeContextGrounding } from './serve/context-grounding.js';
import { carryPhaseAcrossTree } from './serve/context-resolution.js';
import { registerRoutingContextTool } from './serve/routing-context-tool.js';
import { registerCompleteWorkTool } from './serve/complete-work-tool.js';
import { registerReopenWorkTool } from './serve/reopen-work-tool.js';
import { logSettleOutcomes, settleReminder } from './serve/settle-reminder.js';
import { gateCompletedWorkToolCall } from './serve/completed-work-gate.js';
import {
  closeContextOnSettle,
  gateContextToolCall,
  remindContextHandoff,
  observeContextRead,
} from './serve/gathering-gate.js';
import { observeCheckReceipt, observeCheckVerdict } from './serve/check-verdicts.js';
import { registerContextHandoffTool } from './serve/context-handoff-tool.js';

/**
 * True only when the session's currently active model IS the router/auto
 * synthetic provider. All trajectory routing logic must be gated behind this:
 * when the user has deliberately picked a concrete model, this extension's
 * presence must be completely inert and Pi must behave exactly as if it were
 * not installed.
 */
function isRouterAutoActive(model: { provider?: string; id?: string } | undefined): boolean {
  return model?.provider === ROUTER_PROVIDER_ID && model?.id === AUTO_MODEL_ID;
}

/**
 * Tell the user about setup gaps when `router/auto` becomes the session
 * model. Pi has no way to refuse the selection. Missing benchmark data is an
 * error: the router's turns end with the same message until a sync. An
 * uncalibrated index version and a missing browser are warnings: routing
 * continues, and the browser is needed only for the next `/router-sync`.
 */
function noticeSetup(ctx: ExtensionContext, runtime: RuntimeBindings): void {
  try {
    const benchmarks = runtime.checkBenchmarks();
    if (!benchmarks.ready) {
      ctx.ui?.notify?.(benchmarks.message, 'error');
    } else {
      const versionWarning = indexVersionWarning(loadStore()?.indexVersion);
      if (versionWarning) ctx.ui?.notify?.(versionWarning, 'warning');
    }
  } catch {
    // A notice is advisory; the provider reports the same gap at turn time.
  }
  void checkPlaywright()
    .then((browser) => {
      if (!browser.ready) ctx.ui?.notify?.(`/router-sync cannot refresh benchmark data. ${browser.message}`, 'warning');
    })
    .catch(() => {
      // The check reports its own failures; a notice is advisory.
    });
}

/** The tools only router/auto serves. */
const ROUTER_TOOLS: readonly string[] = [
  EXECUTION_CONTRACT_TOOL, CONTEXT_HANDOFF_TOOL, ROUTING_CONTEXT_TOOL, COMPLETE_WORK_TOOL, REOPEN_WORK_TOOL,
];

/**
 * Declare the router tools for every session model. A change of the tool
 * set changes the prompt head, and the provider's cached prefix is lost, so
 * a switch between router/auto and a concrete model changes only the tools
 * note (see router-tools-note.ts). Only these names are added, so other
 * extensions' tools and `--tools` stay as they are. A set that already holds
 * them is not set again, so Pi records no tool change.
 */
function declareRouterTools(pi: ExtensionAPI): void {
  try {
    if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
    const active = pi.getActiveTools();
    const missing = ROUTER_TOOLS.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  } catch {
    // The model then does not see the router tools; router/auto still serves the turn.
  }
}

/**
 * A request to a concrete model carries every recorded note, so its prefix
 * matches the router/auto requests before it, and the tools note that turns
 * the router tools off. Router/auto requests get their notes in the provider.
 */
function handleContext<M extends NotableMessage>(
  event: { messages: M[] },
  ctx: ExtensionContext | undefined,
  session: RouterSession,
): { messages: M[] } | undefined {
  try {
    if (isRouterAutoActive(ctx?.model)) return undefined;
    const plan = planToolsNote(session.notes.getNotes(), event.messages, false);
    return { messages: applyNotePlans(session.notes, event.messages, [plan]) };
  } catch (err) {
    debugLog('notes.context-error', { message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}



async function handleSessionStart(
  event: SessionStartEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  session: RouterSession,
  runtime: RuntimeBindings,
  updateManualModelCompletionContext: ManualModelCompletionUpdater,
): Promise<void> {
  // Establish the log target before reset diagnostics so an automatic
  // runtime replacement is visible in the session sidecar that triggered it.
  try {
    setSessionFile(ctx.sessionManager?.getSessionFile());
    setConfigDebug(loadConfig().debug);
  } catch {
    // Ephemeral / no session manager: logs fall back to the shared store.
  }
  setDebugUiSink(ctx.hasUI === false || typeof pi.appendEntry !== 'function'
    ? undefined
    : (line) => pi.appendEntry(DEBUG_ENTRY_TYPE, { line }));
  declareRouterTools(pi);
  debugLog('lifecycle.session_start.begin', {
    reason: event.reason,
    previousSessionFile: event.previousSessionFile,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    ...session.blacklist.getDebugState(),
  });
  try {
    updateManualModelCompletionContext(ctx);
  } catch {
    // Autocomplete is advisory and must not block session initialization.
  }
  try {
    session.reset();
    session.clearSessionBlacklist();
    // Seed config blacklist so the session can temporarily override it via
    // remove/clear. Config writes stay authoritative: next session_start
    // re-seeds the authoritative list.
    session.addSessionBlacklistPatterns(loadConfig().blacklist ?? []);
    resetModelEventSession();
  } catch {
    // Session cleanup is best-effort and must not block startup.
  }
  restoreWorkLedger(ctx, session);
  // Point per-session logs (decisions + debug) at THIS session's directory,
  // and pick up the `debug` config flag.
  try {
    setSessionFile(ctx.sessionManager?.getSessionFile());
    setConfigDebug(loadConfig().debug);
  } catch {
    // Ephemeral / no session manager: logs fall back to the shared store.
  }
  // A reassertion below selects router/auto through model_select, which
  // gives the notice itself.
  if (isRouterAutoActive(ctx?.model)) {
    noticeSetup(ctx, runtime);
    // The session opens with Pi's level, which the user did not choose for router/auto.
    adoptPiThinkingLevel(pi, session);
  }
  try {
    registerAutoRouterProvider(pi, ctx, session, runtime);
    // Pi derives a resumed/restored session's "current model" from the
    // concrete provider/model recorded on each assistant message (see
    // `getSessionContextSettings` in Pi's session-manager.js), which is
    // always the router's underlying delegate, never `router/auto` itself
    // — the router never calls `pi.setModel`, so it leaves no message
    // trail of its own. A session whose last EXPLICIT choice (via /model,
    // model cycling, or a prior instance of this same reassertion) was
    // `router/auto` therefore restores on next launch to whichever
    // concrete model the router last delegated to, not the router. Only
    // correct this specific case — never override a session whose last
    // explicit choice was a genuine concrete-model pick, which must keep
    // that pick on restart per Pi's normal default behavior.
    if (event.reason === 'startup' || event.reason === 'resume' || event.reason === 'fork') {
      const lastModelChange = ctx.sessionManager
        .getBranch()
        .filter((e): e is ModelChangeEntry => e.type === 'model_change')
        .at(-1);
      const wasExplicitlyRouterAuto =
        lastModelChange?.provider === ROUTER_PROVIDER_ID && lastModelChange.modelId === AUTO_MODEL_ID;
      if (wasExplicitlyRouterAuto && ctx.model?.provider !== ROUTER_PROVIDER_ID) {
        const routerModel = ctx.modelRegistry.getAvailable().find(
          (model) => model.provider === ROUTER_PROVIDER_ID && model.id === AUTO_MODEL_ID,
        );
        if (routerModel) await pi.setModel(routerModel);
      }
    }
  } catch {
    // Provider registration/model selection must never crash the session.
  }
  debugLog('lifecycle.session_start.end', {
    reason: event.reason,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    ...session.blacklist.getDebugState(),
  });
}

/**
 * Record the session model before a request when the branch records another
 * one. Pi records `/model` switches itself, but not a model given with
 * `--model` on resume, or the current model after `/tree` moves to a branch
 * recorded with another model. Without the record, requests to a concrete
 * model read as served by the router, or the reverse. Pi stores the user
 * message only after `before_agent_start`, so the record comes first; a
 * session that is opened or navigated without a request gets no entry.
 */
function recordModelSelection(pi: ExtensionAPI, ctx: ExtensionContext | undefined): void {
  try {
    const model = ctx?.model;
    if (!model || typeof pi.appendEntry !== 'function') return;
    if (requestRouting(readBranch(ctx?.sessionManager)).routedAtEnd === isRouterAutoActive(model)) return;
    pi.appendEntry(SELECTION_ENTRY_TYPE, { provider: model.provider, modelId: model.id });
  } catch {
    // Without the record, the next routed entry's own events show the router served it.
  }
}

/**
 * Rebuild the work ledger and the recorded router notes from the active
 * branch. Reading never writes: a branch without a ledger stays untracked
 * until its next genuine user entry.
 */
function restoreWorkLedger(ctx: ExtensionContext | undefined, session: RouterSession): void {
  try {
    const branch = readBranch(ctx?.sessionManager);
    session.context.restore(branch);
    session.notes.restore(branch);
  } catch {
    // An unreadable branch routes as a fresh one.
  }
}

function handleModelSelect(
  pi: ExtensionAPI,
  event: ModelSelectEventLike,
  ctx: ExtensionContext,
  session: RouterSession,
  runtime: RuntimeBindings,
): void {
  debugLog('lifecycle.model_select', {
    source: event.source,
    model: `${event.model.provider}/${event.model.id}`,
    previousModel: event.previousModel
      ? `${event.previousModel.provider}/${event.previousModel.id}`
      : undefined,
    ...session.blacklist.getDebugState(),
  });
  declareRouterTools(pi);
  // A concrete model selection makes the previous router decision stale,
  // and ends the incumbent: switching back starts by collecting context.
  if (event.model.provider !== ROUTER_PROVIDER_ID || event.model.id !== AUTO_MODEL_ID) {
    session.context.clearIncumbent();
    session.endServing();
  }
  if (event.model.provider !== ROUTER_PROVIDER_ID) {
    clearRouterStatus(ctx);
    return;
  }
  if (event.model.id === AUTO_MODEL_ID) {
    noticeSetup(ctx, runtime);
    // Pi applies the new model's thinking level during the switch; that is
    // not a user choice, so the next turn must not read it as one.
    adoptPiThinkingLevel(pi, session);
    // Requests sent under the previous model were not served by the router:
    // the rebuilt ledger no longer continues the active item, and the
    // requests become history that a later entry can return to.
    restoreWorkLedger(ctx, session);
  }
}

function handleTurnStart(
  _event: TurnStartEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  session: RouterSession,
  runtime: RuntimeBindings,
): void {
  // Ensure provider is registered even if session_start hasn't fired.
  // registerAutoRouterProvider is idempotent (lastRegisteredModels guard).
  if (!ctx.modelRegistry?.getAvailable) return;
  // Keep the per-session log target current (resumed sessions).
  try {
    setSessionFile(ctx.sessionManager?.getSessionFile());
  } catch {
    // ignore
  }
  debugLog('lifecycle.turn_start', {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    ...session.blacklist.getDebugState(),
  });
  // Setting a pending trajectory handoff belongs only to router/auto sessions. Provider
  // registration below stays ungated so a later switch to router/auto
  // can still find the synthetic model.
  if (isRouterAutoActive(ctx?.model)) {
    try {
      session.flushAndSetUnresolvedTrajectory();
    } catch {
      // ignore
    }
  }
  try {
    registerAutoRouterProvider(pi, ctx, session, runtime);
  } catch {
    // ignore
  }
}

/**
 * Count mutation calls for the `editing` status. Observation only: a mutation
 * never changes the routed task type.
 */
function observeMutationToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  session: RouterSession,
): void {
  try {
    if (!isMutationCall(event.toolName, event.input)) return;
    const state = session.getWorkPhaseState();
    if (!state) return;
    const committed = { ...state, observedMutationTools: state.observedMutationTools + 1 };
    session.commitWorkPhaseState(committed);
    const last = session.getLastDecision();
    if (last && committed.intentKey === last.intentKey && !last.mutationObserved) {
      const updated = { ...last, mutationObserved: true };
      session.setLastDecision(updated);
      renderRouterStatus(ctx, updated, session.getLastServed());
    }
  } catch {
    // Observation must never fail a tool call.
  }
}

function handleTrajectoryToolResult(event: ToolResultEvent, session: RouterSession): void {
  try {
    const invocation = session.getWorkPhaseState()?.providerInvocation ?? 0;
    const decision = session.observeTrajectory(
      {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: (event as { input?: unknown }).input,
        content: event.content,
        details: event.details,
        isError: (event as { isError?: boolean }).isError,
      },
      invocation,
    );
    if (!decision) return;
    session.setPendingTrajectoryEscalation(
      decision,
      session.servedTrajectoryKey(),
      session.getLastDecision()?.dimension,
      false,
    );
  } catch {
    // Trajectory observation must never fail a tool result.
  }
}

export default async function autoModelRouterExtension(pi: ExtensionAPI) {
  const session = defaultRouterSession;
  const runtime = defaultRuntimeBindings;
  const updateManualModelCompletionContext = registerCommands(pi, session);

  // Register `router/auto` synchronously at extension-init time (no session
  // ctx) so it lands in the runtime's pendingProviderRegistrations BEFORE Pi
  // resolves the session's default model. Without this, findInitialModel
  // cannot find `router/auto` in the registry and falls back to a concrete
  // provider (e.g. github-copilot/gpt-5.4), so routing never happens.
  registerAutoRouterProvider(pi, undefined, session, runtime);
  registerExecutionContractTool(pi, session);
  registerContextHandoffTool(pi, session);
  if (typeof pi.registerEntryRenderer === 'function') {
    pi.registerEntryRenderer(DEBUG_ENTRY_TYPE, (entry, _options, theme) => renderDebugEntry(entry, theme));
  }
  registerRoutingContextTool(pi, session);
  registerCompleteWorkTool(pi, session);
  registerReopenWorkTool(pi, session);
  session.context.bindPersistence((event) => {
    if (typeof pi.appendEntry === 'function') pi.appendEntry(CONTEXT_ENTRY_TYPE, event);
  });
  session.notes.bindPersistence((note) => {
    if (typeof pi.appendEntry === 'function') pi.appendEntry(REQUEST_NOTE_ENTRY_TYPE, note);
  });

  pi.on('session_start', (event, ctx) =>
    handleSessionStart(
      event,
      ctx,
      pi,
      session,
      runtime,
      updateManualModelCompletionContext,
    ),
  );

  pi.on('session_shutdown', (event) => {
    debugLog('lifecycle.session_shutdown', {
      reason: event.reason,
      ...session.blacklist.getDebugState(),
    });
    return closeSelectorPorts().catch(() => undefined);
  });

  pi.on('model_select', (event, ctx) => handleModelSelect(pi, event, ctx, session, runtime));

  // A missing hand_off_context or complete_work can still be declared, so
  // those reminders run here. agent_settled only records how the entry ended.
  let completedSettlement = false;
  pi.on('agent_before_settle', (event, ctx) => {
    completedSettlement = isRouterAutoActive(ctx?.model) && event.outcome === 'completed';
    if (!isRouterAutoActive(ctx?.model)) return;
    try {
      return settleReminder(event, session);
    } catch {
      return undefined;
    }
  });

  pi.on('agent_settled', () => {
    // An interrupted continuation is not evidence the model ignored its reminder.
    if (completedSettlement) logSettleOutcomes(session);
    completedSettlement = false;
    closeContextOnSettle(session);
    closeContractOnSettle(session);
  });

  // Both rewrite the history, so no cached prefix still matches it. Compaction
  // keeps the branch, and with it the ledger; tree navigation moves to
  // another branch, whose own events rebuild it and which keeps only the
  // entry state that still applies there.
  pi.on('session_compact', () => session.clearWarmCaches());
  pi.on('session_tree', (_event, ctx) => {
    session.clearWarmCaches();
    restoreWorkLedger(ctx, session);
    carryPhaseAcrossTree(session, readBranch(ctx?.sessionManager));
  });

  pi.on('context', (event, ctx) => handleContext(event, ctx, session));

  pi.on('before_agent_start', (_event, ctx) => {
    recordModelSelection(pi, ctx);
  });

  pi.on('turn_start', (event, ctx) => handleTurnStart(event, ctx, pi, session, runtime));

  pi.on('tool_call', (event, ctx) => {
    if (!isRouterAutoActive(ctx?.model)) return;
    // Collecting context runs only its allowed tools, delegation included:
    // a refused call never runs, is not counted, attributed, or observed.
    const completed = gateCompletedWorkToolCall(event, session);
    if (completed) return completed;
    const restricted = gateContextToolCall(event, session);
    if (restricted) return restricted;
    try {
      // A change stopped for an owed plan never runs: it is not counted,
      // attributed to a plan, or observed as trajectory.
      const gate = gateContractMutation(event, session);
      if (gate) return gate;
      observeMutationToolCall(event, ctx, session);
      handleContractToolCall(event, ctx, session);
      const flushed = session.noteTrajectoryToolCall(event.toolName, event.toolCallId, event.input);
      if (flushed) {
        session.setPendingTrajectoryEscalation(
          flushed,
          session.servedTrajectoryKey(),
          session.getLastDecision()?.dimension,
          false,
        );
      }
    } catch {
      // Trajectory observation must never fail a tool call.
    }
    return undefined;
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!isRouterAutoActive(ctx?.model)) return;
    handleTrajectoryToolResult(event, session);
    await observeContextRead(event, ctx, session);
    const cycle = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: (event as { input?: unknown }).input,
      content: event.content,
      details: event.details,
      isError: (event as { isError?: boolean }).isError,
    };
    observeCheckVerdict(cycle, session);
    void observeCheckReceipt(cycle, session, (command, args, options) => pi.exec(command, args, options), ctx.cwd);
    trackContractToolResult(
      {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: (event as { input?: unknown }).input,
        content: event.content,
        details: event.details,
        isError: (event as { isError?: boolean }).isError,
      },
      ctx,
      session,
    );
    const reminder = remindContractOnEdit(event, session) ?? remindContextHandoff(event, session);
    await observeContextGrounding(event, ctx, session);
    return reminder;
  });
}
