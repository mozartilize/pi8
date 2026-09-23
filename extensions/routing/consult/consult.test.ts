/**
 * Unit tests for the always-on assessment layer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  contentText,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  expectedAssessorCost,
  runAssessment,
  selectAssessor,
  type AssessmentConfig,
  type AssessmentAttempt,
} from './consult.js';
import type { AssessmentEvidence } from './assessment-prompt.js';
import type { Candidate } from '../../types.js';
import { resetRouterSession } from '../../serve/router-session-state.js';
import {
  assistantMessage,
  runtimeProvider,
  runtimeRegistry,
  type AuthResolve,
  type RuntimeStream,
} from '../../test-support/runtime-registry.js';

beforeEach(() => resetRouterSession());

const evidence: AssessmentEvidence = {
  conversation: 'User: list the main features of docs/plan.md',
  toolNames: ['read'],
  skillNames: [],
  toolActivity: [],
};

const candidate = (
  id: string,
  intelligence?: number,
  extra: Record<string, unknown> = {},
): Candidate =>
  ({
    registryId: id,
    provider: id.split('/')[0],
    id: id.split('/')[1],
    available: true,
    cost: { input: 1, output: 3 },
    bench: intelligence == null ? undefined : { quality: { intelligence }, ...extra },
  }) as Candidate;

describe('selectAssessor — competence floor', () => {
  it('rejects an assessor below the intelligence ratio of the best routable', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/strong', 100), candidate('test/weak', 33)],
    );
    expect(chosen?.registryId).toBe('test/strong');
  });

  it('accepts a cheaper assessor that clears the floor', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [
        candidate('test/expensive', 100),
        { ...candidate('test/cheap', 60), cost: { input: 0.1, output: 0.3 } },
      ],
    );
    expect(chosen?.registryId).toBe('test/cheap');
  });

  it('ranks on the assessor input/output token shape', () => {
    const inputCheap = {
      ...candidate('test/input-cheap', 90),
      cost: { input: 0.1, output: 100 },
    };
    const outputCheap = {
      ...candidate('test/output-cheap', 90),
      cost: { input: 1, output: 1 },
    };
    const registry = {
      find: (provider: string, id: string) => ({ provider, id }),
    } as never;

    expect(selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      registry,
      [outputCheap, inputCheap],
      new Map(),
      { input: 10_000, output: 1 },
    )?.registryId).toBe('test/input-cheap');
    expect(selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      registry,
      [inputCheap, outputCheap],
      new Map(),
      { input: 1, output: 10_000 },
    )?.registryId).toBe('test/output-cheap');
  });

  it('uses complete benchmark pricing when registry pricing is absent', () => {
    const benchmarkPriced = candidate('test/benchmark-priced', 90, {
      priceInputPer1M: 2,
      priceOutputPer1M: 10,
    });
    benchmarkPriced.cost = undefined;
    expect(expectedAssessorCost(benchmarkPriced, { input: 1_000, output: 80 }))
      .toBeCloseTo((1_000 * 2 + 80 * 10) / 1_000_000, 12);
  });

  it('does not treat zero-filled custom pricing as free', () => {
    const custom = candidate('test/custom', undefined);
    custom.cost = { input: 0, output: 0 };
    expect(expectedAssessorCost(custom, { input: 1_000, output: 80 })).toBeUndefined();
    expect(expectedAssessorCost(candidate('test/known', 90), { input: -1, output: 80 }))
      .toBeUndefined();
  });

  it('keeps provider-specific free pricing authoritative over benchmark rates', () => {
    const freeVariant = candidate('test/free-variant', 90, {
      priceInputPer1M: 2,
      priceOutputPer1M: 10,
    });
    freeVariant.cost = { input: 0, output: 0 };
    expect(expectedAssessorCost(freeVariant, { input: 1_000, output: 80 })).toBe(0);
  });

  // Expected behavior change, not a contract violation: TTFT still never gates
  // on a fixed threshold, but a measured TTFT at or past the whole end-to-end
  // budget is an arithmetic impossibility, not a prediction.
  it('never excludes on latencyMsTtft when no deadline bounds the attempt', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/slow', 90, { latencyMsTtft: 200_000 })],
    );
    expect(chosen?.registryId).toBe('test/slow');
  });

  it('excludes a candidate whose measured TTFT exceeds the end-to-end deadline', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, deadlineMs: 1500 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [
        // Cheapest, but its first token lands after the deadline aborts.
        { ...candidate('test/doomed', 90, { latencyMsTtft: 1760 }), cost: { input: 0.1, output: 0.3 } },
        candidate('test/viable', 90, { latencyMsTtft: 750 }),
      ],
    );
    expect(chosen?.registryId).toBe('test/viable');
  });

  it('gates a reasoning row on time-to-first-ANSWER, not the fast first thinking token', () => {
    // deepseek-v4-pro pattern: ttft 1.6 s (a thinking token) but ttfa 71 s.
    // The gate must read the answer latency, or a guaranteed-expiry assessor
    // sneaks past on its fast thinking token.
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, deadlineMs: 1500 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [
        {
          ...candidate('test/reasoning-doomed', 90, { latencyMsTtft: 100, latencyMsTtfa: 1760 }),
          cost: { input: 0.1, output: 0.3 },
        },
        { ...candidate('test/viable', 90, { latencyMsTtft: 750, latencyMsTtfa: 900 }), cost: { input: 1, output: 3 } },
      ],
    );
    expect(chosen?.registryId).toBe('test/viable');
  });

  it('falls back to TTFT when the row has no answer measurement', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, deadlineMs: 1500 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [
        { ...candidate('test/only-ttft-doomed', 90, { latencyMsTtft: 1760 }), cost: { input: 0.1, output: 0.3 } },
        candidate('test/viable', 90, { latencyMsTtft: 750 }),
      ],
    );
    expect(chosen?.registryId).toBe('test/viable');
  });

  it('keeps an unmeasured TTFT eligible — absent data is not evidence of slowness', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, deadlineMs: 1500 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/unmeasured-ttft', 90)],
    );
    expect(chosen?.registryId).toBe('test/unmeasured-ttft');
  });

  it('returns no assessor rather than spending a request guaranteed to expire', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, deadlineMs: 1500 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/doomed', 90, { latencyMsTtft: 1760 })],
    );
    expect(chosen).toBeUndefined();
  });

  it('uses latencyMsTtft to break a tie between equally priced peers', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [
        candidate('test/a', 80, { latencyMsTtft: 9000 }),
        candidate('test/b', 80, { latencyMsTtft: 800 }),
      ],
    );
    expect(chosen?.registryId).toBe('test/b');
  });

  it('rejects a candidate with no intelligence measurement at all', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/unmeasured')],
    );
    expect(chosen).toBeUndefined();
  });

  it('honours an explicit modelRef when it is routable, bypassing the price order', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, modelRef: 'test/slow' } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [
        candidate('test/cheap', 60, { latencyMsTtft: 100 }),
        candidate('test/slow', 90, { latencyMsTtft: 9000 }),
      ],
    );
    expect(chosen?.registryId).toBe('test/slow');
  });

  it('ignores a modelRef that is not in the routable pool and falls back to selection', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5, modelRef: 'test/elsewhere' } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/only', 80)],
    );
    expect(chosen?.registryId).toBe('test/only');
  });

  it('returns undefined for an empty candidate pool', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [],
    );
    expect(chosen).toBeUndefined();
  });

  // Contract: struck assessors sink below un-struck ones (fewer strikes first),
  // but a strike NEVER excludes — the pool must never empty.
  it('prefers an un-struck equal candidate over a struck one', () => {
    const a = { ...candidate('test/a', 100), cost: { input: 1, output: 3 } };
    const b = { ...candidate('test/b', 100), cost: { input: 1, output: 3 } };
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [a, b],
      new Map([['test/a', 1]]),
    );
    expect(chosen?.registryId).toBe('test/b');
  });

  it('prefers the fewer-struck candidate when both are struck', () => {
    const a = { ...candidate('test/a', 100), cost: { input: 1, output: 3 } };
    const b = { ...candidate('test/b', 100), cost: { input: 1, output: 3 } };
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [a, b],
      new Map([
        ['test/a', 3],
        ['test/b', 1],
      ]),
    );
    expect(chosen?.registryId).toBe('test/b');
  });

  it('still selects a struck candidate when it is the only option', () => {
    const chosen = selectAssessor(
      { assessorQualityRatio: 0.5 } as never,
      { find: (p: string, i: string) => ({ provider: p, id: i }) } as never,
      [candidate('test/only', 80)],
      new Map([['test/only', 5]]),
    );
    expect(chosen?.registryId).toBe('test/only');
  });
});

const ASSESSOR = 'test/a';

const verdict = (kind: string, complexity: string, reasoning = 'ok') => [
  `Kind: ${kind}`,
  `Complexity: ${complexity}`,
  'Scope: bounded',
  'Compound: no',
  'Confidence: high',
  `Reasoning: ${reasoning}`,
].join('\n');

/** Usage as a provider reports it; `costTotal` absent models a custom provider that prices nothing. */
function usage(input: number, output: number, costTotal?: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    ...(costTotal == null ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal } }),
  } as Usage;
}

function terminal(message: AssistantMessage) {
  return message.stopReason === 'error' || message.stopReason === 'aborted'
    ? { type: 'error', reason: message.stopReason, error: message }
    : { type: 'done', reason: message.stopReason, message };
}

/** A provider that answers `text` and ends with the given terminal message fields. */
function reply(text: string, overrides: Partial<AssistantMessage> = {}): RuntimeStream {
  return () => {
    const stream = createAssistantMessageEventStream();
    const content = text ? [{ type: 'text' as const, text }] : [];
    stream.push(terminal(assistantMessage(ASSESSOR, { content, ...overrides })) as never);
    stream.end();
    return stream;
  };
}

/** A provider that neither answers nor honours cancellation. */
const ignoresAbort: RuntimeStream = () => createAssistantMessageEventStream();

/** A provider that settles a cancelled request with its partial output, as Pi providers do. */
function honoursAbort(partialText: string, spent: Usage): RuntimeStream {
  return (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    options?.signal?.addEventListener('abort', () => {
      const content = partialText ? [{ type: 'text' as const, text: partialText }] : [];
      stream.push(terminal(assistantMessage(ASSESSOR, { stopReason: 'aborted', content, usage: spent })) as never);
      stream.end();
    }, { once: true });
    return stream;
  };
}

/** A provider whose transport fails after `events`; Pi keeps the first terminal event. */
function failsAfter(events: unknown[], error: Error): RuntimeStream {
  return () => (async function* () {
    yield* events;
    throw error;
  })() as never;
}

const storedKey: AuthResolve = async ({ credential }) => ({ auth: { apiKey: credential?.key } });

let lastSentPrompt = '';
let dispatches = 0;

const assessorCandidate: Candidate = {
  registryId: ASSESSOR,
  provider: 'test',
  id: 'a',
  bench: {
    registryId: ASSESSOR,
    benchSlug: 'a',
    active: true,
    quality: { intelligence: 90 },
    source: 'test',
  },
  cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
  available: true,
};

/** Run one assessment through Pi's real registry, auth and lazy stream. */
async function assess(
  provider: RuntimeStream,
  over: Partial<AssessmentConfig> = {},
  options: { evidence?: AssessmentEvidence; candidates?: Candidate[]; resolve?: AuthResolve } = {},
): Promise<AssessmentAttempt> {
  lastSentPrompt = '';
  dispatches = 0;
  const registry = await runtimeRegistry([
    runtimeProvider('test', options.resolve ?? storedKey, (model, context, streamOptions) => {
      dispatches++;
      const [first] = context.messages;
      lastSentPrompt = first && 'content' in first ? contentText(first.content as string) : '';
      return provider(model, context, streamOptions);
    }, 'a'),
  ]);
  return runAssessment(
    { enabled: true, deadlineMs: 500, maxInputChars: 4000, assessorQualityRatio: 0.5, ...over },
    registry as unknown as ExtensionContext['modelRegistry'],
    options.candidates ?? [assessorCandidate],
    options.evidence ?? evidence,
  );
}

const usageLimitError = '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 5 days."}';

describe('assessment contract', () => {
  it('uses the v2 assessment contract', async () => {
    await assess(reply(verdict('implement', 'hard')));
    expect(dispatches).toBe(1);
    expect(lastSentPrompt).toContain('Kind: [lightweight|gather|plan|implement|review]');
    expect(lastSentPrompt).toContain('Complexity: [trivial|routine|moderate|hard|frontier]');
    expect(lastSentPrompt).not.toContain('Dimension:');
    expect(lastSentPrompt).not.toContain('Outcome:');
  });
});

describe('runAssessment', () => {
  it('returns no-assessor when no candidate clears the floor', async () => {
    const result = await runAssessment(
      { enabled: true, deadlineMs: 500, maxInputChars: 4000, assessorQualityRatio: 0.5 },
      { find: () => undefined } as never,
      [],
      evidence,
    );
    expect(result).toMatchObject({ ok: false, fallbackReason: 'no-assessor' });
  });

  it('returns disabled without dispatching when consultRouter is false', async () => {
    const result = await runAssessment(
      { enabled: false, deadlineMs: 500, maxInputChars: 4000, assessorQualityRatio: 0.5 },
      { find: () => ({ provider: 'test', id: 'a' }) } as never,
      [candidate('test/a', 90)],
      evidence,
    );
    expect(result).toMatchObject({ ok: false, fallbackReason: 'disabled' });
  });

  it('returns auth without dispatching when credentials cannot be resolved', async () => {
    const result = await assess(reply(verdict('gather', 'routine')), {}, { resolve: async () => undefined });
    expect(result).toMatchObject({ ok: false, fallbackReason: 'auth', model: ASSESSOR });
    expect(dispatches).toBe(0);
  });

  it('returns parse when the reply fails validation', async () => {
    const result = await assess(reply('Dimension: gather\nScope: nonsense'));
    expect(result).toMatchObject({ ok: false, fallbackReason: 'parse' });
  });

  it('returns a fully populated assessment on a valid reply', async () => {
    const result = await assess(reply(verdict('lightweight', 'trivial', 'a bounded extraction from one named file')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.kind).toBe('lightweight');
    expect(result.assessment.complexity).toBe('trivial');
    expect(result.assessment.compound).toBe(false);
    expect(result.assessment.scope).toBe('bounded');
    expect(result.assessment.confidence).toBe('high');
    expect(result.assessment.model).toBe(ASSESSOR);
    expect(result.assessment.ms).toBeGreaterThanOrEqual(0);
  });

  // A failure with no output is the dud signal the caller strikes, so it must
  // carry the chosen model and producedOutput:false.
  it('returns expiry within the settle window when the provider ignores cancellation', async () => {
    const started = Date.now();
    const result = await assess(ignoresAbort, { deadlineMs: 60 });
    expect(result).toMatchObject({ ok: false, fallbackReason: 'expiry', model: ASSESSOR, producedOutput: false });
    expect(Date.now() - started).toBeLessThan(400);
  });

  // A cancelled attempt still cost money, and partial text means the model is
  // slow rather than a dud, so it must not be struck.
  it('reports spend and partial output from a cancelled request', async () => {
    const result = await assess(honoursAbort('Kind: gath', usage(120, 4)), { deadlineMs: 60 });
    expect(result).toMatchObject({ ok: false, fallbackReason: 'expiry', model: ASSESSOR, producedOutput: true });
    if (!result.ok) expect(result.costUsd).toBeCloseTo((120 + 4 * 3) / 1e6, 10);
  });

  it('bounds auth and streaming under the single deadline', async () => {
    const started = Date.now();
    const result = await assess(ignoresAbort, { deadlineMs: 200 }, {
      resolve: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return storedKey(input);
      },
    });
    // Auth ate 120ms of the 200ms budget; the stream cannot get a fresh 200ms.
    expect(Date.now() - started).toBeLessThan(400);
    expect(result).toMatchObject({ ok: false, fallbackReason: 'expiry' });
  });

  it('does not dispatch a provider when auth resolves after the deadline', async () => {
    const result = await assess(reply(verdict('gather', 'routine')), { deadlineMs: 30 }, {
      resolve: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return storedKey(input);
      },
    });
    expect(result).toMatchObject({ ok: false, fallbackReason: 'expiry' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dispatches).toBe(0);
  });

  // A provider failure is an 'error' fallback whether it arrives as an error
  // event or as a transport failure.
  it('reports the assessor provider when the stream emits a usage-limit error event', async () => {
    const result = await assess(reply('', { stopReason: 'error', errorMessage: usageLimitError }));
    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'error',
      model: ASSESSOR,
      producedOutput: false,
      usageLimitProvider: 'test',
    });
  });

  it('keeps the usage-limit signal from a custom error message without content', async () => {
    const result = await assess(reply('', {
      stopReason: 'error',
      errorMessage: usageLimitError,
      content: undefined as never,
    }));
    expect(result).toMatchObject({ ok: false, fallbackReason: 'error', usageLimitProvider: 'test' });
  });

  it('reports the assessor provider when the transport throws a usage-limit error', async () => {
    const result = await assess(failsAfter([], new Error('429: too many requests')));
    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'error',
      model: ASSESSOR,
      producedOutput: false,
      usageLimitProvider: 'test',
    });
  });

  it('does not attach usageLimitProvider for a non-usage assessor error', async () => {
    const result = await assess(reply('', { stopReason: 'error', errorMessage: '421 Misdirected Request' }));
    expect(result).toMatchObject({ ok: false, fallbackReason: 'error', model: ASSESSOR });
    expect('usageLimitProvider' in result).toBe(false);
  });

  it('keeps the usage-limit signal and partial text when the connection drops afterwards', async () => {
    const partial = [{ type: 'text' as const, text: 'Let me look at this...' }];
    const result = await assess(failsAfter(
      [terminal(assistantMessage(ASSESSOR, { stopReason: 'error', errorMessage: usageLimitError, content: partial }))],
      new Error('read ECONNRESET'),
    ));
    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'error',
      model: ASSESSOR,
      producedOutput: true,
      usageLimitProvider: 'test',
    });
  });

  it('does not treat output-limit exhaustion as a usage-limit signal', async () => {
    const result = await assess(reply('', {
      stopReason: 'length',
      errorMessage: 'max tokens reached for this request',
      usage: usage(120, 30),
    }));
    expect(result).toMatchObject({ ok: false, fallbackReason: 'parse', model: ASSESSOR });
    expect('usageLimitProvider' in result).toBe(false);
    if (!result.ok) expect(result.costUsd).toBeCloseTo(120 / 1e6 + (30 * 3) / 1e6, 10);
  });

  it('prices terminal usage at candidate rates when the provider reports no cost', async () => {
    const result = await assess(reply(verdict('gather', 'routine'), { usage: usage(120, 30) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.usage).toEqual({ input: 120, output: 30 });
    // test/a costs 1 USD / 1M input and 3 USD / 1M output.
    expect(result.assessment.costUsd).toBeCloseTo(120 / 1e6 + (30 * 3) / 1e6, 10);
  });

  it('uses the provider terminal cost total when registry pricing is authoritative', async () => {
    const result = await assess(reply(verdict('gather', 'routine'), { usage: usage(120, 30, 0.123) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.costUsd).toBe(0.123);
  });

  it('uses benchmark pricing for actual spend when registry pricing is absent', async () => {
    const benchmarkPriced = candidate(ASSESSOR, 90, { priceInputPer1M: 2, priceOutputPer1M: 10 });
    benchmarkPriced.cost = undefined;
    const result = await assess(
      reply(verdict('gather', 'routine'), { usage: usage(120, 30, 0.123) }),
      {},
      { candidates: [benchmarkPriced] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.costUsd).toBeCloseTo((120 * 2 + 30 * 10) / 1e6, 10);
  });

  it('never sends tool arguments, tool results or skill descriptions', async () => {
    await assess(reply(verdict('lightweight', 'trivial')), {}, {
      evidence: {
        conversation: 'User: fix the bug',
        toolNames: ['read'],
        skillNames: ['systematic-debugging'],
        toolActivity: [{ name: 'read', count: 2 }],
      },
    });
    expect(lastSentPrompt).toContain('read');
    expect(lastSentPrompt).toContain('systematic-debugging');
    expect(lastSentPrompt).not.toContain('"path"');
    expect(lastSentPrompt).not.toContain('Use read to examine files');
  });
});
