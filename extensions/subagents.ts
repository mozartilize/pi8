/**
 * Subagent role injection (M3).
 *
 * Roles are injected per spawn: we patch the `subagent` tool call's `model`
 * field in a `tool_call` handler (`event.input` is mutable — see Pi's
 * docs/extensions.md). Nothing is persisted; the routing decision lives and
 * dies with the call.
 *
 * Design rules (from the implementation handoff M3):
 *  - Role → Dimension: researcher→gather, planner→plan, worker→implement, reviewer→review.
 *  - Reviewer must not equal the worker, and not be same-family (independent second opinion).
 *  - Respect user overrides: a role pinned in settings, or an explicit
 *    `model` on the call itself, always wins — we only fill empty slots.
 *  - Only assign models whose provider has credentials: pi-subagents consumes
 *    the model verbatim and hard-fails on an unauthenticated provider.
 *  - NEVER write to settings.json. It is global, cross-project, outlives the
 *    process, and is owned by pi core's lock-protected SettingsManager.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  BenchModel,
  Candidate,
  Dimension,
  Role,
  RoutingDecision,
  ScoreWeights,
  ExtensionContext,
} from './types.js';
import { ROLE_DIMENSIONS } from './types.js';
import { DEFAULT_DIMENSION_WEIGHTS } from './constants.js';
import { activeModels, loadStore } from './store.js';
import { pickBest, candidateKey, type RegistryModelInfo } from './scorer.js';
import { expandModelCandidates } from './provider.js';
import { loadModelFilter } from './allowlist.js';
import { identityKey } from './matcher.js';
import { appendSubagentEscalationContract } from './subagent-escalation.js';

/** Marker so we can distinguish router-authored overrides from user pins. */
export const AUTO_ROUTER_SOURCE = 'pi8';

export const ALL_ROLES: Role[] = ['researcher', 'planner', 'worker', 'reviewer', 'advisor'];

export interface RoleAssignment {
  role: Role;
  dimension: Dimension;
  /** The chosen "provider/id", or undefined if no candidate was routable. */
  model: string | undefined;
  /**
   * Ranked routable models for this role (best first), used at spawn time to
   * skip any model that has since been runtime-blacklisted. Empty for
   * user-pinned roles and when nothing was routable.
   */
  fallbackChain: string[];
  /** True when this slot was filled by the router (vs. left untouched). */
  applied: boolean;
  /** True when a user/project override already owned this slot and was preserved. */
  userPinned: boolean;
  /** Human-readable reason (incl. routing notes). */
  reason: string;
}

// ─── Candidate building (mirrors provider.ts, sans live auth probe) ─────

export interface BuildCandidatesResult {
  candidates: Candidate[];
  skippedUnauthenticated: number;
  skippedNotAllowed: number;
}

/**
 * Join the registry models with their benchmark rows.
 *
 * `isProviderUsable` gates candidates by credentials. This is NOT optional in
 * practice: pi-subagents does *not* validate model availability at spawn time —
 * it runs whatever model it is handed and hard-fails with "No API key found for
 * <provider>". An earlier version of this function deliberately skipped the
 * credential probe and assumed pi-subagents owned the final gate; that
 * assumption was wrong and caused every role to be pinned to the
 * highest-scoring model overall (e.g. `anthropic/claude-opus-*`) even with no
 * anthropic credentials, breaking every subagent run.
 *
 * `isModelAllowed` applies the user's `models` allowlist (see allowlist.ts).
 *
 * When a predicate is omitted we stay permissive (callers that genuinely
 * cannot probe, and unit tests).
 */
export function buildSubagentCandidates(
  registryModels: readonly RegistryModelInfo[],
  benchModels: ReturnType<typeof activeModels>,
  isProviderUsable?: (provider: string) => boolean,
  isModelAllowed?: (registryId: string) => boolean,
): BuildCandidatesResult {
  // Rows are pre-merged per (registryId, effort) by the store; keep the whole
  // list so the effort-aware expansion can emit one candidate per measured,
  // supported effort instead of binding an arbitrary row per model.
  const rowsByModel = new Map<string, BenchModel[]>();
  for (const b of benchModels) {
    const list = rowsByModel.get(b.registryId) ?? [];
    list.push(b);
    rowsByModel.set(b.registryId, list);
  }
  const candidates: Candidate[] = [];
  let skippedUnauthenticated = 0;
  let skippedNotAllowed = 0;
  for (const rm of registryModels) {
    // Never route a subagent to the router itself.
    if (rm.provider === 'router') continue;
    const rid = `${rm.provider}/${rm.id}`;
    // The user allowlist is checked first: an excluded model is a deliberate
    // choice, not a credentials problem.
    if (isModelAllowed && !isModelAllowed(rid)) {
      skippedNotAllowed++;
      continue;
    }
    if (isProviderUsable && !isProviderUsable(rm.provider)) {
      skippedUnauthenticated++;
      continue;
    }
    candidates.push(...expandModelCandidates(rm, rowsByModel.get(rid) ?? []));
  }
  return { candidates, skippedUnauthenticated, skippedNotAllowed };
}

// ─── Reviewer complementarity ───────────────────────────────────────────

/** Same family if the stripped identity key matches (e.g. all claude-opus-*). */
export function sameFamily(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Candidate keys may carry an effort suffix (`provider/id:high`); the
  // effort is a run choice, not family identity, so strip it before the
  // identity comparison — otherwise a worker at max effort would not be
  // recognized as the same model as a candidate at low effort.
  return identityKey(stripThinkingSuffix(a)) === identityKey(stripThinkingSuffix(b));
}

/**
 * Pick a model for each role. Pure: no I/O, no clock.
 *
 * `existingOverrides` lets the caller tell us which slots are already owned by
 * the user (so we preserve them) — pass a map role → { model, source? }.
 */
export interface ExistingOverride {
  model: string;
  /** If present and not equal to AUTO_ROUTER_SOURCE, this is a user/project pin. */
  source?: string;
}

export interface AssignOptions {
  estimatedContextTokens?: number;
  incumbentRegistryId?: string;
  weights?: Partial<Record<Dimension, ScoreWeights>>;
  /** Pre-existing overrides keyed by role; user pins are preserved. */
  existingOverrides?: Partial<Record<Role, ExistingOverride>>;
}

export function computeRoleAssignments(
  candidates: Candidate[],
  opts: AssignOptions = {},
): RoleAssignment[] {
  const weights = opts.weights ?? DEFAULT_DIMENSION_WEIGHTS;
  const assignments: RoleAssignment[] = [];

  // A registry can contain only router/auto (or be unavailable). Keep role
  // refresh advisory and return a stable empty assignment table rather than
  // calling pickBest([]), which cannot produce a decision.
  if (candidates.length === 0) {
    return ALL_ROLES.map((role) => {
      const existing = opts.existingOverrides?.[role];
      const userPinned = !!existing && existing.source !== AUTO_ROUTER_SOURCE;
      return {
        role,
        dimension: ROLE_DIMENSIONS[role],
        model: userPinned ? existing?.model : undefined,
        fallbackChain: [],
        applied: false,
        userPinned,
        reason: 'no routable models',
      };
    });
  }

  // First pass: compute every role's pick.
  const picks: Partial<Record<Role, RoutingDecision>> = {};
  for (const role of ALL_ROLES) {
    const dim = ROLE_DIMENSIONS[role];
    const decision = pickBest(candidates, dim, weights[dim], {
      estimatedContextTokens: opts.estimatedContextTokens ?? 0,
      incumbentRegistryId: opts.incumbentRegistryId,
    });
    picks[role] = decision;
  }

  // Set after the worker branch below, so reviewer complementarity uses the
  // effective worker model even when the worker is user-pinned.
  let effectiveWorkerModel: string | undefined;

  for (const role of ALL_ROLES) {
    const dim = ROLE_DIMENSIONS[role];
    const existing = opts.existingOverrides?.[role];

    // Preserve a user/project override we did not author.
    if (existing && existing.source !== AUTO_ROUTER_SOURCE) {
      assignments.push({
        role,
        dimension: dim,
        model: existing.model,
        fallbackChain: [],
        applied: false,
        userPinned: true,
        reason: 'user override preserved',
      });
      if (role === 'worker') effectiveWorkerModel = existing.model;
      continue;
    }

    let decision = picks[role]!;

    // Reviewer complementarity: never equal the effective worker, and never
    // same-family. The worker may have been user-pinned above.
    if (role === 'reviewer' && effectiveWorkerModel) {
      const workerFamily = effectiveWorkerModel;
      const filtered = candidates.filter(
        (c) => candidateKey(c) !== effectiveWorkerModel && !sameFamily(candidateKey(c), workerFamily),
      );
      if (filtered.length > 0) {
        decision =
          pickBest(filtered, dim, weights[dim], {
            estimatedContextTokens: opts.estimatedContextTokens ?? 0,
            incumbentRegistryId: opts.incumbentRegistryId,
          }) ?? decision;
      } else {
        decision = { ...decision, reason: `${decision.reason}; review fallback: no independent model` };
      }
    }

    assignments.push({
      role,
      dimension: dim,
      model: decision.chosen,
      fallbackChain: decision.fallbackChain,
      applied: true,
      userPinned: false,
      reason: decision.reason,
    });
    if (role === 'worker') effectiveWorkerModel = decision.chosen;
  }

  return assignments;
}

// ─── Settings file I/O (READ ONLY) ──────────────────────────────────────
//
// This module never writes settings. Roles are injected per spawn via the
// `subagent` tool's own `model` option, so nothing is persisted beyond the
// current session. Settings are read only to detect and respect user pins.

/** Resolve the user-scope settings path, matching pi-subagents' own resolution. */
export function resolveUserSettingsPath(agentDir?: string): string {
  const configured = agentDir ?? process.env.PI_CODING_AGENT_DIR;
  const base = configured === '~'
    ? homedir()
    : configured?.startsWith('~/')
      ? join(homedir(), configured.slice(2))
      : configured ?? join(homedir(), '.pi', 'agent');
  return join(base, 'settings.json');
}

/** The config directory name used by pi for project-local config. */
const PI_CONFIG_DIR = '.pi';

/**
 * Resolve the project-level settings path, matching pi-subagents'
 * `getProjectAgentSettingsPath`. Returns null when there is no cwd.
 */
export function resolveProjectSettingsPath(cwd?: string): string | null {
  if (!cwd) return null;
  return join(cwd, PI_CONFIG_DIR, 'settings.json');
}

export interface AgentOverrideEntry {
  model?: string;
  __source?: string;
  [k: string]: unknown;
}

export interface SubagentSettings {
  subagents?: {
    agentOverrides?: Partial<Record<string, AgentOverrideEntry>>;
  };
  [k: string]: unknown;
}

/** Read a settings file, returning a defensive default. */
export function readSettings(path: string): SubagentSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed as SubagentSettings;
  } catch {
    // Corrupt settings: treat as empty rather than crashing the sync.
  }
  return {};
}

// ─── Role model computation (pure, no I/O beyond the bench store) ───────

export interface RoleSyncContext {
  ctx?: ExtensionContext;
  /** Override the settings path (tests). */
  settingsPath?: string;
  estimatedContextTokens?: number;
  /** Pre-existing overrides (already read from settings). */
  existingOverrides?: Partial<Record<Role, ExistingOverride>>;
  /**
   * Credential gate. An injected model is consumed verbatim by pi-subagents,
   * which does not check availability — so an unauthenticated pick becomes a
   * hard spawn failure. Callers with a live registry should always pass this.
   */
  isProviderUsable?: (provider: string) => boolean;
  /** User `models` allowlist. Defaults to the persisted config. */
  isModelAllowed?: (registryId: string) => boolean;
}

/**
 * Compute the routed model for each role.
 *
 * Returns both the full assignment table (for display) and a role → model map
 * containing ONLY the roles the router owns. A role the user pinned in their
 * settings is deliberately absent from the map so spawn-time injection leaves
 * it alone and the user's pin wins.
 */
export function computeRoleModels(
  registryModels: readonly RegistryModelInfo[],
  opts: RoleSyncContext = {},
): { assignments: RoleAssignment[]; roleModels: Map<Role, string>; roleFallbacks: Map<Role, string[]> } {
  const store = loadStore();
  const benchModels = store ? activeModels(store) : [];
  const { candidates } = buildSubagentCandidates(
    registryModels,
    benchModels,
    opts.isProviderUsable,
    opts.isModelAllowed ?? loadModelFilter(),
  );

  // If the caller didn't pass existing overrides, read them from user and
  // project settings (project wins, matching pi-subagents' own precedence).
  const existing = opts.existingOverrides ?? readExistingOverrides(opts.settingsPath, opts.ctx?.cwd);
  const assignments = computeRoleAssignments(candidates, {
    estimatedContextTokens: opts.estimatedContextTokens ?? 0,
    existingOverrides: existing,
  });

  const roleModels = new Map<Role, string>();
  const roleFallbacks = new Map<Role, string[]>();
  for (const a of assignments) {
    // `applied` is false for user-pinned roles and when nothing was routable.
    if (a.applied && a.model) {
      roleModels.set(a.role, a.model);
      roleFallbacks.set(a.role, a.fallbackChain);
    }
  }
  return { assignments, roleModels, roleFallbacks };
}

/**
 * Resolve the concrete model to inject per role at spawn time, skipping any
 * model that has been runtime-blacklisted this session.
 *
 * The role assignment is computed once (at session_start), but a model can be
 * blacklisted later by a failed main-session turn. Picking from each role's
 * ranked chain here keeps a stale top pick (e.g. a model that has since gone
 * dead) from being injected into a subagent spawn.
 */
export function resolveLiveRoleModels(
  roleFallbacks: ReadonlyMap<Role, string[]>,
  isBlacklisted: (registryId: string) => boolean,
): Map<Role, string> {
  const live = new Map<Role, string>();
  for (const [role, chain] of roleFallbacks) {
    const pick = chain.find((id) => !isBlacklisted(id));
    if (pick) live.set(role, pick);
  }
  return live;
}

// ─── Spawn-time injection into the `subagent` tool call ─────────────────

/** Shape of the bits of the subagent tool input we care about. */
interface SpecLike {
  agent?: unknown;
  model?: unknown;
  task?: unknown;
  tasks?: unknown;
  chain?: unknown;
  parallel?: unknown;
  expand?: unknown;
  /** pi-subagents repeats a task spec `count` times. Must be integer >= 1. */
  count?: unknown;
}

/**
 * Read a valid pi-subagents count from a task spec item.
 * Returns the span (>= 1) or null when the count is invalid/unknowable,
 * which fails open rather than establishing ownership.
 */
function readCountSpan(item: unknown): number | null {
  if (!item || typeof item !== 'object') return null;
  const raw = (item as { count?: unknown }).count;
  if (raw === undefined) return 1; // no count = single child
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw;
  return null; // invalid count → fail open
}

export interface SubagentChildSpec {
  /** Stable launch index matched to pi-subagents SingleResult.index, when knowable. */
  childIndex?: number;
  /** Reserved stable-index span; greater than one for bounded dynamic fanout. */
  childIndexSpan?: number;
  /** False after a dynamic fanout whose globally resolved bound is unavailable. */
  stableIndexKnown: boolean;
  /** Stable traversal path retained for diagnostics and test assertions. */
  path: string;
  agent: string;
  role?: Role;
  model?: string;
  routerOwned: boolean;
  /** Task before the router appended its escalation contract. */
  originalTask?: string;
  /**
   * The explicit model requested by the caller before a router-owned session
   * overrode it. Kept for observability/debug logging only.
   */
  requestedModel?: string;
}

export interface InjectedSubagentSpec extends SubagentChildSpec {
  role: Role;
  model: string;
  routerOwned: true;
}

export interface SubagentRoutingTraversal {
  children: SubagentChildSpec[];
  injected: InjectedSubagentSpec[];
}

/** Sentinel value a caller passes as `model` to explicitly opt into routing. */
export const ROUTER_AUTO_SENTINEL = 'router/auto';

export interface SubagentRoutingOptions {
  consumeOverride?: (role: Role, originalTask?: string) => string | undefined;
  appendEscalationContract?: boolean;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as string[]).includes(value);
}

/**
 * Patch a `subagent` tool call in place so each role-targeted spec carries the
 * routed model.
 *
 * Ownership rules (one rule, no override flag):
 *  - `model` omitted → router-owned (injected with the routed concrete model).
 *  - `model: "router/auto"` → sentinel, treated identically to omitted.
 *  - Any other concrete `model` → left unchanged (explicit choices win).
 *  - User/project pins are already absent from `roleModels` so the router
 *    never touches them regardless.
 *
 * Also: walk single specs, `tasks[]`, `chain[]` steps and nested `parallel[]`.
 *
 * Returns every flattened child plus the router-owned injected subset so
 * details.results[] rows can be correlated by stable child index.
 */
export function injectSubagentRoutingWithMetadata(
  input: unknown,
  roleModels: ReadonlyMap<Role, string>,
  opts: SubagentRoutingOptions = {},
): SubagentRoutingTraversal {
  const children: SubagentChildSpec[] = [];
  const injected: InjectedSubagentSpec[] = [];
  if (!input || typeof input !== 'object') return { children, injected };
  let nextChildIndex: number | undefined = 0;

  const visit = (node: unknown, path: string, childIndexSpan: number | null = 1): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const spec = node as SpecLike;

    if (typeof spec.agent === 'string') {
      const stableIndexKnown = nextChildIndex !== undefined && childIndexSpan !== null;
      const childIndex = stableIndexKnown ? nextChildIndex : undefined;
      if (nextChildIndex !== undefined && childIndexSpan !== null) {
        nextChildIndex += childIndexSpan;
      } else {
        nextChildIndex = undefined;
      }
      const role = isRole(spec.agent) ? spec.agent : undefined;
      const originalTask = typeof spec.task === 'string' ? spec.task : undefined;
      const requestedModel = typeof spec.model === 'string' ? spec.model : undefined;
      let routerOwned = false;

      if (role) {
        // Membership in the base map establishes router ownership. A user pin
        // is absent, so even a stale override can never replace it.
        // Ownership: omitted model or explicit `router/auto` sentinel → owned;
        // any other concrete model → caller's choice wins.
        const baseModel = roleModels.get(role);
        const callerOptedIntoRouting =
          requestedModel === undefined || requestedModel === ROUTER_AUTO_SENTINEL;
        if (baseModel && callerOptedIntoRouting) {
          const override = opts.consumeOverride?.(role, originalTask);
          const model = override ?? baseModel;
          (spec as Record<string, unknown>).model = model;
          if (
            stableIndexKnown &&
            originalTask !== undefined &&
            opts.appendEscalationContract !== false
          ) {
            (spec as Record<string, unknown>).task = appendSubagentEscalationContract(originalTask);
          }
          const owned: InjectedSubagentSpec = {
            ...(childIndex !== undefined ? { childIndex } : {}),
            ...(childIndexSpan !== null && childIndexSpan !== 1 ? { childIndexSpan } : {}),
            stableIndexKnown,
            path,
            agent: spec.agent,
            role,
            model,
            routerOwned: true,
            originalTask,
            ...(requestedModel !== undefined ? { requestedModel } : {}),
          };
          children.push(owned);
          injected.push(owned);
          routerOwned = true;
        }
      }

      if (!routerOwned) {
        children.push({
          ...(childIndex !== undefined ? { childIndex } : {}),
          ...(childIndexSpan !== null && childIndexSpan !== 1 ? { childIndexSpan } : {}),
          stableIndexKnown,
          path,
          agent: spec.agent,
          role,
          model: requestedModel,
          routerOwned: false,
          originalTask,
        });
      }
    }

    const visitContainer = (value: unknown, key: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          const span = readCountSpan(item);
          visit(item, `${path}.${key}[${index}]`, span);
        });
        return;
      }
      // Dynamic fanout stores one child template directly in `parallel` and
      // reserves expand.maxItems stable indexes for its materialized children.
      if (key === 'parallel' && value && typeof value === 'object') {
        const maxItems = (spec.expand as { maxItems?: unknown } | null | undefined)?.maxItems;
        const span = typeof maxItems === 'number' && Number.isInteger(maxItems) && maxItems >= 0
          ? maxItems
          : null;
        visit(value, `${path}.${key}`, span);
      }
    };
    visitContainer(spec.tasks, 'tasks');
    visitContainer(spec.chain, 'chain');
    visitContainer(spec.parallel, 'parallel');
  };

  visit(input, '$');
  return { children, injected };
}

// ─── Thinking-level suffix stripping ───────────────────────────────────

/** Thinking-level suffixes pi-subagents appends to an injected model id. */
const THINKING_SUFFIXES = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Strip a trailing `:<thinking-level>` so `provider/id:high` collapses to the
 * bare `provider/id` that the registry, allowlist, and blacklist all key on. A
 * colon whose suffix is not a known thinking level is left intact.
 */
export function stripThinkingSuffix(model: string): string {
  const idx = model.lastIndexOf(':');
  if (idx === -1) return model;
  return THINKING_SUFFIXES.has(model.slice(idx + 1)) ? model.slice(0, idx) : model;
}

/** Read current override source tags from user and project settings. */
export function readExistingOverrides(
  settingsPath?: string,
  cwd?: string,
): Partial<Record<Role, ExistingOverride>> {
  const result: Partial<Record<Role, ExistingOverride>> = {};

  // User scope: read first, project overrides take precedence.
  const userPath = settingsPath ?? resolveUserSettingsPath();
  const userSettings = readSettings(userPath);
  const userOverrides = userSettings.subagents?.agentOverrides ?? {};
  for (const role of ALL_ROLES) {
    const entry = userOverrides[role];
    if (entry && entry.model) {
      result[role] = { model: entry.model, source: entry.__source };
    }
  }

  // Project scope: same shape, wins when present (matches pi-subagents).
  const projectPath = resolveProjectSettingsPath(cwd);
  if (projectPath) {
    const projectSettings = readSettings(projectPath);
    const projectOverrides = projectSettings.subagents?.agentOverrides ?? {};
    for (const role of ALL_ROLES) {
      const entry = projectOverrides[role];
      if (entry && entry.model) {
        result[role] = { model: entry.model, source: entry.__source };
      }
    }
  }

  return result;
}
