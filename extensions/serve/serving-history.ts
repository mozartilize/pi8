import { MODEL_THINKING_LEVELS } from '../routing/score/scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from '../types.js';
import { SELECTION_ENTRY_TYPE, type BranchEntryLike } from '../routing/context/persistence.js';

export const SERVING_ENTRY_TYPE = 'pi8-serving-v1';
const LEGACY_CONTEXT_ENTRY_TYPE = 'pi8-routing-context-v1';

export interface ServingIdentity {
  registryId: string;
  thinkingLevel?: string;
}
export interface ServingEvent {
  v: 1;
  op: 'served';
  registryId: string;
  effort?: string;
  sourceEntryId: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function identity(value: unknown, effortField: string): ServingIdentity | undefined {
  if (!object(value) || !text(value.registryId) || !/^[^\s/]+\/\S+$/u.test(value.registryId)) return undefined;
  const effort = value[effortField];
  if (effort !== undefined && (typeof effort !== 'string' || !(MODEL_THINKING_LEVELS as readonly string[]).includes(effort))) return undefined;
  return { registryId: value.registryId, ...(typeof effort === 'string' ? { thinkingLevel: effort } : {}) };
}

/** Legacy records contribute only a served identity, never work or task authority. */
export function rebuildServingHistory(branch: readonly unknown[] | undefined): { incumbent?: ServingIdentity; routerSelected: boolean } {
  let incumbent: ServingIdentity | undefined;
  let routerSelected = false;
  for (const raw of branch ?? []) {
    if (!object(raw)) continue;
    const entry = raw as unknown as BranchEntryLike;
    const selection = entry.type === 'model_change' ? raw
      : entry.type === 'custom' && entry.customType === SELECTION_ENTRY_TYPE && object(entry.data) ? entry.data : undefined;
    if (selection && text(selection.provider) && text(selection.modelId)) {
      routerSelected = selection.provider === ROUTER_PROVIDER_ID && selection.modelId === AUTO_MODEL_ID;
      if (!routerSelected) incumbent = undefined;
      continue;
    }
    if (entry.type !== 'custom' || !object(entry.data) || entry.data.v !== 1 || !text(entry.data.sourceEntryId)) continue;
    const data = entry.data;
    const served = entry.customType === SERVING_ENTRY_TYPE && data.op === 'served' ? identity(data, 'effort')
      : entry.customType === LEGACY_CONTEXT_ENTRY_TYPE && data.op === 'incumbent' ? identity(data.served, 'thinkingLevel') : undefined;
    if (served) { incumbent = served; routerSelected = true; }
  }
  return { ...(incumbent ? { incumbent } : {}), routerSelected };
}

/** Branch persistence stores serving identity only. It cannot restore entry authority. */
export class ServingHistoryState {
  private incumbent: ServingIdentity | undefined;
  private persist: ((event: ServingEvent) => void) | undefined;

  bindPersistence(persist: ((event: ServingEvent) => void) | undefined): void { this.persist = persist; }
  getIncumbent(): ServingIdentity | undefined { return this.incumbent; }
  clearIncumbent(): void { this.incumbent = undefined; }
  reset(): void { this.incumbent = undefined; }
  restore(branch: readonly unknown[] | undefined): void { this.incumbent = rebuildServingHistory(branch).incumbent; }

  record(served: ServingIdentity, sourceEntryId: string): void {
    if (this.incumbent?.registryId === served.registryId && this.incumbent.thinkingLevel === served.thinkingLevel) return;
    this.incumbent = { registryId: served.registryId, ...(served.thinkingLevel ? { thinkingLevel: served.thinkingLevel } : {}) };
    try {
      this.persist?.({ v: 1, op: 'served', registryId: served.registryId,
        ...(served.thinkingLevel ? { effort: served.thinkingLevel } : {}), sourceEntryId });
    } catch {
      // The current process still knows the actual serve if persistence fails.
    }
  }
}
