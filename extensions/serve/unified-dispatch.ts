/**
 * Reservation of every provider request, and shared-selector recovery inside
 * one prepared provider call. No compaction starts here.
 *
 * A request starts only through a single-use reservation of its action,
 * checked against the revisions that scoring recorded: session, work item,
 * branch, preference profile, authorization and context. Fallbacks and
 * retries reserve again, so a change during a long attempt stops the next
 * request. The selected recovery action is reserved at the atomic abort.
 */
import type { Candidate } from '../types.js';
import { enumerateEffectiveActions, effortRank, overrideAction } from '../routing/features/actions.js';
import { holdsPrompt, parseCandidateKey, type RegistryModelInfo } from '../routing/score/scorer.js';
import { AssignmentLedger, type AssignmentRevisions, type Reservation, type TurnPlan } from '../routing/policy/assignment-transaction.js';
import type { BoundaryAuthorizationV1 } from '../routing/policy/boundary-authorization.js';
import type { AttemptEpoch } from '../routing/policy/pre-output-intervention.js';
import type { SelectionResult } from '../routing/optimization/select.js';
import { resolveUnifiedDecision, type UnifiedTurnInput, type UnifiedTurnOutcome } from './unified-decision.js';

type DecisionOutcome = Extract<UnifiedTurnOutcome, { kind: 'decision' }>;

export interface UnifiedDispatch {
  /** True when a looping attempt may switch to another action before output. */
  readonly recovery: boolean;
  epoch(): Omit<AttemptEpoch, 'attemptId' | 'outputRevision'>;
  reachable(source: string): string[];
  select(source: string, pool: readonly string[], isCurrent: () => boolean, signal: AbortSignal): Promise<SelectionResult>;
  reserve(target: string): { id: string } | undefined;
  /** Reserve and start one request. False means no provider request may start. */
  dispatch(target: string, signal: AbortSignal): boolean;
  /** Release the unused reservation of one failed target, or all recovery state when no target is given. */
  release(target?: string): void;
  /** Take the live assignment as the base of later requests, after a substituted decision replaced it. Recovery stays off. */
  rebase(): void;
}

export interface DispatchHost {
  revisions(): AssignmentRevisions;
  assignmentId(): string;
  /** The boundary authorization that the session records for the live assignment. */
  authorization(): BoundaryAuthorizationV1 | undefined;
}

export interface RecoveryHost {
  input: UnifiedTurnInput;
  candidates(): readonly Candidate[];
  models(): readonly RegistryModelInfo[];
  /** Apply the new authorization and decision only at the atomic abort boundary. */
  commit(outcome: DecisionOutcome, source: string): boolean;
}

interface Base {
  ledger: AssignmentLedger;
  plan: TurnPlan;
  assignmentId: string;
  /** Set only by a recovery reserved at the abort, until its request starts. */
  reservation?: Reservation;
  recovered: boolean;
}

export function createUnifiedDispatch(host: DispatchHost, recoveryHost?: RecoveryHost): UnifiedDispatch {
  let recoveryOn = recoveryHost !== undefined;
  let pending: { outcome: DecisionOutcome; source: string; current: () => boolean; signal: AbortSignal } | undefined;
  const baseOf = (): Base => {
    const ledger = new AssignmentLedger(host.revisions());
    const boundary = host.authorization();
    if (boundary) ledger.boundary = boundary;
    return { ledger, plan: ledger.plan(), assignmentId: host.assignmentId(), recovered: false };
  };
  let base = baseOf();
  const epoch = (): Omit<AttemptEpoch, 'attemptId' | 'outputRevision'> => {
    const revision = host.revisions();
    return {
      sessionGeneration: revision.session,
      workBoundaryId: JSON.stringify([revision.workItemId, revision.branchId, revision.context, host.assignmentId()]),
      boundaryAuthorizationRevision: revision.authorization,
      profileDigest: revision.profileDigest,
    };
  };
  const reachable = (source: string): string[] => {
    if (!recoveryHost) return [];
    const { input } = recoveryHost;
    const parsed = parseCandidateKey(source);
    const sourceModel = `${parsed.provider}/${parsed.id}`;
    const pool = new Map(recoveryHost.candidates().map((candidate) => [candidate.registryId, candidate]));
    return recoveryHost.models().flatMap((model) => {
      const row = pool.get(`${model.provider}/${model.id}`);
      if (!row || !holdsPrompt(row.contextWindow, input.state.estimatedContextTokens)) return [];
      const actions = input.effortOverride
        ? [overrideAction(model, input.effortOverride)].filter((action) => action !== undefined)
        : enumerateEffectiveActions(model);
      return actions.filter((action) => !input.isExcluded(action.key)
        && (action.key === source || action.registryId !== sourceModel
          || effortRank(action.effort) > effortRank(parsed.effort))).map((action) => action.key);
    });
  };
  return {
    get recovery() { return recoveryOn; },
    epoch,
    reachable,
    async select(source, pool, isCurrent, signal) {
      pending = undefined;
      if (!recoveryHost) return { kind: 'stale' };
      const { input } = recoveryHost;
      const sourceIdentity = parseCandidateKey(source);
      const failed = { registryId: `${sourceIdentity.provider}/${sourceIdentity.id}`, ...(sourceIdentity.effort ? { effort: sourceIdentity.effort } : {}) };
      const workItemId = input.state.workItemId!;
      const scope = input.authorizationScope;
      const before = epoch();
      const current = (): boolean => isCurrent() && input.isCurrent()
        && JSON.stringify(epoch()) === JSON.stringify(before);
      const allowed = new Set(pool);
      const outcome = await resolveUnifiedDecision({
        ...input,
        state: {
          ...input.state, boundary: 'rework', rework: { failed, workItemId }, incumbent: undefined,
          friction: [...input.state.friction, { ...failed, workItemId, kind: 'severe-reasoning-loop' }],
          nowMs: Date.now(),
        },
        candidates: recoveryHost.candidates(), registryModels: recoveryHost.models(),
        authorizationScope: { ...scope, assignmentId: `${host.assignmentId()}:recovery`, revision: before.boundaryAuthorizationRevision + 1 },
        isExcluded: (key) => !allowed.has(key) || input.isExcluded(key),
        signal, isCurrent: current,
      }, () => undefined);
      if (outcome.kind !== 'decision') return outcome;
      if (current()) pending = { outcome, source, current, signal };
      return outcome.selection;
    },
    reserve(target) {
      const proposal = pending;
      pending = undefined;
      if (!recoveryHost || !proposal || proposal.signal.aborted || !proposal.current()
        || proposal.outcome.selection.chosen !== target || !reachable(proposal.source).includes(target)) return undefined;
      const ledger = new AssignmentLedger({ ...host.revisions(), authorization: proposal.outcome.authorization.revision });
      ledger.boundary = proposal.outcome.authorization;
      const plan = ledger.plan();
      const reservation = ledger.commitAndReserve(plan, target, proposal.signal);
      if (!reservation || !recoveryHost.commit(proposal.outcome, proposal.source)) return undefined;
      base = { ledger, plan, assignmentId: host.assignmentId(), reservation, recovered: true };
      return { id: reservation.id };
    },
    dispatch(target, signal) {
      const { ledger, plan } = base;
      ledger.bump(host.revisions());
      if (host.assignmentId() !== base.assignmentId || (base.reservation && target !== base.reservation.target)) return false;
      if (base.recovered && !reachable(target).includes(target)) return false;
      // An authorization that names a model without an effort (a user pin) covers each effort of it.
      const allowed = ledger.boundary?.allowedActors;
      const parsed = parseCandidateKey(target);
      const modelKey = `${parsed.provider}/${parsed.id}`;
      const permitted = !allowed || allowed.includes(target) ? target : allowed.includes(modelKey) ? modelKey : undefined;
      const reservation = base.reservation ?? (permitted ? ledger.commitAndReserve(plan, permitted, signal) : undefined);
      if (!reservation || !ledger.dispatch(reservation.id, signal)) return false;
      base.reservation = undefined;
      return true;
    },
    release(target) {
      pending = undefined;
      if (!base.reservation || (target && base.reservation.target !== target)) return;
      base.ledger.release(base.reservation.id);
      base.reservation = undefined;
    },
    rebase() {
      recoveryOn = false;
      pending = undefined;
      base = baseOf();
    },
  };
}
