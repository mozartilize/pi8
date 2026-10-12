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
import { WorkerLpAdapter } from '../routing/optimization/lp.js';
import {
  DomainCache,
  PRODUCTION_SOLVER_BUDGET,
  selectByRegret,
  type SelectionCandidate,
  type SelectorPorts,
  type UnifiedDecision,
} from '../routing/optimization/select.js';
import { validatePreferences, type ValidatedPreferences } from '../routing/preferences/schema.js';
import { buildCandidate, candidateKey, holdsPrompt, type RegistryModelInfo } from '../routing/score/scorer.js';
import { loadPreferenceSnapshot } from '../config.js';
import type { BenchModel, Candidate, DecisionCause, RoutingDecision, UnifiedDecisionMeta } from '../types.js';

let ports: SelectorPorts | undefined;

/** One LP worker and domain cache per process; both start on first use. */
function selectorPorts(): SelectorPorts {
  if (!ports) {
    const lp = new WorkerLpAdapter();
    ports = { lp, domains: new DomainCache(lp) };
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
  if (current?.lp instanceof WorkerLpAdapter) await current.lp.close();
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

function reasonText(result: UnifiedDecision, chosen: string, preparationTarget: string | undefined): string {
  const method = result.solver === 'exact'
    ? 'minimax regret'
    : `central weights (${result.solverFallbackReason ?? 'fallback'})`;
  const head = `ranked by ${method} among ${result.ranking.length} actions`;
  return preparationTarget ? `${head}; ${preparationTarget} waits for compaction, ${chosen} holds the prompt` : head;
}

export async function resolveUnifiedDecision(
  input: UnifiedTurnInput,
  planPreparation: (ranking: readonly string[], chosen: string, candidates: ReadonlyMap<string, Candidate>) => string | undefined,
): Promise<UnifiedTurnOutcome> {
  if (input.authorizationScope.phase !== input.state.phase
    || input.authorizationScope.workItemId !== input.state.workItemId) return { kind: 'stale' };
  const { selection, candidates } = legalActions(input);
  const authorization = createBoundaryAuthorization(input.authorizationScope, selection.map(({ action }) => action.key),
    input.workState?.workItemId === input.state.workItemId
      ? selection.filter(({ action }) => isExcludedExecutor(input.workState, action.key))
        .map(({ action }) => ({ workItemId: input.authorizationScope.workItemId, phase: 'implement' as const, model: action.key }))
      : []);
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
    profileDigest: result.profileDigest,
    ...(result.compiledDomainIdentity ? { compiledDomainIdentity: result.compiledDomainIdentity } : {}),
    featureSchemaDigest: result.featureSchemaDigest,
    ranked: result.ranking.length,
    insufficientEvidence: result.insufficientEvidence.length,
    holdingPrompt: chain.length,
    ...(preparationTarget ? { preparationTarget } : {}),
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
