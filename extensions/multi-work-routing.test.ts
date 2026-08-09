/**
 * End-to-end acceptance tests for terminal multi-work routing.
 *
 * Drives the real `router/auto` provider (provider.ts -> delegation.ts ->
 * scorer.ts -> work-phase.ts) through `setupProviderTest`, then preflights
 * mutation tool calls the same way `index.ts`'s `tool_call` hook does — via
 * the real `evaluateMutationCall`/`commitWorkPhaseState`/`getLastServed`
 * accessors — to prove the whole pipeline composes correctly across one
 * continuous session. No individual layer is faked beyond the network
 * boundary (`streamSimple`).
 *
 * `setupProviderTest` calls `vi.resetModules()` per invocation, so the
 * provider-level tests re-import `router-session-state.js`/`mutation-gate.js`
 * after each `setupProviderTest` call to bind to the same module instance
 * `provider.js`/`delegation.js` actually mutate — a stale top-level import
 * would silently read a different, untouched module instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';

import { createTempRouterDir } from './test-support/temp-router-dir.js';
import { asStream, setupProviderTest } from './test-support/provider-harness.js';
import { createDelegationHarness } from './test-support/delegation-harness.js';
import { multiWorkRoutingMeta, routingDecision } from './test-support/router-fixtures.js';
import { evaluateMutationCall } from './mutation-gate.js';
import {
  commitWorkPhaseState,
  getLastDecision,
  getLastServed,
} from './router-session-state.js';
import type { BenchModel } from './types.js';
import type { WorkPhaseState } from './work-phase.js';

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: vi.fn(),
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
vi.mock('./embedding.js', () => ({ embedAndClassify: vi.fn() }));

let temp: ReturnType<typeof createTempRouterDir>;

beforeEach(() => {
  temp = createTempRouterDir();
});

afterEach(async () => {
  const { setDecisionLogBase } = await import('./decisionlog.js');
  setDecisionLogBase(undefined);
  vi.restoreAllMocks();
  temp.cleanup();
});

// Same compound-work fixture proven in provider.test.ts's multi-work describe:
// keyword-classifies 'implement' AND satisfies the terminal classifier's
// prerequisite -> sequence -> mutation structure with an explicit
// frontier-complexity, open-scope cue.
const compoundPrompt =
  'Trace the race condition across the codebase from scratch, then fix it, refactor it, and implement the corrected logic.';
const compoundContext = { messages: [{ role: 'user', content: compoundPrompt, timestamp: 1 }] } as unknown as Context;

// alpha/first is expensive/high-quality (clears the frontier terminal floor);
// beta/second is cheap/weaker (clears the inspect floor but not terminal).
const multiWorkBenchmarks: BenchModel[] = [
  {
    registryId: 'alpha/first',
    benchSlug: 'alpha-first',
    active: true,
    quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
    priceInputPer1M: 10,
    priceOutputPer1M: 50,
    source: 'test',
  },
  {
    registryId: 'beta/second',
    benchSlug: 'beta-second',
    active: true,
    quality: { intelligence: 80, coding: 80, agenticCoding: 80 },
    priceInputPer1M: 1,
    priceOutputPer1M: 5,
    source: 'test',
  },
];

interface MutationBlock {
  block: true;
  reason: string;
}

/** Binds session accessors to the module instance the given harness actually mutates. */
async function bindSession() {
  const { getWorkPhaseState, commitWorkPhaseState: commit, getLastServed: served, getLastDecision: decision } =
    await import('./router-session-state.js');
  const { evaluateMutationCall: evaluate } = await import('./mutation-gate.js');
  /** Mirrors index.ts's `tool_call` mutation-gate hook exactly. */
  function preflightMutation(toolName: string, toolCallId: string): MutationBlock | undefined {
    const result = evaluate({ toolName, toolCallId, state: getWorkPhaseState(), served: served() });
    if (result.nextState) commit(result.nextState);
    return result.block ? { block: true, reason: result.reason! } : undefined;
  }
  return { getWorkPhaseState, getLastServed: served, getLastDecision: decision, preflightMutation };
}

describe('multi-work routing acceptance', () => {
  it('serves inspect cheaply across a tool-loop, blocks one mutation, then escapes on retry', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    const session = await bindSession();

    harness.scriptReply([{ type: 'text_delta', delta: 'inspecting' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    expect(session.getWorkPhaseState()).toMatchObject({ phase: 'inspect', multiWorkEngaged: true, providerInvocation: 1 });
    const firstServed = session.getLastServed()?.registryId;
    expect(session.getLastServed()?.capability?.candidate.clearsTerminalFloor).toBe(false);

    // Same-intent tool-loop reinvocation: the assistant read something and
    // the provider is asked again before any mutation is attempted.
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'inspecting more' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    expect(session.getWorkPhaseState()).toMatchObject({ phase: 'inspect', providerInvocation: 2 });
    expect(session.getLastServed()?.registryId).toBe(firstServed);
    expect(session.getLastServed()?.capability?.candidate.clearsTerminalFloor).toBe(false);

    // The under-terminal candidate attempts an edit: blocked exactly once for
    // this invocation. A capability upgrade is not guaranteed — the gate is a
    // bounded degrade, not a re-routing decision.
    const blocked = session.preflightMutation('edit', 'edit-1');
    expect(blocked).toEqual({ block: true, reason: expect.any(String) });
    expect(session.getWorkPhaseState()).toMatchObject({
      gateBlockedInvocation: 2,
      mutationGateTriggered: true,
      mutationGateBlocks: 1,
      phase: 'inspect',
    });

    // The model retries the provider (a later invocation); the retried edit
    // now escapes the gate regardless of clearance, and phase advances.
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'inspecting again' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    expect(session.getWorkPhaseState()).toMatchObject({ phase: 'inspect', providerInvocation: 3 });

    const escaped = session.preflightMutation('edit', 'edit-2');
    expect(escaped).toBeUndefined();
    expect(session.getWorkPhaseState()).toMatchObject({ phase: 'mutate', mutationGateBlocks: 1 });
  });

  it('blocks parallel edit and write from the same served invocation', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    const session = await bindSession();
    harness.scriptReply([{ type: 'text_delta', delta: 'inspecting' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    expect(session.getWorkPhaseState()).toMatchObject({ phase: 'inspect', multiWorkEngaged: true });

    expect(session.preflightMutation('edit', 'e1')).toMatchObject({ block: true });
    expect(session.preflightMutation('write', 'w1')).toMatchObject({ block: true });
    expect(session.getWorkPhaseState()?.mutationGateBlocks).toBe(1);
  });

  it('gates an immediate edit using the actual under-terminal fallback candidate', async () => {
    const decision = routingDecision(['test/frontier', 'test/inspect']);
    decision.multiWork = multiWorkRoutingMeta({
      phase: 'inspect',
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
        'test/inspect': [[{ type: 'toolcall_start' }, { type: 'toolcall_end' }, { type: 'done' }]],
      },
    });
    const result = await harness.run();
    expect(result.lastServed?.registryId).toBe('test/inspect');
    expect(getLastDecision()?.cause).toBe('error-fallback');
    expect(getLastServed()?.capability?.candidate.clearsTerminalFloor).toBe(false);

    // The mutation gate reads whatever multi-work state a real session would
    // have carried alongside the capability delegation.ts just published —
    // real cross-module capability evidence, faked only at the state layer.
    const inspectState: WorkPhaseState = {
      intentKey: 'test-intent',
      terminal: decision.multiWork.terminal,
      terminalRequirement: decision.multiWork.terminalRequirement,
      terminalBand: decision.multiWork.terminalBand,
      phase: 'inspect',
      phaseReason: 'test',
      multiWorkEngaged: true,
      providerInvocation: 1,
      mutationGateBlocks: 0,
      mutationGateTriggered: false,
      mutationCompleted: false,
      pendingMutationToolCallIds: new Set(),
      observedReadTools: 0,
      observedMutationTools: 0,
    };
    commitWorkPhaseState(inspectState);

    const decisionResult = evaluateMutationCall({
      toolName: 'edit',
      toolCallId: 'fallback-edit',
      state: inspectState,
      served: getLastServed(),
    });
    expect(decisionResult).toMatchObject({ block: true, reason: expect.any(String) });
  });

  it('never re-blocks once phase has advanced to mutate, even for a later error-fallback', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    const session = await bindSession();

    // Drive to the same post-escape mutate state as the happy-path test.
    harness.scriptReply([{ type: 'text_delta', delta: 'inspecting' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    session.preflightMutation('edit', 'edit-1');
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'inspecting again' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    session.preflightMutation('edit', 'edit-2');
    expect(session.getWorkPhaseState()?.phase).toBe('mutate');

    // Now in mutate phase, only the terminal floor governs: alpha/first is
    // primary. Force it to fail so beta/second serves as an under-terminal
    // fallback — the objective error-fallback path, still not blacklisting
    // the whole provider for a non-usage-limit error.
    harness.resetEventStream();
    harness.scriptReply((model) => asStream(
      model.id === 'first'
        ? [{ type: 'error', error: { errorMessage: '421 Misdirected Request' } }]
        : [{ type: 'text_delta', delta: 'fallback-mutate' }, { type: 'done' }],
    ));
    await harness.serve(compoundContext);

    expect(session.getLastDecision()?.cause).toBe('error-fallback');
    expect(session.getLastServed()?.capability?.candidate.clearsTerminalFloor).toBe(false);

    const blocksBefore = session.getWorkPhaseState()?.mutationGateBlocks;
    expect(session.preflightMutation('edit', 'edit-3')).toBeUndefined();
    expect(session.getWorkPhaseState()?.mutationGateBlocks).toBe(blocksBefore);
  });
});
