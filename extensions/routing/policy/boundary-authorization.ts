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

export interface BoundaryAuthorizationV1 {
  boundaryId: string;
  workItemId: string;
  phase: Dimension;
  assignmentId: string;
  revision: number;
  /** Effective action keys permitted by contract and phase rules. */
  allowedActors: readonly string[];
  /** Hard exclusions, e.g. a struck executor, by `provider/modelId`. */
  excludedModels?: readonly string[];
  state: 'pending' | 'served' | 'expired';
}

/** Proof that an attempt produced an answer for a boundary assignment. */
export interface ActualServeReceipt {
  boundaryId: string;
  assignmentId: string;
  revision: number;
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

export function actorAllowedForBoundary(auth: BoundaryAuthorizationV1, actor: string): boolean {
  if (auth.excludedModels?.some((model) => modelOf(actor) === model || actor === model)) return false;
  return auth.allowedActors.includes(actor);
}

export function settleBoundary(auth: BoundaryAuthorizationV1, receipt: ActualServeReceipt | undefined): BoundaryAuthorizationV1 {
  if (!receipt || auth.state !== 'pending' || !receipt.answered) return auth;
  if (receipt.boundaryId !== auth.boundaryId || receipt.assignmentId !== auth.assignmentId || receipt.revision !== auth.revision) return auth;
  if (!actorAllowedForBoundary(auth, receipt.actualServed)) return auth;
  return { ...auth, state: 'served' };
}

/** Operational fallbacks that may own the boundary. Chain membership grants nothing. */
export const authorizedFallbacks = (auth: BoundaryAuthorizationV1, chain: readonly string[]): string[] =>
  chain.filter((actor) => actorAllowedForBoundary(auth, actor));
