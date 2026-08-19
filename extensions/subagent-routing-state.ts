import {
  resolveLiveRoleModels,
  selectTaskAwareRoleChildren,
  type RoleRoutingSnapshot,
  type RoleRoutingSelection,
  type SubagentTaskRequest,
} from './subagents.js';
import type { Role } from './types.js';

export interface RoleRoutingMaps {
  roleModels: ReadonlyMap<Role, string>;
  roleFallbacks: ReadonlyMap<Role, string[]>;
  routingSnapshot?: RoleRoutingSnapshot;
}

/**
 * Mutable, generation-guarded owner for the router's per-session subagent
 * role maps. A slow or stale refresh can never clobber a newer result; only
 * `reset()` (called on `session_start`) clears the maps.
 */
export class SubagentRoutingState {
  private generation = 0;
  private roleModels: ReadonlyMap<Role, string> = new Map();
  private roleFallbacks: ReadonlyMap<Role, string[]> = new Map();
  private routingSnapshot: RoleRoutingSnapshot | undefined;

  reset(): void {
    this.generation += 1;
    this.roleModels = new Map();
    this.roleFallbacks = new Map();
    this.routingSnapshot = undefined;
  }

  beginRefresh(): number {
    return ++this.generation;
  }

  commitRefresh(generation: number, maps: RoleRoutingMaps): boolean {
    if (generation !== this.generation) return false;
    this.roleModels = new Map(maps.roleModels);
    this.roleFallbacks = new Map(
      [...maps.roleFallbacks].map(([role, chain]) => [role, [...chain]]),
    );
    this.routingSnapshot = maps.routingSnapshot
      ? {
          candidates: maps.routingSnapshot.candidates.map((candidate) => ({
            ...candidate,
            ...(candidate.bench
              ? { bench: { ...candidate.bench, quality: { ...candidate.bench.quality } } }
              : {}),
          })),
          weights: { ...maps.routingSnapshot.weights },
        }
      : undefined;
    return true;
  }

  snapshot(): RoleRoutingMaps {
    return {
      roleModels: new Map(this.roleModels),
      roleFallbacks: new Map(
        [...this.roleFallbacks].map(([role, chain]) => [role, [...chain]]),
      ),
      ...(this.routingSnapshot ? { routingSnapshot: this.cloneSnapshot() } : {}),
    };
  }

  resolveLive(isBlacklisted: (id: string) => boolean): RoleRoutingMaps {
    const roleModels = resolveLiveRoleModels(this.roleFallbacks, isBlacklisted);
    return {
      roleModels: new Map(roleModels),
      roleFallbacks: new Map(
        [...this.roleFallbacks].map(([role, chain]) => [role, [...chain]]),
      ),
      ...(this.routingSnapshot ? { routingSnapshot: this.cloneSnapshot() } : {}),
    };
  }

  selectChildren(
    requests: readonly SubagentTaskRequest[],
    isBlacklisted: (id: string) => boolean,
    estimatedContextTokens: number,
  ): ReadonlyMap<string, RoleRoutingSelection> {
    if (!this.routingSnapshot) return new Map();
    const live = resolveLiveRoleModels(this.roleFallbacks, isBlacklisted);
    return selectTaskAwareRoleChildren(
      requests,
      live,
      this.roleFallbacks,
      this.routingSnapshot,
      isBlacklisted,
      estimatedContextTokens,
    );
  }

  private cloneSnapshot(): RoleRoutingSnapshot {
    const snapshot = this.routingSnapshot!;
    return {
      candidates: snapshot.candidates.map((candidate) => ({
        ...candidate,
        ...(candidate.bench
          ? { bench: { ...candidate.bench, quality: { ...candidate.bench.quality } } }
          : {}),
      })),
      weights: { ...snapshot.weights },
    };
  }
}
