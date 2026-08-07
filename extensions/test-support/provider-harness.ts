/**
 * Typed provider orchestration harness for provider.test.ts.
 *
 * The router registers `router/auto` through the ExtensionAPI and serves each
 * turn by delegating through `streamSimple(model, context, options)`. Every
 * describe in provider.test.ts used to rebuild that wiring by hand — module
 * resets, decision-log base, event stream, mock registry, credential policy —
 * and then read the `streamSimple` positional shape through `as any` at ~40
 * call sites. This harness is the single place that knows the positional
 * shape (`delegatedCall`) and the single place that assembles the mock
 * ExtensionContext/registry.
 */
import { expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { BenchModel, RoutingDecision } from '../types.js';
import type { ServedInfo } from '../ui.js';
import { registryModel } from './router-fixtures.js';

// ─── Event stream ────────────────────────────────────────────────────

/**
 * Mirror of pi's `ResolvedRequestAuth` registry contract: the mock
 * `getApiKeyAndHeaders` returns this shape, and the delegation loop treats
 * `{ ok: false }` as a credential failure before any stream call.
 */
export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

export interface MockEvent {
  type: string;
  delta?: string;
  error?: { stopReason?: string; errorMessage?: string; message?: string };
  message?: {
    stopReason?: string;
    usage?: { cost?: { total: number } };
  };
}

export class MockEventStream {
  events: MockEvent[] = [];
  ended = false;
  push(event: MockEvent) {
    this.events.push(event);
  }
  end() {
    this.ended = true;
  }
}

export function asStream(events: readonly MockEvent[]): ReturnType<typeof streamSimple> {
  return (async function* () {
    for (const event of events) yield event;
  })() as unknown as ReturnType<typeof streamSimple>;
}

// ─── Default registry fixtures ───────────────────────────────────────

/** Two measured models, one cheap and one strong, plus the router itself. */
export const REGISTRY_MODELS = [
  registryModel('alpha/first', {
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
  }),
  registryModel('beta/second', {
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: 'max' },
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
  }),
];

/** The router registers itself into the registry as a routable-looking model. */
export const ROUTER_AUTO_MODEL = registryModel('router/auto', {
  contextWindow: 1000000,
  maxTokens: 128000,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

// ─── Harness ─────────────────────────────────────────────────────────

/** The slice of the registered provider options the tests drive. */
export interface RouterProviderOptions {
  models?: Array<{ id: string }>;
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}

/** One delegated `streamSimple` call, positionally typed in one place. */
export interface DelegatedCall {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
}

export interface ProviderStateSnapshot {
  lastDecision: RoutingDecision | undefined;
  lastServed: ServedInfo | undefined;
  accumulatedCost: number;
  blacklistedModels: string[];
}

export interface ProviderHarnessOptions {
  /** Temp router dir; also the decision-log base. */
  dir: string;
  /** Registry models; defaults to REGISTRY_MODELS + the router model. */
  models?: Array<ReturnType<typeof registryModel>>;
  /** Omit the router's own registry entry (auth-filter describes). */
  includeRouterModel?: boolean;
  /** Per-provider credential results; missing providers default to authed. */
  credentials?: Record<string, ResolvedRequestAuth | Error>;
  /** Config JSON written to `<dir>/config.json` before registration. */
  config?: Record<string, unknown>;
  /** Benchmark rows written to `<dir>/benchmarks.json` before registration. */
  benchmarks?: BenchModel[];
  /** Extra ExtensionAPI methods (e.g. `setThinkingLevel` spy). */
  pi?: Partial<ExtensionAPI>;
  /** Extra ExtensionContext fields (e.g. `ui`). */
  ctx?: Partial<ExtensionContext>;
}

export interface ProviderTestHarness {
  providerOptions: RouterProviderOptions;
  /** Mutable: a test that simulates a fresh turn may swap in a new stream. */
  outStream: MockEventStream;
  getProviderState(): ProviderStateSnapshot;
  /**
   * Serve one turn through the router and wait for the stream to end.
   * `options` mirrors the provider entry's `SimpleStreamOptions` (e.g. a user
   * reasoning override echoed back by Pi); `model` defaults to the router's
   * own `router/auto` entry (concrete subagent tests pass a child model).
   */
  serve(context: Context, options?: SimpleStreamOptions, model?: Model<Api>): Promise<void>;
  /**
   * The n-th delegation call (0-based), typed at this one accessor. The
   * `(model, context, options)` positional shape of `streamSimple` is
   * asserted here and nowhere else.
   */
  delegatedCall(index?: number): DelegatedCall;
  /** Fresh event stream; re-mocks the provider's stream factory. */
  resetEventStream(): void;
  /** Script every delegation call to yield `events` (or a custom impl). */
  scriptReply(
    events: readonly MockEvent[] | ((model: Model<Api>, context: Context) => AsyncIterable<unknown>),
  ): void;
  /** `provider/id` streamed in call order (credential failures never call). */
  streamedModels(): string[];
}

export async function setupProviderTest(options: ProviderHarnessOptions): Promise<ProviderTestHarness> {
  vi.clearAllMocks();
  vi.resetModules();

  const { dir, config, benchmarks } = options;
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  if (benchmarks) {
    writeFileSync(
      join(dir, 'benchmarks.json'),
      JSON.stringify({ version: 2, syncedAt: Date.now(), aliases: {}, models: benchmarks }),
      'utf8',
    );
  }

  const { setDecisionLogBase } = await import('../decisionlog.js');
  setDecisionLogBase(dir);
  const { registerAutoRouterProvider } = await import('../provider.js');

  const outStream = new MockEventStream();
  vi.mocked(createAssistantMessageEventStream).mockReturnValue(
    outStream as unknown as ReturnType<typeof createAssistantMessageEventStream>,
  );

  const models = options.models ?? REGISTRY_MODELS;
  const registryModels = options.includeRouterModel === false
    ? models
    : [...models, ROUTER_AUTO_MODEL];

  const registry = {
    getAvailable: () => registryModels,
    find: (provider: string, id: string) =>
      registryModels.find((m) => m.provider === provider && m.id === id) as unknown as
        | Model<Api>
        | undefined,
    getApiKeyAndHeaders: async (model: Model<Api>) => {
      const entry = options.credentials?.[`${model.provider}/${model.id}`];
      if (entry instanceof Error) throw entry;
      return entry ?? { ok: true, apiKey: 'k', headers: {} };
    },
  } as unknown as ExtensionContext['modelRegistry'];

  let providerOptions: RouterProviderOptions | undefined;
  const pi = {
    registerProvider: (_name: string, registered: unknown) => {
      providerOptions = registered as RouterProviderOptions;
    },
    ...options.pi,
  } as unknown as ExtensionAPI;

  registerAutoRouterProvider(pi, { modelRegistry: registry, ...options.ctx } as unknown as ExtensionContext);

  const { getProviderState: readProviderState } = await import('../provider.js');

  const harness: ProviderTestHarness = {
    providerOptions: undefined as unknown as RouterProviderOptions,
    outStream,
    getProviderState(): ProviderStateSnapshot {
      return readProviderState() as unknown as ProviderStateSnapshot;
    },
    async serve(
      context: Context,
      entryOptions?: SimpleStreamOptions,
      model?: Model<Api>,
    ): Promise<void> {
      harness.providerOptions.streamSimple(model ?? ({ id: 'auto' } as Model<Api>), context, entryOptions);
      await vi.waitFor(() => expect(harness.outStream.ended).toBe(true));
    },
    delegatedCall(index = 0): DelegatedCall {
      const call = vi.mocked(streamSimple).mock.calls[index];
      if (!call) throw new Error(`delegatedCall(${index}): no streamSimple call recorded`);
      const [model, context, options] = call;
      return {
        model: model as Model<Api>,
        context: context as Context,
        options: options as SimpleStreamOptions | undefined,
      };
    },
    resetEventStream() {
      harness.outStream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        harness.outStream as unknown as ReturnType<typeof createAssistantMessageEventStream>,
      );
    },
    scriptReply(
      events: readonly MockEvent[] | ((model: Model<Api>, context: Context) => AsyncIterable<unknown>),
    ) {
      vi.mocked(streamSimple).mockImplementation(((
        model: Model<Api>,
        context: Context,
      ): AsyncIterable<unknown> => {
        if (typeof events === 'function') return events(model, context);
        return asStream(events);
      }) as never);
    },
    streamedModels(): string[] {
      return vi.mocked(streamSimple).mock.calls.map((call) => {
        const model = call[0] as { provider: string; id: string };
        return `${model.provider}/${model.id}`;
      });
    },
  };
  // Registered synchronously by registerAutoRouterProvider.
  harness.providerOptions = providerOptions!;
  return harness;
}

// ─── Decision contract ───────────────────────────────────────────────

/**
 * Cross-check one cause-precedence row across the three places a user can see
 * it: the in-memory decision (what the next hook reads), the durable decision
 * log (what `/router-why` reconstructs after a restart), and the rendered
 * status detail. Asserting only `getProviderState().lastDecision` lets
 * serialization or formatting regress undetected.
 */
export function expectDecisionContract(opts: {
  state: { lastDecision: RoutingDecision | undefined };
  log: Array<{ kind?: string; dimension?: string; cause?: string; chosen?: string }>;
  ui: string[];
  match: Record<string, unknown>;
}): void {
  expect(opts.state.lastDecision).toMatchObject(opts.match);

  // Shadow-assessment records may trail the decision line; find the newest
  // real decision entry.
  const entry = [...opts.log].reverse().find((e) => e.kind !== 'assessment-shadow');
  expect(entry).toBeDefined();
  if (entry) {
    for (const field of ['dimension', 'cause', 'chosen'] as const) {
      const expected = opts.match[field];
      if (typeof expected === 'string') expect(entry[field]).toBe(expected);
    }
  }

  const text = opts.ui.join('\n');
  if (typeof opts.match.dimension === 'string') {
    expect(text).toContain(`dimension:  ${opts.match.dimension}`);
  }
  if (typeof opts.match.chosen === 'string') {
    expect(text).toContain(`top pick:   ${opts.match.chosen}`);
  }
}

/** Fetch the three handles for {@link expectDecisionContract}. */
export async function fetchDecisionContractHandles(dir: string): Promise<{
  state: { lastDecision: RoutingDecision | undefined };
  log: Array<{ kind?: string; dimension?: string; cause?: string; chosen?: string }>;
  ui: string[];
}> {
  const { getProviderState } = await import('../provider.js');
  const { readRecentEntries } = await import('../decisionlog.js');
  const { formatDecisionDetail } = await import('../ui.js');
  const state = getProviderState();
  return {
    state,
    log: readRecentEntries(10, dir) as Array<{
      kind?: string;
      dimension?: string;
      cause?: string;
      chosen?: string;
    }>,
    ui: formatDecisionDetail(state.lastDecision ?? undefined, state.lastServed),
  };
}
