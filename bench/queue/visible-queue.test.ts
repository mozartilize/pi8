import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('runs jobs and returns their results', async () => {
  const q = createQueue({ concurrency: 2 });
  const results = await Promise.all([q.add(async () => 1).result, q.add(async () => 2).result]);
  assert.deepEqual(results, [1, 2]);
});

test('retries a failing job', async () => {
  const q = createQueue({ concurrency: 1, retries: 1, retryDelayMs: 1 });
  let calls = 0;
  const h = q.add(async () => { calls++; if (calls === 1) throw new Error('x'); return 'ok'; });
  assert.equal(await h.result, 'ok');
});

test('fails an attempt that runs too long', async () => {
  const q = createQueue({ concurrency: 1, timeoutMs: 20 });
  await assert.rejects(q.add(() => new Promise(() => {})).result, { name: 'TimeoutError' });
});

test('cancels a waiting job', async () => {
  const q = createQueue({ concurrency: 1 });
  q.add(() => delay(20));
  const h = q.add(async () => 1);
  assert.equal(h.cancel(), true);
  await assert.rejects(h.result, { name: 'AbortError' });
});
