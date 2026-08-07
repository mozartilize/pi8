/**
 * Direct delegation test harness for `runDelegationLoop`.
 *
 * Mirrors the provider's caller contract: build a `RoutingDecision`, drive
 * `runDelegationLoop` against a mocking registry + scripted `streamSimple`
 * events, and emit through a recording event stream the same way the provider
 * does (push a terminal exhausted error only when the loop did not finalize).
 */
import { vi } from 'vitest';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Model, Api } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { runDelegationLoop, type DelegationResult } from '../delegation.js';
import { resetRouterSession } from '../router-session-state.js';
import { clearBlacklistedModels, getBlacklistedModels } from '../blacklist.js';
import { makeTerminalErrorEvent } from '../error-event.js';
import { routingDecision, registryModel } from './router-fixtures.js';

/** One registryId maps to an ordered list of attempt scripts (one per retry). */
export interface DelegationScript {
  [registryId: string]: Array<readonly unknown[] | Error | AsyncIterable<unknown>>;
}

/** Yield `events` as an async iterable (the shape `streamSimple` returns). */
export function scriptedStream(events: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

/** An async iterable that throws on the first `next()` (stream-level error). */
function scriptedErrorStream(err: Error): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      throw err;
    },
  };
}

/**
 * An async iterable whose iterator `return()` rejects with `cleanup failed`.
 * Used to verify the delegation loop handles a rejecting iterator cleanup
 * (non-awaited `.then` rejection handler) without leaking an unhandled rejection.
 */
export function rejectingReturnStream(events: readonly unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++]!, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
        return(): Promise<IteratorResult<unknown>> {
          return Promise.reject(new Error('cleanup failed'));
        },
      };
    },
  };
}

/**
 * An async iterable whose iterator `return()` never resolves (simulates a
 * hung provider stream that refuses to close). The delegation loop must not
 * await `return()`, so a hung cleanup must never block fallback to the next
 * candidate.
 */
export function hangingReturnStream(events: readonly unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++]!, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
        return(): Promise<IteratorResult<unknown>> {
          return new Promise(() => {});
        },
      };
    },
  };
}

interface RecordingStream {
  push(event: unknown): void;
  end(): void;
  ended: boolean;
}

export interface DelegationHarnessOptions {
  chain: string[];
  scripts: DelegationScript;
  signal?: AbortSignal;
  /** Turn-level reasoning option (the winning candidate's resolved effort). */
  reasoning?: string;
  /** Marks `reasoning` as an explicit user request that entry efforts must not override. */
  userReasoningOverride?: boolean;
  /** Extra registry methods to override the defaults. */
  registry?: Partial<ExtensionContext['modelRegistry']>;
  /** Per-model credential results keyed by `provider/id`. */
  credentials?: Record<string, { ok: boolean; apiKey?: string; headers?: Record<string, string> } | Error>;
  /** Override the registry's provider-auth/base-URL probe (may hang or throw). */
  getProviderAuth?: (provider: string) => Promise<{ auth?: { baseUrl?: string } } | undefined>;
}

export interface DelegationHarness {
  run(): Promise<DelegationResult>;
  attempts: string[];
  output: unknown[];
  /** Models passed to `streamSimple` (with resolved baseUrl), in call order. */
  streamedModels: { provider: string; id: string; baseUrl: string }[];
  /** Reasoning option passed to `streamSimple`, per call (undefined = omitted). */
  reasoningOptions: (string | undefined)[];
  blacklist: string[];
  registry: ExtensionContext['modelRegistry'];
  /** Resolve once at least `n` streamSimple attempts have been recorded. */
  waitForAttempts(n: number): Promise<void>;
}

/** Build a registry whose `find` synthesizes a fixture model for any id. */
function buildRegistry(
  overrides: Partial<ExtensionContext['modelRegistry']> | undefined,
  credentials: DelegationHarnessOptions['credentials'],
  getProviderAuth: DelegationHarnessOptions['getProviderAuth'],
): ExtensionContext['modelRegistry'] {
  const defaultCreds = { ok: true, apiKey: 'test-key', headers: {} };
  return {
    find: (provider: string, id: string) =>
      registryModel(`${provider}/${id}`) as unknown as Model<Api>,
    getApiKeyAndHeaders: async (model: Model<Api>) => {
      const key = `${model.provider}/${model.id}`;
      const entry = credentials?.[key];
      if (entry instanceof Error) throw entry;
      return entry ?? defaultCreds;
    },
    ...(getProviderAuth ? { getProviderAuth } : {}),
    ...overrides,
  } as unknown as ExtensionContext['modelRegistry'];
}

export function createDelegationHarness(options: DelegationHarnessOptions): DelegationHarness {
  const { chain, scripts, signal, reasoning, userReasoningOverride, registry: registryOverrides, credentials, getProviderAuth } = options;

  // Per-model ordered attempt queues; each entry is consumed on one streamSimple call.
  type ScriptEntry = readonly unknown[] | Error | AsyncIterable<unknown>;
  const queuesByModel = new Map<string, ScriptEntry[]>();
  for (const [id, attempts] of Object.entries(scripts)) {
    queuesByModel.set(id, [...attempts]);
  }

  const attempts: string[] = [];
  const output: unknown[] = [];
  const reasoningOptions: (string | undefined)[] = [];
  const streamedModels: { provider: string; id: string; baseUrl: string }[] = [];
  const recordingStream: RecordingStream = {
    push: (event: unknown) => {
      output.push(event);
    },
    end() {
      this.ended = true;
    },
    ended: false,
  };

  vi.mocked(streamSimple).mockImplementation(((model: Model<Api>, _context: unknown, options: unknown) => {
    const id = `${model.provider}/${model.id}`;
    attempts.push(id);
    reasoningOptions.push((options as { reasoning?: string } | undefined)?.reasoning);
    streamedModels.push({ provider: model.provider, id: model.id, baseUrl: model.baseUrl });
    const queue = queuesByModel.get(id);
    const script = queue?.shift();
    if (script === undefined) return scriptedStream([]);
    if (script instanceof Error) return scriptedErrorStream(script);
    if (typeof (script as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
      return script as unknown as AsyncIterable<unknown>;
    }
    return scriptedStream(script as readonly unknown[]);
  }) as never);

  const registry = buildRegistry(registryOverrides, credentials, getProviderAuth);

  return {
    attempts,
    output,
    reasoningOptions,
    streamedModels,
    registry,
    get blacklist(): string[] {
      return [...getBlacklistedModels()].sort();
    },
    waitForAttempts(n: number): Promise<void> {
      return new Promise((resolve) => {
        const check = (): void => {
          if (attempts.length >= n) resolve();
          else setTimeout(check, 1);
        };
        check();
      });
    },
    async run(): Promise<DelegationResult> {
      resetRouterSession();
      clearBlacklistedModels();
      attempts.length = 0;
      output.length = 0;
      recordingStream.ended = false;

      const decision = routingDecision(chain);
      const context = {
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as Context;
      const result = await runDelegationLoop(
        {
          decision,
          registry,
          context,
          options: signal ? { signal } : undefined,
          reasoning,
          userReasoningOverride,
          turnTimer: () => 0,
          extensionContext: undefined,
          notifyOnRoute: false,
        },
        recordingStream as unknown as Parameters<typeof runDelegationLoop>[1],
      );

      // Mirror the provider: emit a terminal exhausted error only when the loop
      // did not already finalize the stream, then always end it.
      if (!result.streamFinalized && !result.success) {
        recordingStream.push(
          makeTerminalErrorEvent(
            'error',
            `All routing fallbacks exhausted${result.lastError ? ` (last error: ${result.lastError})` : ''}.`,
          ),
        );
      }
      recordingStream.end();
      return result;
    },
  };
}