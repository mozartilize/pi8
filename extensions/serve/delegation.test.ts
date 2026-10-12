/**
 * Direct contract tests for `runDelegationLoop`.
 *
 * The harness (extensions/test-support/delegation-harness.ts) drives the loop
 * directly against a fake registry and scripted `streamSimple` events, so these
 * tests own fallback-lifecycle policy without going through the provider
 * integration layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Model, Api, Context } from '@earendil-works/pi-ai';

import { routingDecision, registryModel, candidate } from '../test-support/router-fixtures.js';
import { createDelegationHarness, rejectingReturnStream, hangingReturnStream } from '../test-support/delegation-harness.js';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { setDecisionLogBase } from '../host/decisionlog.js';
import { setDebugPath } from '../host/debuglog.js';
import { defaultRouterSession } from './router-session-state.js';
import { defaultBlacklistState } from './blacklist.js';
import { setDelegationTimeouts } from './delegation.js';
import type { AttemptUsageEvent } from '../types.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
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
  defaultRouterSession.reset();
  defaultBlacklistState.clearBlacklistedModels();
});

afterEach(() => {
  setDecisionLogBase(undefined);
  setDelegationTimeouts();
});

afterAll(() => {
  rmSync(decisionLogTestDir, { recursive: true, force: true });
});

describe('live answer streaming', () => {
  const text = (delta: string) => ({ type: 'text_delta', delta });
  const done = { type: 'done', message: { stopReason: 'stop' } };

  it('streams an answer immediately and makes one request without a handoff', async () => {
    const script = {
      async *[Symbol.asyncIterator]() {
        yield text('direct answer');
        expect(h.output).toEqual([text('direct answer')]);
        expect(h.session.getLastServed()?.registryId).toBe('a/model');
        yield done;
      },
    };
    const h = createDelegationHarness({ chain: ['a/model'], scripts: { 'a/model': [script] } });
    expect((await h.run()).success).toBe(true);
    expect(h.attempts).toEqual(['a/model']);
    expect(h.output).toEqual([text('direct answer'), done]);
  });

  it('never retries a visible answer after a later provider error', async () => {
    const h = createDelegationHarness({
      chain: ['a/model', 'b/fallback'],
      scripts: { 'a/model': [[text('answer'), { type: 'error', error: { errorMessage: '421' } }]] },
    });
    await h.run();
    expect(h.attempts).toEqual(['a/model']);
    expect(h.output.filter((e) => (e as { type: string }).type === 'text_delta')).toEqual([text('answer')]);
    expect(h.output.some((e) => (e as { type: string }).type === 'error')).toBe(true);
  });

  it('accepts visible output when the provider omits done', async () => {
    const h = createDelegationHarness({ chain: ['a/model'], scripts: { 'a/model': [[text('answer')]] } });
    expect((await h.run()).success).toBe(true);
    expect(h.attempts).toHaveLength(1);
    expect(h.output).toEqual([text('answer')]);
  });
});

describe('runDelegationLoop contracts', () => {
  it('falls back when an iterator rejects with a falsey error before any output', async () => {
    const rejectUndefined: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(undefined) }),
    };
    const h = createDelegationHarness({
      chain: ['alpha/broken', 'beta/fallback'],
      scripts: {
        'alpha/broken': [rejectUndefined],
        'beta/fallback': [[{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    expect((await h.run()).lastServed?.registryId).toBe('beta/fallback');
    expect(h.attempts).toEqual(['alpha/broken', 'beta/fallback']);
    expect(h.output.filter((event) => (event as { type: string }).type === 'done')).toHaveLength(1);
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

  it('asks beforeFallback only for a real model change, not a missing chain entry', async () => {
    const asked: Array<[string, string]> = [];
    const h = createDelegationHarness({
      chain: ['missing/ghost', 'alpha/first', 'beta/second'],
      scripts: {
        'alpha/first': [[{ type: 'error', error: { errorMessage: '421' } }]],
        'beta/second': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
      registry: {
        find: (provider: string, id: string) =>
          provider === 'missing' ? undefined : registryModel(`${provider}/${id}`) as never,
      },
      beforeFallback: async (candidateId, previousId) => {
        asked.push([candidateId, previousId]);
        return { kind: 'proceed' };
      },
    });

    expect((await h.run()).success).toBe(true);
    // missing/ghost never attempted, so the first real model is not a switch.
    // The hop from alpha/first → beta/second is.
    expect(asked).toEqual([['beta/second', 'alpha/first']]);
    expect(h.attempts).toEqual(['alpha/first', 'beta/second']);
  });

  it('applies a fallback substitution in place on the live chain and pool', async () => {
    const decision = routingDecision(['alpha/first', 'beta/second', 'gamma/third']);
    const chain = decision.fallbackChain;
    const pool = [candidate('alpha/first'), candidate('beta/second'), candidate('gamma/third')];
    const pick = candidate('delta/pick');
    const h = createDelegationHarness({
      chain,
      decision,
      candidates: pool,
      beforeFallback: async () => ({
        kind: 'substitute',
        decision: { ...routingDecision(['delta/pick']), cause: 'manual-override' },
        candidates: [pick],
      }),
      scripts: {
        'alpha/first': [[{ type: 'error', error: { errorMessage: '421' } }]],
        'delta/pick': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });

    expect((await h.run()).success).toBe(true);
    expect(h.attempts).toEqual(['alpha/first', 'delta/pick']);
    expect(decision.fallbackChain).toBe(chain);
    expect(chain).toEqual(['alpha/first', 'delta/pick']);
    expect(decision.cause).toBe('manual-override');
    expect(pool).toEqual([pick]);
    expect(h.session.getLastDecision()?.chosen).toBe('delta/pick');
  });

  it.each(['thinking_delta', 'start'])('bounds a single oversized %s payload before buffering', async (type) => {
    const h = createDelegationHarness({
      chain: ['alpha/huge', 'beta/fallback'],
      scripts: {
        'alpha/huge': [[{ type, delta: 'x'.repeat(2_000_000) }]],
        'beta/fallback': [[{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    expect((await h.run()).success).toBe(true);
    expect(h.output).toEqual([{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }]);
  });

  it('commits character overflow after buffered thinking without replay', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/huge', 'beta/fallback'],
      scripts: {
        'alpha/huge': [[
          { type: 'thinking_delta', delta: 'trace' },
          ...Array.from({ length: 3 }, () => ({ type: 'thinking_delta', delta: 'x'.repeat(400_000) })),
          { type: 'error', error: { errorMessage: 'failed after thinking' } },
        ]],
      },
    });
    expect((await h.run()).streamFinalized).toBe(true);
    expect(h.attempts).toEqual(['alpha/huge']);
    expect(h.output.some((event) => (event as { type: string }).type === 'thinking_delta')).toBe(true);
  });

  describe('tool loop handed to a candidate that declines it', () => {
    const toolLoop = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }] },
        { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'x' }] },
      ],
    } as unknown as Context;
    const answerless = [{ type: 'done', message: { stopReason: 'stop' } }];
    const answer = [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }];
    const lastMessage = (context: Context) => context.messages.at(-1) as { role: string; content: unknown };

    it('continues the task on the same candidate from a router-authored user turn', async () => {
      const h = createDelegationHarness({
        chain: ['bridge/agent'],
        context: toolLoop,
        scripts: { 'bridge/agent': [answerless, answer] },
      });

      expect((await h.run()).lastServed?.registryId).toBe('bridge/agent');
      expect(h.attempts).toEqual(['bridge/agent', 'bridge/agent']);
      expect(h.contexts[0]).toBe(h.sourceContext);
      expect(h.contexts[1]!.messages.slice(0, -1)).toEqual(toolLoop.messages);
      expect(lastMessage(h.contexts[1]!)).toMatchObject({ role: 'user', content: expect.any(String) });
      expect(h.sourceContext!.messages).toHaveLength(3);
      // The declined attempt's answerless done never reaches Pi.
      expect(h.output).toEqual(answer);
      expect(h.blacklist).toEqual([]);
    });

    it('keeps the handoff turn on retries of the handed-off attempt', async () => {
      const h = createDelegationHarness({
        chain: ['bridge/agent'],
        context: toolLoop,
        scripts: {
          'bridge/agent': [answerless, [{ type: 'error', error: { stopReason: 'error', errorMessage: 'overloaded' } }], answer],
        },
      });

      expect((await h.run()).success).toBe(true);
      expect(h.contexts.map((context) => lastMessage(context).role)).toEqual(['toolResult', 'user', 'user']);
    });

    it('hands off once, then falls back when the handoff gets no answer either', async () => {
      const h = createDelegationHarness({
        chain: ['bridge/agent', 'beta/fallback'],
        context: toolLoop,
        scripts: { 'bridge/agent': [answerless, answerless], 'beta/fallback': [answer] },
      });

      expect((await h.run()).lastServed?.registryId).toBe('beta/fallback');
      expect(h.attempts).toEqual(['bridge/agent', 'bridge/agent', 'beta/fallback']);
      // The fallback continues the original tool loop, not the handoff turn.
      expect(h.contexts[2]).toBe(h.sourceContext);
      expect(h.output).toEqual(answer);
    });

    it('never hands off a continuation that already ends on a user turn', async () => {
      const h = createDelegationHarness({
        chain: ['bridge/agent', 'beta/fallback'],
        scripts: { 'bridge/agent': [answerless], 'beta/fallback': [answer] },
      });

      expect((await h.run()).lastServed?.registryId).toBe('beta/fallback');
      expect(h.attempts).toEqual(['bridge/agent', 'beta/fallback']);
    });
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
    const events: AttemptUsageEvent[] = [];
    const h = createDelegationHarness({
      onAttemptUsage: (event) => events.push(event),
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
    expect(events[0]?.outputState).toEqual({ visibleTextReceived: false, toolCallReceived: false, committedToStream: true });
    expect(events[0]?.timing?.firstEventMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.timing).not.toHaveProperty('firstOutputMs');
    expect(JSON.stringify(events[0])).not.toContain('trace');
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

  const fullThinkingRegistry = {
    find: (provider: string, id: string) =>
      registryModel(`${provider}/${id}`, {
        reasoning: true,
        thinkingLevelMap: {
          off: 'off', minimal: 'minimal', low: 'low', medium: 'medium',
          high: 'high', xhigh: 'xhigh', max: 'max',
        },
      }) as unknown as Model<Api>,
  };
  const served = [{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }];

  it('serves a chain entry at its scored effort for every task type', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model:low'],
      scripts: { 'alpha/model': [served] },
      registry: fullThinkingRegistry,
    });
    expect((await h.run()).success).toBe(true);
    expect(h.reasoningOptions).toEqual(['low']);
  });

  it('raises entries of the incumbent model to the effort the incumbent served at, and no other model', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model:low', 'beta/model:low'],
      scripts: {
        'alpha/model': [[{ type: 'error', error: { errorMessage: '421' } }]],
        'beta/model': [served],
      },
      registry: fullThinkingRegistry,
      decision: { ...routingDecision(['alpha/model:low', 'beta/model:low']), incumbentEffort: { model: 'alpha/model', effort: 'high' } },
    });
    expect((await h.run()).success).toBe(true);
    expect(h.reasoningOptions).toEqual(['high', 'low']);
  });

  it('never lowers a scored effort above the incumbent effort', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model:max'],
      scripts: { 'alpha/model': [served] },
      registry: fullThinkingRegistry,
      decision: { ...routingDecision(['alpha/model:max']), incumbentEffort: { model: 'alpha/model', effort: 'high' } },
    });
    expect((await h.run()).success).toBe(true);
    expect(h.reasoningOptions).toEqual(['max']);
  });

  it('lets an explicit user thinking level win over the incumbent effort', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model:low'],
      scripts: { 'alpha/model': [served] },
      registry: fullThinkingRegistry,
      reasoning: 'minimal',
      userReasoningOverride: true,
      decision: { ...routingDecision(['alpha/model:low']), incumbentEffort: { model: 'alpha/model', effort: 'high' } },
    });
    expect((await h.run()).success).toBe(true);
    expect(h.reasoningOptions).toEqual(['minimal']);
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

  it('waits for slow request auth metadata without a deadline', async () => {
    vi.useFakeTimers();
    try {
      const h = createDelegationHarness({
        chain: ['alpha/model', 'beta/answer'],
        getProviderAuth: async () => {
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return undefined;
        },
        scripts: {
          'alpha/model': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop' } }]],
        },
      });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(6000);
      expect((await pending).lastServed?.registryId).toBe('alpha/model');
      expect(h.attempts).toEqual(['alpha/model']);
      expect(h.blacklist).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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

  it('waits through a long silence after thinking without replay', async () => {
    vi.useFakeTimers();
    try {
      const events: AttemptUsageEvent[] = [];
      const h = createDelegationHarness({
        chain: ['alpha/thinker', 'beta/answer'],
        scripts: {
          'alpha/thinker': [{
            async *[Symbol.asyncIterator]() {
              yield { type: 'thinking_delta', delta: 'reasoning...' };
              await new Promise((resolve) => setTimeout(resolve, 31000));
              yield { type: 'text_delta', delta: 'served' };
              yield { type: 'done', message: { stopReason: 'stop' } };
            },
          }],
        },
        onAttemptUsage: (event) => events.push(event),
      });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(31000);
      expect((await pending).lastServed?.registryId).toBe('alpha/thinker');
      expect(h.attempts).toEqual(['alpha/thinker']);
      expect(h.blacklist).toEqual([]);
      expect(events[0]).toMatchObject({
        timing: { authMs: 0, firstEventMs: 0, firstOutputMs: 31000, durationMs: 31000, maxEventGapMs: 31000 },
        outputState: { visibleTextReceived: true, toolCallReceived: false, committedToStream: false },
      });
    } finally {
      vi.useRealTimers();
    }
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

  it.each([
    ['visible text', [{ type: 'text_delta', delta: 'partial but visible' }]],
    ['a tool call', [{ type: 'toolcall_start' }, { type: 'toolcall_delta', delta: '{}' }, { type: 'toolcall_end' }]],
  ])('never replays after %s followed by a retryable error', async (_label, output) => {
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [[...output, { type: 'error', error: { stopReason: 'error', errorMessage: '503 service unavailable' } }]],
        'beta/y': [[{ type: 'text_delta', delta: 'replayed' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    await h.run();
    expect(h.attempts).toEqual(['alpha/x']);
    expect(h.output.some((e) => (e as { delta?: string }).delta === 'replayed')).toBe(false);
  });

  it.each([
    ['visible text', [{ type: 'text_delta', delta: 'partial but visible' }]],
    ['a tool call', [{ type: 'toolcall_start' }, { type: 'toolcall_delta', delta: '{}' }, { type: 'toolcall_end' }]],
  ])('never replays after %s when the stream then throws', async (_label, output) => {
    const throwsAfterOutput: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield* output;
        throw new Error('503 service unavailable');
      },
    };
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [throwsAfterOutput],
        'beta/y': [[{ type: 'text_delta', delta: 'replayed' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    await h.run();
    expect(h.attempts).toEqual(['alpha/x']);
    expect(h.output.some((e) => (e as { delta?: string }).delta === 'replayed')).toBe(false);
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

  it('waits for an answer after lifecycle events without a deadline', async () => {
    vi.useFakeTimers();
    try {
      const events: AttemptUsageEvent[] = [];
      const h = createDelegationHarness({
        onAttemptUsage: (event) => events.push(event),
        chain: ['alpha/heartbeat', 'beta/answer'],
        scripts: {
          'alpha/heartbeat': [{
            async *[Symbol.asyncIterator]() {
              yield { type: 'start' };
              await new Promise((resolve) => setTimeout(resolve, 16000));
              yield { type: 'start' };
              await new Promise((resolve) => setTimeout(resolve, 16000));
              yield { type: 'text_delta', delta: 'served' };
              yield { type: 'done', message: { stopReason: 'stop' } };
            },
          }],
        },
      });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(32000);
      expect((await pending).lastServed?.registryId).toBe('alpha/heartbeat');
      expect(h.attempts).toEqual(['alpha/heartbeat']);
      expect(events[0]?.timing).toEqual({ authMs: 0, firstEventMs: 0, firstOutputMs: 32000, durationMs: 32000, maxEventGapMs: 16000 });
    } finally {
      vi.useRealTimers();
    }
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

  it('allows caller cancellation of a hanging credential lookup', async () => {
    const controller = new AbortController();
    const authStarted = Promise.withResolvers<void>();
    const h = createDelegationHarness({
      chain: ['alpha/hang', 'beta/answer'],
      signal: controller.signal,
      registry: {
        getApiKeyAndHeaders: async () => {
          authStarted.resolve();
          return new Promise(() => {});
        },
      },
      scripts: {},
    });
    const pending = h.run();
    await authStarted.promise;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ success: false, streamFinalized: true, lastError: 'aborted' });
    expect(h.attempts).toEqual([]);
    expect(h.blacklist).toEqual([]);
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

  it('keeps a transient model eligible when a later retry hits the shared provider cap', async () => {
    setDelegationTimeouts({ retryBackoffMs: 0 });
    const h = createDelegationHarness({
      chain: ['alpha/one', 'beta/answer'],
      scripts: {
        'alpha/one': [
          [{ type: 'error', error: { stopReason: 'error', errorMessage: '503 service unavailable' } }],
          [{ type: 'error', error: { stopReason: 'error', errorMessage: '429: too many requests' } }],
        ],
        'beta/answer': [[{ type: 'text_delta', delta: 'served' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    expect((await h.run()).success).toBe(true);
    expect(h.attempts).toEqual(['alpha/one', 'alpha/one', 'beta/answer']);
    expect(h.blacklistedProviders).toEqual(['alpha']);
    expect(h.blacklist).not.toContain('alpha/one');
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

  it('uses registry streaming for a standard provider', async () => {
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

describe('attempt lifecycle', () => {
  it('does not persist a served decision after the session generation advances', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        await held;
        yield { type: 'text_delta', delta: 'stale' };
        yield { type: 'done', message: { stopReason: 'stop' } };
      },
    };
    const h = createDelegationHarness({
      chain: ['alpha/model'],
      scripts: { 'alpha/model': [delayed] },
    });
    const pending = h.run();
    await h.waitForAttempts(1);
    const marker = routingDecision(['newer/model']);
    h.session.reset();
    h.session.setLastDecision(marker);
    release();
    await pending;
    expect(h.session.getLastDecision()?.chosen).toBe('newer/model');
  });

  it('keeps a served attempt signal open and linked to the caller', async () => {
    const controller = new AbortController();
    const h = createDelegationHarness({
      chain: ['alpha/model'],
      signal: controller.signal,
      scripts: {
        'alpha/model': [[{ type: 'start' }, { type: 'text_delta', delta: 'x' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    await h.run();
    // A provider with its own agent loop waits on this signal for the next tool result.
    expect(h.abortSignals[0]?.aborted).toBe(false);
    controller.abort();
    expect(h.abortSignals[0]?.aborted).toBe(true);
  });

  it('logs which events kept an attempt open after its tool call ended', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi8-attempt-events-'));
    setDebugPath(join(dir, 'debug.log'));
    try {
      const h = createDelegationHarness({
        chain: ['alpha/model'],
        scripts: {
          'alpha/model': [[
            { type: 'start' },
            { type: 'toolcall_start' }, { type: 'toolcall_end' },
            { type: 'thinking_delta', delta: '' }, { type: 'thinking_delta', delta: '' },
            { type: 'done', message: { stopReason: 'toolUse' } },
          ]],
        },
      });
      await h.run();
      const line = readFileSync(join(dir, 'debug.log'), 'utf8').split('\n').find((l) => l.includes(' attempt.timing '))!;
      const timing = JSON.parse(line.slice(line.indexOf('{')));
      expect(timing.eventCounts).toEqual({ start: 1, toolcall_start: 1, toolcall_end: 1, thinking_delta: 2, done: 1 });
      expect(timing.lastEventType).toBe('done');
      expect(timing.toolCallEndMs).toBeGreaterThanOrEqual(0);
    } finally {
      setDebugPath(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts the signal of an attempt that failed before the next candidate starts', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/model', 'beta/model'],
      scripts: {
        'alpha/model': [[{ type: 'error', error: { stopReason: 'error', errorMessage: 'boom' } }]],
        'beta/model': [[{ type: 'start' }, { type: 'text_delta', delta: 'x' }, { type: 'done', message: { stopReason: 'stop' } }]],
      },
    });
    const result = await h.run();
    expect(result.success).toBe(true);
    expect(h.abortSignals[0]?.aborted).toBe(true);
    expect(h.abortSignals.at(-1)?.aborted).toBe(false);
  });
});

describe('failure reporting and spend', () => {
  it.each([
    ['an error payload message', { type: 'error', error: { stopReason: 'error', errorMessage: 'quota detail 7' } }],
    ['an error string', { type: 'error', error: 'quota detail 7' }],
    ['an event message', { type: 'error', message: 'quota detail 7' }],
  ])('reports the provider text from %s', async (_label, event) => {
    const h = createDelegationHarness({ chain: ['alpha/x'], scripts: { 'alpha/x': [[event]] } });
    const result = await h.run();
    expect(result.success).toBe(false);
    expect(result.lastError).toContain('quota detail 7');
  });

  it('reports the accounting of each attempt on its own model', async () => {
    const events: Array<Record<string, unknown>> = [];
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [[{ type: 'error', error: { stopReason: 'error', errorMessage: '421 misdirected', usage: { input: 10, output: 0, cost: { total: 0.25 } } } }]],
        'beta/y': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop', usage: { input: 10, output: 5, cost: { total: 0.5 } } } }]],
      },
      onAttemptUsage: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    expect((await h.run()).success).toBe(true);
    // The misdirected request is retried once on its own model. The retry has no usage.
    expect(events.map((event) => [event.candidateKey, event.served])).toEqual([['alpha/x', false], ['alpha/x', false], ['beta/y', true]]);
    expect(events[0]).toMatchObject({ usage: { input: 10, output: 0 }, providerReportedUsd: 0.25, usageComplete: true });
    expect(events[1]).toMatchObject({ usageComplete: false });
    expect(events[2]).toMatchObject({ usage: { input: 10, output: 5 }, providerReportedUsd: 0.5, usageComplete: true });
    expect(new Set(events.map((event) => event.usageEventId)).size).toBe(3);
  });

  it('records delayed first events and tool output separately from auth', async () => {
    vi.useFakeTimers();
    try {
      const events: AttemptUsageEvent[] = [];
      const h = createDelegationHarness({
        chain: ['alpha/tool'],
        getProviderAuth: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return undefined;
        },
        scripts: {
          'alpha/tool': [{
            async *[Symbol.asyncIterator]() {
              await new Promise((resolve) => setTimeout(resolve, 40000));
              yield { type: 'toolcall_start' };
              await new Promise((resolve) => setTimeout(resolve, 4000));
              yield { type: 'toolcall_end' };
              yield { type: 'done', message: { stopReason: 'toolUse' } };
            },
          }],
        },
        onAttemptUsage: (event) => events.push(event),
      });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(45000);
      expect((await pending).success).toBe(true);
      expect(h.attempts).toEqual(['alpha/tool']);
      expect(events[0]).toMatchObject({
        served: true,
        timing: { authMs: 1000, firstEventMs: 41000, firstOutputMs: 41000, durationMs: 45000, maxEventGapMs: 40000 },
        outputState: { visibleTextReceived: false, toolCallReceived: true, committedToStream: false },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records an unfinished silent attempt when the caller cancels it', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const events: AttemptUsageEvent[] = [];
      const h = createDelegationHarness({
        chain: ['alpha/silent', 'beta/answer'],
        signal: controller.signal,
        scripts: {
          'alpha/silent': [{
            async *[Symbol.asyncIterator]() {
              await new Promise((resolve) => setTimeout(resolve, 45000));
              controller.abort();
              await new Promise(() => {});
            },
          }],
        },
        onAttemptUsage: (event) => events.push(event),
      });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(45000);
      expect(await pending).toMatchObject({ success: false, streamFinalized: true, lastError: 'aborted' });
      expect(h.attempts).toEqual(['alpha/silent']);
      expect(h.blacklist).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        served: false,
        failure: { category: 'aborted' },
        timing: { authMs: 0, durationMs: 45000, maxEventGapMs: 45000 },
        outputState: { visibleTextReceived: false, toolCallReceived: false, committedToStream: false },
      });
      expect(events[0]?.timing).not.toHaveProperty('firstEventMs');
      expect(events[0]?.timing).not.toHaveProperty('firstOutputMs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the category and status of a failed attempt and never its message', async () => {
    const events: AttemptUsageEvent[] = [];
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [[{ type: 'error', error: { stopReason: 'error', errorMessage: "400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls' /home/u/secret.rs" } }]],
        'beta/y': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop', usage: { input: 1, output: 1 } } }]],
      },
      onAttemptUsage: (event) => events.push(event),
    });
    expect((await h.run()).success).toBe(true);
    expect(events[0]?.failure).toEqual({ category: 'tool-sequence', status: 400 });
    expect(JSON.stringify(events[0])).not.toContain('secret');
    expect(events.at(-1)?.failure).toBeUndefined();
  });

  it('marks an attempt without terminal usage as incomplete and survives a failing report', async () => {
    const events: AttemptUsageEvent[] = [];
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [[{ type: 'error', error: { stopReason: 'error', errorMessage: '421 misdirected' } }]],
        'beta/y': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop', usage: { input: 1, output: 1 } } }]],
      },
      onAttemptUsage: (event) => {
        events.push(event);
        if (events.length === 1) throw new Error('report failed');
      },
    });
    expect((await h.run()).success).toBe(true);
    expect(events[0]).toMatchObject({ served: false, usageComplete: false });
    expect(events[0]?.usage).toBeUndefined();
  });

  it('adds the provider-reported cost of every attempt, failed ones included', async () => {
    const h = createDelegationHarness({
      chain: ['alpha/x', 'beta/y'],
      scripts: {
        'alpha/x': [[{ type: 'error', error: { stopReason: 'error', errorMessage: '421 misdirected', usage: { input: 10, output: 0, cost: { total: 0.25 } } } }]],
        'beta/y': [[{ type: 'text_delta', delta: 'ok' }, { type: 'done', message: { stopReason: 'stop', usage: { input: 10, output: 5, cost: { total: 0.5 } } } }]],
      },
    });
    const before = h.session.getAccumulatedCost();
    expect((await h.run()).success).toBe(true);
    expect(h.session.getAccumulatedCost() - before).toBeCloseTo(0.75, 9);
  });
});
