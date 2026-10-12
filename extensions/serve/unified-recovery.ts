/** Shared-selector recovery inside one prepared provider call. No compaction starts here. */
import type { Candidate } from '../types.js';
import { enumerateEffectiveActions, effortRank, overrideAction } from '../routing/features/actions.js';
import { holdsPrompt, parseCandidateKey, type RegistryModelInfo } from '../routing/score/scorer.js';
import { AssignmentLedger, type AssignmentRevisions, type Reservation } from '../routing/policy/assignment-transaction.js';
import type { AttemptEpoch } from '../routing/policy/pre-output-intervention.js';
import type { SelectionResult } from '../routing/optimization/select.js';
import { resolveUnifiedDecision, type UnifiedTurnInput, type UnifiedTurnOutcome } from './unified-decision.js';

type DecisionOutcome = Extract<UnifiedTurnOutcome, { kind: 'decision' }>;

export interface PreOutputAdapter {
  epoch(): Omit<AttemptEpoch, 'attemptId' | 'outputRevision'>;
  reachable(source: string): string[];
  select(source: string, pool: readonly string[], isCurrent: () => boolean, signal: AbortSignal): Promise<SelectionResult>;
  reserve(target: string): { id: string } | undefined;
  dispatch(target: string, signal: AbortSignal): boolean;
  /** Release one failed target's reservation, or all recovery state when no target is given. */
  release(target?: string): void;
}

export interface UnifiedRecoveryHost {
  input: UnifiedTurnInput;
  candidates(): readonly Candidate[];
  models(): readonly RegistryModelInfo[];
  revisions(): AssignmentRevisions;
  assignmentId(): string;
  /** Apply the new authorization and decision only at the atomic abort boundary. */
  commit(outcome: DecisionOutcome, source: string): boolean;
}

/** A reservation belongs to the selected action, not another action of the same model. */
export function createUnifiedRecovery(host: UnifiedRecoveryHost): PreOutputAdapter {
  let pending: { outcome: DecisionOutcome; source: string; current: () => boolean; signal: AbortSignal } | undefined;
  let reserved: { ledger: AssignmentLedger; reservation?: Reservation; revisions: AssignmentRevisions; assignmentId: string } | undefined;
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
    const parsed = parseCandidateKey(source);
    const sourceModel = `${parsed.provider}/${parsed.id}`;
    const pool = new Map(host.candidates().map((candidate) => [candidate.registryId, candidate]));
    return host.models().flatMap((model) => {
      const row = pool.get(`${model.provider}/${model.id}`);
      if (!row || !holdsPrompt(row.contextWindow, host.input.state.estimatedContextTokens)) return [];
      const actions = host.input.effortOverride
        ? [overrideAction(model, host.input.effortOverride)].filter((action) => action !== undefined)
        : enumerateEffectiveActions(model);
      return actions.filter((action) => !host.input.isExcluded(action.key)
        && (action.key === source || action.registryId !== sourceModel
          || effortRank(action.effort) > effortRank(parsed.effort))).map((action) => action.key);
    });
  };
  return {
    epoch,
    reachable,
    async select(source, pool, isCurrent, signal) {
      pending = undefined;
      const sourceIdentity = parseCandidateKey(source);
      const failed = { registryId: `${sourceIdentity.provider}/${sourceIdentity.id}`, ...(sourceIdentity.effort ? { effort: sourceIdentity.effort } : {}) };
      const workItemId = host.input.state.workItemId!;
      const scope = host.input.authorizationScope;
      const before = epoch();
      const current = (): boolean => isCurrent() && host.input.isCurrent()
        && JSON.stringify(epoch()) === JSON.stringify(before);
      const allowed = new Set(pool);
      const outcome = await resolveUnifiedDecision({
        ...host.input,
        state: {
          ...host.input.state, boundary: 'rework', rework: { failed, workItemId }, incumbent: undefined,
          friction: [...host.input.state.friction, { ...failed, workItemId, kind: 'severe-reasoning-loop' }],
          nowMs: Date.now(),
        },
        candidates: host.candidates(), registryModels: host.models(),
        authorizationScope: { ...scope, assignmentId: `${host.assignmentId()}:recovery`, revision: before.boundaryAuthorizationRevision + 1 },
        isExcluded: (key) => !allowed.has(key) || host.input.isExcluded(key),
        signal, isCurrent: current,
      }, () => undefined);
      if (outcome.kind !== 'decision') return outcome;
      if (current()) pending = { outcome, source, current, signal };
      return outcome.selection;
    },
    reserve(target) {
      const proposal = pending;
      pending = undefined;
      if (!proposal || proposal.signal.aborted || !proposal.current()
        || proposal.outcome.selection.chosen !== target || !reachable(proposal.source).includes(target)) return undefined;
      const ledger = new AssignmentLedger({ ...host.revisions(), authorization: proposal.outcome.authorization.revision });
      ledger.boundary = proposal.outcome.authorization;
      const reservation = ledger.commitAndReserve(ledger.plan([]), target, proposal.signal);
      if (!reservation || !host.commit(proposal.outcome, proposal.source)) return undefined;
      reserved = { ledger, reservation, revisions: { ...reservation.revisions }, assignmentId: host.assignmentId() };
      return { id: reservation.id };
    },
    dispatch(target, signal) {
      if (!reserved) return true;
      const { ledger, assignmentId } = reserved;
      ledger.bump(host.revisions());
      if (host.assignmentId() !== assignmentId || !ledger.isCurrent(reserved)
        || !reachable(target).includes(target) || (reserved.reservation && target !== reserved.reservation.target)) return false;
      const reservation = reserved.reservation ?? ledger.commitAndReserve(ledger.plan([]), target, signal);
      if (!reservation || !ledger.dispatch(reservation.id, () => {}, signal)) return false;
      reserved.reservation = undefined;
      return true;
    },
    release(target) {
      if (target && reserved?.reservation && reserved.reservation.target !== target) return;
      if (reserved?.reservation) reserved.ledger.release(reserved.reservation.id);
      if (target && reserved) reserved.reservation = undefined;
      else reserved = undefined;
      pending = undefined;
    },
  };
}
