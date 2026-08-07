import { describe, expect, it, vi } from 'vitest';
import type { Role } from './types.js';

import { SubagentRoutingState, type RoleRoutingMaps } from './subagent-routing-state.js';

vi.mock('./subagents.js', () => ({
  resolveLiveRoleModels: vi.fn(
    (roleFallbacks: ReadonlyMap<Role, string[]>, isBlacklisted: (id: string) => boolean) => {
      const live = new Map<Role, string>();
      for (const [role, chain] of roleFallbacks) {
        const pick = chain.find((id) => !isBlacklisted(id));
        if (pick) live.set(role, pick);
      }
      return live;
    },
  ),
}));

function maps(roleModel: string): RoleRoutingMaps {
  const [role, model] = roleModel.split('=');
  return {
    roleModels: new Map([[role as Role, model]]),
    roleFallbacks: new Map([[role as Role, [model]]]),
  };
}

describe('SubagentRoutingState', () => {
  it('returns empty maps by default', () => {
    const state = new SubagentRoutingState();
    expect(state.snapshot().roleModels.size).toBe(0);
    expect(state.snapshot().roleFallbacks.size).toBe(0);
  });

  it('commits a refresh result', () => {
    const state = new SubagentRoutingState();
    const generation = state.beginRefresh();
    expect(state.commitRefresh(generation, maps('worker=alpha/cheap'))).toBe(true);
    expect(state.snapshot().roleModels.get('worker')).toBe('alpha/cheap');
  });

  it('ignores a refresh result superseded by a newer generation', () => {
    const state = new SubagentRoutingState();
    const first = state.beginRefresh();
    const second = state.beginRefresh();

    expect(state.commitRefresh(second, maps('worker=beta/new'))).toBe(true);
    expect(state.commitRefresh(first, maps('worker=alpha/stale'))).toBe(false);

    expect(state.snapshot().roleModels.get('worker')).toBe('beta/new');
  });

  it('preserves the current maps while a newer refresh is pending', () => {
    const state = new SubagentRoutingState();
    const initial = state.beginRefresh();
    expect(state.commitRefresh(initial, maps('worker=alpha/current'))).toBe(true);
    state.beginRefresh();
    expect(state.snapshot().roleModels.get('worker')).toBe('alpha/current');
  });

  it('clears role maps at session reset', () => {
    const state = new SubagentRoutingState();
    const generation = state.beginRefresh();
    expect(state.commitRefresh(generation, maps('worker=alpha/model'))).toBe(true);
    state.reset();
    expect(state.snapshot().roleModels.size).toBe(0);
    expect(state.snapshot().roleFallbacks.size).toBe(0);
  });

  it('resolves live maps through the blacklist filter', () => {
    const state = new SubagentRoutingState();
    const generation = state.beginRefresh();
    const mapsValue: RoleRoutingMaps = {
      roleModels: new Map<Role, string>([['worker', 'alpha/current']]),
      roleFallbacks: new Map<Role, string[]>([['worker', ['alpha/current', 'beta/next']]]),
    };
    expect(state.commitRefresh(generation, mapsValue)).toBe(true);
    const live = state.resolveLive((id) => id === 'alpha/current');
    expect(live.roleModels.get('worker')).toBe('beta/next');
  });
});
