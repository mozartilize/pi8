/**
 * Production adapter of the unified selector.
 *
 * Legal actions are every supported effort of each routable model, minus
 * excluded action keys. Vision input keeps only vision models when any
 * exists. Context size is not a guard: a smaller-window action stays in the
 * ranking, and `context-preparation.ts` asks Pi to compact for it.
 *
 * The dispatch chain is the ranking restricted to actions whose window holds
 * the current prompt, because Pi cannot compact inside one provider call. It
 * keeps the best-ranked action of each model: another effort of a model that
 * failed for availability does not change that availability. An action whose
 * window cannot hold the prompt is never dispatched in this call.
 */
import { enumerateEffectiveActions, overrideAction, effortRank, type EffectiveAction } from '../routing/features/actions.js';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { rowAtServedEffort } from '../routing/features/model.js';
import { createBoundaryAuthorization, type BoundaryAuthorizationV1 } from '../routing/policy/boundary-authorization.js';
import { isExcludedExecutor } from '../routing/policy/execution-contract.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import type { DecisionStateV1 } from '../routing/features/state.js';
import { composeTaskDemand } from '../routing/features/task-demand.js';
import { WorkerLpAdapter } from '../routing/optimization/lp.js';
import {
  DomainCache,
  PRODUCTION_SOLVER_BUDGET,
  selectByRegret,
  type SelectionCandidate,
  type SelectorPorts,
  type UnifiedDecision,
} from '../routing/optimization/select.js';
import { hasSubstantiveAnswers, validatePreferences, type ValidatedPreferences } from '../routing/preferences/schema.js';
import { buildCandidate, candidateKey, holdsPrompt, type RegistryModelInfo } from '../routing/score/scorer.js';
import { loadPreferenceSnapshot } from '../config.js';
import { isDebugEnabled } from '../host/debuglog.js';
import { fileDomainStore } from './domain-artifact-store.js';
import { FEATURE_NAMES, FEATURE_SCHEMA_DIGEST } from '../routing/features/schema.js';
import type { BenchModel, Candidate, DecisionCause, RoutingDecision, UnifiedActionTrace, UnifiedDecisionMeta } from '../types.js';

let ports: SelectorPorts | undefined;
let domainCache: DomainCache | undefined;

/** One LP worker and domain cache per process; both start on first use. */
function selectorPorts(): SelectorPorts {
  if (!ports) {
    const lp = new WorkerLpAdapter();
    domainCache = new DomainCache(lp, fileDomainStore);
    ports = { lp, domains: domainCache };
  }
  return ports;
}

/**
 * Ends the LP worker thread. An idle worker keeps its message port open, and a
 * one-shot Pi process waits for that port after the session ends.
 */
export async function closeSelectorPorts(): Promise<void> {
  const current = ports;
  ports = undefined;
  domainCache = undefined;
  if (current?.lp instanceof WorkerLpAdapter) await current.lp.close();
}

export type DomainPreparation = 'ready' | 'not-needed' | 'failed';

/**
 * Compiles the domain of the current preferences and stores it, so the first
 * selection of the next process applies them. A profile with no substantive
 * answer needs no compile.
 */
export async function prepareSelectorDomain(): Promise<DomainPreparation> {
  const { profile, status } = readPreferences();
  if (status === 'invalid' || status === 'unsupported-version' || !profile || !hasSubstantiveAnswers(profile)) return 'not-needed';
  selectorPorts();
  const artifact = await domainCache!.compile(profile);
  return artifact ? 'ready' : 'failed';
}

/** A config that cannot be read applies no preferences; it never blocks a turn. */
export function readPreferences(): ValidatedPreferences {
  try {
    return loadPreferenceSnapshot();
  } catch {
    return validatePreferences(undefined);
  }
}

export interface UnifiedTurnInput {
  state: DecisionStateV1;
  cause: DecisionCause;
  authorizationScope: Pick<BoundaryAuthorizationV1, 'boundaryId' | 'workItemId' | 'phase' | 'assignmentId' | 'revision'>;
  workState?: WorkPhaseState;
  /** Routable candidates; their models define the legal action set. */
  candidates: readonly Candidate[];
  registryModels: readonly RegistryModelInfo[];
  rows: readonly BenchModel[];
  /** Action keys that this session excluded. */
  isExcluded: (key: string) => boolean;
  /** Only the candidates' own action keys are legal, as for a pinned model and effort. */
  exactActions?: boolean;
  /** An explicit user thinking level: each model's only legal action is that level. */
  effortOverride?: ModelThinkingLevel;
  /** Thinking minimum of an owned continuation, not of a new phase. */
  minimumEffort?: ModelThinkingLevel;
  incumbentKey?: string;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  /** Test seam for the selector ports. */
  ports?: SelectorPorts;
}

export type UnifiedTurnOutcome =
  | { kind: 'decision'; decision: RoutingDecision; candidates: Candidate[]; authorization: BoundaryAuthorizationV1; selection: UnifiedDecision }
  | { kind: 'cancelled' }
  | { kind: 'stale' };

/** Legal actions with their dispatch candidates, by action key. */
function legalActions(input: UnifiedTurnInput): { selection: SelectionCandidate[]; candidates: Map<string, Candidate> } {
  const pool = new Map(input.candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const modelIds = new Set(input.candidates.map((candidate) => candidate.registryId));
  let models = input.registryModels.filter((model) => modelIds.has(`${model.provider}/${model.id}`));
  if (input.state.needsVision) {
    const vision = models.filter((model) => model.input?.includes('image'));
    if (vision.length > 0) models = vision;
  }
  const selection: SelectionCandidate[] = [];
  const candidates = new Map<string, Candidate>();
  for (const model of models) {
    const registryId = `${model.provider}/${model.id}`;
    // A pin names its own action, which need not be an enumerated representative level.
    const actions: EffectiveAction[] = input.exactActions
      ? input.candidates.filter((candidate) => candidate.registryId === registryId).map((candidate) => ({
        registryId, key: candidateKey(candidate), levels: candidate.effort ? [candidate.effort] : [],
        ...(candidate.effort ? { effort: candidate.effort } : {}),
      }))
      : input.effortOverride
        ? [overrideAction(model, input.effortOverride)].filter((action): action is EffectiveAction => action !== undefined)
        : enumerateEffectiveActions(model);
    for (const action of actions) {
      if (input.isExcluded(action.key)) continue;
      const minimum = input.minimumEffort && overrideAction(model, input.minimumEffort)?.effort;
      if (minimum && effortRank(action.effort) < effortRank(minimum)) continue;
      selection.push({ model, action });
      // The routable candidate keeps its expansion data; an action without one
      // serves at exactly its own effort.
      const known = pool.get(action.key);
      candidates.set(action.key, known ?? { ...buildCandidate(model, rowAtServedEffort(input.rows, action)), effort: action.effort });
    }
  }
  return { selection, candidates };
}

/** Ranked actions that a decision record lists; debug lists every ranked action. */
const TRACE_TOP = 12;

const round = (value: number): number => Math.round(value * 1e5) / 1e5;

/** The first `limit` ranked actions, the chosen action and the incumbent, with the numbers that ordered them. */
function traceActions(
  result: UnifiedDecision,
  chosen: string,
  incumbentKey: string | undefined,
  limit: number,
  scales: ReadonlyMap<string, number> | undefined,
): UnifiedActionTrace[] {
  const byKey = new Map(result.actions.map((action) => [action.features.key, action]));
  const keys = new Set(result.ranking.slice(0, limit));
  for (const key of [chosen, incumbentKey]) if (key && byKey.has(key)) keys.add(key);
  return [...keys].flatMap((key): UnifiedActionTrace[] => {
    const action = byKey.get(key);
    if (!action) return [];
    const { values } = action.features;
    const regret = result.maxRegret?.get(key);
    const { centralUSD, minUSD, maxUSD } = action.spend;
    return [{
      key,
      rank: result.ranking.indexOf(key) + 1,
      capabilityShortfall: round(action.capabilityShortfall),
      ...(regret !== undefined ? { maxRegret: round(regret) } : {}),
      ...(result.theta ? { centralScore: round(result.theta.reduce((sum, weight, index) => sum + weight * (values[index] ?? 0), 0)) } : {}),
      features: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, round(values[index] ?? 0)])),
      ...(centralUSD !== undefined ? {
        costUsd: { central: round(centralUSD), ...(minUSD !== undefined ? { min: round(minUSD) } : {}), ...(maxUSD !== undefined ? { max: round(maxUSD) } : {}) },
      } : {}),
      ...(scales?.has(action.action.registryId) ? { promptTokenScale: round(scales.get(action.action.registryId)!) } : {}),
      evidenceGaps: [...action.evidenceGaps],
    }];
  }).sort((a, b) => a.rank - b.rank);
}

function reasonText(result: UnifiedDecision, chosen: string, preparationTarget: string | undefined): string {
  const method = result.solver === 'exact'
    ? 'minimax regret'
    : `central weights (${result.solverFallbackReason ?? 'fallback'})`;
  const head = `ranked by ${method} among ${result.ranking.length} actions`;
  return preparationTarget ? `${head}; ${preparationTarget} waits for compaction, ${chosen} holds the prompt` : head;
}

/** Classify absent demand without inferring it from an earlier entry's log join key. */
function difficultyMissingReason(input: UnifiedTurnInput): UnifiedDecisionMeta['difficultyMissingReason'] {
  if (input.state.contextAcquisition) return 'collecting-context';
  const work = input.workState;
  if (work?.contextAnswer) return 'direct-answer';
  const contract = work?.contract;
  if (input.state.phase === 'implement' && contract && !contract.rubric
    && (contract.status === 'active' || contract.status === 'executed')) return 'no-rubric';
  if (work?.reasoningHandoff) {
    return work.reasoningHandoff.target === input.state.phase ? 'no-rubric' : 'phase-mismatch';
  }
  return work?.incumbentServes ? 'continuation' : 'no-handoff';
}

/** A new authorization for the legal actions, minus the executors that this work item excluded. */
function authorize(input: UnifiedTurnInput, selection: readonly SelectionCandidate[]): BoundaryAuthorizationV1 {
  return createBoundaryAuthorization(input.authorizationScope, selection.map(({ action }) => action.key),
    input.workState?.workItemId === input.state.workItemId
      ? selection.filter(({ action }) => isExcludedExecutor(input.workState, action.key))
        .map(({ action }) => ({ workItemId: input.authorizationScope.workItemId, phase: 'implement' as const, model: action.key }))
      : []);
}

/**
 * The route that was ranked before a manual pin, without a new ranking. The
 * saved route applies only to the same feature mapping, task type and work.
 * Its chain keeps the saved actions that are legal now and hold the prompt.
 * Returns undefined when one check fails or no saved action remains.
 */
export function restoreUnifiedDecision(input: UnifiedTurnInput, saved: RoutingDecision): {
  kind: 'decision'; decision: RoutingDecision; candidates: Candidate[]; authorization: BoundaryAuthorizationV1;
} | undefined {
  if (!saved.unified || saved.unified.featureSchemaDigest !== FEATURE_SCHEMA_DIGEST
    || saved.dimension !== input.state.phase || input.authorizationScope.phase !== input.state.phase
    || input.authorizationScope.workItemId !== input.state.workItemId) return undefined;
  // A saved work item must be the current one. Without one, the saved entry must be the current entry.
  const savedWork = saved.workContext?.workItemId;
  if (savedWork !== undefined ? savedWork !== input.state.workItemId : saved.intentKey !== input.authorizationScope.boundaryId) {
    return undefined;
  }
  const { selection, candidates } = legalActions(input);
  const authorization = authorize(input, selection);
  const allowed = new Set(authorization.allowedActors);
  const chain = saved.fallbackChain.filter((key) => {
    const candidate = candidates.get(key);
    return allowed.has(key) && candidate !== undefined && holdsPrompt(candidate.contextWindow, input.state.estimatedContextTokens);
  });
  const chosen = chain[0];
  if (!chosen) return undefined;
  const decision: RoutingDecision = {
    dimension: saved.dimension,
    cause: 'resume',
    chosen,
    reason: `restored the route ranked before the manual pin: ${saved.reason}`,
    fallbackChain: chain,
    unified: structuredClone(saved.unified),
    ...(input.incumbentKey ? { switched: input.incumbentKey !== chosen } : {}),
  };
  return { kind: 'decision', decision, candidates: [...candidates.values()], authorization };
}

export async function resolveUnifiedDecision(
  input: UnifiedTurnInput,
  planPreparation: (ranking: readonly string[], chosen: string, candidates: ReadonlyMap<string, Candidate>) => string | undefined,
): Promise<UnifiedTurnOutcome> {
  if (input.authorizationScope.phase !== input.state.phase
    || input.authorizationScope.workItemId !== input.state.workItemId) return { kind: 'stale' };
  const { selection, candidates } = legalActions(input);
  const authorization = authorize(input, selection);
  const preferences = readPreferences();
  const result = await selectByRegret(input.state, selection, input.rows, preferences, input.ports ?? selectorPorts(), {
    signal: input.signal,
    allowedActors: authorization.allowedActors,
    expectedProfileDigest: preferences.digest,
    decisionDeadlineMs: PRODUCTION_SOLVER_BUDGET.deadlineMs,
    isSnapshotCurrent: () => input.isCurrent() && readPreferences().digest === preferences.digest,
  });
  if (result.kind !== 'decision') return result;

  const tokens = input.state.estimatedContextTokens;
  const models = new Set<string>();
  const chain = result.ranking.filter((key) => {
    const candidate = candidates.get(key);
    if (!candidate || !holdsPrompt(candidate.contextWindow, tokens) || models.has(candidate.registryId)) return false;
    models.add(candidate.registryId);
    return true;
  });
  const chosen = chain[0] ?? '';
  const preparationTarget = chosen ? planPreparation(result.ranking, chosen, candidates) : undefined;
  const unified: UnifiedDecisionMeta = {
    solver: result.solver,
    ...(result.solverFallbackReason ? { solverFallbackReason: result.solverFallbackReason } : {}),
    domainStatus: result.domainStatus,
    constraintsEnforced: result.constraintsEnforced,
    ...(result.domainMode ? { domainMode: result.domainMode } : {}),
    ...(result.totalSlack !== undefined ? { totalSlack: result.totalSlack } : {}),
    profileDigest: result.profileDigest,
    ...(result.compiledDomainIdentity ? { compiledDomainIdentity: result.compiledDomainIdentity } : {}),
    featureSchemaDigest: result.featureSchemaDigest,
    ...(result.solver === 'exact' ? { regretScope: 'pool' as const } : {}),
    ranked: result.ranking.length,
    insufficientEvidence: result.insufficientEvidence.length,
    holdingPrompt: chain.length,
    ...(preparationTarget ? { preparationTarget } : {}),
    ...(input.state.difficulty
      ? { difficulty: input.state.difficulty.value, difficultyAxes: input.state.difficulty.axes, difficultySource: input.state.difficulty.source }
      : { difficultyMissingReason: difficultyMissingReason(input) }),
    difficultyBounds: Object.fromEntries(Object.entries(composeTaskDemand(input.state).demand)
      .map(([axis, { lower, upper }]) => [axis, { lower, upper }])) as UnifiedDecisionMeta['difficultyBounds'],
    ...(result.theta ? { theta: result.theta.map(round) } : {}),
    top: traceActions(result, chosen, input.incumbentKey,
      isDebugEnabled() ? result.ranking.length : TRACE_TOP, input.state.promptTokenScales),
  };
  const decision: RoutingDecision = {
    dimension: input.state.phase,
    cause: input.cause,
    chosen,
    reason: chosen ? reasonText(result, chosen, preparationTarget) : 'No routable models: no legal action remains for this request.',
    fallbackChain: chain,
    unified,
    ...(input.incumbentKey ? { switched: input.incumbentKey !== chosen } : {}),
  };
  return { kind: 'decision', decision, candidates: [...candidates.values()], authorization, selection: result };
}
