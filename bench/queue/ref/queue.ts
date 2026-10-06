import { abortError } from './sleep.ts';

export interface QueueOptions {
  concurrency: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface AddOptions {
  priority?: number;
}

export interface JobHandle<T> {
  id: string;
  result: Promise<T>;
  cancel(): boolean;
}

export interface Queue {
  add<T>(fn: (signal: AbortSignal) => Promise<T>, options?: AddOptions): JobHandle<T>;
  onIdle(): Promise<void>;
  pause(): void;
  resume(): void;
  readonly size: number;
  readonly pending: number;
}

interface Job {
  id: string;
  priority: number;
  seq: number;
  fn: (signal: AbortSignal) => Promise<unknown>;
  attempt: number;
  state: 'waiting' | 'delayed' | 'running' | 'settled';
  controller?: AbortController;
  retryTimer?: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function timeoutError(ms: number): Error {
  const error = new Error(`Attempt timed out after ${ms} ms`);
  error.name = 'TimeoutError';
  return error;
}

export function createQueue(options: QueueOptions): Queue {
  const { concurrency, retries = 0, retryDelayMs = 0, timeoutMs } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be an integer >= 1');

  const waiting: Job[] = [];
  const delayed = new Set<Job>();
  let running = 0;
  let paused = false;
  let nextId = 0;
  let idleWaiters: Array<() => void> = [];

  const isIdle = () => waiting.length === 0 && delayed.size === 0 && running === 0;

  function checkIdle(): void {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function enqueue(job: Job): void {
    job.state = 'waiting';
    // Keep the array sorted: higher priority first, then lower seq first.
    let index = waiting.findIndex((other) => other.priority < job.priority || (other.priority === job.priority && other.seq > job.seq));
    if (index === -1) index = waiting.length;
    waiting.splice(index, 0, job);
  }

  function pump(): void {
    while (!paused && running < concurrency && waiting.length > 0) start(waiting.shift()!);
    checkIdle();
  }

  function settle(job: Job): void {
    job.state = 'settled';
    job.controller = undefined;
  }

  function start(job: Job): void {
    job.state = 'running';
    job.attempt += 1;
    running += 1;
    const controller = new AbortController();
    job.controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = new Promise<unknown>((resolve, reject) => {
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const error = timeoutError(timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }
      Promise.resolve()
        .then(() => job.fn(controller.signal))
        .then(resolve, reject);
    });
    attempt.then(
      (value) => {
        clearTimeout(timer);
        if (job.state !== 'running' || job.controller !== controller) return;
        running -= 1;
        settle(job);
        job.resolve(value);
        pump();
      },
      (error) => {
        clearTimeout(timer);
        if (job.state !== 'running' || job.controller !== controller) return;
        running -= 1;
        job.controller = undefined;
        if (job.attempt <= retries) {
          job.state = 'delayed';
          delayed.add(job);
          job.retryTimer = setTimeout(() => {
            job.retryTimer = undefined;
            delayed.delete(job);
            enqueue(job);
            pump();
          }, retryDelayMs * 2 ** (job.attempt - 1));
          job.retryTimer.unref?.();
        } else {
          settle(job);
          job.reject(error);
        }
        pump();
      },
    );
  }

  function cancel(job: Job): boolean {
    if (job.state === 'settled') return false;
    if (job.state === 'waiting') {
      waiting.splice(waiting.indexOf(job), 1);
    } else if (job.state === 'delayed') {
      clearTimeout(job.retryTimer);
      job.retryTimer = undefined;
      delayed.delete(job);
    } else {
      running -= 1;
      job.controller?.abort(abortError());
    }
    settle(job);
    job.reject(abortError());
    pump();
    return true;
  }

  return {
    add<T>(fn: (signal: AbortSignal) => Promise<T>, addOptions: AddOptions = {}): JobHandle<T> {
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<T>((res, rej) => {
        resolve = res as (value: unknown) => void;
        reject = rej;
      });
      const job: Job = {
        id: String(nextId++),
        priority: addOptions.priority ?? 0,
        seq: nextId,
        fn,
        attempt: 0,
        state: 'waiting',
        resolve,
        reject,
      };
      enqueue(job);
      // Defer the start so that jobs added in the same tick are ordered by priority.
      queueMicrotask(pump);
      return { id: job.id, result, cancel: () => cancel(job) };
    },
    onIdle(): Promise<void> {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
      pump();
    },
    get size(): number {
      return waiting.length + delayed.size;
    },
    get pending(): number {
      return running;
    },
  };
}
