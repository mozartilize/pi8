/** Pi's real ModelRuntime and ModelRegistry around scripted native providers. */
import {
  createProvider,
  InMemoryCredentialStore,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

import { registryModel } from './router-fixtures.js';

/** A terminal assistant message for `registryId` with zero usage. */
export function assistantMessage(
  registryId: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const slash = registryId.indexOf('/');
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions' as Api,
    provider: registryId.slice(0, slash),
    model: registryId.slice(slash + 1),
    stopReason: 'stop',
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  } as AssistantMessage;
}

export type AuthResolve = ApiKeyAuth['resolve'];
export type RuntimeStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** A native provider serving the single model `<id>/<modelId>`. */
export function runtimeProvider(
  id: string,
  resolve: AuthResolve,
  streamSimple: RuntimeStream,
  modelId = 'model',
): Provider {
  const model = registryModel(`${id}/${modelId}`) as unknown as Model<Api>;
  return createProvider({
    id,
    auth: { apiKey: { name: `${id} key`, resolve } },
    models: [model],
    api: { stream: streamSimple as never, streamSimple },
  });
}

/** A registry with one stored API key per provider. */
export async function runtimeRegistry(providers: Provider[]): Promise<ModelRegistry> {
  const credentials = new InMemoryCredentialStore();
  for (const provider of providers) {
    await credentials.modify(provider.id, async () => ({
      type: 'api_key',
      key: `${provider.id}-stored-key`,
      env: { [`${provider.id.toUpperCase()}_ENV`]: 'destination' },
    }));
  }
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const provider of providers) runtime.registerNativeProvider(provider);
  return new ModelRegistry(runtime);
}
