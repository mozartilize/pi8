import { resolveLiveRoleModels } from './subagents.js';
import type { Role } from './types.js';

export interface RoleRoutingMaps {
  roleModels: ReadonlyMap<Role, string>;
  roleFallbacks: ReadonlyMap<Role, string[]>;
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

  reset(): void {
    this.generation += 1;
    this.roleModels = new Map();
    this.roleFallbacks = new Map();
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
    return true;
  }

  snapshot(): RoleRoutingMaps {
    return {
      roleModels: new Map(this.roleModels),
      roleFallbacks: new Map(
        [...this.roleFallbacks].map(([role, chain]) => [role, [...chain]]),
      ),
    };
  }

  resolveLive(isBlacklisted: (id: string) => boolean): RoleRoutingMaps {
    const roleModels = resolveLiveRoleModels(this.roleFallbacks, isBlacklisted);
    return {
      roleModels: new Map(roleModels),
      roleFallbacks: new Map(
        [...this.roleFallbacks].map(([role, chain]) => [role, [...chain]]),
      ),
    };
  }
}
