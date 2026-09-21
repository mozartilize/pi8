import { describe, expect, it } from 'vitest';
import { TrajectoryState } from './trajectory.js';
import type { ToolCycleInput } from './fingerprints.js';

let seq = 0;
function read(path: string, body: string): ToolCycleInput {
  seq += 1;
  return {
    toolName: 'read',
    toolCallId: `read-${path}-${seq}`,
    input: { path },
    content: [{ type: 'text', text: body }],
  };
}

function edit(path: string, diff: string, oldText = 'old', newText = 'new'): ToolCycleInput {
  return {
    toolName: 'edit',
    toolCallId: `edit-${path}-${oldText}-${newText}`,
    input: { path, oldText, newText },
    content: [{ type: 'text', text: 'ok' }],
    details: { diff },
  };
}

function write(path: string, content: string): ToolCycleInput {
  seq += 1;
  return {
    toolName: 'write',
    toolCallId: `write-${path}-${seq}`,
    input: { path, content },
    content: [{ type: 'text', text: 'ok' }],
  };
}

let pytestSeq = 0;
function pytest(output: string, isError = true): ToolCycleInput {
  pytestSeq += 1;
  return {
    toolName: 'bash',
    toolCallId: `test-${pytestSeq}`,
    input: { command: 'pytest tests/test_policy.py -q' },
    content: [{ type: 'text', text: output }],
    isError,
  };
}

describe('TrajectoryState', () => {
  it('treats a changed re-read as progress, not recurrence', () => {
    const state = new TrajectoryState();
    state.observeToolResult(read('a.ts', 'v1'), 1);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-old\n+new\n'), 2);
    const decision = state.observeToolResult(read('a.ts', 'v2'), 3);
    expect(decision?.signals.find((s) => s.kind === 'aor')?.severity).toBe('none');
    expect(decision?.escalate).toBe(false);
  });

  it('does not treat unverified edits as stagnation', () => {
    const state = new TrajectoryState();
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-old\n+new\n'), 1);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-x\n+y\n', 'x', 'y'), 2);
    const decision = state.observeToolResult(edit('b.ts', '--- a\n+++ b\n-x\n+y\n', 'x', 'y'), 3);
    expect(decision?.signals.find((s) => s.kind === 'stagnation')?.severity).toBe('none');
    expect(decision?.escalate).toBe(false);
  });

  it('counts a corrective attempt only across invocations', () => {
    const fail = 'FAILED tests/test_policy.py::test_escalates_same_failure\nAssertionError: expected true';
    const state = new TrajectoryState();
    state.observeToolResult(pytest(fail), 1);
    state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-old\n+new\n'), 1);
    let decision = state.observeToolResult(pytest(fail), 1);
    expect(decision?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('none');

    state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-a\n+b\n', 'a', 'b'), 2);
    decision = state.observeToolResult(pytest(fail), 3);
    expect(decision?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('warning');

    state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-c\n+d\n', 'c', 'd'), 4);
    decision = state.observeToolResult(pytest(fail), 5);
    expect(decision?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('severe');
    expect(decision?.escalate).toBe(true);
  });

  it('resets on a new intent key', () => {
    const state = new TrajectoryState();
    state.bindIntent('one');
    state.observeToolResult(read('a.ts', 'v1'), 1);
    state.observeToolResult(read('a.ts', 'v1'), 2);
    state.bindIntent('two');
    const decision = state.observeToolResult(read('a.ts', 'v1'), 1);
    expect(decision?.signals.find((s) => s.kind === 'aor')?.severity).toBe('none');
  });

  it('does not re-arm the same pending fingerprint', () => {
    const fail = 'FAILED tests/test_policy.py::test_escalates_same_failure';
    const state = new TrajectoryState();
    state.observeToolResult(pytest(fail), 1);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-old\n+new\n'), 2);
    state.observeToolResult(pytest(fail), 3);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-x\n+y\n', 'x', 'y'), 4);
    const decision = state.observeToolResult(pytest(fail), 5);
    expect(decision).toBeDefined();
    state.maybeArmPending(decision!, 'test/weak:low', 'implement', false);
    expect(state.peekPending()?.fromModel).toBe('test/weak:low');
    state.consumePending();
    state.maybeArmPending(decision!, 'test/weak:low', 'implement', false);
    expect(state.peekPending()).toBeUndefined();
  });

  it('does not collapse distinct edits or writes to the same file into AOR', () => {
    const state = new TrajectoryState();
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-old\n+new\n', 'old', 'new'), 1);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-x\n+y\n', 'x', 'y'), 2);
    const third = state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-p\n+q\n', 'p', 'q'), 3);
    expect(third?.signals.find((s) => s.kind === 'aor')?.severity).toBe('none');
    expect(third?.escalate).toBe(false);

    const writes = new TrajectoryState();
    writes.observeToolResult(write('a.ts', 'one'), 1);
    writes.observeToolResult(write('a.ts', 'two'), 2);
    const written = writes.observeToolResult(write('a.ts', 'three'), 3);
    expect(written?.signals.find((s) => s.kind === 'aor')?.severity).toBe('none');
  });

  it('treats repeated identical failed edits as AOR and leaves unverified mutations unknown', () => {
    const failed = (id: string): ToolCycleInput => ({
      toolName: 'edit',
      toolCallId: id,
      input: { path: 'a.ts', oldText: 'same', newText: 'attempt' },
      content: [{ type: 'text', text: 'ok' }],
      isError: true,
    });
    const state = new TrajectoryState();
    state.observeToolResult(failed('e1'), 1);
    state.observeToolResult(failed('e2'), 2);
    const third = state.observeToolResult(failed('e3'), 3);
    expect(third?.signals.find((s) => s.kind === 'aor')?.severity).toBe('severe');

    const unverified = new TrajectoryState();
    const bare = (id: string): ToolCycleInput => ({
      toolName: 'edit',
      toolCallId: id,
      input: { path: 'a.ts' },
      content: [{ type: 'text', text: 'ok' }],
    });
    unverified.observeToolResult(bare('u1'), 1);
    unverified.observeToolResult(bare('u2'), 2);
    const unknown = unverified.observeToolResult(bare('u3'), 3);
    expect(unknown?.signals.find((s) => s.kind === 'aor')?.severity).toBe('none');
  });

  it('applies a parallel batch in call order, not completion order', () => {
    const fail = 'FAILED tests/test_policy.py::test_escalates_same_failure\nAssertionError: expected true';
    const run = (order: Array<'fail' | 'progress'>): boolean => {
      const state = new TrajectoryState();
      state.noteToolCall('bash', 'a', { command: 'pytest tests/test_policy.py -q' });
      state.noteToolCall('read', 'b', { path: 'new.ts' });
      const events: Record<'fail' | 'progress', ToolCycleInput> = {
        fail: { ...pytest(fail), toolCallId: 'a' },
        progress: { ...read('new.ts', 'fresh-evidence'), toolCallId: 'b' },
      };
      let decision;
      for (const key of order) {
        decision = state.observeToolResult(events[key], 1);
      }
      return decision?.escalate === true;
    };
    expect(run(['fail', 'progress'])).toBe(run(['progress', 'fail']));
  });

  it('clears pending escalation when a later batch shows progress', () => {
    const state = new TrajectoryState();
    state.observeToolResult(read('a.ts', 'v1'), 1);
    state.observeToolResult(read('a.ts', 'v1'), 2);
    state.observeToolResult(read('a.ts', 'v1'), 3);
    const armed = state.observeToolResult(read('a.ts', 'v1'), 4);
    state.maybeArmPending(armed!, 'test/weak:low', 'implement', false);
    expect(state.peekPending()).toBeDefined();
    const progress = state.observeToolResult(read('b.ts', 'new'), 4);
    state.maybeArmPending(progress!, 'test/weak:low', 'implement', false);
    expect(state.peekPending()).toBeUndefined();
  });

  it('does not treat three retained replacements as backtracking', () => {
    const state = new TrajectoryState();
    state.observeToolResult(read('a.ts', 'aaa\nbbb\nccc'), 1);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-aaa\n+xxx\n', 'aaa', 'xxx'), 2);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-bbb\n+yyy\n', 'bbb', 'yyy'), 3);
    const third = state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-ccc\n+zzz\n', 'ccc', 'zzz'), 4);
    expect(third?.signals.find((s) => s.kind === 'backtracking')?.severity).toBe('none');
    expect(third?.escalate).toBe(false);
  });

  it('reports backtracking unavailable without a reconstructable file snapshot', () => {
    const state = new TrajectoryState();
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-old\n+new\n', 'old', 'new'), 1);
    state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-x\n+y\n', 'x', 'y'), 2);
    const third = state.observeToolResult(edit('a.ts', '--- a\n+++ b\n-p\n+q\n', 'p', 'q'), 3);
    expect(third?.signals.find((s) => s.kind === 'backtracking')?.severity).toBe('unavailable');
  });

  it('detects write-then-restore as backtracking', () => {
    const state = new TrajectoryState();
    state.observeToolResult(write('a.ts', 'one'), 1);
    state.observeToolResult(write('a.ts', 'two'), 2);
    const restored = state.observeToolResult(write('a.ts', 'one'), 3);
    expect(restored?.signals.find((s) => s.kind === 'backtracking')?.severity).toBe('severe');
  });

  it('does not wait forever for a blocked sibling in a parallel batch', () => {
    const state = new TrajectoryState();
    state.noteToolCall('bash', 'blocked', { command: 'pytest' });
    state.noteToolCall('read', 'ok', { path: 'a.ts' });
    const first = state.observeToolResult({ ...read('a.ts', 'v1'), toolCallId: 'ok' }, 1);
    expect(first).toBeUndefined();
    const flushed = state.noteToolCall('read', 'next', { path: 'b.ts' });
    expect(flushed).toBeDefined();
    const next = state.observeToolResult({ ...read('b.ts', 'fresh'), toolCallId: 'next' }, 2);
    expect(next).toBeDefined();
  });

  it('classifies a blocked-sibling batch at an explicit provider-boundary flush', () => {
    const state = new TrajectoryState();
    state.noteToolCall('bash', 'blocked', { command: 'pytest' });
    state.noteToolCall('read', 'ok', { path: 'a.ts' });
    expect(state.observeToolResult({ ...read('a.ts', 'v1'), toolCallId: 'ok' }, 1)).toBeUndefined();
    const flushed = state.abandonUnresolvedCalls();
    expect(flushed).toBeDefined();
    expect(state.abandonUnresolvedCalls()).toBeUndefined();
  });

  it('ignores duplicate results for the same toolCallId', () => {
    const state = new TrajectoryState();
    const first = read('a.ts', 'v1');
    expect(state.observeToolResult(first, 1)).toBeDefined();
    expect(state.observeToolResult(first, 1)).toBeUndefined();
  });
});
