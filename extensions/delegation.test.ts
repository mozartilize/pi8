/**
 * Direct contract tests for `runDelegationLoop`.
 *
 * The harness (extensions/test-support/delegation-harness.ts) drives the loop
 * directly against a fake registry and scripted `streamSimple` events, so these
 * tests own fallback-lifecycle policy without going through the provider
 * integration layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Model, Api } from '@earendil-works/pi-ai';

import { multiWorkRoutingMeta, routingDecision, registryModel } from './test-support/router-fixtures.js';
import { createDelegationHarness, rejectingReturnStream, hangingReturnStream } from './test-support/delegation-harness.js';
import { setDecisionLogBase } from './decisionlog.js';
import { getLastDecision, resetRouterSession } from './router-session-state.js';
import { clearBlacklistedModels } from './blacklist.js';
import { setDelegationTimeouts } from './delegation.js';

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: vi.fn(),
  // Real-style transient classifier: retry only on overload/5xx/rate-limit/network.
  isRetryableAssistantError: (m: { stopReason?: string; errorMessage?: string }) =>
    m?.stopReason === 'error' &&
    !!m.errorMessage &&
    /(overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|network|timeout|connection)/i.test(
      m.errorMessage,
    ),
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

const decisionLogTestDir = mkdtempSync(join(tmpdir(), 'ar-delegation-log-'));

beforeEach(() => {
  vi.clearAllMocks();
  setDecisionLogBase(decisionLogTestDir);
  resetRouterSession();
  clearBlacklistedModels();
});

afterEach(() => {
  setDecisionLogBase(undefined);
  setDelegationTimeouts();
});

afterAll(() => {
  rmSync(decisionLogTestDir, { recursive: true, force: true });
});

describe('runDelegationLoop contracts', () => {
  it('serves a fallback to a different effort of the same model with that entry\'s effort', async () => {
    // Two effort variants of one model are two chain entries: the xhigh entry
    // fails before content, and the high entry serves with ITS measured
    // effort, not the failed entry's.
    const h = createDelegationHarness({
      chain: ['alpha/model:xhigh', 'alpha/model:high'],
      scripts: {
        'alpha/model': [
          new Error('stream exploded'),
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
      registry: {
        find: (provider: string, id: string) =>
          registryModel(`${provider}/${id}`, {
            reasoning: true,
            thinkingLevelMap: {
              off: 'off', minimal: 'minimal', low: 'low', medium: 'medium',
              high: 'high', xhigh: 'xhigh', max: 'max',
            },
          }) as unknown as Model<Api>,
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/model', 'alpha/model']);
    expect(h.reasoningOptions).toEqual(['xhigh', 'high']);
    // The failed xhigh variant is blacklisted as its own key; the high
    // variant stays routable.
    expect(h.blacklist).toEqual(['alpha/model:xhigh']);
  });

  it('raises a chain entry effort below the dimension floor to the floor', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model:low'],
      scripts: {
        'alpha/model': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
      registry: {
        find: (provider: string, id: string) =>
          registryModel(`${provider}/${id}`, {
            reasoning: true,
            thinkingLevelMap: {
              off: 'off', minimal: 'minimal', low: 'low', medium: 'medium',
              high: 'high', xhigh: 'xhigh', max: 'max',
            },
          }) as unknown as Model<Api>,
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    // routingDecision defaults to dimension 'implement' (floor medium): a low
    // chain entry is raised to medium before serving.
    expect(h.reasoningOptions).toEqual(['medium']);
  });

  it('never lets an explicit user reasoning request be overridden by an entry effort', async () => {
    // The user asked for xhigh; the chain entry carries its own low effort,
    // but an explicit user instruction always wins (the router fills a gap,
    // it does not override an instruction).
    const h = createDelegationHarness({
      chain: ['alpha/model:low'],
      reasoning: 'xhigh',
      userReasoningOverride: true,
      scripts: {
        'alpha/model': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
      registry: {
        find: (provider: string, id: string) =>
          registryModel(`${provider}/${id}`, {
            reasoning: true,
            thinkingLevelMap: {
              off: 'off', minimal: 'minimal', low: 'low', medium: 'medium',
              high: 'high', xhigh: 'xhigh', max: 'max',
            },
          }) as unknown as Model<Api>,
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.reasoningOptions).toEqual(['xhigh']);
  });

  it('serves an unmeasured fallback at the turn-level reasoning', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model:max', 'beta/other'],
      reasoning: 'max',
      scripts: {
        'alpha/model': [new Error('stream exploded')],
        'beta/other': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
      registry: {
        find: (provider: string, id: string) =>
          registryModel(`${provider}/${id}`, {
            reasoning: true,
            thinkingLevelMap: {
              off: 'off', minimal: 'minimal', low: 'low', medium: 'medium',
              high: 'high', xhigh: 'xhigh', max: 'max',
            },
          }) as unknown as Model<Api>,
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    // The unmeasured fallback inherits the turn-level reasoning (max from the
    // winning entry), clamped to its own support.
    expect(h.reasoningOptions).toEqual(['max', 'max']);
  });

  it('serves the first candidate after meaningful text', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/fast', 'beta/strong'],
      scripts: {
        'alpha/fast': [[
          { type: 'text_delta', delta: 'ok' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/fast']);
    expect(h.output.map((event) => (event as { type: string }).type)).toEqual([
      'text_delta',
      'done',
    ]);
  });

  it('builds routing decisions with the full fallback chain', () => {
    expect(routingDecision(['a/x', 'b/y']).fallbackChain).toEqual(['a/x', 'b/y']);
  });

  it.each([
    ['empty iterator', []],
    [
      'lifecycle-only completion',
      [
        { type: 'start' },
        { type: 'done', message: { stopReason: 'stop' } },
      ],
    ],
    ['done without a message', [{ type: 'done' }]],
  ])('falls back after %s', async (_name, firstEvents) => {
    const h = createDelegationHarness({
      chain: ['alpha/empty', 'beta/answer'],
      scripts: {
        'alpha/empty': [firstEvents],
        'beta/answer': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/empty', 'beta/answer']);
    expect(result.lastServed?.registryId).toBe('beta/answer');
  });

  it('classifies a length-only terminal event before generic answerless completion', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/limited', 'beta/answer'],
      scripts: {
        'alpha/limited': [[{ type: 'done', message: { stopReason: 'length' } }]],
        'beta/answer': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
    });

    const result = await h.run();
    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.blacklist).not.toContain('alpha/limited');
  });

  it('falls back to the model baseUrl when provider auth metadata hangs', async () => {
    setDelegationTimeouts({ authMs: 10 });
    const h = createDelegationHarness({
      chain: ['alpha/model'],
      getProviderAuth: () => new Promise(() => {}),
      scripts: {
        'alpha/model': [
          [
            { type: 'text_delta', delta: 'ok' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.streamedModels[0]?.baseUrl).toBe('https://alpha.example.test');
  });

  it('does not blacklist or attempt a fallback when aborted during retry entry', async () => {
    setDelegationTimeouts({ retryBackoffMs: 100 });
    const controller = new AbortController();
    const h = createDelegationHarness({
      chain: ['alpha/retry', 'beta/next'],
      signal: controller.signal,
      scripts: {
        'alpha/retry': [
          [
            {
              type: 'error',
              error: { stopReason: 'error', errorMessage: 'temporary overload' },
            },
          ],
        ],
      },
    });

    const pending = h.run();
    // Wait for the first attempt to finish (transient error). At this point
    // the loop has entered retry backoff (or is about to), so aborting now
    // cancels it before a fallback attempt.
    await h.waitForAttempts(1);
    controller.abort();
    const result = await pending;

    expect(result.streamFinalized).toBe(true);
    expect((h.output.at(-1) as { error?: { stopReason?: string } })?.error?.stopReason).toBe('aborted');
    expect(h.blacklist).toEqual([]);
    expect(h.attempts).toEqual(['alpha/retry']);
  });

  it('aborts during retry backoff without blacklisting or trying a fallback', async () => {
    setDelegationTimeouts({ retryBackoffMs: 100 });
    const controller = new AbortController();
    const h = createDelegationHarness({
      chain: ['alpha/retry', 'beta/next'],
      signal: controller.signal,
      scripts: {
        'alpha/retry': [
          [
            {
              type: 'error',
              error: { stopReason: 'error', errorMessage: 'temporary overload' },
            },
          ],
        ],
      },
    });

    const pending = h.run();
    // Wait for the first attempt to complete and enter retry backoff.
    await h.waitForAttempts(1);
    // Abort while the retry delay is in progress (100ms backoff).
    controller.abort();
    const result = await pending;

    expect(result.streamFinalized).toBe(true);
    expect((h.output.at(-1) as { type: string })?.type).toBe('error');
    expect(
      (h.output.at(-1) as { error?: { stopReason?: string } })?.error?.stopReason,
    ).toBe('aborted');
    expect(h.blacklist).toEqual([]);
    expect(h.attempts).toEqual(['alpha/retry']);
  });

  it('swallows a rejecting iterator cleanup without an unhandled rejection', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/cleanup', 'beta/answer'],
      scripts: {
        'alpha/cleanup': [
          [rejectingReturnStream([{ type: 'error', error: { errorMessage: 'boom' } }])],
        ],
        'beta/answer': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(result.lastServed?.registryId).toBe('beta/answer');
  });

  it('does not let three output-limit failures suppress a later sibling model', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/one', 'alpha/two', 'alpha/three', 'alpha/four'],
      scripts: {
        'alpha/one': [[{ type: 'done', message: { stopReason: 'length' } }]],
        'alpha/two': [[{ type: 'done', message: { stopReason: 'length' } }]],
        'alpha/three': [[{ type: 'done', message: { stopReason: 'length' } }]],
        'alpha/four': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
    });

    const result = await h.run();

    expect(result.lastServed?.registryId).toBe('alpha/four');
    expect(h.attempts).toEqual(['alpha/one', 'alpha/two', 'alpha/three', 'alpha/four']);
  });

  it('still splits a provider open after three provider-health failures', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/one', 'alpha/two', 'alpha/three', 'alpha/four', 'beta/answer'],
      scripts: {
        'alpha/one': [[{ type: 'error', error: { message: 'boom' } }]],
        'alpha/two': [[{ type: 'error', error: { message: 'boom' } }]],
        'alpha/three': [[{ type: 'error', error: { message: 'boom' } }]],
        'alpha/four': [
          [
            { type: 'text_delta', delta: 'late' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
        'beta/answer': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
    });

    const result = await h.run();

    // The provider is dead after three provider-health failures, so alpha/four is
    // skipped and the fallback provider's candidate serves.
    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.attempts).not.toContain('alpha/four');
  });
});

describe('runDelegationLoop fallback policy', () => {
  it('falls back after a pre-content error event', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/err', 'beta/answer'],
      scripts: {
        'alpha/err': [[{ type: 'error', error: { errorMessage: '421 Misdirected Request' } }]],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/err', 'beta/answer']);
    expect(result.lastServed?.registryId).toBe('beta/answer');
    // The failed candidate's error must not reach the user.
    expect(h.output.filter((e) => (e as { type: string }).type === 'error')).toHaveLength(0);
    expect(h.blacklist).toContain('alpha/err');
  });

  it('falls back after a thrown transport error', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/throw', 'beta/answer'],
      scripts: {
        'alpha/throw': [new Error('network down')],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/throw', 'beta/answer']);
    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.blacklist).toContain('alpha/throw');
  });

  it('retries the same model on a transient provider error before falling over', async () => {
    setDelegationTimeouts({ retryBackoffMs: 0 });
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [
          [{ type: 'error', error: { stopReason: 'error', errorMessage: '503 service unavailable' } }],
          [{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
        'beta/y': [
          [{ type: 'text_delta', delta: 'beta' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/x', 'alpha/x']);
    expect(h.blacklist).not.toContain('alpha/x');
  });

  it('retries a generic provider error once on the same model', async () => {
    setDelegationTimeouts({ retryBackoffMs: 0 });
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [
          [
            {
              type: 'error',
              error: { stopReason: 'error', errorMessage: 'Provider finish_reason: error' },
            },
          ],
          [{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
        'beta/y': [
          [{ type: 'text_delta', delta: 'beta' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/x', 'alpha/x']);
  });

  it('falls back after reasoning-only length without blacklisting', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/reason', 'beta/answer'],
      scripts: {
        'alpha/reason': [
          [
            { type: 'thinking_delta', delta: 'still reasoning' },
            { type: 'done', message: { stopReason: 'length' } },
          ],
        ],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/reason', 'beta/answer']);
    expect(h.blacklist).not.toContain('alpha/reason');
  });

  it('never replays after visible text followed by length', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [
          [
            { type: 'text_delta', delta: 'partial but visible' },
            { type: 'done', message: { stopReason: 'length' } },
          ],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/x']);
    expect(result.lastServed?.registryId).toBe('alpha/x');
    expect(h.output.some((e) => (e as { type: string }).type === 'text_delta')).toBe(true);
  });

  it('never replays after a tool call followed by length', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [
          [
            { type: 'toolcall_start' },
            { type: 'toolcall_delta', delta: '{}' },
            { type: 'toolcall_end' },
            { type: 'done', message: { stopReason: 'length' } },
          ],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/x']);
    expect(h.output.some((e) => (e as { type: string }).type === 'toolcall_start')).toBe(true);
  });

  it('uses one absolute meaningful-output deadline despite lifecycle heartbeats', async () => {
    setDelegationTimeouts({ firstEventMs: 40, authMs: 500 });
    const heartbeatStream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 20; i++) {
          yield { type: 'start' };
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise(() => {});
      },
    };
    const h = createDelegationHarness({
      chain: ['alpha/heartbeat', 'beta/answer'],
      scripts: {
        'alpha/heartbeat': [heartbeatStream],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/heartbeat', 'beta/answer']);
    expect(result.lastServed?.registryId).toBe('beta/answer');
  });

  it('does not kill provider siblings after one failed model', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/one', 'alpha/two'],
      scripts: {
        'alpha/one': [[{ type: 'error', error: { message: 'boom' } }]],
        'alpha/two': [
          [{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/one', 'alpha/two']);
    expect(h.blacklist).toContain('alpha/one');
    expect(result.lastServed?.registryId).toBe('alpha/two');
  });

  it('skips a candidate whose credential lookup has no usable key', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/no-auth', 'beta/ready'],
      credentials: {
        'alpha/no-auth': { ok: false },
        'beta/ready': { ok: true, apiKey: 'key' },
      },
      scripts: {
        'beta/ready': [
          [{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.lastServed?.registryId).toBe('beta/ready');
    expect(h.attempts).toEqual(['beta/ready']);
  });

  it('uses the credential-derived baseUrl, not the model default', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model'],
      getProviderAuth: async () => ({ auth: { baseUrl: 'https://api.alpha.override' } }),
      scripts: {
        'alpha/model': [
          [{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.streamedModels[0]?.baseUrl).toBe('https://api.alpha.override');
  });

  it('falls back after a hanging credential lookup times out', async () => {
    setDelegationTimeouts({ authMs: 20 });
    const h = createDelegationHarness({
      chain: ['alpha/hang', 'beta/answer'],
      registry: {
        getApiKeyAndHeaders: async (model: Model<Api>) => {
          // Only hang for the first candidate; the fallback must still resolve.
          if (`${model.provider}/${model.id}` === 'alpha/hang') return new Promise(() => {});
          return { ok: true, apiKey: 'test-key', headers: {} };
        },
      },
      scripts: {
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.blacklist).toContain('alpha/hang');
  });

  it('falls back after a hanging iterator cleanup without blocking', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/hang-return', 'beta/answer'],
      scripts: {
        'alpha/hang-return': [
          [hangingReturnStream([{ type: 'error', error: { errorMessage: 'boom' } }])],
        ],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    // The hanging return() must not block fallback — the loop does not await it.
    expect(result.success).toBe(true);
    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.attempts).toEqual(['alpha/hang-return', 'beta/answer']);
  });

  it('finalizes stream on abort before any candidate is attempted', async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted before the loop starts

    const h = createDelegationHarness({
      chain: ['alpha/first'],
      signal: controller.signal,
      scripts: {},
    });

    const result = await h.run();

    expect(result.success).toBe(false);
    expect(result.streamFinalized).toBe(true);
    expect(result.lastError).toBe('aborted');
    expect(h.attempts).toEqual([]);
  });
});

describe('runDelegationLoop usage-limit provider blacklist', () => {
  it('blacklists the whole provider on a usage-limit error, skips its siblings, and does not retry', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/one', 'alpha/two', 'beta/answer'],
      scripts: {
        'alpha/one': [
          [
            {
              type: 'error',
              error: {
                stopReason: 'error',
                errorMessage:
                  '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 5 days."}',
              },
            },
          ],
        ],
        'alpha/two': [
          [{ type: 'text_delta', delta: 'x' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.lastServed?.registryId).toBe('beta/answer');
    // Fail-fast: no same-model retry, and the sibling on the same provider is skipped.
    expect(h.attempts).toEqual(['alpha/one', 'beta/answer']);
    expect(h.blacklistedProviders).toEqual(['alpha']);
    expect(h.blacklist).toContain('alpha/one');
  });

  it('blacklists the provider on a plain 429 rate-limit error', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/one', 'beta/answer'],
      scripts: {
        'alpha/one': [
          [
            {
              type: 'error',
              error: { stopReason: 'error', errorMessage: '429: too many requests' },
            },
          ],
        ],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.attempts).toEqual(['alpha/one', 'beta/answer']);
    expect(h.blacklistedProviders).toEqual(['alpha']);
  });

  it('does not blacklist the provider for a transient overload error', async () => {
    setDelegationTimeouts({ retryBackoffMs: 0 });
    const h = createDelegationHarness({
      chain: ['alpha/one', 'beta/answer'],
      scripts: {
        'alpha/one': [
          [{ type: 'error', error: { stopReason: 'error', errorMessage: '503 service unavailable' } }],
          [{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.blacklistedProviders).toEqual([]);
    expect(h.blacklist).toEqual([]);
  });

  it('blacklists only the model for a non-usage provider error', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/one', 'beta/answer'],
      scripts: {
        'alpha/one': [[{ type: 'error', error: { errorMessage: '421 Misdirected Request' } }]],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.blacklistedProviders).toEqual([]);
    expect(h.blacklist).toEqual(['alpha/one']);
  });

  it('publishes capability for the fallback that actually emits the tool call', async () => {
    const decision = routingDecision(['test/frontier', 'test/inspect']);
    decision.multiWork = multiWorkRoutingMeta({
      candidateCapability: {
        'test/frontier': { taskRatio: 1, clearsTerminalFloor: true, viaInspectPromotion: false },
        'test/inspect': { taskRatio: 0.7, clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });
    const harness = createDelegationHarness({
      chain: ['test/frontier', 'test/inspect'],
      decision,
      scripts: {
        'test/frontier': [new Error('provider failed')],
        'test/inspect': [[
          { type: 'toolcall_start' },
          { type: 'toolcall_end' },
          { type: 'done' },
        ]],
      },
    });
    const result = await harness.run();
    expect(result.lastServed?.registryId).toBe('test/inspect');
    expect(result.lastServed?.capability?.candidate.clearsTerminalFloor).toBe(false);
    expect(getLastDecision()?.cause).toBe('error-fallback');
    expect(getLastDecision()?.multiWork?.servedCandidateKey).toBe('test/inspect');
  });
});