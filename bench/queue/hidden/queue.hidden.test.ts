// Hidden acceptance tests. The models never see this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.ts';

const OPT = process.env.DELAY_OPTION ?? 'retryDelayMs';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opts = (o: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...o };
  if ('delay' in out) { out[OPT] = out.delay; delete out.delay; }
  return out as never;
};

test('H01 rejects a concurrency below 1 or not an integer', () => {
  assert.throws(() => createQueue(opts({ concurrency: 0 })), RangeError);
  assert.throws(() => createQueue(opts({ concurrency: 1.5 })), RangeError);
});

test('H02 runs at most `concurrency` attempts at once', async () => {
  const q = createQueue(opts({ concurrency: 2 }));
  let now = 0; let max = 0;
  const job = async () => { now++; max = Math.max(max, now); await delay(20); now--; return 1; };
  const hs = Array.from({ length: 6 }, () => q.add(job));
  await Promise.all(hs.map((h) => h.result));
  assert.equal(max, 2);
});

test('H03 higher priority first, FIFO within a priority', async () => {
  const q = createQueue(opts({ concurrency: 1 }));
  const order: string[] = [];
  const blocker = q.add(() => delay(20));
  const mk = (name: string) => async () => { order.push(name); };
  const hs = [q.add(mk('low1'), { priority: 0 }), q.add(mk('high1'), { priority: 5 }), q.add(mk('low2'), { priority: 0 }), q.add(mk('high2'), { priority: 5 })];
  await Promise.all([blocker.result, ...hs.map((h) => h.result)]);
  assert.deepEqual(order, ['high1', 'high2', 'low1', 'low2']);
});

test('H04 retries a failing job and resolves with the later value', async () => {
  const q = createQueue(opts({ concurrency: 1, retries: 2, delay: 5 }));
  let calls = 0;
  const h = q.add(async () => { calls++; if (calls < 3) throw new Error('boom'); return 'ok'; });
  assert.equal(await h.result, 'ok');
  assert.equal(calls, 3);
});

test('H05 rejects with the last error after the last retry', async () => {
  const q = createQueue(opts({ concurrency: 1, retries: 1, delay: 1 }));
  let calls = 0;
  const h = q.add(async () => { calls++; throw new Error(`e${calls}`); });
  await assert.rejects(h.result, { message: 'e2' });
  assert.equal(calls, 2);
});

test('H06 retry delays grow as delay * 2 ** (k - 1)', async () => {
  const q = createQueue(opts({ concurrency: 1, retries: 2, delay: 60 }));
  const times: number[] = [];
  const h = q.add(async () => { times.push(Date.now()); if (times.length < 3) throw new Error('x'); return 1; });
  await h.result;
  const d1 = times[1]! - times[0]!; const d2 = times[2]! - times[1]!;
  assert.ok(d1 >= 50 && d1 < 110, `first retry delay ${d1}`);
  assert.ok(d2 >= 110 && d2 < 200, `second retry delay ${d2}`);
});

test('H07 a job that waits for a retry does not hold a slot', async () => {
  const q = createQueue(opts({ concurrency: 1, retries: 1, delay: 80 }));
  let first = 0;
  const a = q.add(async () => { first++; if (first === 1) throw new Error('x'); return 'a'; });
  await delay(10);
  const start = Date.now();
  const b = q.add(async () => Date.now() - start);
  const waited = await b.result;
  assert.ok(waited < 60, `b waited ${waited} ms`);
  assert.equal(await a.result, 'a');
});

test('H08 a timed-out attempt aborts its signal and fails with TimeoutError', async () => {
  const q = createQueue(opts({ concurrency: 1, timeoutMs: 30 }));
  let signal: AbortSignal | undefined;
  const h = q.add((s) => { signal = s; return new Promise(() => {}); });
  await assert.rejects(h.result, { name: 'TimeoutError' });
  assert.equal(signal?.aborted, true);
});

test('H09 a timeout counts as a failure and retries', async () => {
  const q = createQueue(opts({ concurrency: 1, timeoutMs: 30, retries: 1, delay: 1 }));
  let calls = 0;
  const h = q.add(async () => { calls++; if (calls === 1) await new Promise(() => {}); return 'second'; });
  assert.equal(await h.result, 'second');
});

test('H10 cancel of a waiting job removes it and rejects with AbortError', async () => {
  const q = createQueue(opts({ concurrency: 1 }));
  const blocker = q.add(() => delay(30));
  let ran = false;
  const h = q.add(async () => { ran = true; });
  await delay(1);
  assert.equal(h.cancel(), true);
  await assert.rejects(h.result, { name: 'AbortError' });
  await blocker.result; await q.onIdle();
  assert.equal(ran, false);
});

test('H11 cancel of a running job aborts its signal and frees its slot', async () => {
  const q = createQueue(opts({ concurrency: 1, retries: 3, delay: 1 }));
  let signal: AbortSignal | undefined; let calls = 0;
  const h = q.add((s) => { calls++; signal = s; return new Promise(() => {}); });
  await delay(10);
  assert.equal(h.cancel(), true);
  await assert.rejects(h.result, { name: 'AbortError' });
  assert.equal(signal?.aborted, true);
  const next = q.add(async () => 'next');
  assert.equal(await Promise.race([next.result, delay(200).then(() => 'stalled')]), 'next');
  await delay(20);
  assert.equal(calls, 1);
});

test('H12 cancel during the retry delay stops further attempts', async () => {
  const q = createQueue(opts({ concurrency: 1, retries: 2, delay: 50 }));
  let calls = 0;
  const h = q.add(async () => { calls++; throw new Error('x'); });
  await delay(15);
  assert.equal(h.cancel(), true);
  await assert.rejects(h.result, { name: 'AbortError' });
  await delay(120);
  assert.equal(calls, 1);
});

test('H13 cancel returns false after the job settled', async () => {
  const q = createQueue(opts({ concurrency: 1 }));
  const h = q.add(async () => 1);
  await h.result;
  assert.equal(h.cancel(), false);
});

test('H14 onIdle waits for running jobs and resolves at once when idle', async () => {
  const q = createQueue(opts({ concurrency: 2 }));
  await q.onIdle();
  let done = 0;
  q.add(async () => { await delay(30); done++; });
  q.add(async () => { await delay(40); done++; });
  await delay(5);
  await q.onIdle();
  assert.equal(done, 2);
});

test('H15 pause stops new starts and resume continues', async () => {
  const q = createQueue(opts({ concurrency: 1 }));
  q.pause();
  let ran = false;
  const h = q.add(async () => { ran = true; return 1; });
  await delay(30);
  assert.equal(ran, false);
  assert.equal(q.size, 1);
  q.resume();
  assert.equal(await h.result, 1);
});

test('H16 size and pending count waiting and running jobs', async () => {
  const q = createQueue(opts({ concurrency: 1 }));
  q.add(() => delay(30)); q.add(() => delay(10)); q.add(() => delay(10));
  await delay(5);
  assert.equal(q.pending, 1);
  assert.equal(q.size, 2);
  await q.onIdle();
  assert.equal(q.pending, 0);
  assert.equal(q.size, 0);
});

test('H17 ids are unique', () => {
  const q = createQueue(opts({ concurrency: 1 }));
  q.pause();
  const ids = new Set(Array.from({ length: 20 }, () => q.add(async () => 1).id));
  assert.equal(ids.size, 20);
});
