import { writeFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const REGISTRY_SNAPSHOT_ENV = 'PI8_REGISTRY_SNAPSHOT';

interface RegistryModel {
  provider: string;
  id: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly string[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevelMap?: unknown;
  compat?: unknown;
}

/** Keep the registry fields that can change routing, execution, or cost accounting. */
export function registrySnapshot(models: readonly RegistryModel[]): RegistryModel[] {
  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    ...(model.api !== undefined ? { api: model.api } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.input !== undefined ? { input: model.input } : {}),
    ...(model.cost !== undefined ? { cost: model.cost } : {}),
    ...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.compat !== undefined ? { compat: model.compat } : {}),
  }));
}

export default function registrySnapshotExtension(pi: ExtensionAPI): void {
  const output = process.env[REGISTRY_SNAPSHOT_ENV];
  if (!output) return;
  pi.on('session_start', async (_event, ctx) => {
    writeFileSync(output, `${JSON.stringify(registrySnapshot(ctx.modelRegistry.getAvailable() as RegistryModel[]), null, 2)}\n`);
    ctx.shutdown();
  });
}
