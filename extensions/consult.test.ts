/**
 * Unit tests for the always-on assessment layer (formerly the consult gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  expectedAssessorCost,
  runAssessment,
  selectAssessor,
  type AssessmentConfig,
  type AssessmentAttempt,
} from './consult.js';
import { classify } from './classifier.js';
import type { AssessmentEvidence } from './assessment-prompt.js';
import type { Candidate } from './types.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Model, Api, Context } from '@earendil-works/pi-ai';
import { resetRouterSession } from './router-session-state.js';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

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

function asStreamWithUsage(
  text: string,
  usage: { inputTokens: number; outputTokens: number; costTotal?: number },
): AsyncIterable<{ type: string }> {
  const events: Array<{
    type: string;
    delta?: string;
    message?: {
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cost?: { total: number };
      };
    };
  }> = [
    { type: 'text_delta', delta: text },
    {
      type: 'done',
      message: {
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: 0,
          ...(usage.costTotal == null ? {} : { cost: { total: usage.costTotal } }),
        },
      },
    },
  ];
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: async () => {
          if (i < events.length) {
            const value = events[i];
            i += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

let lastSentPrompt = '';

function asTextStream(text: string): AsyncIterable<{ type: string }> {
  return {
    [Symbol.asyncIterator]: () => {
      let sent = false;
      return {
        next: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: { type: 'text_delta', delta: text } };
        },
      };
    },
  };
}

async function runAssessmentWithStream(
  stream: AsyncIterable<{ type: string }>,
  over: Partial<AssessmentConfig> = {},
  sentEvidence: AssessmentEvidence = evidence,
  candidateOverrides?: Candidate[],
): Promise<AssessmentAttempt> {
  const { streamSimple } = await import('@earendil-works/pi-ai/compat');
  vi.mocked(streamSimple).mockImplementation(((_model: Model<Api>, context: Context) => {
    const content = context.messages[0]?.content;
    lastSentPrompt = typeof content === 'string' ? content : '';
    return stream as never;
  }) as never);

  const candidates: Candidate[] = candidateOverrides ?? [
    {
      registryId: 'test/a',
      provider: 'test',
      id: 'a',
      bench: {
        registryId: 'test/a',
        benchSlug: 'a',
        active: true,
        quality: { intelligence: 90 },
        source: 'test',
      },
      cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
      available: true,
    },
  ];
  const registry = {
    find: () => ({ id: 'a', provider: 'test' } as unknown as Model<Api>),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'k', headers: {} }),
  } as unknown as ExtensionContext['modelRegistry'];

  return runAssessment(
    {
      enabled: true,
      mode: 'shadow',
      deadlineMs: 500,
      maxInputChars: 4000,
      assessorQualityRatio: 0.5,
      ...over,
    },
    registry,
    candidates,
    sentEvidence,
  );
}

const runAssessmentWithStreamText = (text: string): Promise<AssessmentAttempt> =>
  runAssessmentWithStream(asTextStream(text));

async function runAssessmentWithNeverEndingStream({
  deadlineMs,
  usageBefore,
}: {
  deadlineMs: number;
  usageBefore?: boolean;
}): Promise<AssessmentAttempt> {
  const events: Array<{ type: string; usage?: { inputTokens?: number; outputTokens?: number } }> =
    usageBefore ? [{ type: 'usage', usage: { inputTokens: 120 } }] : [];
  const neverEnding: AsyncIterable<{ type: string }> = {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: (): Promise<IteratorResult<{ type: string }>> => {
          if (i < events.length) {
            const value = events[i];
            i += 1;
            return Promise.resolve({ done: false, value });
          }
          return new Promise(() => {});
        },
      };
    },
  };
  return runAssessmentWithStream(neverEnding, { deadlineMs });
}

/**
 * A stream that never resolves `next` but records `return()` calls, so the
 * expiry path's iterator release is observable.
 */
function neverEndingWithReturnTracker(): {
  stream: AsyncIterable<{ type: string }>;
  wasReturned: () => boolean;
} {
  let returned = false;
  const stream: AsyncIterable<{ type: string }> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<{ type: string }>> => new Promise(() => {}),
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return { stream, wasReturned: () => returned };
}

async function capturePromptSentFor(customEvidence: AssessmentEvidence): Promise<string> {
  lastSentPrompt = '';
  await runAssessmentWithStream(
    asTextStream(
      [
        'Kind: lightweight',
        'Complexity: trivial',
        'Scope: bounded',
        'Compound: no',
        'Confidence: high',
        'Reasoning: ok',
      ].join('\n'),
    ),
    {},
    customEvidence,
  );
  return lastSentPrompt;
}

describe('assessment contract', () => {
  it.each(['shadow', 'active'] as const)('uses one v2 contract in %s mode', async (mode) => {
    const { streamSimple } = await import('@earendil-works/pi-ai/compat');
    vi.mocked(streamSimple).mockClear();
    await runAssessmentWithStream(
      asTextStream([
        'Kind: implement',
        'Complexity: hard',
        'Scope: open-ended',
        'Compound: yes',
        'Confidence: high',
        'Reasoning: ok',
      ].join('\n')),
      { mode },
    );
    expect(vi.mocked(streamSimple).mock.calls.length).toBe(1);
    expect(lastSentPrompt).toContain('Kind: [lightweight|gather|plan|implement|review]');
    expect(lastSentPrompt).toContain('Complexity: [trivial|routine|moderate|hard|frontier]');
    expect(lastSentPrompt).not.toContain('Dimension:');
    expect(lastSentPrompt).not.toContain('Outcome:');
  });
});

describe('runAssessment', () => {
  it('returns no-assessor when no candidate clears the floor', async () => {
    const result = await runAssessment(
      { enabled: true, mode: 'shadow', deadlineMs: 500, maxInputChars: 4000, assessorQualityRatio: 0.5 },
      { find: () => undefined } as never,
      [],
      evidence,
    );
    expect(result).toMatchObject({ ok: false, fallbackReason: 'no-assessor' });
  });

  it('returns disabled without dispatching when consultRouter is false', async () => {
    const result = await runAssessment(
      { enabled: false, mode: 'shadow', deadlineMs: 500, maxInputChars: 4000, assessorQualityRatio: 0.5 },
      { find: () => ({ provider: 'test', id: 'a' }) } as never,
      [candidate('test/a', 90)],
      evidence,
    );
    expect(result).toMatchObject({ ok: false, fallbackReason: 'disabled' });
  });

  it('returns auth when credentials cannot be resolved', async () => {
    const result = await runAssessment(
      { enabled: true, mode: 'shadow', deadlineMs: 500, maxInputChars: 4000, assessorQualityRatio: 0.5 },
      {
        find: () => ({ provider: 'test', id: 'a' }),
        getApiKeyAndHeaders: async () => ({ ok: false }),
      } as never,
      [candidate('test/a', 90)],
      evidence,
    );
    expect(result).toMatchObject({ ok: false, fallbackReason: 'auth' });
  });

  it('returns parse when the reply fails validation', async () => {
    const result = await runAssessmentWithStreamText('Dimension: gather\nScope: nonsense');
    expect(result).toMatchObject({ ok: false, fallbackReason: 'parse' });
  });

  it('returns expiry when the deadline elapses before any output', async () => {
    const result = await runAssessmentWithNeverEndingStream({ deadlineMs: 60 });
    // Failure carries the chosen model and producedOutput:false so the caller
    // can strike a model that emitted nothing before the deadline (the dud
    // signal that dominated the corpus).
    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'expiry',
      model: 'test/a',
      producedOutput: false,
    });
  });

  it('returns a fully populated assessment on a valid reply', async () => {
    const result = await runAssessmentWithStreamText(
      [
        'Kind: lightweight',
        'Complexity: trivial',
        'Scope: bounded',
        'Compound: no',
        'Confidence: high',
        'Reasoning: a bounded extraction from one named file',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.kind).toBe('lightweight');
    expect(result.assessment.complexity).toBe('trivial');
    expect(result.assessment.compound).toBe(false);
    expect(result.assessment.scope).toBe('bounded');
    expect(result.assessment.confidence).toBe('high');
    expect(result.assessment.model).toBe('test/a');
    expect(result.assessment.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports the assessor provider when the stream emits a usage-limit error event', async () => {
    const stream: AsyncIterable<{ type: string }> = (async function* () {
      yield {
        type: 'error',
        error: {
          stopReason: 'error',
          errorMessage:
            '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 5 days."}',
        },
      };
    })();

    const result = await runAssessmentWithStream(stream);

    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'parse',
      model: 'test/a',
      producedOutput: false,
      usageLimitProvider: 'test',
    });
  });

  it('reports the assessor provider when the stream throws a usage-limit error', async () => {
    const throwing: AsyncIterable<{ type: string }> = {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<{ type: string }>> =>
          Promise.reject(new Error('429: too many requests')),
      }),
    };

    const result = await runAssessmentWithStream(throwing);

    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'error',
      model: 'test/a',
      producedOutput: false,
      usageLimitProvider: 'test',
    });
  });

  it('does not attach usageLimitProvider for a non-usage assessor error', async () => {
    const stream: AsyncIterable<{ type: string }> = (async function* () {
      yield { type: 'error', error: { stopReason: 'error', errorMessage: '421 Misdirected Request' } };
    })();

    const result = await runAssessmentWithStream(stream);

    expect(result).toMatchObject({ ok: false, fallbackReason: 'parse', model: 'test/a' });
    expect('usageLimitProvider' in result).toBe(false);
  });

  it('attaches usageLimitProvider after partial text even when the provider drops the connection', async () => {
    // Partial narration, then a usage-limit error event, then a thrown
    // transport error on the next next(): the usage-limit signal must survive
    // the overwrite-by-throw and still blacklist the provider.
    const stream: AsyncIterable<{ type: string }> = (async function* () {
      yield { type: 'text_delta', delta: 'Let me look at this...' };
      yield {
        type: 'error',
        error: {
          stopReason: 'error',
          errorMessage: '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached."}',
        },
      };
      throw new Error('read ECONNRESET');
    })();

    const result = await runAssessmentWithStream(stream);

    expect(result).toMatchObject({
      ok: false,
      fallbackReason: 'error',
      model: 'test/a',
      producedOutput: true,
      usageLimitProvider: 'test',
    });
  });

  it('does not treat an error event with stopReason length as a usage-limit signal', async () => {
    const stream: AsyncIterable<{ type: string }> = (async function* () {
      yield {
        type: 'error',
        error: {
          stopReason: 'length',
          errorMessage: 'max tokens reached for this request',
          usage: { input: 120, output: 30, cacheRead: 0 },
        },
      };
    })();

    const result = await runAssessmentWithStream(stream);

    expect(result).toMatchObject({ ok: false, fallbackReason: 'parse', model: 'test/a' });
    expect('usageLimitProvider' in result).toBe(false);
    if (!result.ok) {
      expect(result.costUsd).toBeCloseTo(120 / 1e6 + (30 * 3) / 1e6, 10);
    }
  });

  it('extracts terminal protocol usage and computes exact candidate cost', async () => {
    const result = await runAssessmentWithStream(
      asStreamWithUsage(
        [
          'Kind: gather',
          'Complexity: routine',
          'Scope: bounded',
          'Compound: no',
          'Confidence: high',
          'Reasoning: reading a few files',
        ].join('\n'),
        { inputTokens: 120, outputTokens: 30 },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.usage).toEqual({ input: 120, output: 30 });
    // test/a costs 1 USD / 1M input and 3 USD / 1M output.
    expect(result.assessment.costUsd).toBeCloseTo(120 / 1e6 + (30 * 3) / 1e6, 10);
  });

  it('uses the provider terminal cost total when registry pricing is authoritative', async () => {
    const result = await runAssessmentWithStream(
      asStreamWithUsage(
        [
          'Kind: gather',
          'Complexity: routine',
          'Scope: bounded',
          'Compound: no',
          'Confidence: high',
          'Reasoning: reading a few files',
        ].join('\n'),
        { inputTokens: 120, outputTokens: 30, costTotal: 0.123 },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.costUsd).toBe(0.123);
  });

  it('uses benchmark pricing for actual spend when registry pricing is absent', async () => {
    const benchmarkPriced = candidate('test/a', 90, {
      priceInputPer1M: 2,
      priceOutputPer1M: 10,
    });
    benchmarkPriced.cost = undefined;
    const result = await runAssessmentWithStream(
      asStreamWithUsage(
        [
          'Kind: gather',
          'Complexity: routine',
          'Scope: bounded',
          'Compound: no',
          'Confidence: high',
          'Reasoning: reading a few files',
        ].join('\n'),
        { inputTokens: 120, outputTokens: 30 },
      ),
      {},
      evidence,
      [benchmarkPriced],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.costUsd).toBeCloseTo((120 * 2 + 30 * 10) / 1e6, 10);
  });

  it('calls iterator.return() when the deadline expires mid-stream', async () => {
    const { stream, wasReturned } = neverEndingWithReturnTracker();
    const result = await runAssessmentWithStream(stream, { deadlineMs: 50 });
    expect(result).toMatchObject({ ok: false, fallbackReason: 'expiry' });
    expect(wasReturned()).toBe(true);
  });

  it('bounds auth and streaming under the single deadline', async () => {
    const started = Date.now();
    const { streamSimple } = await import('@earendil-works/pi-ai/compat');
    vi.mocked(streamSimple).mockImplementation((() =>
      ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }) as never) as never);

    const registry = {
      find: () => ({ provider: 'test', id: 'a' }),
      getApiKeyAndHeaders: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true, apiKey: 'k' };
      },
    };

    const result = await runAssessment(
      { enabled: true, mode: 'shadow', deadlineMs: 200, maxInputChars: 4000, assessorQualityRatio: 0.5 },
      registry as never,
      [candidate('test/a', 90)],
      evidence,
    );

    // Auth ate 120ms of the 200ms budget; the stream cannot get a fresh 200ms.
    expect(Date.now() - started).toBeLessThan(400);
    expect(result).toMatchObject({ ok: false, fallbackReason: 'expiry' });
  });

  it('returns expiry for a timed-out attempt', async () => {
    const timedOut = await runAssessmentWithNeverEndingStream({ deadlineMs: 60, usageBefore: true });
    // A cancelled attempt still cost money; the failure return carries costUsd
    // and ms so the caller can account for the wasted spend.
    expect(timedOut).toMatchObject({ ok: false, fallbackReason: 'expiry' });
    if (!timedOut.ok) {
      expect(timedOut.costUsd).toBeGreaterThan(0);
      expect(timedOut.ms).toBeGreaterThan(0);
    }
  });

  it('never sends tool arguments, tool results or skill descriptions', async () => {
    const sent = await capturePromptSentFor({
      conversation: 'User: fix the bug',
      toolNames: ['read'],
      skillNames: ['systematic-debugging'],
      toolActivity: [{ name: 'read', count: 2 }],
    });
    expect(sent).toContain('read');
    expect(sent).toContain('systematic-debugging');
    expect(sent).not.toContain('"path"');
    expect(sent).not.toContain('Use read to examine files');
  });
});

describe('consult integration with classifier', () => {
  it('motivating prompt now classifies high enough to avoid lightweight', () => {
    const prompt =
      'ok, put it aside, lets try something harder. currently we learn pi-subagents and support it, what if after we publish this extension, other extensions especially subagents extensions want to utilize it, which mean we have to expose some apis for them to use, go for a research';
    const result = classify(prompt);
    expect(result.dimension).not.toBe('lightweight');
  });
});

describe('runAssessment custom provider streamSimple dispatch', () => {
  it('dispatches through a provider-registered streamSimple instead of the generic compat one', async () => {
    const { streamSimple } = await import('@earendil-works/pi-ai/compat');
    vi.mocked(streamSimple).mockClear();

    const responseText = [
      'Kind: gather',
      'Complexity: routine',
      'Scope: bounded',
      'Compound: no',
      'Confidence: high',
      'Reasoning: reading a few files',
    ].join('\n');
    const customStreamSimple = vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', delta: responseText };
        yield { type: 'done', message: { stopReason: 'stop' } };
      },
    });

    const candidates: Candidate[] = [
      {
        registryId: 'bridge/model',
        provider: 'bridge',
        id: 'model',
        bench: {
          registryId: 'bridge/model',
          benchSlug: 'model',
          active: true,
          quality: { intelligence: 90 },
          source: 'test',
        },
        cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
        available: true,
      },
    ];
    const registry = {
      find: () => ({ id: 'model', provider: 'bridge' } as unknown as Model<Api>),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'k', headers: {} }),
      getProvider: (provider: string) =>
        (provider === 'bridge' ? ({ streamSimple: customStreamSimple } as never) : undefined),
    } as unknown as ExtensionContext['modelRegistry'];

    const result = await runAssessment(
      {
        enabled: true,
        mode: 'active',
        deadlineMs: 500,
        maxInputChars: 4000,
        assessorQualityRatio: 0.5,
      },
      registry,
      candidates,
      evidence,
    );

    expect(result.ok).toBe(true);
    expect(customStreamSimple).toHaveBeenCalledTimes(1);
    expect(streamSimple).not.toHaveBeenCalled();
  });
});
