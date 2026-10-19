/**
 * Explicit boundary authorization. Phase and contract permissions name the
 * actors that may own a boundary; benchmark rank and fallback order never
 * grant ownership.
 *
 * Settlement rule v1: any explicitly authorized actor that actually serves
 * settles the boundary. Actors are effective action keys, so a higher served
 * effort of an authorized action is a different actor and needs its own
 * authorization. A rank, a reservation or a failed attempt never settles.
 */
import type { Dimension } from '../../types.js';

/**
 * The scope that one authorization covers. `entryId` and `boundaryId` name
 * the routing boundary of the current entry; `routingEpoch` changes on
 * `/tree`, a model switch, and a session reset, so an authorization of an
 * earlier epoch never matches. `flowId` is set only when implement
 * exclusions of a live execution flow apply.
 */
export interface BoundaryScope {
  sessionGeneration: number;
  profileDigest: string;
  contextRevision: number;
  entryId: string;
  routingEpoch: number;
  boundaryId: string;
  phase: Dimension;
  assignmentId: string;
  revision: number;
  flowId?: string;
}

export interface BoundaryAuthorizationV1 extends BoundaryScope {
  /** Effective action keys permitted by contract and phase rules. */
  allowedActors: readonly string[];
  /** Hard exclusions, e.g. a struck executor, by `provider/modelId`. */
  excludedModels?: readonly string[];
  state: 'pending' | 'served' | 'expired';
}

/** Proof that an attempt produced an answer for a boundary assignment. */
export interface ActualServeReceipt extends BoundaryScope {
  /** Effective action key that served. */
  actualServed: string;
  /** True only when the attempt produced a meaningful answer. */
  answered: boolean;
}

const modelOf = (actionKey: string): string => {
  const colon = actionKey.lastIndexOf(':');
  const slash = actionKey.indexOf('/');
  return colon > slash ? actionKey.slice(0, colon) : actionKey;
};

/**
 * The caller supplies callable effective actions after availability filters.
 * The executors that the live execution flow excluded apply only to the
 * `implement` task type. Benchmark scores, price and rank do not grant or
 * remove permission.
 */
export function createBoundaryAuthorization(
  scope: BoundaryScope,
  availableActors: readonly string[],
  flowExclusions: readonly string[] = [],
): BoundaryAuthorizationV1 {
  const excludedModels = Object.freeze(scope.phase === 'implement'
    ? [...new Set(flowExclusions.map(modelOf))] : []);
  const excluded = new Set(excludedModels);
  return Object.freeze({
    ...scope,
    allowedActors: Object.freeze([...new Set(availableActors)].filter((actor) => !excluded.has(modelOf(actor)))),
    excludedModels,
    state: 'pending' as const,
  });
}

export function actorAllowedForBoundary(auth: BoundaryAuthorizationV1, actor: string): boolean {
  if (auth.state === 'expired') return false;
  if (auth.excludedModels?.some((model) => modelOf(actor) === modelOf(model))) return false;
  return auth.allowedActors.includes(actor);
}

export function settleBoundary(auth: BoundaryAuthorizationV1, receipt: ActualServeReceipt | undefined): BoundaryAuthorizationV1 {
  if (!receipt || auth.state !== 'pending' || !receipt.answered) return auth;
  if (receipt.sessionGeneration !== auth.sessionGeneration || receipt.profileDigest !== auth.profileDigest
    || receipt.contextRevision !== auth.contextRevision || receipt.flowId !== auth.flowId
    || receipt.entryId !== auth.entryId || receipt.routingEpoch !== auth.routingEpoch
    || receipt.boundaryId !== auth.boundaryId || receipt.phase !== auth.phase
    || receipt.assignmentId !== auth.assignmentId || receipt.revision !== auth.revision) return auth;
  if (!actorAllowedForBoundary(auth, receipt.actualServed)) return auth;
  return { ...auth, state: 'served' };
}
