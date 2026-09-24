/**
 * pi8 extension entry point.
 *
 * Register commands and the `router/auto` provider immediately at extension
 * init (synchronously, with no session ctx) so the model is available before
 * Pi resolves the session's default model. session_start / turn_start then
 * re-register with the live registry to refresh capacities (idempotent).
 *
 * Subagent roles are injected per spawn in a `tool_call` handler; this
 * extension never writes to settings.json.
 */
import type {
  BeforeAgentStartEvent,
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
import { registerAutoRouterProvider, buildSubagentProviderAuthFilter } from './serve/provider.js';

import {
  computeRoleModels,
  injectSubagentRoutingWithMetadata,
  pickSubagentDefaultModel,
  stripThinkingSuffix,
} from './agents/subagents.js';
import { SubagentRoutingState } from './agents/subagent-routing-state.js';
import { extractMissingTools } from './host/gap-detector.js';
import {
  collectSubagentResultText,
  parseSubagentResultRows,
  isFailedResult,
  type SubagentResultRow,
} from './agents/subagent-results.js';
import { isUsageLimitErrorMessage } from './serve/usage-limit.js';
import { computeSubagentSpend } from './agents/subagent-spend.js';
import { loadModelFilter, buildExcludeFilter, buildScopedModelFilter } from './routing/policy/allowlist.js';
import { loadConfig } from './config.js';
import { ensureEmbeddingEngine } from './embed/embedding.js';
import { setSessionFile } from './sessionpaths.js';
import { debugLog, setConfigDebug } from './host/debuglog.js';
import type { RegistryModelInfo } from './routing/score/scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type Role } from './types.js';
import {
  appendMutationGateSignal,
  appendSubagentGapSignal,
  appendSubagentSpend,
} from './host/decisionlog.js';
import { clearRouterStatus, renderRouterStatus } from './host/ui.js';
import {
  handleContractToolCall,
  nudgeContractOnEdit,
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
import { evaluateMutationCall, recordMutationResult } from './routing/policy/mutation-gate.js';
import { classifyMutationCall } from './routing/policy/mutation-detector.js';

/** Tool registered by pi-subagents that spawns child agents. */
const SUBAGENT_TOOL = 'subagent';

interface SubagentCallObservation {
  observedModels: string[];
  observedRoles: Role[];
}

/**
 * True only when the session's currently active model IS the router/auto
 * synthetic provider. All subagent-injection and trajectory routing logic must
 * be gated behind this: when the user has deliberately picked a concrete
 * model, this extension's presence must be completely inert and pi /
 * pi-subagents must behave exactly as if it were not installed.
 */
function isRouterAutoActive(model: { provider?: string; id?: string } | undefined): boolean {
  return model?.provider === ROUTER_PROVIDER_ID && model?.id === AUTO_MODEL_ID;
}

/** Matches Pi's own offline semantics (model-runtime.js: any non-empty value). */
function isOfflineMode(): boolean {
  const raw = process.env.PI_OFFLINE;
  return raw !== undefined && raw !== '';
}

/**
 * The session_start auth sweep probes provider credential resolution, which
 * can trigger a network token refresh for OAuth providers (pi#7508). It must
 * only run when the router actually owns the session AND the user did not
 * request offline mode. Concrete-model sessions skip this sweep; switching
 * to router/auto re-arms it via model_select.
 */
function shouldRunAuthSweep(model: { provider?: string; id?: string } | undefined): boolean {
  if (isOfflineMode()) return false;
  return isRouterAutoActive(model);
}

type ModelRegistry = ExtensionContext['modelRegistry'];

type RoleModelRefresher = (
  modelRegistry: ModelRegistry,
  ctx?: ExtensionContext,
) => Promise<void>;

async function refreshRoleModelsState(
  routingState: SubagentRoutingState,
  session: RouterSession,
  modelRegistry: ModelRegistry,
  ctx?: ExtensionContext,
): Promise<void> {
  // A refresh is only valid for the generation in which it began. If reset()
  // or a newer refresh happens while we are awaiting auth probes, this
  // result must be discarded so stale maps cannot overwrite current ones.
  const generation = routingState.beginRefresh();
  if (!modelRegistry?.getAvailable) return;
  const models = modelRegistry.getAvailable() as unknown as RegistryModelInfo[];
  if (!Array.isArray(models) || models.length === 0) return;
  // Pre-filter by allowlist so we only probe credentials for providers the
  // user intends to route to (avoid probing every registry provider).
  const isModelAllowed = loadModelFilter();
  const isBlacklisted = buildExcludeFilter(session.getSessionBlacklistPatterns());
  const blacklistedSet = session.getBlacklistedModels();
  const blacklistedProviders = session.getBlacklistedProviders();
  // Pi's native session scoping (--models / enabledModels) is the
  // authoritative user-intent signal for which models are usable.
  const isScoped = buildScopedModelFilter(ctx?.scopedModels as
    | readonly { model: { provider: string; id: string } }[]
    | undefined);
  const allowedModels = models.filter((m) => {
    if (!m.provider || m.provider === 'router') return false;
    const registryId = `${m.provider}/${m.id}`;
    return (
      isModelAllowed(registryId) &&
      !isBlacklisted(registryId) &&
      !blacklistedSet.has(registryId) &&
      !blacklistedProviders.has(m.provider) &&
      isScoped(registryId)
    );
  });
  if (allowedModels.length === 0) return;
  // Gate by credentials: pi-subagents consumes the injected model verbatim
  // and hard-fails ("No API key found for <provider>") on a provider we are
  // not logged into.
  const isProviderUsable = buildSubagentProviderAuthFilter(modelRegistry, allowedModels);
  // Pass ctx through so project-scoped pins (.pi/settings.json under
  // ctx.cwd) are discovered, not just user-scope ones — without this, a
  // project pin silently loses to router injection at spawn time.
  const config = loadConfig();
  const usage = (ctx as ExtensionContext & {
    getContextUsage?: () => { tokens?: number } | undefined;
  }).getContextUsage?.();
  const estimatedContextTokens = typeof usage?.tokens === 'number' && usage.tokens > 0
    ? usage.tokens
    : 0;
  const computed = computeRoleModels(allowedModels, {
    isProviderUsable,
    ctx,
    weights: config.dimensionWeights,
    estimatedContextTokens,
  });
  routingState.commitRefresh(generation, {
    roleModels: computed.roleModels,
    roleFallbacks: computed.roleFallbacks,
    routingSnapshot: computed.routingSnapshot,
  });
}

async function handleSessionStart(
  event: SessionStartEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  session: RouterSession,
  runtime: RuntimeBindings,
  subagentCalls: Map<string, SubagentCallObservation>,
  routingState: SubagentRoutingState,
  refreshRoleModels: RoleModelRefresher,
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
    subagentCalls.clear();
    routingState.reset();
  } catch {
    // Session cleanup is best-effort and must not block startup.
  }
  // Point per-session logs (decisions + debug) at THIS session's directory,
  // and pick up the `debug` config flag.
  try {
    setSessionFile(ctx.sessionManager?.getSessionFile());
    setConfigDebug(loadConfig().debug);
  } catch {
    // Ephemeral / no session manager: logs fall back to the shared store.
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
  try {
    // Gated: a concrete-model session must not poke provider auth (it can
    // trigger a token refresh under Pi's credential-store lock, pi#7508).
    if (shouldRunAuthSweep(ctx?.model)) await refreshRoleModels(ctx.modelRegistry, ctx);
  } catch {
    // Advisory only.
  }
  try {
    // Pre-warm the ONNX embedding engine off the turn path so the first
    // ambiguous prompt does not pay the cold-start load inline. Only when the
    // classifier is enabled and the session actually routes (R9). Detached
    // and advisory: the engine is a process-global singleton whose load
    // failures degrade to the keyword classifier (R2), so this never blocks
    // or fails the session.
    const cfg = loadConfig();
    if (cfg.embeddingClassifier && isRouterAutoActive(ctx?.model)) {
      void ensureEmbeddingEngine({ deadlineMs: cfg.embeddingDeadlineMs }).catch(() => {});
    }
  } catch {
    // Advisory only.
  }
  debugLog('lifecycle.session_start.end', {
    reason: event.reason,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    ...session.blacklist.getDebugState(),
  });
}

function handleModelSelect(
  event: ModelSelectEventLike,
  ctx: ExtensionContext,
  refreshRoleModels: RoleModelRefresher,
  session: RouterSession,
): void {
  debugLog('lifecycle.model_select', {
    source: event.source,
    model: `${event.model.provider}/${event.model.id}`,
    previousModel: event.previousModel
      ? `${event.previousModel.provider}/${event.previousModel.id}`
      : undefined,
    ...session.blacklist.getDebugState(),
  });
  // A concrete model selection makes the previous router decision stale.
  if (event.model.provider !== ROUTER_PROVIDER_ID) {
    clearRouterStatus(ctx);
    return;
  }
  // Switching TO router/auto mid-session re-arms subagent role routing that
  // the session_start gate skipped in a concrete-model session. Detached and
  // generation-guarded: a slow probe sweep must never block the switch, and
  // a stale refresh cannot overwrite a newer one.
  if (event.model.id === AUTO_MODEL_ID) {
    // Pi applies the new model's thinking level during the switch; that is
    // not a user choice, so the next turn must not read it as one.
    session.setSyncedThinkingLevel(undefined);
  }
  if (event.model.id === AUTO_MODEL_ID && !isOfflineMode()) {
    void refreshRoleModels(ctx.modelRegistry, ctx).catch(() => {
      // Advisory only.
    });
  }
}

function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  session: RouterSession,
): void {
  // Skill tracking belongs only to sessions actively using router/auto.
  if (!isRouterAutoActive(ctx?.model)) return;
  try {
    const skills = (event as { systemPromptOptions?: { skills?: unknown } }).systemPromptOptions
      ?.skills;
    if (!Array.isArray(skills)) return;
    // Names only. systemPromptOptions may include full context-file contents
    // (Pi docs/extensions.md:1094) and is sensitive extension-local data.
    const names = skills
      .map((skill) =>
        typeof skill === 'string' ? skill : ((skill as { name?: unknown })?.name ?? ''),
      )
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    session.setActiveSkillNames(names);
  } catch {
    // Enrichment is optional; identity from context alone is acceptable.
  }
}

function handleTurnStart(
  _event: TurnStartEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  session: RouterSession,
  runtime: RuntimeBindings,
): void {
  // Ensure provider is registered even if session_start hasn't fired
  // (subagents fire turn_start without a prior session_start).
  // registerAutoRouterProvider is idempotent (lastRegisteredModels guard).
  if (!ctx.modelRegistry?.getAvailable) return;
  // Keep the per-session log target current (subagents / resumed sessions).
  try {
    setSessionFile(ctx.sessionManager?.getSessionFile());
  } catch {
    // ignore
  }
  debugLog('lifecycle.turn_start', {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    ...session.blacklist.getDebugState(),
  });
  // Trajectory arming belongs only to router/auto sessions. Provider
  // registration below stays ungated so a later switch to router/auto
  // can still find the synthetic model.
  if (isRouterAutoActive(ctx?.model)) {
    try {
      session.flushAndArmUnresolvedTrajectory();
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

function handleSubagentToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  session: RouterSession,
  routingState: SubagentRoutingState,
  subagentCalls: Map<string, SubagentCallObservation>,
): void {
  try {
    // Resolve each role's model against the LIVE session blacklist: a model
    // assigned at session_start may have since failed and been blacklisted
    // by a main-session turn, and must not be injected into a spawn. A
    // usage-limit-blacklisted provider excludes every model on it the same
    // way.
    const blacklisted = session.getBlacklistedModels();
    const blacklistedProviders = session.getBlacklistedProviders();
    const isExcluded = (id: string): boolean => {
      const slash = id.indexOf('/');
      return (
        blacklisted.has(id) ||
        (slash > 0 ? blacklistedProviders.has(id.slice(0, slash)) : false)
      );
    };
    const live = routingState.resolveLive(isExcluded);
    const usage = (ctx as ExtensionContext & {
      getContextUsage?: () => { tokens?: number } | undefined;
    }).getContextUsage?.();
    const currentTokens = typeof usage?.tokens === 'number' && usage.tokens > 0
      ? usage.tokens
      : 0;
    const traversal = injectSubagentRoutingWithMetadata(event.input, live.roleModels, {
      selectChildren: (requests) => routingState.selectChildren(requests, isExcluded, currentTokens),
      defaultModel: pickSubagentDefaultModel(live.roleModels),
    });
    subagentCalls.set(event.toolCallId, {
      observedModels: [...new Set(traversal.children.flatMap((child) => child.model ? [child.model] : []))],
      observedRoles: [...new Set(traversal.children.flatMap((child) => child.role ? [child.role] : []))],
    });
  } catch {
    // Never block or break a subagent spawn because of routing.
  }
}

function handleMutationToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  session: RouterSession,
): { block: true; reason: string } | undefined {
  // Bounded mutation handoff: an internal failure here must fail
  // open, not fail the tool call). Returning `undefined` allows execution;
  // only an intentional `{ block: true, reason }` stops it. Bash is
  // classified best-effort: high-confidence write shapes feed the same
  // bounded gate as `edit`/`write`; possible/opaque shapes stay observable
  // but never block.
  try {
    const state = session.getWorkPhaseState();
    const served = session.getLastServed();
    const detection = classifyMutationCall(event.toolName, event.input as Record<string, unknown>);
    const decision = evaluateMutationCall({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      state,
      served,
      detection,
    });
    if (decision.nextState) {
      session.commitWorkPhaseState(decision.nextState);
    }
    if (decision.metadata) {
      const capability = served?.capability;
      // `/router-status` and `/router-why` read the in-memory decision, so
      // gate outcomes have to land there too, not only in the log.
      const last = session.getLastDecision();
      const committed = decision.nextState ?? state;
      if (last?.multiWork && committed) {
        const updated = {
          ...last,
          multiWork: {
            ...last.multiWork,
            phase: committed.phase,
            phaseReason: committed.phaseReason,
            gateBlockedInvocation: committed.gateBlockedInvocation,
            capabilityDegraded: decision.metadata.capabilityDegraded,
            mutationGateEscaped: decision.metadata.mutationGateEscaped,
          },
        };
        session.setLastDecision(updated);
      }
      appendMutationGateSignal({
        intentKey: (decision.nextState ?? state)?.intentKey ?? 'unknown',
        served: served?.registryId ?? 'unknown/unknown',
        providerInvocation: capability?.providerInvocation ?? 0,
        gateBlockedInvocation: decision.nextState?.gateBlockedInvocation,
        terminalFloor: capability?.terminalFloor,
        servedTaskRatio: capability?.candidate.taskRatio,
        clearance: decision.metadata.clearance,
        action: decision.block
          ? 'block'
          : decision.metadata.mutationGateEscaped
            ? 'escape'
            : 'allow',
        capabilityDegraded: decision.metadata.capabilityDegraded,
        mutationSurface: decision.metadata.mutationSurface,
        mutationSignal: decision.metadata.mutationSignal,
      });
    }
    const last = session.getLastDecision();
    const committed = decision.nextState;
    if (last && committed && committed.intentKey === last.intentKey && !last.mutationObserved &&
        (committed.observedMutationTools > 0 || committed.mutationGateTriggered)) {
      const updated = { ...last, mutationObserved: true };
      session.setLastDecision(updated);
      renderRouterStatus(ctx, updated, served);
    }
    if (decision.block) return { block: true, reason: decision.reason ?? '' };
  } catch {
    // An internal gate failure must never block a mutation call.
  }
  return undefined;
}

/** Provider of a `provider/id[:effort]` model id, or undefined if unparseable. */
function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const bare = stripThinkingSuffix(model);
  const slash = bare.indexOf('/');
  return slash > 0 ? bare.slice(0, slash) : undefined;
}

/**
 * Providers a failed child proved are usage-capped. A quota/billing/subscription
 * limit is the one non-retryable failure worth persisting from a child result:
 * the cap is shared by every model on the provider, so a later
 * spawn or main turn on any sibling model would fail the same way. Transient
 * errors are retried by pi-subagents/the model, and request-specific failures
 * (invalid request, refusal) say nothing about provider health, so neither is
 * matched here. Per-attempt errors attribute the cap to the exact model.
 */
function usageLimitProvidersFromRows(rows: readonly SubagentResultRow[]): string[] {
  const providers = new Set<string>();
  for (const row of rows) {
    if (!isFailedResult(row)) continue;
    const sources: Array<{ model?: string; error?: string }> = [
      { model: row.model, error: row.error },
      ...row.modelAttempts.filter((attempt) => attempt.success !== true),
    ];
    for (const { model, error } of sources) {
      if (!isUsageLimitErrorMessage(error)) continue;
      const provider = providerOf(model);
      if (provider) providers.add(provider);
    }
  }
  return [...providers];
}

function handleSubagentToolResult(
  event: ToolResultEvent,
  ctx: ExtensionContext,
  session: RouterSession,
  routingState: SubagentRoutingState,
  subagentCalls: Map<string, SubagentCallObservation>,
  refreshRoleModels: RoleModelRefresher,
): void {
  try {
    const snapshot = routingState.snapshot();
    const pending = subagentCalls.get(event.toolCallId);
    subagentCalls.delete(event.toolCallId);
    const observedModels = pending?.observedModels ?? [];
    const observedRoles = pending?.observedRoles ?? [];
    const rows = parseSubagentResultRows(event.details);

    // A child that hit a provider-wide usage cap excludes that provider for the
    // session, so later spawns and main turns skip every model on it. This does
    // not retry or respawn the child — recovery is the parent's decision.
    const cappedProviders = usageLimitProvidersFromRows(rows);
    for (const provider of cappedProviders) {
      session.blacklistProvider(provider);
      debugLog('subagent.usage-limit', { provider });
    }

    // Harvest tool-gap signals independently of model ownership: explicit
    // children remain visible for observability.
    const missingTools = extractMissingTools(collectSubagentResultText(event));
    if (missingTools.length > 0) {
      const role = observedRoles[0];
      const model = observedModels[0];
      for (const tool of missingTools) {
        appendSubagentGapSignal({ role, tool, model });
      }
    }

    // Foreground child spend, recorded on the same registry-price basis
    // as parent turns so `/router-report` can add them without mixing
    // cost scales. Explicitly-pinned children are recorded too, marked
    // not-router-owned, so the report never claims credit for spend it
    // did not route.
    const candidates = snapshot.routingSnapshot?.candidates;
    if (candidates && candidates.length > 0) {
      const records = computeSubagentSpend(rows, {
        candidates,
        configBaselineModel: loadConfig().baselineModel,
        ...(observedRoles.length === 1 ? { role: observedRoles[0] } : {}),
        routerOwnedModels: observedModels,
      });
      for (const record of records) appendSubagentSpend(record);
    }

    // Recompute role assignments only when a provider was excluded, so the next
    // spawn's role maps drop the now-capped provider. Generation-guarded: a
    // newer refresh already in flight wins.
    if (cappedProviders.length > 0) void refreshRoleModels(ctx.modelRegistry, ctx);
  } catch {
    // A routing/observability failure must never surface as a tool error.
  }
}

function handleMutationToolResult(
  event: ToolResultEvent,
  session: RouterSession,
): void {
  // Correlate a mutation result back to its pending call, if this extension
  // recorded one. Installed Pi does not invoke this hook for a blocked
  // preflight, so only allowed calls ever reach here.
  try {
    const state = session.getWorkPhaseState();
    if (!state?.pendingMutationToolCallIds.has(event.toolCallId)) return;
    const isError = (event as { isError?: boolean }).isError === true;
    const next = recordMutationResult({ state, toolCallId: event.toolCallId, isError });
    session.commitWorkPhaseState(next);
    const served = session.getLastServed();
    appendMutationGateSignal({
      intentKey: state.intentKey,
      served: served?.registryId ?? 'unknown/unknown',
      providerInvocation: served?.capability?.providerInvocation ?? state.providerInvocation,
      terminalFloor: served?.capability?.terminalFloor,
      servedTaskRatio: served?.capability?.candidate.taskRatio,
      clearance: served?.capability?.candidate.clearsTerminalFloor ?? 'unknown',
      action: isError ? 'error' : 'complete',
    });
  } catch {
    // A gate-observability failure must never surface as a tool error.
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
    session.armTrajectoryEscalation(
      decision,
      session.servedTrajectoryKey(),
      session.getLastDecision()?.dimension,
      false,
    );
  } catch {
    // Trajectory observation must never fail a tool result.
  }
}

export default async function autoModelRouterExtension(
  pi: ExtensionAPI,
  session: RouterSession = defaultRouterSession,
  runtime: RuntimeBindings = defaultRuntimeBindings,
) {
  const updateManualModelCompletionContext = registerCommands(pi, session);

  // Register `router/auto` synchronously at extension-init time (no session
  // ctx) so it lands in the runtime's pendingProviderRegistrations BEFORE Pi
  // resolves the session's default model. Without this, findInitialModel
  // cannot find `router/auto` in the registry and falls back to a concrete
  // provider (e.g. github-copilot/gpt-5.4), so routing never happens.
  registerAutoRouterProvider(pi, undefined, session, runtime);
  registerExecutionContractTool(pi, session);

  const routingState = new SubagentRoutingState();
  const subagentCalls = new Map<string, SubagentCallObservation>();

  const refreshRoleModels: RoleModelRefresher = (modelRegistry, ctx) =>
    refreshRoleModelsState(routingState, session, modelRegistry, ctx);

  pi.on('session_start', (event, ctx) =>
    handleSessionStart(
      event,
      ctx,
      pi,
      session,
      runtime,
      subagentCalls,
      routingState,
      refreshRoleModels,
      updateManualModelCompletionContext,
    ),
  );

  pi.on('session_shutdown', (event) => {
    debugLog('lifecycle.session_shutdown', {
      reason: event.reason,
      ...session.blacklist.getDebugState(),
    });
  });

  pi.on('model_select', (event, ctx) => handleModelSelect(event, ctx, refreshRoleModels, session));

  pi.on('agent_settled', () => closeContractOnSettle(session));

  // Both rewrite the history, so no cached prefix still matches it.
  pi.on('session_compact', () => session.clearWarmCaches());
  pi.on('session_tree', () => session.clearWarmCaches());

  pi.on('before_agent_start', (event, ctx) => handleBeforeAgentStart(event, ctx, session));

  pi.on('turn_start', (event, ctx) => handleTurnStart(event, ctx, pi, session, runtime));

  pi.on('tool_call', (event, ctx) => {
    if (!isRouterAutoActive(ctx?.model)) return;
    if (event.toolName === SUBAGENT_TOOL) {
      handleSubagentToolCall(event, ctx, session, routingState, subagentCalls);
      return;
    }
    try {
      const block = handleMutationToolCall(event, ctx, session);
      if (block?.block) return block;
      handleContractToolCall(event, ctx, session);
      const flushed = session.noteTrajectoryToolCall(event.toolName, event.toolCallId, event.input);
      if (flushed) {
        session.armTrajectoryEscalation(
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

  pi.on('tool_result', (event, ctx) => {
    if (!isRouterAutoActive(ctx?.model)) return;
    if (event.toolName === SUBAGENT_TOOL) {
      handleSubagentToolResult(event, ctx, session, routingState, subagentCalls, refreshRoleModels);
      return;
    }
    handleMutationToolResult(event, session);
    handleTrajectoryToolResult(event, session);
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
    return nudgeContractOnEdit(event, session);
  });
}
