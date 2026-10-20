import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendContextHandoffSignal } from '../host/decisionlog.js';
import { setDebugPath } from '../host/debuglog.js';
import { ACQUISITION_DENIAL_LIMIT } from '../routing/policy/context-acquisition.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { routingDecision } from '../test-support/router-fixtures.js';
import { RouterSession } from './router-session-state.js';
import { submitContextHandoff } from './context-handoff-tool.js';
import { CONTINUE_TURN, CONTRACT_REMINDER } from './execution-contract-tool.js';
import { CLARIFICATION_TEXT, closeContextEntry, countContextRefusal, gateContextToolCall, logContextHandoff } from './gathering-gate.js';
import { factsLog } from '../routing/policy/change-facts.js';

vi.mock('../host/decisionlog.js', () => ({ appendContextHandoffSignal: vi.fn() }));

function acquiringSession(): RouterSession {
  const session = new RouterSession();
  const state: WorkPhaseState = {
    intentKey: 'entry', deliverable: 'plan', status: 'triage',
    contextDenials: 0,
    providerInvocation: 1, observedMutationTools: 0,
  };
  session.commitWorkPhaseState(state);
  session.setLastDecision({ ...routingDecision(['a/model']), intentKey: state.intentKey, dimension: 'gather' });
  session.setLastServed({ registryId: 'a/model', viaFallback: false, accumulatedCost: 0 });
  return session;
}

beforeEach(() => vi.clearAllMocks());

const ROUTER_AUTO = { model: { provider: 'router', id: 'auto' } } as unknown as ExtensionContext;
const READY = { outcome: 'ready', deliverable: 'implement', complexity: 'routine', scope: 'bounded', findings: 'f', question: 'q' };
const UNREAD = { unmet: ['src/queue.ts'] };

describe('gathering gate refusal accounting', () => {
  it('shares one refusal between a blocked mutation and a rejected handoff in the same invocation', () => {
    const session = acquiringSession();
    expect(gateContextToolCall({ toolName: 'write', input: {} }, session)?.block).toBe(true);
    expect(submitContextHandoff(READY, ROUTER_AUTO, session, UNREAD).accepted).toBe(false);
    expect(session.getWorkPhaseState()?.contextDenials).toBe(1);
    expect(session.getWorkPhaseState()?.deniedAtInvocation).toBe(1);
    expect(vi.mocked(appendContextHandoffSignal).mock.calls.map(([signal]) => signal.action)).toEqual(['deny', 'reject']);
  });

  it('ends gathering at the same refusal limit and logs exhaustion once', () => {
    const session = acquiringSession();
    for (let invocation = 1; invocation <= ACQUISITION_DENIAL_LIMIT; invocation += 1) {
      session.commitWorkPhaseState({
        ...session.getWorkPhaseState()!, providerInvocation: invocation,
      });
      expect(gateContextToolCall({ toolName: 'edit', input: {} }, session)?.block).toBe(true);
    }
    const ended = session.getWorkPhaseState()!;
    expect(ended.contextDenials).toBe(ACQUISITION_DENIAL_LIMIT);
    expect(ended.status).toBe('clarification-only');
    expect(countContextRefusal(session, ended, 'a/model')).toBe(ended);
    expect(gateContextToolCall({ toolName: 'edit', input: {} }, session)?.block).toBe(true);
    expect(vi.mocked(appendContextHandoffSignal).mock.calls.filter(([signal]) => signal.action === 'budget-exhausted'))
      .toHaveLength(1);
  });

  it('does not count a handoff rejected for its shape: calling again fixes it', () => {
    const session = acquiringSession();
    for (const [invocation, params] of [[1, { outcome: 'ready' }], [2, { ...READY, question: '' }], [3, { ...READY, deliverable: 'nonsense' }]] as const) {
      session.commitWorkPhaseState({ ...session.getWorkPhaseState()!, providerInvocation: invocation });
      expect(submitContextHandoff(params, ROUTER_AUTO, session).accepted).toBe(false);
    }
    expect(session.getWorkPhaseState()).toMatchObject({ contextDenials: 0, status: 'triage' });
  });

  it('counts a handoff rejected for unread files', () => {
    const session = acquiringSession();
    const result = submitContextHandoff(READY, ROUTER_AUTO, session, UNREAD);
    expect(result.text).toContain('Reads in parts count when together they show every line. Then call it again: src/queue.ts.');
    expect(session.getWorkPhaseState()?.contextDenials).toBe(1);
  });

  it('gives only the closing instruction when an unread-file rejection ends gathering', () => {
    const session = acquiringSession();
    session.commitWorkPhaseState({ ...session.getWorkPhaseState()!, contextDenials: ACQUISITION_DENIAL_LIMIT - 1 });
    const result = submitContextHandoff(READY, ROUTER_AUTO, session, UNREAD);
    expect(session.getWorkPhaseState()?.status).toBe('clarification-only');
    // The files stay named so the reply can ask for them; no instruction to read or call again.
    expect(result.text).toBe(`Context not handed off: the request rests on files not read in full as they are now: src/queue.ts. ${CLARIFICATION_TEXT}`);
  });

  it.each(['fffind', 'ffgrep', 'extension_control', 'extension_inspect', 'ctx_execute', 'ctx_execute_file', 'mcp', 'read_file', 'web_search', 'subagent'])('allows %s without a refusal or phase transition', (toolName) => {
    const session = acquiringSession();
    const before = session.getWorkPhaseState();
    expect(gateContextToolCall({ toolName, input: { pattern: 'retryDelayMs', path: 'src/' } }, session)).toBeUndefined();
    expect(session.getWorkPhaseState()).toBe(before);
    expect(vi.mocked(appendContextHandoffSignal)).not.toHaveBeenCalled();
  });

  it.each(['commit_execution'])('refuses %s before a handoff', (toolName) => {
    const session = acquiringSession();
    const refusal = gateContextToolCall({ toolName, input: { command: 'rg retryDelayMs' } }, session);
    expect(refusal?.block).toBe(true);
    expect(refusal?.reason).toContain(`${toolName} does not run while collecting context.`);
    expect(refusal?.reason).toContain('Use tools to collect evidence without changing the product.');
    expect(refusal?.reason).toContain('Do not hand off only to run a refused tool.');
    expect(refusal?.reason).toContain('Follow the applicable skill instructions.');
    expect(refusal?.reason).not.toContain('the next step can run it');
    expect(session.getWorkPhaseState()?.contextDenials).toBe(0);
    expect(vi.mocked(appendContextHandoffSignal).mock.calls.at(-1)?.[0]).toMatchObject({
      action: 'deny', deniedTool: toolName,
    });
  });

  it('allows a shell read without spending the mutation refusal budget', () => {
    const session = acquiringSession();
    expect(gateContextToolCall({ toolName: 'bash', input: { command: 'pwd' } }, session)).toBeUndefined();
    expect(session.getWorkPhaseState()?.contextDenials).toBe(0);
    expect(gateContextToolCall({ toolName: 'read', input: { path: 'file.ts' } }, session)).toBeUndefined();
  });

  it.each(['echo changed > src/a.ts', 'rm src/a.ts', 'git reset --hard'])('blocks recognized shell mutation: %s', (command) => {
    const session = acquiringSession();
    expect(gateContextToolCall({ toolName: 'bash', input: { command } }, session)?.block).toBe(true);
    expect(session.getWorkPhaseState()?.contextDenials).toBe(1);
  });

  it('does not count refusals while the accepted handoff awaits its next invocation', () => {
    const session = acquiringSession();
    session.commitWorkPhaseState({ ...session.getWorkPhaseState()!, status: 'ready-pending' });
    expect(gateContextToolCall({ toolName: 'subagent', input: {} }, session)?.block).toBe(true);
    expect(session.getWorkPhaseState()?.contextDenials).toBe(0);
  });

  it('blocks an unchecked call in a restricted phase if bookkeeping fails', () => {
    const session = acquiringSession();
    vi.mocked(appendContextHandoffSignal).mockImplementationOnce(() => { throw new Error('log failed'); });
    expect(gateContextToolCall({ toolName: 'write', input: {} }, session)).toEqual({
      block: true,
      reason: 'Router: this call was not made: the router could not check it while collecting context.',
    });
  });
});

describe('implementation boundary guidance', () => {
  it.each(['implement', 'plan', 'review'])('adds closed-plan guidance only for an %s handoff', (deliverable) => {
    const session = acquiringSession();
    const result = submitContextHandoff({ ...READY, deliverable }, ROUTER_AUTO, session);
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('Make no changes now.');
    expect(result.text).toContain(CONTINUE_TURN);
    if (deliverable === 'implement') {
      expect(result.text).toContain('For the next implementation step:');
      expect(result.text).toContain(CONTRACT_REMINDER);
    } else {
      expect(result.text).not.toContain('commit_execution');
    }
    expect(session.getWorkPhaseState()).toMatchObject({ status: 'ready-pending', observedMutationTools: 0 });
    expect(session.getWorkPhaseState()?.reasoningHandoff?.rubric).toBeUndefined();
    expect(session.getWorkPhaseState()?.contract).toBeUndefined();
  });
});

describe('closing an entry', () => {
  it('logs the check verdicts of an implement handoff at the end of the entry', () => {
    const state: WorkPhaseState = {
      intentKey: 'entry', deliverable: 'implement', status: 'served', providerInvocation: 3, observedMutationTools: 2,
      changeFacts: { log: factsLog('implement', undefined, {}) },
      checkVerdicts: { beforeHandoff: 'fail', afterHandoff: 'pass', runsAfterHandoff: 2 },
    };
    expect(closeContextEntry(state, 'a/model').contextClosed).toBe(true);
    expect(vi.mocked(appendContextHandoffSignal)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'phase-end', deliverable: 'implement',
      checks: { beforeHandoff: 'fail', afterHandoff: 'pass', runsAfterHandoff: 2 },
    }));
  });

  it('logs nothing for an entry without a handoff or collected context', () => {
    const state: WorkPhaseState = { intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0 };
    expect(closeContextEntry(state, 'a/model')).toBe(state);
    expect(vi.mocked(appendContextHandoffSignal)).not.toHaveBeenCalled();
  });
});

describe('context-handoff debug lines', () => {
  afterEach(() => setDebugPath(undefined));

  it('records work item, topic and phase on a handoff action', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi8-handoff-dbg-'));
    const path = join(dir, 'debug.log');
    try {
      setDebugPath(path);
      logContextHandoff({
        intentKey: 'entry-a',
        sourceEntryId: 'entry-a',
        boundaryId: 'boundary-7',
        deliverable: 'plan',
        status: 'ready-pending',
        providerInvocation: 1,
        observedMutationTools: 0,
      }, 'openai/gpt', 'accept', { deliverable: 'implement' });
      const payload = JSON.parse(readFileSync(path, 'utf8').trim().split(' ').slice(2).join(' '));
      expect(payload).toMatchObject({
        action: 'accept',
        entryId: 'entry-a',
        boundaryId: 'boundary-7',
        phase: 'implement',
        status: 'ready-pending',
        intentKey: 'entry-a',
        served: 'openai/gpt',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
