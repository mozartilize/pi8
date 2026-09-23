/**
 * `runDelegationLoop` against Pi's real `AssistantMessageEventStream`.
 *
 * `delegation.test.ts` records pushes into a plain array, which keeps
 * accepting events after a terminal one. Pi's stream does not: pushing `done`
 * or `error` marks the stream complete, resolves `result()`, and silently
 * drops every later push. That is exactly what the per-attempt buffer exists
 * to protect, so these tests assert the consequence a recording array cannot
 * show — which model's answer the consumer actually ends up with.
 *
 * Nothing in pi-ai is mocked here. The terminal tests use a scripted registry;
 * the request-boundary tests instantiate Pi's real ModelRuntime and
 * ModelRegistry, including request-time auth and lazy stream setup.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { registryModel, routingDecision } from '../test-support/router-fixtures.js';
import { scriptedRegistryStream } from '../test-support/registry-stream.js';
import { assistantMessage, runtimeProvider, runtimeRegistry } from '../test-support/runtime-registry.js';
import { setDecisionLogBase } from '../host/decisionlog.js';
import { RouterSession } from './router-session-state.js';
import { runDelegationLoop, setDelegationTimeouts } from './delegation.js';

const decisionLogTestDir = mkdtempSync(join(tmpdir(), 'ar-delegation-stream-log-'));

beforeEach(() => {
  setDecisionLogBase(decisionLogTestDir);
});

afterEach(() => {
  setDelegationTimeouts();
});

afterAll(() => {
  setDecisionLogBase(undefined);
  rmSync(decisionLogTestDir, { recursive: true, force: true });
});

const textDelta = (registryId: string, delta: string) => ({
  type: 'text_delta',
  contentIndex: 0,
  delta,
  partial: assistantMessage(registryId, { stopReason: 'pending' }),
});

const doneEvent = (registryId: string, stopReason: AssistantMessage['stopReason'] = 'stop') => ({
  type: 'done',
  reason: stopReason,
  message: assistantMessage(registryId, { stopReason }),
});

const errorEvent = (registryId: string, errorMessage: string) => ({
  type: 'error',
  reason: 'error',
  error: assistantMessage(registryId, { stopReason: 'error', errorMessage }),
});

interface RealStreamRun {
  result: Awaited<ReturnType<typeof runDelegationLoop>>;
  session: RouterSession;
  received: { type: string }[];
  finalMessage: AssistantMessage;
}

/** Drive the loop end to end and consume the stream the way Pi does. */
async function runWithRegistry(
  chain: string[],
  registry: ExtensionContext['modelRegistry'],
  options?: SimpleStreamOptions,
): Promise<RealStreamRun> {
  const session = new RouterSession();
  const stream = createAssistantMessageEventStream();
  const received: { type: string }[] = [];
  const drained = (async () => {
    for await (const event of stream) received.push(event as { type: string });
  })();
  const result = await runDelegationLoop(
    {
      decision: routingDecision(chain),
      registry,
      context: { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context,
      options,
      turnTimer: () => 0,
      extensionContext: undefined,
      notifyOnRoute: false,
      session,
    },
    stream,
  );
  stream.end();
  await drained;
  return { result, session, received, finalMessage: (await stream.result()) as AssistantMessage };
}

async function runAgainstRealStream(
  chain: string[],
  scripts: Record<string, readonly unknown[]>,
): Promise<RealStreamRun & { attempts: string[] }> {
  const attempts: string[] = [];
  const registry = {
    find: (provider: string, id: string) =>
      registryModel(`${provider}/${id}`) as unknown as Model<Api>,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key', headers: {} }),
    getProvider: () => ({
      streamSimple: (model: Model<Api>) => {
        const registryId = `${model.provider}/${model.id}`;
        attempts.push(registryId);
        const provider = createAssistantMessageEventStream();
        for (const event of scripts[registryId] ?? []) provider.push(event as never);
        provider.end();
        return provider;
      },
    }),
  } as unknown as ExtensionContext['modelRegistry'];
  registry.streamSimple = scriptedRegistryStream(registry);
  return { ...await runWithRegistry(chain, registry), attempts };
}

describe('runDelegationLoop against Pi\'s event stream', () => {
  it('leaves the turn owned by the fallback after an answerless done', async () => {
    // Pi completes the stream on the first terminal event it receives. If the
    // failed candidate's `done` were forwarded, the consumer would keep an
    // empty assistant message and the fallback's answer would be dropped on
    // the floor — the turn would end with no visible output at all.
    const run = await runAgainstRealStream(['alpha/empty', 'beta/fallback'], {
      'alpha/empty': [doneEvent('alpha/empty')],
      'beta/fallback': [textDelta('beta/fallback', 'served'), doneEvent('beta/fallback')],
    });

    expect(run.result.success).toBe(true);
    expect(run.attempts).toEqual(['alpha/empty', 'beta/fallback']);
    expect(run.received.map((event) => event.type)).toEqual(['text_delta', 'done']);
    expect(run.finalMessage.model).toBe('fallback');
  });

  it('leaves the turn owned by the fallback after an output-limit done', async () => {
    // `stopReason: 'length'` before any answer is a model-specific failure, so
    // it must be classified out of the stream rather than forwarded: a
    // forwarded `length` terminal would close the turn just as firmly as a
    // clean one.
    const run = await runAgainstRealStream(['alpha/truncated', 'beta/fallback'], {
      'alpha/truncated': [doneEvent('alpha/truncated', 'length')],
      'beta/fallback': [textDelta('beta/fallback', 'served'), doneEvent('beta/fallback')],
    });

    expect(run.result.success).toBe(true);
    expect(run.received.map((event) => event.type)).toEqual(['text_delta', 'done']);
    expect(run.finalMessage.model).toBe('fallback');
  });

  it('hands the turn to the serving model\'s own error once its text has streamed', async () => {
    // Visible text locks replay, so no fallback is attempted. The provider's
    // error is its own terminal for a turn it already began answering, and it
    // passes through verbatim: the user reads the model's real failure rather
    // than a router-authored substitute, and the partial answer survives.
    const run = await runAgainstRealStream(['alpha/partial', 'beta/fallback'], {
      'alpha/partial': [textDelta('alpha/partial', 'half an answer'), errorEvent('alpha/partial', 'boom')],
      'beta/fallback': [textDelta('beta/fallback', 'served'), doneEvent('beta/fallback')],
    });

    expect(run.attempts).toEqual(['alpha/partial']);
    expect(run.received.map((event) => event.type)).toEqual(['text_delta', 'error']);
    expect(run.finalMessage.model).toBe('partial');
    expect(run.finalMessage.errorMessage).toBe('boom');
  });

  it('forwards exactly one terminal event for a candidate that serves', async () => {
    const run = await runAgainstRealStream(['alpha/ok'], {
      'alpha/ok': [textDelta('alpha/ok', 'answer'), doneEvent('alpha/ok')],
    });

    expect(run.result.success).toBe(true);
    expect(run.received.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(run.finalMessage.model).toBe('ok');
  });
});

describe('runDelegationLoop through Pi ModelRuntime', () => {
  it('uses destination auth and drops synthetic router request credentials', async () => {
    let resolvedCredential: string | undefined;
    let dispatched: {
      apiKey?: string;
      headers?: ProviderHeaders;
      env?: Record<string, string>;
      baseUrl: string;
    } | undefined;
    const provider = runtimeProvider(
      'destination',
      async ({ credential }) => {
        resolvedCredential = credential?.key;
        return {
          auth: {
            apiKey: credential?.key,
            headers: { 'X-Destination': 'stored' },
            baseUrl: 'https://stored.destination.test',
          },
          env: { DESTINATION_ENV: 'stored' },
        };
      },
      (model, _context, options) => {
        dispatched = {
          apiKey: options?.apiKey,
          headers: options?.headers,
          env: options?.env,
          baseUrl: model.baseUrl,
        };
        const stream = createAssistantMessageEventStream();
        stream.push(textDelta('destination/model', 'served') as never);
        stream.push(doneEvent('destination/model') as never);
        stream.end();
        return stream;
      },
    );
    const registry = await runtimeRegistry([provider]);

    const run = await runWithRegistry(
      ['destination/model'],
      registry,
      {
        apiKey: 'pi8',
        headers: { 'X-Router': 'synthetic' },
        env: { ROUTER_ENV: 'synthetic' },
      },
    );

    expect(run.result.success).toBe(true);
    expect(resolvedCredential).toBe('destination-stored-key');
    expect(dispatched).toEqual({
      apiKey: 'destination-stored-key',
      headers: { 'X-Destination': 'stored' },
      env: { DESTINATION_ENV: 'stored' },
      baseUrl: 'https://stored.destination.test',
    });
  });

  it('bounds request auth and prevents a timed-out setup from dispatching late', async () => {
    setDelegationTimeouts({ authMs: 20, firstEventMs: 200 });
    const authStarted = Promise.withResolvers<void>();
    const releaseAuth = Promise.withResolvers<void>();
    let alphaDispatches = 0;
    let betaDispatches = 0;
    const alpha = runtimeProvider(
      'alpha',
      async ({ credential }) => {
        authStarted.resolve();
        await releaseAuth.promise;
        return { auth: { apiKey: credential?.key } };
      },
      () => {
        alphaDispatches++;
        return createAssistantMessageEventStream();
      },
    );
    const beta = runtimeProvider(
      'beta',
      async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
      () => {
        betaDispatches++;
        const stream = createAssistantMessageEventStream();
        stream.push(textDelta('beta/model', 'served') as never);
        stream.push(doneEvent('beta/model') as never);
        stream.end();
        return stream;
      },
    );
    const registry = await runtimeRegistry([alpha, beta]);
    const runPromise = runWithRegistry(['alpha/model', 'beta/model'], registry);
    await authStarted.promise;

    const run = await runPromise;
    releaseAuth.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(run.result.success).toBe(true);
    expect(run.finalMessage.model).toBe('model');
    expect(alphaDispatches).toBe(0);
    expect(betaDispatches).toBe(1);
    expect(run.session.getBlacklistedModels()).toContain('alpha/model');
    expect(run.session.getLastDecision()?.spend?.incomplete).not.toBe(true);
  });

  it('surfaces caller cancellation canonically while request auth is pending', async () => {
    setDelegationTimeouts({ authMs: 500, firstEventMs: 200 });
    const authStarted = Promise.withResolvers<void>();
    const releaseAuth = Promise.withResolvers<void>();
    let dispatches = 0;
    const provider = runtimeProvider(
      'alpha',
      async ({ credential }) => {
        authStarted.resolve();
        await releaseAuth.promise;
        return { auth: { apiKey: credential?.key } };
      },
      () => {
        dispatches++;
        return createAssistantMessageEventStream();
      },
    );
    const registry = await runtimeRegistry([provider]);
    const controller = new AbortController();
    const runPromise = runWithRegistry(['alpha/model'], registry, { signal: controller.signal });
    await authStarted.promise;
    controller.abort();

    const run = await runPromise;
    releaseAuth.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(run.result).toMatchObject({ success: false, streamFinalized: true, lastError: 'aborted' });
    expect(run.finalMessage.stopReason).toBe('aborted');
    expect(dispatches).toBe(0);
    expect(run.session.getBlacklistedModels()).toEqual(new Set());
  });
});
