/**
 * The single automatic ranking API of the unified router.
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
import type { DecisionStateV1 } from '../features/state.js';
import { FEATURE_SCHEMA_DIGEST } from '../features/schema.js';
import { hasSubstantiveAnswers, type UserRoutingPreferencesV1, type ValidatedPreferences } from '../preferences/schema.js';
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
import { centralChoice, solveMinimaxRegret, type SelectableAction } from './regret.js';
import { THETA0 } from './weights.js';

export type DomainStatus = 'ready' | 'domain-not-ready' | 'domain-error' | 'unsupported-version';
export type SolverFallbackReason =
  | 'timeout' | 'spike-pair-cap' | 'numerical' | 'no-solver'
  | 'domain-not-ready' | 'domain-error' | 'unsupported-version';

/** Spike parameters for solver measurement only; not approved production limits. */
export const SPIKE_SOLVER_BUDGET = Object.freeze({ deadlineMs: 200, pairCap: 4096 });

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
  /** Absent only for `no-feasible-action`. */
  chosen?: string;
  /**
   * Every legal action, best first. Operational fallback keeps all of them.
   * Actions without evidence for the phase's required axes come last.
   */
  ranking: string[];
  /** Actions in the ranking tail for lack of evidence. They were not compared by regret. */
  insufficientEvidence: string[];
  /** True when no action had the required evidence, so all were compared. */
  allInsufficient: boolean;
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
  /** Digest of the profile snapshot the caller planned with. */
  expectedProfileDigest: string;
  /** Total budget: queue, domain lookup, LP and verification. */
  decisionDeadlineMs: number;
  /** Live host check of the planning snapshot. */
  isSnapshotCurrent?: () => boolean;
  /** Spike-only pair cap; absent means no cap. */
  pairCap?: number;
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

  constructor(private readonly lp: LPAdapter) {}

  lookup(identity: string): DomainArtifact | undefined {
    return this.ready.get(identity);
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
    if (ready) return Promise.resolve(ready);
    const running = this.inFlight.get(identity);
    if (running) return running;
    const task = compileDomainArtifact(profile, this.lp)
      .then((artifact) => {
        this.ready.set(identity, artifact);
        this.errors.delete(identity);
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
  preferences: Pick<ValidatedPreferences, 'status' | 'profile' | 'digest'>,
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

  const actions = candidates.map((candidate) => candidateFeatures(state, candidate.model, candidate.action, rows));
  // A model without evidence for the required axes stays callable but is not compared.
  const withEvidence = actions.filter((features) => features.evidenceGaps.length === 0);
  const allInsufficient = actions.length > 0 && withEvidence.length === 0;
  const compared = allInsufficient ? actions : withEvidence;
  const tail = allInsufficient ? [] : actions.filter((features) => features.evidenceGaps.length > 0);
  const selectable = compared.map(toSelectable);
  const tailSelectable = tail.map(toSelectable);
  const insufficientEvidence = tail.map((features) => features.features.key).sort();
  const withTail = (ranking: readonly string[], theta: readonly number[]): string[] =>
    [...ranking, ...(tail.length > 0 ? centralChoice(tailSelectable, theta).ranking : [])];
  const base = {
    kind: 'decision' as const,
    profileDigest: preferences.digest,
    featureSchemaDigest: FEATURE_SCHEMA_DIGEST,
    actions,
    insufficientEvidence,
    allInsufficient,
  };

  const central = (
    reason: SolverFallbackReason,
    domainStatus: DomainStatus,
    theta: readonly number[],
    constraintsEnforced: boolean,
    compiledDomainIdentity?: string,
  ): UnifiedDecision => {
    const { chosen, ranking } = centralChoice(selectable, theta);
    return {
      ...base, solver: 'fallback-central', solverFallbackReason: reason, domainStatus, constraintsEnforced,
      chosen, ranking: withTail(ranking, theta), theta, ...(compiledDomainIdentity ? { compiledDomainIdentity } : {}),
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
    });
  }
  if (!artifact) {
    // Answers exist but their constraints are not applied: THETA0 inside ThetaBase, labeled unenforced.
    return finish(central(notReady!.reason, notReady!.status, THETA0, false));
  }
  const enforced = true;
  if (controls.pairCap !== undefined && compared.length * (compared.length - 1) > controls.pairCap) {
    return finish(central('spike-pair-cap', 'ready', artifact.thetaRepresentative, enforced, artifact.identity));
  }
  try {
    const exact = await solveMinimaxRegret(selectable, artifact.domain, ports.lp, { signal: controls.signal, deadlineAt });
    if (controls.signal?.aborted) return { kind: 'cancelled' };
    return finish({
      ...base, solver: 'exact', domainStatus: 'ready', constraintsEnforced: enforced,
      chosen: exact.chosen, ranking: withTail(exact.ranking, artifact.thetaRepresentative), maxRegret: exact.maxRegret, compiledDomainIdentity: artifact.identity,
    });
  } catch (error) {
    if (error instanceof LpCancelledError || controls.signal?.aborted) return { kind: 'cancelled' };
    return finish(central(classifySolverFailure(error), 'ready', artifact.thetaRepresentative, enforced, artifact.identity));
  }
}
