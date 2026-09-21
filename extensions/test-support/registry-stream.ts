/** Registry request boundary for policy tests; real runtime coverage lives in delegation-stream.test.ts. */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';

type Registry = ExtensionContext['modelRegistry'];

export function scriptedRegistryStream(registry: Registry): Registry['streamSimple'] {
  return (model, context, options) => (async function* () {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`no usable credentials: ${model.provider}/${model.id}`);
    const metadata = await registry.getProviderAuth?.(model.provider);
    const headers = await options?.transformHeaders?.(auth.headers ?? {}) ?? auth.headers;
    const { transformHeaders: _transform, ...providerOptions } = options ?? {};
    const provider = registry.getProvider?.(model.provider)?.streamSimple;
    const resolvedModel = { ...model, baseUrl: auth.baseUrl ?? metadata?.auth?.baseUrl ?? model.baseUrl };
    const resolvedOptions = { ...providerOptions, apiKey: auth.apiKey, headers, env: auth.env };
    // Test scripts accept the legacy fixture context; normalization is exercised by the real runtime tests.
    yield* (provider ?? streamSimple)(resolvedModel, context as never, resolvedOptions);
  })() as unknown as ReturnType<Registry['streamSimple']>;
}
