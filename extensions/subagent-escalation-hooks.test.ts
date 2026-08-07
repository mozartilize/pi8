import { describe, expect, it } from 'vitest';

import { SubagentEscalationHooks } from './subagent-escalation-hooks.js';
import {
  SUBAGENT_ESCALATION_MARKER,
  SubagentEscalationState,
  planSubagentOutcome,
} from './subagent-escalation.js';
import type { Role } from './types.js';
import { subagentResultRow } from './test-support/router-fixtures.js';

const roleModels = new Map<Role, string>([['worker', 'provider/fast']]);
const roleFallbacks = new Map<Role, string[]>([
  ['worker', ['provider/fast', 'provider/strong', 'provider/strongest']],
]);

function toolResult(results: unknown[], text = 'result', isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { results },
    isError,
  };
}

describe('SubagentEscalationHooks tool boundaries', () => {
  it('correlates repeated same-role/model children by stable result index and path', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', task: 'first' },
        { agent: 'worker', task: 'second' },
      ],
    };
    const call = hooks.toolCall('call-1', input, roleModels, roleFallbacks, () => false);

    expect(call.children).toMatchObject([
      { childIndex: 0, path: '$.tasks[0]', routerOwned: true },
      { childIndex: 1, path: '$.tasks[1]', routerOwned: true },
    ]);
    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-1',
      toolResult([
        subagentResultRow(),
        subagentResultRow({ index: 1, finalOutput: `${SUBAGENT_ESCALATION_MARKER}{"reason":"second needs help"}` }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );

    expect(blacklisted).toEqual([]);
    expect(plan.retryDirectives).toHaveLength(1);
    expect(plan.content?.at(-1)).toMatchObject({ type: 'text' });
    expect((plan.content?.at(-1) as { text: string }).text).toContain('provider/strong');
  });

  it('never owns an explicit child that shares a model with a routed sibling', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', model: 'provider/fast', task: 'explicit' },
        { agent: 'worker', task: 'routed' },
      ],
    };
    const call = hooks.toolCall('call-2', input, roleModels, roleFallbacks, () => false);
    expect(call.children).toMatchObject([
      { childIndex: 0, routerOwned: false, model: 'provider/fast' },
      { childIndex: 1, routerOwned: true, model: 'provider/fast' },
    ]);

    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-2',
      toolResult([
        subagentResultRow({ exitCode: 1, error: 'explicit failed', finalOutput: 'failed' }),
        subagentResultRow({ index: 1 }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual([]);
    expect(plan.retryDirectives).toEqual([]);
    expect(plan.content).toBeUndefined();
  });

  it('uses stable result indexes when explicit/routed same-model rows are reordered', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', model: 'provider/fast', task: 'explicit' },
        { agent: 'worker', task: 'routed' },
      ],
    };
    hooks.toolCall('call-reordered', input, roleModels, roleFallbacks, () => false);
    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-reordered',
      toolResult([
        subagentResultRow({ index: 1, exitCode: 1, error: 'routed failed', finalOutput: 'failed' }),
        subagentResultRow({ index: 0 }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual(['provider/fast']);
    expect(plan.retryDirectives).toHaveLength(1);
  });

  it('uses a sparse stable result index without assigning by row position', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', model: 'provider/fast', task: 'explicit' },
        { agent: 'worker', task: 'routed' },
      ],
    };
    hooks.toolCall('call-sparse', input, roleModels, roleFallbacks, () => false);
    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-sparse',
      toolResult([
        subagentResultRow({ index: 1, exitCode: 1, error: 'routed failed', finalOutput: 'failed' }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual(['provider/fast']);
    expect(plan.retryDirectives).toHaveLength(1);
  });

  it('fails open for missing, duplicate, invalid, or unknown stable result indexes', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', task: 'first' },
        { agent: 'worker', task: 'second' },
      ],
    };
    hooks.toolCall('call-invalid-index', input, roleModels, roleFallbacks, () => false);
    const blacklisted: string[] = [];
    const failure = { exitCode: 1, error: 'must not be assigned', finalOutput: 'failed' };
    const plan = hooks.toolResult(
      'call-invalid-index',
      toolResult([
        { ...subagentResultRow(failure), index: undefined },
        subagentResultRow({ ...failure, index: 1 }),
        subagentResultRow({ ...failure, index: 1 }),
        subagentResultRow({ ...failure, index: -1 }),
        subagentResultRow({ ...failure, index: 1.5 }),
        subagentResultRow({ ...failure, index: 99 }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual([]);
    expect(plan.retryDirectives).toEqual([]);
    expect(plan.content).toBeUndefined();
  });

  it('does not guess ownership for a multi-child tool-level error', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', model: 'provider/fast', task: 'explicit' },
        { agent: 'worker', task: 'routed' },
      ],
    };
    hooks.toolCall('call-ambiguous-error', input, roleModels, roleFallbacks, () => false);
    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-ambiguous-error',
      toolResult([], 'provider/fast failed', true),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual([]);
    expect(plan.retryDirectives).toEqual([]);
  });

  it('ignores an explicit child self-report that shares the routed model', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', model: 'provider/fast', task: 'explicit' },
        { agent: 'worker', task: 'routed' },
      ],
    };
    hooks.toolCall('call-explicit-report', input, roleModels, roleFallbacks, () => false);

    const plan = hooks.toolResult(
      'call-explicit-report',
      toolResult([
        subagentResultRow({ finalOutput: `${SUBAGENT_ESCALATION_MARKER}{"reason":"explicit asks"}` }),
        subagentResultRow({ index: 1 }),
      ]),
      roleFallbacks,
      () => { throw new Error('explicit report must not blacklist'); },
    );
    expect(plan.retryDirectives).toEqual([]);
    expect(plan.content).toBeUndefined();
  });

  it('blacklists and retries only the routed failed result row', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      tasks: [
        { agent: 'worker', task: 'routed' },
        { agent: 'worker', model: 'provider/fast', task: 'explicit' },
      ],
    };
    hooks.toolCall('call-3', input, roleModels, roleFallbacks, () => false);

    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-3',
      toolResult([
        subagentResultRow({ exitCode: 1, error: 'routed failed', finalOutput: 'failed' }),
        subagentResultRow({ index: 1 }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual(['provider/fast']);
    expect(plan.retryDirectives).toHaveLength(1);
    expect((plan.content?.at(-1) as { text: string }).text).toContain('provider/strong');
  });

  it('tracks object-valued dynamic fanout templates across their reserved stable indexes', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      chain: [
        {
          expand: { from: { output: 'targets', path: '/items' }, maxItems: 3 },
          parallel: { agent: 'worker', task: 'inspect {item}' },
          collect: { as: 'reviews' },
        },
        { agent: 'worker', task: 'summarize' },
      ],
    };
    const call = hooks.toolCall('call-dynamic', input, roleModels, roleFallbacks, () => false);
    expect(call.children).toMatchObject([
      { childIndex: 0, childIndexSpan: 3, path: '$.chain[0].parallel', routerOwned: true },
      { childIndex: 3, path: '$.chain[1]', routerOwned: true },
    ]);

    const plan = hooks.toolResult(
      'call-dynamic',
      toolResult([
        subagentResultRow({ index: 2, finalOutput: `${SUBAGENT_ESCALATION_MARKER}{"reason":"fanout item needs help"}` }),
      ]),
      roleFallbacks,
      () => { throw new Error('self-report must not blacklist'); },
    );
    expect(plan.retryDirectives).toHaveLength(1);
    expect((plan.content?.at(-1) as { text: string }).text).toContain('provider/strong');
  });

  it('does not correlate unknown-span dynamic results to later routed children', () => {
    const hooks = new SubagentEscalationHooks();
    const input = {
      chain: [
        {
          expand: { from: { output: 'targets', path: '/items' } },
          parallel: { agent: 'worker', model: 'provider/fast', task: 'explicit {item}' },
          collect: { as: 'reviews' },
        },
        { agent: 'worker', task: 'later routed child' },
      ],
    };
    const call = hooks.toolCall('call-unknown-dynamic', input, roleModels, roleFallbacks, () => false);
    expect(call.children).toMatchObject([
      { path: '$.chain[0].parallel', stableIndexKnown: false, routerOwned: false },
      { path: '$.chain[1]', stableIndexKnown: false, routerOwned: true },
    ]);
    const later = input.chain[1] as { model?: string; task: string };
    expect(later.model).toBe('provider/fast');
    expect(later.task).not.toContain(SUBAGENT_ESCALATION_MARKER);

    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-unknown-dynamic',
      toolResult([
        subagentResultRow({ index: 1, exitCode: 1, error: 'explicit materialized child failed', finalOutput: 'failed' }),
      ]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual([]);
    expect(plan.retryDirectives).toEqual([]);
    expect(plan.content).toBeUndefined();
  });

  it('skips a blacklisted pending override and injects the next live same-role fallback', () => {
    const state = new SubagentEscalationState();
    planSubagentOutcome(state, 'self-report', 'worker', 'provider/fast', roleFallbacks, 'retry');
    const hooks = new SubagentEscalationHooks(state);
    const input: { agent: string; task: string; model?: string } = { agent: 'worker', task: 'retry task' };

    hooks.toolCall(
      'call-4',
      input,
      roleModels,
      roleFallbacks,
      (model) => model === 'provider/strong',
    );
    expect(input.model).toBe('provider/strongest');
  });

  it('consumes a pending override on exactly one router-owned hook call', () => {
    const state = new SubagentEscalationState();
    planSubagentOutcome(state, 'self-report', 'worker', 'provider/fast', roleFallbacks, 'retry');
    const hooks = new SubagentEscalationHooks(state);
    const first: { agent: string; task: string; model?: string } = { agent: 'worker', task: 'first retry' };
    const second: { agent: string; task: string; model?: string } = { agent: 'worker', task: 'later work' };

    hooks.toolCall('one-shot-1', first, roleModels, roleFallbacks, () => false);
    hooks.toolCall('one-shot-2', second, roleModels, roleFallbacks, () => false);
    expect(first.model).toBe('provider/strong');
    expect(second.model).toBe('provider/fast');
  });

  it('keeps async concrete injection but omits contract and same-request escalation', () => {
    const hooks = new SubagentEscalationHooks();
    const input: { agent: string; task: string; async: boolean; model?: string } = { agent: 'worker', task: 'background task', async: true };
    hooks.toolCall('call-5', input, roleModels, roleFallbacks, () => false);

    expect(input.model).toBe('provider/fast');
    expect(input.task).not.toContain(SUBAGENT_ESCALATION_MARKER);
    const blacklisted: string[] = [];
    const plan = hooks.toolResult(
      'call-5',
      toolResult([subagentResultRow({ finalOutput: `${SUBAGENT_ESCALATION_MARKER}{"reason":"ignored"}` })]),
      roleFallbacks,
      (model) => blacklisted.push(model),
    );
    expect(blacklisted).toEqual([]);
    expect(plan.retryDirectives).toEqual([]);
    expect(plan.content).toBeUndefined();
  });

  it('routes each failed fixed reviewer task to the next model on batch retry', () => {
    const reviewerModels = new Map<Role, string>([['reviewer', 'provider/fast']]);
    const reviewerFallbacks = new Map<Role, string[]>([
      ['reviewer', ['provider/fast', 'provider/strong']],
    ]);
    const hooks = new SubagentEscalationHooks();
    const firstInput: { tasks: Array<{ agent: string; task: string; model?: string }> } = {
      tasks: [
        { agent: 'reviewer', task: 'review routing' },
        { agent: 'reviewer', task: 'review routing' },
      ],
    };
    hooks.toolCall('first', firstInput, reviewerModels, reviewerFallbacks, () => false);
    const plan = hooks.toolResult(
      'first',
      toolResult([
        subagentResultRow({ index: 0, agent: 'reviewer', exitCode: 1, error: 'region blocked' }),
        subagentResultRow({ index: 1, agent: 'reviewer', exitCode: 1, error: 'region blocked' }),
      ]),
      reviewerFallbacks,
      () => { /* no-op blacklist */ },
    );
    expect(plan.retryDirectives).toHaveLength(2);

    const retryInput: { tasks: Array<{ agent: string; task: string; model?: string }> } = {
      tasks: [
        { agent: 'reviewer', task: 'review routing' },
        { agent: 'reviewer', task: 'review routing' },
      ],
    };
    hooks.toolCall('retry', retryInput, reviewerModels, reviewerFallbacks, () => false);
    expect(retryInput.tasks.map((task) => task.model)).toEqual(['provider/strong', 'provider/strong']);
  });

  it('does not leak a task-keyed override to an unrelated same-role task', () => {
    const reviewerModels = new Map<Role, string>([['reviewer', 'provider/fast']]);
    const reviewerFallbacks = new Map<Role, string[]>([
      ['reviewer', ['provider/fast', 'provider/strong']],
    ]);
    const hooks = new SubagentEscalationHooks();
    hooks.toolCall('plan-call', { tasks: [{ agent: 'reviewer', task: 'review routing' }] }, reviewerModels, reviewerFallbacks, () => false);
    hooks.toolResult(
      'plan-call',
      toolResult([subagentResultRow({ index: 0, agent: 'reviewer', exitCode: 1, error: 'region blocked' })]),
      reviewerFallbacks,
      () => { /* no-op blacklist */ },
    );

    const unrelated: { tasks: Array<{ agent: string; task: string; model?: string }> } = {
      tasks: [{ agent: 'reviewer', task: 'review release notes' }],
    };
    hooks.toolCall('unrelated-call', unrelated, reviewerModels, reviewerFallbacks, () => false);
    expect(unrelated.tasks[0].model).toBe('provider/fast');

    const matching: { tasks: Array<{ agent: string; task: string; model?: string }> } = {
      tasks: [{ agent: 'reviewer', task: 'review routing' }],
    };
    hooks.toolCall('matching-call', matching, reviewerModels, reviewerFallbacks, () => false);
    expect(matching.tasks[0].model).toBe('provider/strong');
  });

  it('reset clears pending calls and one-shot overrides', () => {
    const state = new SubagentEscalationState();
    const hooks = new SubagentEscalationHooks(state);
    hooks.toolCall('old-call', { agent: 'worker', task: 'old' }, roleModels, roleFallbacks, () => false);
    planSubagentOutcome(state, 'self-report', 'worker', 'provider/fast', roleFallbacks, 'retry');
    hooks.reset();

    const input: { agent: string; task: string; model?: string } = { agent: 'worker', task: 'new' };
    hooks.toolCall('new-call', input, roleModels, roleFallbacks, () => false);
    expect(input.model).toBe('provider/fast');
    expect(hooks.toolResult(
      'old-call',
      toolResult([subagentResultRow({ exitCode: 1, error: 'stale failure' })]),
      roleFallbacks,
      () => { throw new Error('stale call must not blacklist'); },
    ).retryDirectives).toEqual([]);
  });
});
