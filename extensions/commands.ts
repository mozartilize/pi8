/**
 * Slash commands for the auto model router.
 */
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { saveApiKey, loadConfig, getConfigPath, saveBlacklist } from './config.js';
import { buildModelFilter } from './allowlist.js';
import { syncBenchmarks, syncSummary } from './sync.js';
import type { AdapterName } from './adapters/index.js';
import { ROLE_DIMENSIONS } from './types.js';
import { activeModels, isStale, loadStore, addAlias, saveStore } from './store.js';
import {
  getProviderState,
  buildSubagentProviderAuthFilter,
  addSessionBlacklistPatterns,
  clearSessionBlacklist,
  getSessionBlacklistPatterns,
  removeSessionBlacklistPatterns,
  removeBlacklistedModel,
  removeBlacklistedProvider,
} from './provider.js';
import { formatDecisionDetail, formatAssessmentSpend, formatEmbeddingStats } from './ui.js';
import {
  computeRoleModels,
  readExistingOverrides,
  ALL_ROLES,
  type RoleAssignment,
} from './subagents.js';
import { readRecentEntries, type DecisionLogEntry } from './decisionlog.js';
import { detectToolGaps } from './gap-detector.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';
import { provisionEmbedding } from './embedding-provision.js';
import { clearActiveEscalation } from './escalation.js';
import {
  getLastDecision,
  getLastServed,
  getAssessmentCost,
  getEmbeddingStats,
  setPendingUserEscalation,
} from './router-session-state.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type Dimension } from './types.js';

/**
 * Dimensions a user may escalate to. `lightweight` is excluded: escalation is
 * up-only, and asking for the weakest tier is never an escalation.
 */
const ESCALATABLE_DIMENSIONS: Dimension[] = ['gather', 'implement', 'review', 'plan'];

const ESCALATE_USAGE = `Usage: /router-escalate [${ESCALATABLE_DIMENSIONS.join('|')}]`;

/**
 * Hidden follow-up that makes an escalation take effect immediately instead of
 * waiting for the user's next message.
 *
 * Delivered as a follow-up rather than a user message so it cannot replace the
 * cached per-user-entry classification key, and never as a steer/abort so a
 * stream that already produced output is not replayed on another model.
 */
const HANDOFF_PROMPT =
  'The user escalated the router to a stronger model. Continue the unresolved task ' +
  'from the existing conversation context without recapping the escalation. ' +
  'If no work remains, acknowledge briefly.';

/** Alias to keep command code readable. */
const readRecentDecisions = (limit?: number): DecisionLogEntry[] => readRecentEntries(limit);

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

function safeCommand(name: string, handler: CommandHandler): CommandHandler {
  return async (args, ctx) => {
    try {
      await handler(args, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        ctx.ui.notify(`${name}: ${message}`, 'error');
      } catch {
        // Error reporting is best-effort; command failures never escape to Pi.
      }
    }
  };
}

function splitArgs(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('router-sync', {
    description: 'Fetch fresh benchmark data and update the model routing table',
    handler: safeCommand('/router-sync', async (args, ctx: ExtensionCommandContext) => {
      const [sourceOrKey, subArg] = splitArgs(args);

      // `/router-sync embedding` — download embedding model only.
      if (sourceOrKey === 'embedding') {
        const force = subArg === '--force';
        const result = await provisionEmbedding({
          force,
          onProgress: (status) => ctx.ui.notify(status, 'info'),
        });
        ctx.ui.notify(result.status, result.ok ? 'info' : 'error');
        return;
      }

      const config = loadConfig();
      let apiKey: string | undefined;
      if (sourceOrKey) {
        // If user provided a key, save it.
        saveApiKey(sourceOrKey);
        apiKey = sourceOrKey;
      } else if (config.artificialAnalysisApiKey) {
        apiKey = config.artificialAnalysisApiKey;
      }

      const results = await syncBenchmarks(ctx, {
        apiKey,
        sources: config.sources as AdapterName[],
        onProgress: (r) => {
          ctx.ui.notify(`${r.source}: ${r.ok ? 'ok' : 'failed'}`, r.ok ? 'info' : 'error');
        },
      });
      const summary = syncSummary(results);
      ctx.ui.notify(summary, results.some((r) => r.ok) ? 'info' : 'error');
    }),
  });

  pi.registerCommand('router-blacklist', {
    description:
      'Manage the model blacklist: /router-blacklist [add|remove <patterns…>] [--save] [clear]',
    handler: safeCommand('/router-blacklist', async (args, ctx: ExtensionCommandContext) => {
      const tokens = splitArgs(args);
      const config = loadConfig();
      const persisted = config.blacklist ?? [];
      const sessionPatterns = getSessionBlacklistPatterns();
      const sessionFailed = [...getProviderState().blacklistedModels].sort();

      if (tokens.length === 0) {
        const lines: string[] = [];
        lines.push(
          persisted.length > 0
            ? `Config blacklist (persisted, ${getConfigPath()}):\n${persisted.map((p) => `  ${p}`).join('\n')}`
            : 'Config blacklist: (empty)',
        );
        lines.push(
          sessionPatterns.length > 0
            ? `Session blacklist patterns:\n${sessionPatterns.map((p) => `  ${p}`).join('\n')}`
            : 'Session blacklist patterns: (empty)',
        );
        if (sessionFailed.length > 0)
          lines.push(
            `Runtime failures (this session):\n${sessionFailed.map((id) => `  ${id}`).join('\n')}`,
          );
        const failedProviders = [...getProviderState().blacklistedProviders];
        if (failedProviders.length > 0)
          lines.push(
            `Providers excluded for usage limits (this session):\n${failedProviders
              .map((p) => `  ${p}`)
              .join('\n')}`,
          );
        lines.push(
          '',
          'add <patterns…>         — exclude matching models for this session',
          'remove <patterns…>      — lift a session exclusion',
          '--save                  — write to the config blacklist instead of the session',
          'clear                   — wipe every session exclusion (no patterns)',
        );
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      const [action, ...rest] = tokens;
      // --save may appear anywhere after the action; collect patterns separately.
      const isSave = rest.includes('--save');
      const patterns = isSave ? rest.filter((t) => t !== '--save') : rest;

      if (action === 'add') {
        if (patterns.length === 0) {
          ctx.ui.notify('Usage: /router-blacklist add <patterns…> [--save]', 'error');
          return;
        }
        if (isSave) {
          const next = [...persisted];
          let added = 0;
          for (const raw of patterns) {
            const p = raw.trim();
            if (!p || next.includes(p)) continue;
            next.push(p);
            added++;
          }
          if (added > 0) saveBlacklist(next);
          // Also seed into the session so the new pattern is live immediately.
          addSessionBlacklistPatterns(patterns);
          ctx.ui.notify(
            added > 0
              ? `Added ${added} pattern(s) to the config blacklist (${getConfigPath()}).`
              : 'No new patterns to add to the config blacklist.',
            'info',
          );
        } else {
          const added = addSessionBlacklistPatterns(patterns);
          ctx.ui.notify(
            added.length > 0
              ? `Added to session blacklist:\n${added.map((p) => `  ${p}`).join('\n')}`
              : 'No new patterns to add to the session blacklist.',
            'info',
          );
        }
        return;
      }

      if (action === 'remove') {
        if (patterns.length === 0) {
          ctx.ui.notify('Usage: /router-blacklist remove <patterns…> [--save]', 'error');
          return;
        }
        if (isSave) {
          const set = new Set(patterns.map((p) => p.trim()).filter(Boolean));
          const next = persisted.filter((p) => !set.has(p));
          if (next.length !== persisted.length) saveBlacklist(next);
          // Mirror the removal in session so the lift is immediate.
          removeSessionBlacklistPatterns(patterns);
          ctx.ui.notify(
            next.length !== persisted.length
              ? `Removed from the config blacklist (${getConfigPath()}).`
              : 'No matching persisted patterns to remove.',
            'info',
          );
        } else {
          const removed = removeSessionBlacklistPatterns(patterns);
          const filter = buildModelFilter(patterns);
          for (const id of getProviderState().blacklistedModels) {
            if (filter(id)) removeBlacklistedModel(id);
          }
          // A provider-wide pattern (e.g. `opencode-go/*`) also lifts a
          // usage-limit provider exclusion; an exact model pattern does not.
          for (const provider of getProviderState().blacklistedProviders) {
            if (filter(`${provider}/x`)) removeBlacklistedProvider(provider);
          }
          ctx.ui.notify(
            removed.length > 0
              ? `Removed from the session blacklist:\n${removed.map((p) => `  ${p}`).join('\n')}`
              : 'No matching session patterns to remove.',
            'info',
          );
        }
        return;
      }

      if (action === 'clear') {
        if (rest.length > 0) {
          ctx.ui.notify(
            'Usage: /router-blacklist clear (no patterns — wipes everything session-scoped)',
            'error',
          );
          return;
        }
        clearSessionBlacklist();
        ctx.ui.notify('Cleared all session blacklist state (config blacklist untouched).', 'info');
        return;
      }

      ctx.ui.notify(
        'Usage: /router-blacklist [add|remove <patterns…>] [--save] [clear]',
        'error',
      );
    }),
  });

  pi.registerCommand('router-status', {
    description: 'Show pi8 status, freshness, coverage and the last routing decision',
    handler: safeCommand('/router-status', async (_args, ctx: ExtensionCommandContext) => {
      const { lastDecision, lastServed } = getProviderState();
      const store = loadStore();
      if (!store || !store.syncedAt) {
        const msg =
          'Auto-router has no benchmark data — run `/router-sync <key>` with a free key from https://artificialanalysis.ai/.';
        ctx.ui.notify(msg, 'warning');
        return;
      }
      const stale = isStale(store);
      const active = activeModels(store);
      // Coverage against the live registry is the number that actually
      // predicts routing quality: unmatched models fall back to price-only.
      const registryIds = new Set(
        (ctx.modelRegistry?.getAvailable() ?? [])
          .map((m) => `${m.provider}/${m.id}`)
          .filter((id) => !id.startsWith('router/')),
      );
      const covered = active.filter((m) => registryIds.has(m.registryId)).length;
      const lines = [
        `Synced: ${new Date(store.syncedAt).toISOString()}${stale ? ' (stale)' : ''}`,
        `Active models in store: ${active.length}`,
        `Registry coverage: ${covered}/${registryIds.size} models have benchmark data`,
        `Unresolved models: ${store.models.filter((m) => !m.active).length}`,
        `Aliases: ${Object.keys(store.aliases).length}`,
      ];
      if (covered === 0) {
        lines.push('', 'No registry model matched a benchmark row — routing is price-only.');
        lines.push('Map one manually with `/router-fix <bench-slug> <provider/id>`.');
      }
      lines.push('', ...formatDecisionDetail(lastDecision, lastServed));
      lines.push(formatAssessmentSpend(getAssessmentCost()));
      const embStats = getEmbeddingStats();
      if (embStats.fired + embStats.degraded > 0) {
        lines.push(formatEmbeddingStats(embStats));
      }
      // M4: show recent routing history, surfacing any real fallbacks.
      // Only actual routing decisions belong here: shadow counterfactuals and
      // mutation-gate signals join decisions by intentKey offline, and letting
      // them through would push real turns out of the recent window.
      const history = readRecentDecisions(20);
      const routingHistory = history.filter(
        (e) => e.cause !== 'self-healing-gap' && (e.kind === undefined || e.kind === 'decision'),
      );
      const fallbacks = routingHistory.filter((e) => e.viaFallback);
      if (routingHistory.length > 0) {
        lines.push('', 'Recent routing history:');
        for (const e of routingHistory.slice(-6).reverse()) {
          const markFallback = e.viaFallback ? ` ⚠ FELL BACK to ${e.served} (rank ${e.fallbackRank})` : '';
          lines.push(
            `  ${new Date(e.ts).toISOString().slice(11, 19)} ${e.dimension.padEnd(10)} → ${e.served}${markFallback}`,
          );
        }
        if (fallbacks.length === 0) {
          lines.push('  (no fallbacks in window)');
        }
      }

      const gaps = detectToolGaps(history).slice(0, 3);
      if (gaps.length > 0) {
        lines.push('', 'Observed subagent tool gaps (read-only detector):');
        for (const gap of gaps) {
          lines.push(
            `  ${gap.role.padEnd(11)} missing ${gap.tool}  obs=${gap.observations} confidence=${gap.strength.toFixed(2)}`,
          );
        }
      }
      const msg = lines.join('\n');
      ctx.ui.notify(msg, stale ? 'warning' : 'info');
    }),
  });

  pi.registerCommand('router-why', {
    description: 'Explain which model served the last turn and why it was chosen',
    handler: safeCommand('/router-why', async (_args, ctx: ExtensionCommandContext) => {
      const { lastDecision, lastServed } = getProviderState();
      const lines = formatDecisionDetail(lastDecision, lastServed);
      if (!lastDecision) {
        lines.push(
          '',
          'If the footer shows `(router) auto`, the router is active and the next turn will populate this.',
        );
      }
      ctx.ui.notify(lines.join('\n'), lastDecision ? 'info' : 'warning');
    }),
  });

  pi.registerCommand('router-fix', {
    description: 'Manually fix a benchmark-to-registry alias: /router-fix <bench-slug> <provider/id>',
    handler: safeCommand('/router-fix', async (args, ctx: ExtensionCommandContext) => {
      const [slug, registryId] = splitArgs(args);
      if (!slug || !registryId) {
        const msg = 'Usage: /router-fix <bench-slug> <provider/id>';
        ctx.ui.notify(msg, 'error');
        return;
      }
      const store = loadStore();
      if (!store) {
        const msg = 'No benchmark store found. Run /router-sync first.';
        ctx.ui.notify(msg, 'error');
        return;
      }
      const next = addAlias(store, slug, registryId);
      saveStore(next);
      const msg = `Alias added: ${slug} -> ${registryId}. Re-run /router-sync to apply.`;
      ctx.ui.notify(msg, 'info');
    }),
  });

  pi.registerCommand('router-models', {
    description: 'Show the `models` allowlist and which registry models it selects',
    handler: safeCommand('/router-models', async (_args, ctx: ExtensionCommandContext) => {
      const config = loadConfig();
      const patterns = config.models;
      const isAllowed = buildModelFilter(patterns);
      const registryModels = (ctx.modelRegistry?.getAvailable() ?? []) as unknown as Array<{
        provider: string;
        id: string;
      }>;

      const lines: string[] = [];
      if (!patterns || patterns.length === 0) {
        lines.push('models allowlist: (not set — every registry model is routable)');
      } else {
        lines.push('models allowlist:');
        for (const p of patterns) lines.push(`  ${p}`);
      }

      const routable: string[] = [];
      let excluded = 0;
      for (const m of registryModels) {
        if (m.provider === 'router') continue;
        const rid = `${m.provider}/${m.id}`;
        if (isAllowed(rid)) routable.push(rid);
        else excluded++;
      }

      lines.push('', `routable: ${routable.length}   excluded: ${excluded}`);
      for (const rid of routable.slice(0, 40)) lines.push(`  ${rid}`);
      if (routable.length > 40) lines.push(`  … and ${routable.length - 40} more`);

      if (patterns && patterns.length > 0 && routable.length === 0) {
        lines.push('', 'WARNING: the allowlist matches nothing — routing will fail.');
      }

      lines.push(
        '',
        `Edit "models" in ${getConfigPath()}`,
        'e.g. ["github-copilot/*", "opencode-go/deepseek-v4-pro"]',
      );
      ctx.ui.notify(lines.join('\n'), 'info');
    }),
  });

  pi.registerCommand('router-escalate', {
    description: `Immediately re-route the current task to a stronger model: ${ESCALATE_USAGE}`,
    handler: safeCommand('/router-escalate', async (args, ctx: ExtensionCommandContext) => {
      // route_up-adjacent surface: inert unless the session actually routes.
      // On a concrete model there is no routing loop to consume the request.
      const model = ctx.model as { provider?: string; id?: string } | undefined;
      if (model?.provider !== ROUTER_PROVIDER_ID || model?.id !== AUTO_MODEL_ID) {
        ctx.ui.notify(
          '/router-escalate has no effect: the session model is not router/auto.',
          'warning',
        );
        return;
      }

      const parsed = splitArgs(args);
      if (parsed.length > 1) {
        ctx.ui.notify(ESCALATE_USAGE, 'error');
        return;
      }
      const [rawTarget] = parsed;
      if (rawTarget && !ESCALATABLE_DIMENSIONS.includes(rawTarget as Dimension)) {
        ctx.ui.notify(ESCALATE_USAGE, 'error');
        return;
      }
      const target = rawTarget as Dimension | undefined;

      const last = getLastDecision();
      if (!last) {
        ctx.ui.notify(
          'Nothing to escalate yet — the router has not served a turn in this session.',
          'warning',
        );
        return;
      }

      // Equal is allowed: it requests a different model at the same dimension.
      if (target && DIMENSION_STRENGTH[target] < DIMENSION_STRENGTH[last.dimension]) {
        ctx.ui.notify(
          `Escalation is up-only: the last turn already routed to ${last.dimension}, ` +
            `which is stronger than ${target}.`,
          'error',
        );
        return;
      }

      // The served model is the one the user actually saw; preserve its effort
      // variant so an exact repeat is excluded while a higher-effort retry stays
      // eligible. Fall back to the chosen candidate when delegation never
      // recorded a serve.
      const served = getLastServed();
      const fromModel = served?.registryId
        ? served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId
        : last.chosen;
      setPendingUserEscalation({ target, fromModel });
      // An explicit user request supersedes a model's pending route_up.
      clearActiveEscalation();

      await pi.sendMessage(
        {
          customType: 'pi8:handoff',
          content: HANDOFF_PROMPT,
          display: false,
          details: { kind: 'user-escalation', target, fromModel },
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    }),
  });

  pi.registerCommand('router-agents', {
    description: 'Show which model each pi-subagents role gets (researcher/planner/worker/reviewer/advisor)',
    handler: safeCommand('/router-agents', async (_args, ctx: ExtensionCommandContext) => {
      const registryModels = (ctx.modelRegistry?.getAvailable() ?? []) as unknown as Array<{
        provider: string;
        id: string;
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
        input?: readonly ('text' | 'image')[];
        cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      }>;

      let assignments: RoleAssignment[];
      const store = loadStore();
      if (registryModels.length > 0 && store && store.models.length > 0) {
        // Same credential gate the spawn-time injection uses, so what we show
        // is what a subagent would actually get.
        const isProviderUsable = buildSubagentProviderAuthFilter(
          ctx.modelRegistry,
          registryModels as never,
        );
        assignments = computeRoleModels(registryModels as never, {
          isProviderUsable,
          ctx,
          weights: loadConfig().dimensionWeights,
        }).assignments;
      } else {
        // No registry or no benchmark data yet: display whatever is pinned.
        const existing = readExistingOverrides(undefined, ctx.cwd);
        assignments = ALL_ROLES.map((role) => ({
          role,
          dimension: ROLE_DIMENSIONS[role],
          model: existing[role]?.model,
          fallbackChain: [],
          applied: false,
          userPinned: !!existing[role],
          reason: existing[role]
            ? 'current override'
            : store
              ? 'no model registry available'
              : 'no benchmark data — run /router-sync',
        }));
      }

      const lines = ['Subagent role assignment:'];
      for (const a of assignments) {
        const tag = a.userPinned ? ' [user-pinned]' : a.applied ? ' [auto]' : '';
        const model = a.model ?? '(none)';
        lines.push(`  ${a.role.padEnd(11)} ${a.dimension.padEnd(10)} → ${model}${tag}`);
        if (a.reason && a.reason !== 'user override preserved' && a.reason !== 'current override') {
          lines.push(`       ${a.reason}`);
        }
      }
      lines.push(
        '',
        '[auto] roles receive a concrete provider/model selected at spawn time.',
        'The model shown is the baseline; structured child tasks may raise and re-score it.',
        'Nothing is written to settings.',
        'An explicit model on the call (e.g. reviewer[model=...]) always wins.',
      );
      ctx.ui.notify(lines.join('\n'), 'info');
    }),
  });
}
