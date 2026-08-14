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
import type { ExtensionAPI, ExtensionContext, ModelChangeEntry } from '@earendil-works/pi-coding-agent';

import { registerCommands } from './commands.js';
import {
  registerAutoRouterProvider,
  buildSubagentProviderAuthFilter,
  clearSessionBlacklist,
  addSessionBlacklistPatterns,
  getBlacklistedModels,
  getBlacklistedProviders,
  getSessionBlacklistPatterns,
  blacklistModel,
} from './provider.js';
import { registerRouteUpTool, resetEscalationSession } from './escalation.js';
import { computeRoleModels, pickSubagentDefaultModel } from './subagents.js';
import { SubagentEscalationHooks } from './subagent-escalation-hooks.js';
import { SubagentRoutingState } from './subagent-routing-state.js';
import { extractMissingTools } from './gap-detector.js';
import { collectSubagentResultText } from './subagent-results.js';
import { loadModelFilter, buildExcludeFilter, buildScopedModelFilter } from './allowlist.js';
import { loadConfig } from './config.js';
import { setSessionFile } from './sessionpaths.js';
import { setConfigDebug } from './debuglog.js';
import type { RegistryModelInfo } from './scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from './types.js';
import { appendMutationGateSignal, appendSubagentGapSignal } from './decisionlog.js';
import { clearRouterStatus } from './ui.js';
import {
  getLastDecision,
  setLastDecision,
  getLastServed,
  getWorkPhaseState,
  commitWorkPhaseState,
  resetRouterSession,
  setActiveSkillNames,
} from './router-session-state.js';
import { evaluateMutationCall, recordMutationResult } from './mutation-gate.js';

/** Tool registered by pi-subagents that spawns child agents. */
const SUBAGENT_TOOL = 'subagent';

/**
 * True only when the session's currently active model IS the router/auto
 * synthetic provider. All subagent-injection and route_up routing logic must
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
 * request offline mode. Concrete-model sessions stay a complete no-op (hard
 * rule 9); a switch to router/auto re-arms the sweep via model_select.
 */
function shouldRunAuthSweep(model: { provider?: string; id?: string } | undefined): boolean {
  if (isOfflineMode()) return false;
  return isRouterAutoActive(model);
}

type ModelRegistry = ExtensionContext['modelRegistry'];

export default async function autoModelRouterExtension(pi: ExtensionAPI) {
  registerCommands(pi);

  // M4b: self-escalation tool. Costs nothing unless a model calls it.
  registerRouteUpTool(pi);

  // Register `router/auto` synchronously at extension-init time (no session
  // ctx) so it lands in the runtime's pendingProviderRegistrations BEFORE Pi
  // resolves the session's default model. Without this, findInitialModel
  // cannot find `router/auto` in the registry and falls back to a concrete
  // provider (e.g. github-copilot/gpt-5.4), so routing never happens.
  registerAutoRouterProvider(pi);

  const routingState = new SubagentRoutingState();
  const subagentEscalationHooks = new SubagentEscalationHooks();

  const refreshRoleModels = async (
    modelRegistry: ModelRegistry,
    ctx?: ExtensionContext,
  ): Promise<void> => {
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
    const isBlacklisted = buildExcludeFilter(getSessionBlacklistPatterns());
    const blacklistedSet = getBlacklistedModels();
    const blacklistedProviders = getBlacklistedProviders();
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
    const computed = computeRoleModels(allowedModels, { isProviderUsable, ctx });
    routingState.commitRefresh(generation, {
      roleModels: computed.roleModels,
      roleFallbacks: computed.roleFallbacks,
    });
  };

  pi.on('session_start', async (event, ctx) => {
    try {
      resetRouterSession();
      resetEscalationSession();
      clearSessionBlacklist();
      // Seed config blacklist so the session can temporarily override it via
      // remove/clear. Config writes stay authoritative: next session_start
      // re-seeds the authoritative list.
      addSessionBlacklistPatterns(loadConfig().blacklist ?? []);
      subagentEscalationHooks.reset();
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
      registerAutoRouterProvider(pi, ctx);
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
  });

  pi.on('model_select', (event, ctx) => {
    // A concrete model selection makes the previous router decision stale.
    if (event.model.provider !== ROUTER_PROVIDER_ID) {
      clearRouterStatus(ctx);
      return;
    }
    // Switching TO router/auto mid-session re-arms subagent role routing that
    // the session_start gate skipped in a concrete-model session. Detached and
    // generation-guarded: a slow probe sweep must never block the switch, and
    // a stale refresh cannot overwrite a newer one.
    if (event.model.id === AUTO_MODEL_ID && !isOfflineMode()) {
      void refreshRoleModels(ctx.modelRegistry, ctx).catch(() => {
        // Advisory only.
      });
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    // Hard rule 9: this extension is a complete no-op when the session's
    // active model is a concrete pick.
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
      setActiveSkillNames(names);
    } catch {
      // Enrichment is optional; identity from context alone is acceptable.
    }
  });

  pi.on('turn_start', (_event, ctx) => {
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
    try {
      registerAutoRouterProvider(pi, ctx);
    } catch {
      // ignore
    }
  });

  // Inject the routed model into subagent spawns. `event.input` is mutable and
  // patching it here is the supported way to adjust tool arguments before
  // execution (see Pi docs/extensions.md, "tool_call"). This replaces the old
  // behaviour of persisting role models into ~/.pi/agent/settings.json.
  //
  // Ownership: omitted model or explicit `router/auto` sentinel → router-owned
  // and injected with the routed concrete model. Any other concrete model is
  // left unchanged (explicit choices win).
  //
  // Gate: this only applies when the PARENT session's active model is
  // router/auto. When the user picked a concrete model, subagent spawns must
  // get pi-subagents' own default model selection untouched — this extension
  // must not silently reach into a session that never opted into routing.
  pi.on('tool_call', (event, ctx) => {
    if (!isRouterAutoActive(ctx?.model)) return;

    if (event.toolName === SUBAGENT_TOOL) {
      try {
        // Resolve each role's model against the LIVE session blacklist: a model
        // assigned at session_start may have since failed and been blacklisted
        // by a main-session turn, and must not be injected into a spawn. A
        // usage-limit-blacklisted provider excludes every model on it the same
        // way.
        const blacklisted = getBlacklistedModels();
        const blacklistedProviders = getBlacklistedProviders();
        const isExcluded = (id: string): boolean => {
          const slash = id.indexOf('/');
          return (
            blacklisted.has(id) ||
            (slash > 0 ? blacklistedProviders.has(id.slice(0, slash)) : false)
          );
        };
        const live = routingState.resolveLive(isExcluded);
        const defaultModel = pickSubagentDefaultModel(live.roleModels);
        subagentEscalationHooks.toolCall(
          event.toolCallId,
          event.input,
          live.roleModels,
          live.roleFallbacks,
          isExcluded,
          defaultModel,
        );
      } catch {
        // Never block or break a subagent spawn because of routing.
      }
      return;
    }

    // Bounded mutation handoff (rule 2: an internal failure here must fail
    // open, not fail the tool call). Returning `undefined` allows execution;
    // only an intentional `{ block: true, reason }` stops it.
    try {
      const state = getWorkPhaseState();
      const served = getLastServed();
      const decision = evaluateMutationCall({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        state,
        served,
      });
      if (decision.nextState) commitWorkPhaseState(decision.nextState);
      if (decision.metadata) {
        const capability = served?.capability;
        // `/router-status` and `/router-why` read the in-memory decision, so
        // gate outcomes have to land there too, not only in the log.
        const last = getLastDecision();
        const committed = decision.nextState ?? state;
        if (last?.multiWork && committed) {
          setLastDecision({
            ...last,
            multiWork: {
              ...last.multiWork,
              phase: committed.phase,
              phaseReason: committed.phaseReason,
              gateBlockedInvocation: committed.gateBlockedInvocation,
              capabilityDegraded: decision.metadata.capabilityDegraded,
              mutationGateEscaped: decision.metadata.mutationGateEscaped,
            },
          });
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
        });
      }
      if (decision.block) return { block: true, reason: decision.reason };
    } catch {
      // An internal gate failure must never block a mutation call.
    }
  });

  pi.on('tool_result', (event, ctx) => {
    if (!isRouterAutoActive(ctx?.model)) return;

    if (event.toolName === SUBAGENT_TOOL) {
      try {
        const snapshot = routingState.snapshot();
        const plan = subagentEscalationHooks.toolResult(
          event.toolCallId,
          event,
          snapshot.roleFallbacks,
          blacklistModel,
        );

        // Harvest tool-gap signals independently of model ownership: explicit
        // children remain visible for observability but never gain router retry
        // or blacklist ownership.
        const missingTools = extractMissingTools(collectSubagentResultText(event));
        if (missingTools.length > 0) {
          const role = plan.observedRoles[0];
          const model = plan.blacklistModels[0] ?? plan.observedModels[0];
          for (const tool of missingTools) {
            appendSubagentGapSignal({ role, tool, model });
          }
        }

        // Only recompute role assignments when a blacklist actually changed them.
        // The refresh is generation-guarded: if a newer refresh started while we
        // were processing this result, this refresh is ignored rather than
        // overwriting newer maps.
        if (plan.blacklistModels.length > 0) void refreshRoleModels(ctx.modelRegistry, ctx);
        if (plan.content) return { content: plan.content };
      } catch {
        // A routing/observability failure must never surface as a tool error.
      }
      return;
    }

    // Correlate a mutation result back to its pending call, if this extension
    // recorded one. Installed Pi does not invoke this hook for a blocked
    // preflight, so only allowed calls ever reach here.
    try {
      const state = getWorkPhaseState();
      if (!state?.pendingMutationToolCallIds.has(event.toolCallId)) return;
      const isError = (event as { isError?: boolean }).isError === true;
      const next = recordMutationResult({ state, toolCallId: event.toolCallId, isError });
      commitWorkPhaseState(next);
      const served = getLastServed();
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
  });
}
