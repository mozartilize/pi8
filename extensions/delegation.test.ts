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
import { streamSimple } from '@earendil-works/pi-ai/compat';
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
  it('does not advertise a failed earlier candidate as a route_up target to fallback', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/strong:high', 'beta/fallback:medium'],
      enableRouteUpGuidance: true,
      scripts: {
        'alpha/strong': [new Error('stream exploded')],
        'beta/fallback': [[
          { type: 'text_delta', delta: 'served' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    expect((await h.run()).success).toBe(true);
    expect(h.systemPrompts[0]).toContain('[router/auto]');
    expect(h.systemPrompts.at(-1) ?? '').not.toContain('[router/auto]');
  });

  it('never forwards a failed candidate\'s answerless done into the consumer stream', async () => {
    // A provider that completes with a terminal `done` before any output (a
    // bridge returning an empty completion) must not finalize the caller's
    // turn: Pi ends the turn on the first `done` it receives, so leaking the
    // failed attempt's would persist an empty assistant message and drop the
    // fallback model's response.
    const h = createDelegationHarness({
      chain: ['alpha/broken', 'beta/fallback'],
      scripts: {
        'alpha/broken': [[{ type: 'done', message: { stopReason: 'stop' } }]],
        'beta/fallback': [[
          { type: 'start' },
          { type: 'text_delta', delta: 'served' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    expect((await h.run()).success).toBe(true);
    expect(h.output.filter((e) => (e as { type: string }).type === 'done')).toHaveLength(1);
    expect(h.output).toHaveLength(3);
    expect(h.output[0]).toEqual({ type: 'start' });
    expect(h.output[1]).toEqual({ type: 'text_delta', delta: 'served' });
  });

  it('falls back when a candidate spams events before meaningful output', async () => {
    // The per-attempt buffer is capped so a provider that floods lifecycle
    // events until the meaningful-output deadline fails the candidate
    // instead of growing the buffer unboundedly — and none of its spam
    // reaches the consumer stream.
    const h = createDelegationHarness({
      chain: ['alpha/spammy', 'beta/fallback'],
      scripts: {
        'alpha/spammy': [Array.from({ length: 10_001 }, () => ({ type: 'start' }))],
        'beta/fallback': [[
          { type: 'text_delta', delta: 'served' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.output).toEqual([
      { type: 'text_delta', delta: 'served' },
      { type: 'done', message: { stopReason: 'stop' } },
    ]);
    expect(h.blacklist).toContain('alpha/spammy');
  });

  it('does not commit overflow when the first thinking event is the one that overflows the buffer', async () => {
    // The overflow-commit branch requires the BUFFER to already hold
    // thinking, not the current (10,001st) event that triggered the
    // overflow check. 10,000 pure lifecycle events followed by a single
    // thinking delta must still fail this candidate as pathological spam and
    // fall over to the next one, never commit to live streaming.
    const h = createDelegationHarness({
      chain: ['alpha/spammy', 'beta/fallback'],
      scripts: {
        'alpha/spammy': [[
          ...Array.from({ length: 10_000 }, () => ({ type: 'start' })),
          { type: 'thinking_delta', delta: 'late thought' },
        ]],
        'beta/fallback': [[
          { type: 'text_delta', delta: 'served' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.output).toEqual([
      { type: 'text_delta', delta: 'served' },
      { type: 'done', message: { stopReason: 'stop' } },
    ]);
    expect(h.blacklist).toContain('alpha/spammy');
  });

  it('commits overflow when thinking is already buffered, then finalizes without fallback', async () => {
    // Overflow with thinking already in the buffer commits to live streaming
    // and locks replay. A later pre-answer error must finalize this turn,
    // not fall over to the next model (that would leak the reasoning into
    // another answer).
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/fallback'],
      scripts: {
        'alpha/x': [[
          { type: 'thinking_delta', delta: 'trace' },
          ...Array.from({ length: 10_000 }, () => ({ type: 'start' })),
          { type: 'error', error: { errorMessage: 'failed after thinking' } },
        ]],
        'beta/fallback': [[
          { type: 'text_delta', delta: 'served' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    const result = await h.run();

    expect(result.streamFinalized).toBe(true);
    expect(result.success).toBe(false);
    expect(h.attempts).toEqual(['alpha/x']);
    expect(h.output.some((e) => (e as { type: string }).type === 'thinking_delta')).toBe(true);
    expect(h.output.some((e) => (e as { type: string }).type === 'text_delta')).toBe(false);
  });

  it('serves when the first meaningful output arrives exactly at the cap boundary', async () => {
    // The cap must only fail pre-output spam. A candidate whose (cap+1)th
    // event is its first text has proven itself: it flushes its buffer and
    // serves, rather than having its answer discarded by the cap check.
    const h = createDelegationHarness({
      chain: ['alpha/edge'],
      scripts: {
        'alpha/edge': [[
          ...Array.from({ length: 10_000 }, () => ({ type: 'start' })),
          { type: 'text_delta', delta: 'late' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.output.at(-2)).toEqual({ type: 'text_delta', delta: 'late' });
    expect(h.output.at(-1)).toEqual({ type: 'done', message: { stopReason: 'stop' } });
    expect(h.blacklist).toEqual([]);
  });

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

  it('never leaks a failed candidate\'s pre-text thinking into the fallback answer', async () => {
    // R5: a candidate that streams reasoning then errors before any answer is
    // answerless. Its buffered thinking must be discarded with the attempt,
    // never stitched onto the fallback model's answer, and the consumer must
    // not see two models' `start` events.
    const h = createDelegationHarness({
      chain: ['alpha/thinker', 'beta/fallback'],
      scripts: {
        'alpha/thinker': [[
          { type: 'start' },
          { type: 'thinking_delta', delta: 'A-SECRET-REASONING-1' },
          { type: 'thinking_delta', delta: 'A-SECRET-REASONING-2' },
          { type: 'error', error: { message: 'boom' } },
        ]],
        'beta/fallback': [[
          { type: 'text_delta', delta: 'B-ANSWER' },
          { type: 'done', message: { stopReason: 'stop' } },
        ]],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/thinker', 'beta/fallback']);
    const types = h.output.map((e) => (e as { type: string }).type);
    expect(types.filter((t) => t === 'start').length).toBeLessThanOrEqual(1);
    expect(types).not.toContain('thinking_delta');
    expect(
      h.output.some((e) => String((e as { delta?: string }).delta ?? '').includes('SECRET')),
    ).toBe(false);
  });

  it('a single thinking token does not disable the answer deadline', async () => {
    // R5 liveness: thinking keeps a reasoning-stall deadline alive but must not
    // disarm it outright — a provider that emits one thinking token then hangs
    // still times out and falls over instead of blocking the turn forever.
    setDelegationTimeouts({ firstEventMs: 40, authMs: 500 });
    const thinkThenHang: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'thinking_delta', delta: 'reasoning...' };
        await new Promise(() => {});
      },
    };
    const h = createDelegationHarness({
      chain: ['alpha/staller', 'beta/answer'],
      scripts: {
        'alpha/staller': [thinkThenHang],
        'beta/answer': [
          [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }],
        ],
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/staller', 'beta/answer']);
    expect(result.lastServed?.registryId).toBe('beta/answer');
    expect(h.output.some((e) => (e as { type: string }).type === 'thinking_delta')).toBe(false);
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

describe('runDelegationLoop custom provider streamSimple dispatch', () => {
  it('dispatches through a provider-registered streamSimple instead of the generic compat one', async () => {
    // A virtual provider with a non-standard `api` (e.g. an OAuth/SDK-backed
    // subscription bridge) registers its own streamSimple via pi.registerProvider.
    // The generic compat streamSimple only knows built-in `api` types and throws
    // "No API provider registered for api: <custom>" for anything else.
    const customStreamSimple = vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', delta: 'served' };
        yield { type: 'done', message: { stopReason: 'stop' } };
      },
    });

    const h = createDelegationHarness({
      chain: ['bridge/model'],
      scripts: {},
      registry: {
        getProvider: (provider: string) =>
          (provider === 'bridge' ? ({ streamSimple: customStreamSimple } as never) : undefined),
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(customStreamSimple).toHaveBeenCalledTimes(1);
    expect(customStreamSimple.mock.calls[0]?.[0]).toMatchObject({ provider: 'bridge', id: 'model' });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('falls back to the generic compat streamSimple when the provider has none registered', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model'],
      scripts: {
        'alpha/model': [
          [
            { type: 'text_delta', delta: 'served' },
            { type: 'done', message: { stopReason: 'stop' } },
          ],
        ],
      },
      registry: {
        getProvider: () => undefined,
      },
    });

    const result = await h.run();

    expect(result.success).toBe(true);
    expect(h.attempts).toEqual(['alpha/model']);
  });
});