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

let shellSeq = 0;
function shell(command: string, output: string, isError = false): ToolCycleInput {
  shellSeq += 1;
  return {
    toolName: 'bash',
    toolCallId: `shell-${shellSeq}`,
    input: { command },
    content: [{ type: 'text', text: output }],
    isError,
  };
}

const PYTEST_FAIL =
  'FAILED tests/test_policy.py::test_escalates_same_failure\nAssertionError: expected true';

/**
 * Verifier runs separated by distinct corrective edits. A correction only
 * counts when the mutation lands strictly between two verifier invocations,
 * so each step advances the invocation counter.
 */
function driveFailurePersistence(
  state: TrajectoryState,
  fail = PYTEST_FAIL,
  startInvocation = 1,
) {
  let decision = state.observeToolResult(pytest(fail), startInvocation);
  const patches = [['a', 'b'], ['c', 'd'], ['e', 'f']];
  for (let i = 0; i < patches.length; i += 1) {
    const [oldText, newText] = patches[i]!;
    const editAt = startInvocation + i * 2 + 1;
    state.observeToolResult(
      edit('policy.ts', `--- a\n+++ b\n-${oldText}\n+${newText}\n`, oldText, newText),
      editAt,
    );
    decision = state.observeToolResult(pytest(fail), editAt + 1);
  }
  return decision;
}

function lastProgressKind(state: TrajectoryState): string | undefined {
  const cycles = (state as unknown as { cycles: Array<{ progressKind: string }> }).cycles;
  return cycles[cycles.length - 1]?.progressKind;
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

describe('TrajectoryState evidence ownership', () => {
  it('does not let one owner\'s struggle condemn the next one', () => {
    const state = new TrajectoryState();
    state.bindOwner('alpha/weak');
    const armed = driveFailurePersistence(state);
    expect(armed?.escalate).toBe(true);
    state.maybeArmPending(armed!, 'alpha/weak', 'implement', false);
    expect(state.peekPending()?.fromModel).toBe('alpha/weak');

    state.bindOwner('beta/strong');
    expect(state.peekPending()).toBeUndefined();
    const neutral = state.observeToolResult(read('fresh.ts', 'new evidence'), 20);
    expect(neutral?.escalate).toBe(false);
    state.maybeArmPending(neutral!, 'beta/strong', 'implement', false);
    expect(state.peekPending()).toBeUndefined();
  });

  it('makes the new owner earn its own escalation', () => {
    const state = new TrajectoryState();
    state.bindOwner('alpha/weak');
    driveFailurePersistence(state);
    state.bindOwner('beta/strong');

    const halfway = state.observeToolResult(pytest(PYTEST_FAIL), 20);
    state.maybeArmPending(halfway!, 'beta/strong', 'implement', false);
    expect(state.peekPending()).toBeUndefined();

    const earned = driveFailurePersistence(state, PYTEST_FAIL, 21);
    expect(earned?.escalate).toBe(true);
    state.maybeArmPending(earned!, 'beta/strong', 'implement', false);
    expect(state.peekPending()?.fromModel).toBe('beta/strong');
  });

  it('treats a higher effort on the same model as a distinct owner', () => {
    const state = new TrajectoryState();
    state.bindOwner('alpha/model:medium');
    const armed = driveFailurePersistence(state);
    state.maybeArmPending(armed!, 'alpha/model:medium', 'implement', false);
    expect(state.peekPending()).toBeDefined();

    state.bindOwner('alpha/model:high');
    const after = state.observeToolResult(pytest(PYTEST_FAIL), 20);
    expect(after?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('none');
    expect(state.peekPending()).toBeUndefined();
  });

  it('refuses to arm a model that does not own the evidence', () => {
    const state = new TrajectoryState();
    state.bindOwner('alpha/weak');
    const armed = driveFailurePersistence(state);
    state.maybeArmPending(armed!, 'beta/strong', 'implement', false);
    expect(state.peekPending()).toBeUndefined();
  });

  it('keeps task knowledge across an owner change', () => {
    const state = new TrajectoryState();
    state.bindOwner('alpha/weak');
    state.observeToolResult(read('a.ts', 'v1'), 1);
    state.bindOwner('beta/strong');
    state.observeToolResult(read('a.ts', 'v1'), 2);
    // Already-seen evidence is not new evidence just because the owner changed.
    expect(lastProgressKind(state)).toBe('none');
  });
});

describe('TrajectoryState verifier scoping', () => {
  it('keeps a test failure alive across an unrelated passing verifier', () => {
    for (const passing of ['npx tsc --noEmit', 'npx eslint src']) {
      const state = new TrajectoryState();
      state.observeToolResult(pytest(PYTEST_FAIL), 1);
      state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-a\n+b\n', 'a', 'b'), 2);
      state.observeToolResult(shell(passing, 'all good'), 3);
      const back = state.observeToolResult(pytest(PYTEST_FAIL), 3);
      expect(back?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('warning');
    }
  });

  it('clears a failure when its own verifier passes', () => {
    const state = new TrajectoryState();
    state.observeToolResult(pytest(PYTEST_FAIL), 1);
    state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-a\n+b\n', 'a', 'b'), 2);
    const passed = state.observeToolResult(pytest('3 passed', false), 3);
    expect(passed?.signals.find((s) => s.kind === 'stagnation')?.severity).toBe('none');

    state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-c\n+d\n', 'c', 'd'), 4);
    const again = state.observeToolResult(pytest(PYTEST_FAIL), 5);
    expect(again?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('none');
  });

  it('does not treat a changed failure signature as progress', () => {
    const state = new TrajectoryState();
    state.observeToolResult(pytest(PYTEST_FAIL), 1);
    state.observeToolResult(edit('policy.ts', '--- a\n+++ b\n-a\n+b\n', 'a', 'b'), 2);
    state.observeToolResult(
      pytest('FAILED tests/test_other.py::test_unrelated\nTypeError: bad'),
      3,
    );
    // A different failure is not evidence the run improved, so the recurrence
    // chain must not be broken by confirmed progress.
    expect(lastProgressKind(state)).toBe('unknown');
  });
});

describe('TrajectoryState snapshot memory', () => {
  it('bounds tracked file bodies and skips oversized reads', () => {
    const state = new TrajectoryState();
    for (let i = 0; i < 200; i += 1) {
      state.observeToolResult(read(`file-${i}.ts`, `body ${i}\n`.repeat(50)), i + 1);
    }
    state.observeToolResult(read('huge.ts', 'x'.repeat(1_000_001)), 201);
    const files = (state as unknown as { files: Map<string, unknown> }).files;
    expect(files.size).toBeLessThanOrEqual(16);
    expect(files.has('huge.ts')).toBe(false);
  });

  it('keeps other detectors working once snapshots are evicted', () => {
    const state = new TrajectoryState();
    state.observeToolResult(read('policy.ts', 'baseline\n'), 1);
    for (let i = 0; i < 40; i += 1) {
      state.observeToolResult(read(`other-${i}.ts`, `body ${i}\n`), i + 2);
    }
    const decision = driveFailurePersistence(state, PYTEST_FAIL, 50);
    expect(decision?.signals.find((s) => s.kind === 'failure-persistence')?.severity).toBe('severe');
    expect(decision?.escalate).toBe(true);
  });
});
