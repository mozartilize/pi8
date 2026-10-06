// Negative control for self-authored checks. `weakCancelCheck` is the kind of
// test an executor writes: it passes for a queue that keeps the slot of a
// cancelled job. `cancelFreesSlotCheck` follows the spec and fails for it.
import assert from 'node:assert/strict';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Observes only the abort signal. */
export async function weakCancelCheck(JobQueue) {
  const queue = new JobQueue({ concurrency: 1 });
  let signal;
  const id = queue.add((s) => {
    signal = s;
    return new Promise(() => {});
  });
  await tick();
  queue.cancel(id);
  assert.equal(signal.aborted, true);
}

/** Keeps the cancelled handler unresolved, then checks that another job starts. */
export async function cancelFreesSlotCheck(JobQueue) {
  const queue = new JobQueue({ concurrency: 1 });
  const id = queue.add(() => new Promise(() => {}));
  let started = false;
  queue.add(async () => {
    started = true;
  });
  await tick();
  assert.equal(started, false);
  queue.cancel(id);
  await tick();
  assert.equal(started, true, 'a job starts after the running job is cancelled');
}
