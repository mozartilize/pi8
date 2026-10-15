/**
 * The single automatic ranking API of the unified router.
 * Every authorized action enters one comparison pool. Exact minimax regret,
 * or its labeled central fallback, ranks that whole pool. Capability
 * shortfall and evidence gaps are diagnostics: they never filter, group,
 * rank or break ties. Capability and uncertainty enter only as features and
 * their intervals.
 *
 * Inputs are legal actions only: hard guards (pins, availability,
 * blacklists, ownership, impossible modality) run before this call and are
 * never traded against utility. The selector writes no session state.
 *
 * Every result passes one final check: cancellation wins over staleness,
 * and staleness wins over any computed result. A stale result names no
 * action, so a caller cannot dispatch it.
 */
import { candidateFeatures, type ActionFeatures } from '../features/candidate.js';
import type { EffectiveAction } from '../features/actions.js';
import type { DecisionStateV1, Immutable } from '../features/state.js';
import { FEATURE_SCHEMA_DIGEST } from '../features/schema.js';
import { hasSubstantiveAnswers, preferenceProfileDigest, type UserRoutingPreferencesV1, type ValidatedPreferences } from '../preferences/schema.js';
import type { BenchModel } from '../../types.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import {
  artifactMatches,
  compileDomainArtifact,
  domainIdentity,
  thetaBaseArtifact,
  type DomainArtifact,
} from './domain.js';
import { LpCancelledError, LpTimeoutError, LpVerificationError, type LPAdapter } from './lp.js';
import { checkDomain, DecisionProblemError, partitionDecisionProblem, type SelectableAction } from './compile.js';
import { centralChoice, solveMinimaxRegret } from './minimax.js';
import { THETA0 } from './weights.js';

export type DomainStatus = 'ready' | 'domain-not-ready' | 'domain-error' | 'unsupported-version';
export type SolverFallbackReason =
  | 'timeout' | 'spike-pair-cap' | 'numerical' | 'no-solver'
  | 'domain-not-ready' | 'domain-error' | 'unsupported-version'
  | 'invalid-features';

/**
 * Production selection budget: 500 ms in total, with no pair cap. Selection
 * runs before each routed request, so this deadline is the most latency it can
 * add. In recorded samples with a preference domain, the allowlisted pool
 * solved exactly in 15 of 15 runs. A timeout uses the labeled central fallback.
 */
export const PRODUCTION_SOLVER_BUDGET = Object.freeze({ deadlineMs: 500 });

export interface SelectionCandidate {
  model: RegistryModelInfo;
  action: EffectiveAction;
}

export interface UnifiedDecision {
  kind: 'decision';
  solver: 'exact' | 'fallback-central' | 'no-feasible-action';
  solverFallbackReason?: SolverFallbackReason;
  domainStatus: DomainStatus;
  /** False when user answers exist but were not applied. */
  constraintsEnforced: boolean;
  /** Weight-domain mode that ordered this pick. Absent when no artifact was applied. */
  domainMode?: DomainArtifact['domain']['mode'];
  /** Minimum total slack when the domain used uniform slack. */
  totalSlack?: number;
  /** Absent only for `no-feasible-action`. */
  chosen?: string;
  /** Every legal action, best first. Operational fallback keeps all of them. */
  ranking: string[];
  /**
   * Diagnostic: actions without evidence for a required quality axis. They
   * compete in the same pool; their missing quality is an uncertainty interval.
   */
  insufficientEvidence: string[];
  /** Diagnostic: true when no action had evidence for every required axis. */
  allInsufficient: boolean;
  /**
   * Diagnostic: actions whose feature vector is malformed or whose key is
   * duplicated. They stay at the end of the ranking, in key order, so they
   * remain in the fallback chain; the solver does not compare them.
   */
  invalidActions?: string[];
  /** Exact max regret of every action against the whole pool. Absent for a central fallback. */
  maxRegret?: ReadonlyMap<string, number>;
  /** Weight vector of a central fallback. */
  theta?: readonly number[];
  profileDigest: string;
  compiledDomainIdentity?: string;
  featureSchemaDigest: string;
  actions: ActionFeatures[];
}

export type SelectionResult = UnifiedDecision | { kind: 'cancelled' } | { kind: 'stale' };

export interface DomainLookup {
  /** The artifact stored under an identity. The selector validates it; a lookup is not trusted. */
  lookup(identity: string): DomainArtifact | undefined;
  /** True when the last compile of this identity failed. */
  failed?(identity: string): boolean;
  /** Ask for a compile of this profile; must not block the selection. */
  request?(profile: UserRoutingPreferencesV1): void;
}

export interface SelectorPorts {
  lp: LPAdapter;
  domains: DomainLookup;
}

export interface SelectControls {
  signal?: AbortSignal;
  /** Permission snapshot for this work item, phase and assignment. Not a quality threshold. */
  allowedActors?: readonly string[];
  /** Digest of the profile snapshot the caller planned with. */
  expectedProfileDigest: string;
  /** Total budget: queue, domain lookup, LP and verification. */
  decisionDeadlineMs: number;
  /** Live host check of the planning snapshot. */
  isSnapshotCurrent?: () => boolean;
  /** Spike-only pair cap; absent means no cap. */
  pairCap?: number;
}

/** Keeps compiled artifacts between processes. A read result is not trusted. */
export interface DomainStore {
  read(identity: string): DomainArtifact | undefined;
  write(artifact: DomainArtifact): void;
}

/**
 * Compiles domain artifacts on request and keeps them by identity. The
 * artifact is one immutable object, so the domain and its representative are
 * replaced together.
 */
export class DomainCache implements DomainLookup {
  private readonly ready = new Map<string, DomainArtifact>();
  private readonly errors = new Set<string>();
  private readonly inFlight = new Map<string, Promise<DomainArtifact | undefined>>();

  private readonly probed = new Set<string>();

  constructor(private readonly lp: LPAdapter, private readonly store?: DomainStore) {}

  lookup(identity: string): DomainArtifact | undefined {
    const known = this.ready.get(identity);
    if (known || !this.store || this.probed.has(identity)) return known;
    // One read per identity: a stored artifact is checked by the selector, not here.
    this.probed.add(identity);
    try {
      const stored = this.store.read(identity);
      if (stored) this.ready.set(identity, stored);
      return stored;
    } catch {
      return undefined;
    }
  }

  failed(identity: string): boolean {
    return this.errors.has(identity);
  }

  request(profile: UserRoutingPreferencesV1): void {
    void this.compile(profile);
  }

  compile(profile: UserRoutingPreferencesV1): Promise<DomainArtifact | undefined> {
    const identity = domainIdentity(profile);
    const ready = this.ready.get(identity);
    if (ready && artifactMatches(ready, profile, preferenceProfileDigest(profile))) return Promise.resolve(ready);
    // A rejected disk artifact must not prevent compilation or remain visible during it.
    this.ready.delete(identity);
    const running = this.inFlight.get(identity);
    if (running) return running;
    const task = compileDomainArtifact(profile, this.lp)
      .then((artifact) => {
        this.ready.set(identity, artifact);
        this.errors.delete(identity);
        try { this.store?.write(artifact); } catch { /* a missing store only costs the next process a compile */ }
        return artifact;
      })
      .catch(() => {
        this.errors.add(identity);
        return undefined;
      })
      .finally(() => this.inFlight.delete(identity));
    this.inFlight.set(identity, task);
    return task;
  }
}

const toSelectable = (features: ActionFeatures): SelectableAction => ({
  features: features.features,
  ...(features.spend.priceKnown ? { centralUsd: features.spend.centralUSD } : {}),
});

function classifySolverFailure(error: unknown): SolverFallbackReason {
  if (error instanceof LpTimeoutError) return 'timeout';
  if (error instanceof LpVerificationError) return 'numerical';
  return 'no-solver';
}

export async function selectByRegret(
  state: DecisionStateV1,
  candidates: readonly SelectionCandidate[],
  rows: readonly BenchModel[],
  preferences: Immutable<Pick<ValidatedPreferences, 'status' | 'profile' | 'digest'>>,
  ports: SelectorPorts,
  controls: SelectControls,
): Promise<SelectionResult> {
  const deadlineAt = performance.now() + controls.decisionDeadlineMs;
  const finish = (result: SelectionResult): SelectionResult =>
    controls.signal?.aborted ? { kind: 'cancelled' }
      : controls.isSnapshotCurrent && !controls.isSnapshotCurrent() ? { kind: 'stale' }
        : result;

  if (controls.signal?.aborted) return { kind: 'cancelled' };
  if (preferences.digest !== controls.expectedProfileDigest) return finish({ kind: 'stale' });
  if (controls.isSnapshotCurrent && !controls.isSnapshotCurrent()) return finish({ kind: 'stale' });

  const allowed = controls.allowedActors === undefined ? undefined : new Set(controls.allowedActors);
  const actions = candidates
    .filter((candidate) => !allowed || allowed.has(candidate.action.key))
    .map((candidate) => candidateFeatures(state, candidate.model, candidate.action, rows));
  const { problem, invalid } = partitionDecisionProblem(actions.map(toSelectable));
  const invalidActions = invalid.map((entry) => entry.key);
  const withInvalid = (ranking: readonly string[]): string[] => [...ranking, ...invalidActions];
  const insufficientEvidence = actions.filter((features) => features.evidenceGaps.length > 0)
    .map((features) => features.features.key).sort();
  const allInsufficient = actions.length > 0 && insufficientEvidence.length === actions.length;
  const base = {
    kind: 'decision' as const,
    profileDigest: preferences.digest,
    featureSchemaDigest: FEATURE_SCHEMA_DIGEST,
    actions,
    insufficientEvidence,
    allInsufficient,
    ...(invalidActions.length > 0 ? { invalidActions } : {}),
  };

  const domainBinding = (compiled: DomainArtifact | undefined): Pick<UnifiedDecision, 'domainMode' | 'totalSlack'> => {
    if (!compiled) return {};
    return {
      domainMode: compiled.domain.mode,
      ...(compiled.domain.mode === 'min-slack' ? { totalSlack: compiled.domain.totalSlack } : {}),
    };
  };
  const central = (
    reason: SolverFallbackReason,
    domainStatus: DomainStatus,
    theta: readonly number[],
    constraintsEnforced: boolean,
    compiled?: DomainArtifact,
  ): UnifiedDecision => {
    const { ranking } = centralChoice(problem, theta);
    const full = withInvalid(ranking);
    return {
      ...base, solver: 'fallback-central', solverFallbackReason: reason, domainStatus, constraintsEnforced,
      chosen: full[0], ranking: full, theta,
      ...(compiled ? { compiledDomainIdentity: compiled.identity, ...domainBinding(compiled) } : {}),
    };
  };

  // An invalid or unsupported profile is never applied, and never reported as exact.
  const domainStatus: DomainStatus = preferences.status === 'unsupported-version' ? 'unsupported-version'
    : preferences.status === 'invalid' ? 'domain-error' : 'ready';
  const profile = preferences.profile;
  let artifact: DomainArtifact | undefined;
  let notReady: { reason: SolverFallbackReason; status: DomainStatus } | undefined;
  if (domainStatus !== 'ready' || !profile) {
    notReady = { reason: domainStatus === 'unsupported-version' ? 'unsupported-version' : 'domain-error', status: domainStatus === 'ready' ? 'domain-error' : domainStatus };
  } else if (!hasSubstantiveAnswers(profile)) {
    // Exact ThetaBase is legal only when there is no constraint to apply.
    artifact = thetaBaseArtifact(profile);
  } else {
    const identity = domainIdentity(profile);
    const stored = ports.domains.lookup(identity);
    if (artifactMatches(stored, profile, controls.expectedProfileDigest)) {
      artifact = stored;
    } else {
      const failed = ports.domains.failed?.(identity) === true;
      notReady = failed ? { reason: 'domain-error', status: 'domain-error' } : { reason: 'domain-not-ready', status: 'domain-not-ready' };
      if (!failed) ports.domains.request?.(profile);
    }
  }

  if (actions.length === 0) {
    return finish({
      ...base, solver: 'no-feasible-action', domainStatus: notReady?.status ?? 'ready',
      constraintsEnforced: artifact !== undefined, ranking: [],
      ...domainBinding(artifact),
    });
  }
  if (problem.actions.length === 0) {
    // Every action is invalid: no numbers to compare. Keep all of them in key order.
    return finish(central('invalid-features', notReady?.status ?? 'ready', THETA0, false));
  }
  if (artifact) {
    try {
      checkDomain(problem, artifact.domain);
    } catch (error) {
      if (!(error instanceof DecisionProblemError)) throw error;
      // A domain that leaves the base bounds is not applied: its representative is not trusted either.
      artifact = undefined;
      notReady = { reason: 'domain-error', status: 'domain-error' };
    }
  }
  if (!artifact) {
    // Answers exist but their constraints are not applied: THETA0 inside ThetaBase, labeled unenforced.
    return finish(central(notReady!.reason, notReady!.status, THETA0, false));
  }
  const enforced = true;
  const size = problem.actions.length;
  if (controls.pairCap !== undefined && size * (size - 1) > controls.pairCap) {
    return finish(central('spike-pair-cap', 'ready', artifact.thetaRepresentative, enforced, artifact));
  }
  try {
    const exact = await solveMinimaxRegret(problem, artifact.domain, ports.lp, { signal: controls.signal, deadlineAt });
    if (controls.signal?.aborted) return { kind: 'cancelled' };
    return finish({
      ...base, solver: 'exact', domainStatus: 'ready', constraintsEnforced: enforced,
      chosen: exact.chosen, ranking: withInvalid(exact.ranking), maxRegret: exact.maxRegret,
      compiledDomainIdentity: artifact.identity, ...domainBinding(artifact),
    });
  } catch (error) {
    if (error instanceof LpCancelledError || controls.signal?.aborted) return { kind: 'cancelled' };
    return finish(central(classifySolverFailure(error), 'ready', artifact.thetaRepresentative, enforced, artifact));
  }
}
