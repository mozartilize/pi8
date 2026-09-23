/** Registry request boundary for policy tests; real runtime coverage lives in delegation-stream.test.ts. */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';

type Registry = ExtensionContext['modelRegistry'];

export function scriptedRegistryStream(registry: Registry): Registry['streamSimple'] {
  return (model, context, options) => withResult((async function* () {
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
  })()) as unknown as ReturnType<Registry['streamSimple']>;
}

type ScriptedEvent = { type: string; message?: unknown; error?: unknown };

/**
 * Pi's `result()`: the first terminal event's message, with a setup or
 * transport failure surfaced as a `stopReason: 'error'` message. A stream that
 * ends without a terminal event never settles, as in Pi.
 */
function withResult(events: AsyncGenerator<ScriptedEvent>) {
  return Object.assign(events, {
    async result(): Promise<unknown> {
      try {
        for await (const event of events) {
          if (event.type === 'done') return event.message;
          if (event.type === 'error') return event.error;
        }
      } catch (error) {
        return {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
      return new Promise(() => {});
    },
  });
}
