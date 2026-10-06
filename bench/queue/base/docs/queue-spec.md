# Job queue specification

`src/queue.ts` exports `createQueue(options)`.

```ts
export interface QueueOptions {
  concurrency: number;    // integer >= 1, else createQueue throws RangeError
  retries?: number;       // extra attempts after a failure, default 0
  retryDelayMs?: number;  // base delay before a retry, default 0
  timeoutMs?: number;     // limit for one attempt, default: no limit
}

export interface AddOptions { priority?: number }  // default 0

export interface JobHandle<T> {
  id: string;             // unique in the queue
  result: Promise<T>;
  cancel(): boolean;
}

export interface Queue {
  add<T>(fn: (signal: AbortSignal) => Promise<T>, options?: AddOptions): JobHandle<T>;
  onIdle(): Promise<void>;
  pause(): void;
  resume(): void;
  readonly size: number;    // jobs that wait to start (including jobs that wait for a retry)
  readonly pending: number; // jobs that run an attempt now
}
```

Rules:

1. At most `concurrency` attempts run at the same time.
2. A job with a higher `priority` starts before a job with a lower one. Jobs with the same priority start in the order they were added.
3. When an attempt rejects, the job is tried again, up to `retries` more times. The delay before retry number k (k = 1, 2, ...) is `retryDelayMs * 2 ** (k - 1)`. A job that waits for a retry does not use a concurrency slot. When no attempt is left, `result` rejects with the last error.
4. When an attempt runs longer than `timeoutMs`, its signal is aborted and the attempt fails with an Error whose `name` is `"TimeoutError"`. A timeout counts as a failure, so the job can retry.
5. `cancel()` returns `false` when the job already settled. Otherwise it returns `true`, `result` rejects with an Error whose `name` is `"AbortError"`, and the job never runs again. A running attempt gets its signal aborted. A job that waits (to start or for a retry) is removed.
6. `onIdle()` resolves when no job waits and no attempt runs. It resolves at once when the queue is idle.
7. `pause()` stops new attempts from starting. Running attempts continue. `resume()` starts attempts again.
8. Timers that the queue starts must not keep the process alive after the queue is idle.
