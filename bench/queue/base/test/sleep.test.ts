import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep } from '../src/sleep.ts';

test('sleep resolves after the delay', async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 15);
});

test('sleep rejects with AbortError when aborted', async () => {
  const controller = new AbortController();
  const pending = sleep(1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
