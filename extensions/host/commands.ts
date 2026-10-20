import { formatDecisionDetail, preferenceBinding, formatUnifiedSummary } from './ui.js';
/**
 * Slash commands for the auto model router.
 */
import { loadModelHistory, compliancePenalties, modelHistoryReady } from '../bench/model-history.js';
import {
  ModelSelectorComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { resolveManualModel } from '../serve/manual-model.js';

import { saveApiKey, loadConfig, getConfigPath, saveBlacklist, saveSemi, loadPreferenceSnapshot } from '../config.js';
import { checkPlaywright } from '../adapters/artificial-analysis-site.js';
import { buildModelFilter } from '../routing/policy/allowlist.js';
import { syncBenchmarks, syncSummary } from '../bench/sync.js';
import { prepareSelectorDomain } from '../serve/unified-decision.js';
import { ROUTER_PROVIDER_ID } from '../types.js';
import { activeModels, checkBenchmarkStore, isStale, loadStore, addAlias, saveStore } from '../bench/store.js';
import { CALIBRATED_INDEX_VERSION, indexVersionWarning } from '../routing/score/scorer.js';
import {
  getProviderState,
} from '../serve/provider.js';
import { CORE_PREFERENCE_KEYS, hasSubstantiveAnswers } from '../routing/preferences/schema.js';

import { readRecentEntries, type DecisionLogEntry } from './decisionlog.js';
import {
  RouterSession,
  defaultRouterSession,
} from '../serve/router-session-state.js';

/**
 * Alias to keep command code readable.
 */
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

function parseBlacklistArgs(args: string): {
  action: 'show' | 'add' | 'remove' | 'clear' | 'invalid';
  isSave: boolean;
  patterns: string[];
  extraArgs: string[];
} {
  const tokens = splitArgs(args);
  if (tokens.length === 0) {
    return { action: 'show', isSave: false, patterns: [], extraArgs: [] };
  }

  const [rawAction, ...rest] = tokens;
  const isSave = rest.includes('--save');
  const patterns = isSave ? rest.filter((t) => t !== '--save') : rest;

  if (rawAction === 'add' || rawAction === 'remove') {
    return { action: rawAction, isSave, patterns, extraArgs: [] };
  }
  if (rawAction === 'clear') {
    return { action: 'clear', isSave, patterns: [], extraArgs: rest };
  }
  return { action: 'invalid', isSave, patterns, extraArgs: rest };
}

function handleBlacklistShow(ctx: ExtensionCommandContext, session: RouterSession): void {
  const config = loadConfig();
  const persisted = config.blacklist ?? [];
  const sessionPatterns = session.getSessionBlacklistPatterns();
  const sessionFailed = [...session.getBlacklistedModels()].sort();

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
  const failedProviders = [...session.getBlacklistedProviders()];
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
}

function handleBlacklistAdd(
  patterns: string[],
  isSave: boolean,
  ctx: ExtensionCommandContext,
  session: RouterSession,
): void {
  if (patterns.length === 0) {
    ctx.ui.notify('Usage: /router-blacklist add <patterns…> [--save]', 'error');
    return;
  }
  if (isSave) {
    const config = loadConfig();
    const persisted = config.blacklist ?? [];
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
    session.addSessionBlacklistPatterns(patterns);
    ctx.ui.notify(
      added > 0
        ? `Added ${added} pattern(s) to the config blacklist (${getConfigPath()}).`
        : 'No new patterns to add to the config blacklist.',
      'info',
    );
  } else {
    const added = session.addSessionBlacklistPatterns(patterns);
    ctx.ui.notify(
      added.length > 0
        ? `Added to session blacklist:\n${added.map((p) => `  ${p}`).join('\n')}`
        : 'No new patterns to add to the session blacklist.',
      'info',
    );
  }
}

function handleBlacklistRemove(
  patterns: string[],
  isSave: boolean,
  ctx: ExtensionCommandContext,
  session: RouterSession,
): void {
  if (patterns.length === 0) {
    ctx.ui.notify('Usage: /router-blacklist remove <patterns…> [--save]', 'error');
    return;
  }
  if (isSave) {
    const config = loadConfig();
    const persisted = config.blacklist ?? [];
    const set = new Set(patterns.map((p) => p.trim()).filter(Boolean));
    const next = persisted.filter((p) => !set.has(p));
    if (next.length !== persisted.length) saveBlacklist(next);
    // Mirror the removal in session so the lift is immediate.
    session.removeSessionBlacklistPatterns(patterns);
    ctx.ui.notify(
      next.length !== persisted.length
        ? `Removed from the config blacklist (${getConfigPath()}).`
        : 'No matching persisted patterns to remove.',
      'info',
    );
  } else {
    const removed = session.removeSessionBlacklistPatterns(patterns);
    const filter = buildModelFilter(patterns);
    for (const id of session.getBlacklistedModels()) {
      if (filter(id)) session.removeBlacklistedModel(id);
    }
    // A provider-wide pattern (e.g. `opencode-go/*`) also lifts a
    // usage-limit provider exclusion; an exact model pattern does not.
    for (const provider of session.getBlacklistedProviders()) {
      if (filter(`${provider}/x`)) session.removeBlacklistedProvider(provider);
    }
    ctx.ui.notify(
      removed.length > 0
        ? `Removed from the session blacklist:\n${removed.map((p) => `  ${p}`).join('\n')}`
        : 'No matching session patterns to remove.',
      'info',
    );
  }
}

function handleBlacklistClear(
  extraArgs: string[],
  ctx: ExtensionCommandContext,
  session: RouterSession,
): void {
  if (extraArgs.length > 0) {
    ctx.ui.notify(
      'Usage: /router-blacklist clear (no patterns; clears every session blacklist entry)',
      'error',
    );
    return;
  }
  session.clearSessionBlacklist();
  ctx.ui.notify('Cleared all session blacklist state (config blacklist untouched).', 'info');
}

async function handleSyncCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const [apiKey] = splitArgs(args);
  if (apiKey) saveApiKey(apiKey);
  ctx.ui.notify('Syncing Artificial Analysis benchmark data…', 'info');
  const results = await syncBenchmarks(ctx, { apiKey });
  ctx.ui.notify(
    syncSummary(results),
    !results.every((r) => r.ok) ? 'error' : results.some((r) => r.warning) ? 'warning' : 'info',
  );
  // The compile is stored, so the first selection of the next process applies the preferences.
  try {
    const preparation = await prepareSelectorDomain();
    if (preparation === 'failed') ctx.ui.notify('Preference domain did not compile. The first selection of a process ignores your preferences.', 'warning');
  } catch {
    // A compile failure must not fail the sync.
  }
}

async function handleStatusCommand(
  ctx: ExtensionCommandContext,
  session: RouterSession,
): Promise<void> {
  const { lastDecision, lastServed } = getProviderState(session);
  const manualStatus = `Manual override: ${session.getManualModel() ?? 'none (auto routing)'}`;
  const semiStatus = `Semi-auto: ${loadConfig().semi ? 'on (ask before model switches)' : 'off'}`;
  const config = loadConfig();
  const protocolHistory = config.reputation === false ? undefined : loadModelHistory();
  const penalties = protocolHistory ? compliancePenalties(protocolHistory, config.reputationWeights, config.switchMargin) : new Map<string, number>();
  const modelHistory = !protocolHistory ? ['Model history: disabled'] : [
    `Model history: ${!modelHistoryReady(protocolHistory) ? 'collecting; global preference starts after 14 days' : config.reputationWeights ? 'compliance weights configured' : 'collecting compliance; no penalty weights configured'}`,
    ...[...protocolHistory.stats].map(([model, stats]) => {
      const kinds = [...stats.byReminder].map(([kind, counts]) =>
        `${kind}: ${counts.reminders.toFixed(1)} reminders, ${counts.followed.toFixed(1)} followed, ${counts.ignored.toFixed(1)} ignored`);
      return `  ${model}: ${stats.entries.toFixed(1)} decayed entries${kinds.length ? `; ${kinds.join('; ')}` : ''}; penalty ${(penalties.get(model) ?? 0).toFixed(3)}`;
    }),
  ];
  const browser = await checkPlaywright();
  const browserStatus = browser.ready
    ? ['Chromium for Playwright: ready']
    : ['Chromium for Playwright: missing — /router-sync cannot refresh benchmark data. The current data stays in use.', browser.message];
  const store = loadStore();
  if (!store || !store.syncedAt) {
    const msg = [
      manualStatus,
      semiStatus,
      ...browserStatus,
      ...modelHistory,
      'Auto-router has no benchmark data — run `/router-sync <key>` with a free key from https://artificialanalysis.ai/.',
    ].join('\n');
    ctx.ui.notify(msg, 'warning');
    return;
  }
  const stale = isStale(store);
  const active = activeModels(store);
  const readiness = checkBenchmarkStore(store);
  const versionWarning = indexVersionWarning(store.indexVersion);
  // Coverage against the live registry is the number that actually
  // predicts routing quality: unmatched models fall back to price-only.
  const registryIds = new Set(
    (ctx.modelRegistry?.getAvailable() ?? [])
      .map((m) => `${m.provider}/${m.id}`)
      .filter((id) => !id.startsWith('router/')),
  );
  const covered = active.filter((m) => registryIds.has(m.registryId)).length;
  const lines = [
    manualStatus,
    semiStatus,
    ...browserStatus,
    ...modelHistory,
    `Synced: ${new Date(store.syncedAt).toISOString()}${stale ? ' (stale)' : ''}`,
    `AA Intelligence Index version: ${store.indexVersion ?? 'not reported'} (minimums calibrated for ${CALIBRATED_INDEX_VERSION})`,
    ...(readiness.ready ? [] : [`router/auto does not route: ${readiness.message}`]),
    ...(versionWarning ? [`Warning: ${versionWarning}`] : []),
    `Active models in store: ${active.length}`,
    `Registry coverage: ${covered}/${registryIds.size} models have benchmark data`,
    `Benchmark rows without a registry match: ${store.models.filter((m) => !m.active).length}`,
    `Manual mappings (/router-fix): ${Object.keys(store.aliases).length}`,
  ];
  if (covered === 0) {
    lines.push('', 'No registry model matched a benchmark row — routing is price-only.');
    lines.push('Map one manually with `/router-fix <bench-slug> <provider/id>`.');
  }
  lines.push('', ...formatDecisionDetail(lastDecision, lastServed));
  // M4: show recent routing history, surfacing any real fallbacks.
  // Only actual routing decisions belong here: secondary records join
  // decisions by intentKey offline, and letting them through would push real
  // turns out of the recent window. A record with no `kind` from an older
  // writer can be a gap observation, so its cause is excluded by name.
  const history = readRecentDecisions(200);
  const routingHistory = history.filter(
    (e) => (e.kind === undefined || e.kind === 'decision') && e.cause !== 'self-healing-gap',
  );
  const fallbacks = routingHistory.filter((e) => e.viaFallback);
  // One row for each run of turns served by the same model, stamped with the
  // newest turn of the run. A fallback turn always gets its own row.
  const switches = routingHistory.filter((e, i) => {
    const next = routingHistory[i + 1];
    return !next || next.served !== e.served || e.viaFallback || next.viaFallback;
  });
  if (switches.length > 0) {
    lines.push('', 'Recent routing history:');
    for (const e of switches.slice(-6).reverse()) {
      const markFallback = e.viaFallback ? ` ⚠ FELL BACK to ${e.served} (rank ${e.fallbackRank})` : '';
      lines.push(
        `  ${new Date(e.ts).toISOString().slice(11, 19)} ${e.dimension.padEnd(10)} → ${e.served}${markFallback}`,
      );
    }
    if (fallbacks.length === 0) {
      lines.push('  (no fallbacks in window)');
    }
  }

  const msg = lines.join('\n');
  ctx.ui.notify(msg, stale ? 'warning' : 'info');
}

async function handleWhyCommand(
  ctx: ExtensionCommandContext,
  session: RouterSession,
): Promise<void> {
  const { lastDecision, lastServed } = getProviderState(session);
  const lines = formatDecisionDetail(lastDecision, lastServed);
  if (!lastDecision) {
    lines.push(
      '',
      'If the footer shows `(router) auto`, the router is active and the next turn will populate this.',
    );
  }
  ctx.ui.notify(lines.join('\n'), lastDecision ? 'info' : 'warning');
}

async function handlePreferencesCommand(
  args: string,
  ctx: ExtensionCommandContext,
  session: RouterSession,
): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = tokens[0] ?? 'show';
    const details = tokens.includes('--details');
    if (action !== 'show' && action !== '--details') {
      ctx.ui.notify('Usage: /router-preferences show [--details]', 'error');
      return;
    }
    const snapshot = loadPreferenceSnapshot();
    const last = getProviderState(session).lastDecision?.unified;
    const lines: string[] = [];
    if (snapshot.status !== 'valid' || !snapshot.profile) {
      lines.push(`Preferences: ${snapshot.status}`);
      lines.push(...snapshot.diagnostics.map((line) => `  ${line}`));
    } else {
      lines.push('Preferences version 1');
      for (const key of CORE_PREFERENCE_KEYS) {
        lines.push(`  ${key}: ${snapshot.profile[key] ?? '(unset)'}`);
      }
        lines.push(hasSubstantiveAnswers(snapshot.profile)
          ? last ? `Binding: ${preferenceBinding(last)}`
            : 'Binding: saved, no decision yet'
          : 'Binding: none');
    }
    if (last) {
      lines.push(`Last ranking: ${formatUnifiedSummary(last)}`);
      if (details && last.top) {
        for (const action of last.top.slice(0, 8)) {
          const regret = action.maxRegret !== undefined ? ` regret ${action.maxRegret}` : '';
          const shortfall = action.capabilityShortfall !== undefined ? ` shortfall ${action.capabilityShortfall}` : '';
          lines.push(`  ${action.rank}. ${action.key}${shortfall}${regret}`);
        }
      }
    }
    ctx.ui.notify(lines.join('\n'), snapshot.status === 'valid' ? 'info' : 'warning');
  }

async function handleReportCommand(ctx: ExtensionCommandContext): Promise<void> {
  const all = readRecentEntries(Number.MAX_SAFE_INTEGER);
  const decisions = all.filter((e) => e.kind === undefined || e.kind === 'decision');
  if (decisions.length === 0) {
    ctx.ui.notify('No routing decisions recorded yet this session.', 'warning');
    return;
  }
  let routedTotal = 0;
  let baselineTotal = 0;
  let priced = 0;
  let incompleteTurns = 0;
  let baselineDrift = false;
  let firstBaseline: string | undefined;
  const byDimension = new Map<string, number>();
  for (const e of decisions) {
    byDimension.set(e.dimension, (byDimension.get(e.dimension) ?? 0) + 1);
    if (e.spendIncomplete) incompleteTurns += 1;
    if (typeof e.routedCost === 'number' && typeof e.baselineCost === 'number') {
      routedTotal += e.routedCost;
      baselineTotal += e.baselineCost;
      priced++;
      if (e.baselineModel) {
        if (!firstBaseline) firstBaseline = e.baselineModel;
        else if (firstBaseline !== e.baselineModel) baselineDrift = true;
      }
    }
  }
    const lastUnified = [...decisions].reverse().find((entry) => entry.unified)?.unified;

    const saved = baselineTotal - routedTotal;
  const pctSaved = baselineTotal > 0 ? (saved / baselineTotal) * 100 : 0;
  const lines = [
    `Routed spend: $${routedTotal.toFixed(4)} across ${priced}/${decisions.length} priced turns`,
    `Baseline spend (${firstBaseline ?? 'n/a'}${baselineDrift ? ', baseline changed mid-session' : ''}): $${baselineTotal.toFixed(4)}`,
    `Saved: $${saved.toFixed(4)} (${pctSaved.toFixed(1)}%)`,
      ...(incompleteTurns > 0
        ? [`${incompleteTurns} turn(s) have incomplete usage — routed spend is a lower bound, not complete savings.`]
        : []),
      ...(lastUnified ? [`Last ranking: ${formatUnifiedSummary(lastUnified)}`] : []),
      '',
      'Turns by task type:',
    ...[...byDimension.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([dim, n]) => `  ${dim.padEnd(11)} ${n}`),
    '',
    "Baseline spend prices the observed tokens at the baseline model's registry rate. " +
      'It is an estimate, not a real bill.',
  ];
  ctx.ui.notify(lines.join('\n'), 'info');
}

async function handleFixCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const [slug, ...registryIds] = splitArgs(args);
  if (!slug || registryIds.length === 0 || registryIds.some((id) => !id.includes('/'))) {
    const msg = 'Usage: /router-fix <bench-slug> <provider/id> [<provider/id>…]';
    ctx.ui.notify(msg, 'error');
    return;
  }
  const store = loadStore();
  if (!store) {
    const msg = 'No benchmark store found. Run /router-sync first.';
    ctx.ui.notify(msg, 'error');
    return;
  }
  const next = addAlias(store, slug, registryIds);
  saveStore(next);
  const msg = `Alias saved: ${slug} -> ${next.aliases[slug].join(', ')}. Re-run /router-sync to apply.`;
  ctx.ui.notify(msg, 'info');
}

type ManualModelCatalogContext = Pick<ExtensionCommandContext, 'modelRegistry' | 'scopedModels'>;
export type ManualModelCompletionUpdater = (ctx: ManualModelCatalogContext) => void;

// A manual pin is an explicit user choice, so its list mirrors Pi's own
// `/model`: session-scoped models when the session is scoped (`--models` /
// `enabledModels`), otherwise every authenticated registry model. The router's
// own allowlist / config-blacklist / session-blacklist / scoped filters are
// deliberately NOT applied here — the whole point of a manual pin is to reach a
// model automatic routing would skip. Only the synthetic `router/*` provider is
// dropped, since `router/auto` is not a pinnable target (`resume` returns to it).
function manualModelList(ctx: ManualModelCatalogContext): Model<any>[] {
  const registryModels = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry?.getAvailable() ?? [];

  return registryModels
    .filter((model) => model.provider !== ROUTER_PROVIDER_ID)
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

function manualModelIds(ctx: ManualModelCatalogContext): string[] {
  return manualModelList(ctx).map((model) => `${model.provider}/${model.id}`);
}

function isFuzzyMatch(searchText: string, prefix: string): boolean {
  const text = searchText.toLowerCase();
  return prefix.trim().toLowerCase().split(/\s+/).every((term) => {
    let cursor = 0;
    for (const char of text) {
      if (char === term[cursor]) cursor++;
      if (cursor === term.length) return true;
    }
    return term.length === 0;
  });
}

function manualModelCompletions(
  ctx: ManualModelCatalogContext,
  prefix: string,
) {
  const entries = [
    { value: 'resume', label: 'resume', description: 'reuse the prior route', search: 'resume prior route auto automatic' },
    ...manualModelList(ctx).map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.id,
      description: model.provider,
      search: `${model.id} ${model.provider} ${model.provider}/${model.id} ${model.name ?? ''}`,
    })),
  ].filter((entry) => isFuzzyMatch(entry.search, prefix));
  return entries.length > 0
    ? entries.map(({ value, label, description }) => ({ value, label, description }))
    : null;
}

async function showManualModelPicker(
  ctx: ExtensionCommandContext,
  session: RouterSession,
): Promise<string | undefined> {
  const resumeModel = {
    provider: ROUTER_PROVIDER_ID,
    id: 'resume',
    name: 'Resume prior route',
  } as Model<any>;
  const models = [resumeModel, ...manualModelList(ctx)];
  const byId = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const current = session.getManualModel();
  const currentModel = current ? byId.get(current) : resumeModel;
  // ModelSelectorComponent is Pi's actual /model picker. It needs ModelRuntime,
  // but the extension API exposes only a read-only registry snapshot; this
  // structural adapter deliberately disables catalogue mutation/refresh.
  const staticRuntime = {
    getAvailableSnapshot: (): readonly Model<any>[] => models,
    getModel: (provider: string, id: string): Model<any> | undefined => byId.get(`${provider}/${id}`),
    getError: (): undefined => undefined,
    refresh: async () => ({ aborted: false, errors: new Map<string, Error>() }),
  };
  const scopedModels = ctx.scopedModels.length > 0
    ? models.map((model) => ({ model }))
    : [];

  return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
    new ModelSelectorComponent(
      tui,
      currentModel,
      staticRuntime as never,
      scopedModels,
      (model) => done(model === resumeModel ? 'resume' : `${model.provider}/${model.id}`),
      () => done(undefined),
    ));
}

async function handleManualCommand(
  args: string,
  ctx: ExtensionCommandContext,
  session: RouterSession,
): Promise<void> {
  const tokens = splitArgs(args);
  if (tokens.length > 1) {
      ctx.ui.notify('Usage: /router-manual [provider/model[:thinking]|resume]', 'error');
    return;
  }

  let selection: string | undefined = tokens[0];
  if (!selection) {
    if (!ctx.hasUI) {
      const current = session.getManualModel() ?? 'none (auto routing)';
      const models = manualModelIds(ctx);
      ctx.ui.notify(
        [`Manual override: ${current}`, '', ...models, '', 'Usage: /router-manual <provider/model[:thinking]|resume>'].join('\n'),
        'info',
      );
      return;
    }
    selection = await showManualModelPicker(ctx, session);
    if (!selection) return;
  }

  if (selection.toLowerCase() === 'resume') {
    const active = session.resumeManual();
    ctx.ui.notify(
      active
        ? 'Manual override off; reusing the prior route for the next turn, then automatic routing resumes.'
        : 'No manual override active; automatic routing continues.',
      'info',
    );
    return;
  }

  if (!resolveManualModel(selection, manualModelList(ctx))) {
    ctx.ui.notify(
      `Model is not routable: ${selection}. Run /router-manual with no argument to choose from the available models.`,
      'error',
    );
    return;
  }

  session.setManualModel(selection);
  ctx.ui.notify(`Manual override: ${selection} for this session. No fallback to other models.`, 'info');
}

async function handleSemiCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const token = splitArgs(args)[0]?.toLowerCase();
  if (token === undefined) {
    ctx.ui.notify(
      `Semi-auto: ${loadConfig().semi ? 'on (ask before model switches)' : 'off'}. Usage: /router-semi [on|off]`,
      'info',
    );
    return;
  }
  if (token !== 'on' && token !== 'off') {
    ctx.ui.notify('Usage: /router-semi [on|off]', 'error');
    return;
  }
  const enabled = token === 'on';
  saveSemi(enabled);
  ctx.ui.notify(
    enabled
      ? 'Semi-auto on: ask before switching away from the last served model.'
      : 'Semi-auto off: route without confirmation.',
    'info',
  );
}

async function handleModelsCommand(ctx: ExtensionCommandContext): Promise<void> {
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
}


export function registerCommands(
  pi: ExtensionAPI,
  session: RouterSession = defaultRouterSession,
): ManualModelCompletionUpdater {
  let manualModelCatalogContext: ManualModelCatalogContext | undefined;
  const updateManualModelCompletionContext: ManualModelCompletionUpdater = (ctx) => {
    manualModelCatalogContext = ctx;
  };

  pi.registerCommand('router-sync', {
    description: 'Fetch fresh benchmark data and update the model routing table',
    handler: safeCommand('/router-sync', (args, ctx) => handleSyncCommand(args, ctx)),
  });

  pi.registerCommand('router-blacklist', {
    description:
      'Manage the model blacklist: /router-blacklist [add|remove <patterns…>] [--save] [clear]',
    handler: safeCommand('/router-blacklist', async (args, ctx: ExtensionCommandContext) => {
      const parsed = parseBlacklistArgs(args);
      switch (parsed.action) {
        case 'show':
          handleBlacklistShow(ctx, session);
          break;
        case 'add':
          handleBlacklistAdd(parsed.patterns, parsed.isSave, ctx, session);
          break;
        case 'remove':
          handleBlacklistRemove(parsed.patterns, parsed.isSave, ctx, session);
          break;
        case 'clear':
          handleBlacklistClear(parsed.extraArgs, ctx, session);
          break;
        default:
          ctx.ui.notify(
            'Usage: /router-blacklist [add|remove <patterns…>] [--save] [clear]',
            'error',
          );
          break;
      }
    }),
  });

  pi.registerCommand('router-manual', {
    description: 'Pin one model for this session: /router-manual [provider/model[:thinking]|resume]',
    getArgumentCompletions: (prefix) => {
      try {
        return manualModelCatalogContext
          ? manualModelCompletions(manualModelCatalogContext, prefix)
          : null;
      } catch {
        return null;
      }
    },
    handler: safeCommand('/router-manual', (args, ctx) => {
      updateManualModelCompletionContext(ctx);
      return handleManualCommand(args, ctx, session);
    }),
  });

  pi.registerCommand('router-semi', {
    description: 'Ask before model switches: /router-semi [on|off]',
    getArgumentCompletions: (prefix) => {
      try {
        const entries = [
          { value: 'on', label: 'on', description: 'ask before model switches' },
          { value: 'off', label: 'off', description: 'route without confirmation' },
        ].filter((entry) => entry.value.startsWith(prefix.trim().toLowerCase()));
        return entries.length > 0 ? entries : null;
      } catch {
        return null;
      }
    },
    handler: safeCommand('/router-semi', (args, ctx) => handleSemiCommand(args, ctx)),
  });

  pi.registerCommand('router-status', {
    description: 'Show pi8 status, freshness, coverage and the last routing decision',
    handler: safeCommand('/router-status', (_args, ctx) => handleStatusCommand(ctx, session)),
  });

  pi.registerCommand('router-why', {
    description: 'Explain which model served the last turn and why it was chosen',
    handler: safeCommand('/router-why', (_args, ctx) => handleWhyCommand(ctx, session)),
  });

    pi.registerCommand('router-report', {
      description: 'Show routed vs baseline spend, percent saved, and turns by task type for this session',
      handler: safeCommand('/router-report', (_args, ctx) => handleReportCommand(ctx)),
    });

    pi.registerCommand('router-preferences', {
      description: 'Show saved routing preferences and whether the last decision applied them',
      handler: safeCommand('/router-preferences', (args, ctx) => handlePreferencesCommand(args, ctx, session)),
    });

  pi.registerCommand('router-fix', {
    description: 'Add registry models to a benchmark alias: /router-fix <bench-slug> <provider/id> [<provider/id>…]',
    handler: safeCommand('/router-fix', (args, ctx) => handleFixCommand(args, ctx)),
  });

  pi.registerCommand('router-models', {
    description: 'Show the `models` allowlist and which registry models it selects',
    handler: safeCommand('/router-models', (_args, ctx) => handleModelsCommand(ctx)),
  });

  return updateManualModelCompletionContext;
}
