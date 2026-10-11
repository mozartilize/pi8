/**
 * Linear-programming adapter of the unified selector.
 *
 * The solver is HiGHS (npm `highs`, MIT) in a worker thread. A synchronous
 * WebAssembly solve cannot be interrupted from the main event loop, so the
 * deadline and cancellation terminate the worker. The next request starts a
 * new worker. Every optimal answer is verified here before use: an answer
 * that fails verification is an error, never a partial optimum.
 */
import { Worker } from 'node:worker_threads';

import { LP_RESIDUAL_TOLERANCE } from './weights.js';

export interface LinearRow {
  /** Dense coefficients, one per column. */
  coeffs: readonly number[];
  /** Absent means no lower bound. */
  lower?: number;
  /** Absent means no upper bound. */
  upper?: number;
}

/** `{ x | colLower <= x <= colUpper, lower <= row.x <= upper }`. */
export interface Polytope {
  numCols: number;
  /** `undefined` entry means unbounded below. */
  colLower: readonly (number | undefined)[];
  /** `undefined` entry means unbounded above. */
  colUpper: readonly (number | undefined)[];
  rows: readonly LinearRow[];
}

export type LpStatus = 'optimal' | 'infeasible' | 'infeasible-or-unbounded' | 'unbounded' | `status-${number}`;

export interface LpResult {
  status: LpStatus;
  objective?: number;
  x?: number[];
}

export interface LpRequest {
  polytope: Polytope;
  objectives: readonly (readonly number[])[];
  sense: 'max' | 'min';
}

export interface LpRunControls {
  signal?: AbortSignal;
  /** Absolute `performance.now()` time after which the request fails with `LpTimeoutError`. */
  deadlineAt?: number;
}

export interface LPAdapter {
  solve(request: LpRequest, controls?: LpRunControls): Promise<LpResult[]>;
  /** Release solver resources. Later requests start new resources. */
  close(): Promise<void>;
}

export class LpTimeoutError extends Error {
  constructor() {
    super('LP deadline reached');
    this.name = 'LpTimeoutError';
  }
}

export class LpCancelledError extends Error {
  constructor() {
    super('LP request cancelled');
    this.name = 'LpCancelledError';
  }
}

export class LpVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LpVerificationError';
  }
}

const dot = (a: readonly number[], b: readonly number[]): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * (b[i] ?? 0);
  return sum;
};

/**
 * Check an LP answer: finite values, column and row bounds within the
 * residual tolerance, and the reported objective equal to `objective . x`.
 * Returns undefined when the answer passes, else the failure.
 */
export function lpAnswerProblem(
  polytope: Polytope,
  objective: readonly number[],
  result: LpResult,
  tolerance = LP_RESIDUAL_TOLERANCE,
): string | undefined {
  if (result.status !== 'optimal') return `status ${result.status}`;
  const x = result.x;
  if (!x || x.length !== polytope.numCols) return 'solution has the wrong length';
  if (!x.every(Number.isFinite) || !Number.isFinite(result.objective)) return 'solution is not finite';
  return pointProblem(polytope, x, tolerance)
    ?? (Math.abs(dot(objective, x) - result.objective!) > tolerance ? 'objective residual above tolerance' : undefined);
}

/** Undefined when `x` lies in the polytope within `tolerance`, else the failure. */
export function pointProblem(polytope: Polytope, x: readonly number[], tolerance = LP_RESIDUAL_TOLERANCE): string | undefined {
  if (x.length !== polytope.numCols || !x.every(Number.isFinite)) return 'point is not a finite vector of the polytope dimension';
  for (let j = 0; j < polytope.numCols; j++) {
    const lower = polytope.colLower[j];
    const upper = polytope.colUpper[j];
    if (lower !== undefined && x[j]! < lower - tolerance) return `column ${j} below its lower bound`;
    if (upper !== undefined && x[j]! > upper + tolerance) return `column ${j} above its upper bound`;
  }
  for (const [index, row] of polytope.rows.entries()) {
    const activity = dot(row.coeffs, x);
    if (row.lower !== undefined && activity < row.lower - tolerance) return `row ${index} below its lower bound`;
    if (row.upper !== undefined && activity > row.upper + tolerance) return `row ${index} above its upper bound`;
  }
  return undefined;
}

interface Pending {
  resolve: (results: LpResult[]) => void;
  reject: (error: Error) => void;
}

const WORKER_URL = new URL('./lp-worker.mjs', import.meta.url);

/** HiGHS in a terminable worker thread. One request at a time per adapter. */
export class WorkerLpAdapter implements LPAdapter {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  solve(request: LpRequest, controls: LpRunControls = {}): Promise<LpResult[]> {
    const run = this.queue.then(() => this.run(request, controls));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_URL);
    worker.unref();
    worker.on('message', (message: { id: number; results?: LpResult[]; error?: string }) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(`LP worker: ${message.error}`));
      else entry.resolve(message.results ?? []);
    });
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = undefined;
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        entry.reject(error);
      }
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`LP worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  private async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }

  private run(request: LpRequest, controls: LpRunControls): Promise<LpResult[]> {
    if (controls.signal?.aborted) return Promise.reject(new LpCancelledError());
    if (controls.deadlineAt !== undefined && performance.now() >= controls.deadlineAt) {
      return Promise.reject(new LpTimeoutError());
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<LpResult[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => stop(new LpCancelledError());
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        controls.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const stop = (error: Error) => {
        cleanup();
        // The worker may be in a synchronous solve; only termination stops it.
        void this.terminate().finally(() => reject(error));
      };
      this.pending.set(id, {
        resolve: (results) => { cleanup(); resolve(results); },
        reject: (error) => { cleanup(); reject(error); },
      });
      if (controls.deadlineAt !== undefined) {
        timer = setTimeout(() => stop(new LpTimeoutError()), Math.max(0, controls.deadlineAt - performance.now()));
      }
      controls.signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ id, polytope: request.polytope, objectives: request.objectives, sense: request.sense });
    });
  }

  async close(): Promise<void> {
    await this.terminate();
  }

  /** True while a worker thread exists. Tests use it to observe termination. */
  get hasWorker(): boolean {
    return this.worker !== undefined;
  }
}
