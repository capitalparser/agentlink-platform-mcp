/**
 * Tool execution isolation: bounded concurrency, bounded waiting, response
 * timeouts and a health path that never queues.
 *
 * Limits of a single Node.js event loop:
 * - `ToolLimiter` only bounds how many tool calls are in flight and how long a
 *   caller waits. It cannot interrupt synchronous or CPU-heavy code; such work
 *   blocks every request, including health checks, no matter what wrapper is used.
 *   Run that work through `runInWorker` (worker_threads) or an injected executor.
 * - On timeout the caller gets an error immediately, but the slot stays occupied
 *   until the underlying work really ends. Otherwise abandoned work would pile up.
 *   Work that ignores the abort signal keeps its slot; worker-thread work is
 *   terminated, and its slot frees when the thread exits.
 */

import { Worker } from "node:worker_threads";
import type { WorkerOptions } from "node:worker_threads";
import type { Scheduler, TimerHandle } from "./clock.js";
import { systemScheduler } from "./clock.js";

export class ToolBusyError extends Error {
  readonly code = "TOOL_BUSY";
  readonly transient = true;
  constructor(message = "All execution slots are busy; retry shortly.") {
    super(message);
    this.name = "ToolBusyError";
  }
}

export class ToolTimeoutError extends Error {
  readonly code = "TOOL_TIMEOUT";
  readonly transient = true;
  constructor(message = "The tool did not finish in time.") {
    super(message);
    this.name = "ToolTimeoutError";
  }
}

export interface ToolLimiterOptions {
  /** Maximum calls running at once. */
  maxConcurrent: number;
  /** How long a call may wait for a free slot before ToolBusyError. 0 = fail immediately. */
  queueWaitMs: number;
  /** Maximum waiting callers (beyond this, fail at once). Default unlimited. */
  maxQueued?: number;
  /** Default response timeout for a call. 0 or undefined = none. */
  timeoutMs?: number;
  scheduler?: Scheduler;
}

export interface RunOptions {
  /** Overrides the default response timeout for this call. */
  timeoutMs?: number;
}

export interface LimiterStats {
  active: number;
  queued: number;
  maxConcurrent: number;
}

interface Waiter {
  grant: () => void;
  timer: TimerHandle | null;
}

export class ToolLimiter {
  private readonly opts: ToolLimiterOptions;
  private readonly scheduler: Scheduler;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(options: ToolLimiterOptions) {
    if (!(options.maxConcurrent >= 1)) throw new RangeError("maxConcurrent must be >= 1");
    this.opts = options;
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  /** Synchronous snapshot; safe for health endpoints. */
  stats(): LimiterStats {
    return { active: this.active, queued: this.waiters.length, maxConcurrent: this.opts.maxConcurrent };
  }

  /**
   * Run `task` in a slot. `task` receives an AbortSignal that fires on timeout.
   * The returned promise rejects with ToolBusyError / ToolTimeoutError, or the task's own error.
   */
  async run<T>(task: (signal: AbortSignal) => Promise<T>, options: RunOptions = {}): Promise<T> {
    await this.acquire();
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 0;
    let work: Promise<T>;
    try {
      work = Promise.resolve(task(controller.signal));
    } catch (error) {
      this.release();
      throw error;
    }
    // The slot is released only when the work itself settles, not when the caller gives up.
    const settled = work.then(
      () => undefined,
      () => undefined,
    ).finally(() => this.release());
    void settled;
    if (!(timeoutMs > 0)) return work;
    let timer: TimerHandle;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.scheduler.setTimeout(() => {
        controller.abort();
        reject(new ToolTimeoutError());
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      this.scheduler.clearTimeout(timer);
      // The timed-out work may reject later; that must not become an unhandled rejection.
      work.catch(() => undefined);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.opts.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    const max = this.opts.maxQueued ?? Number.POSITIVE_INFINITY;
    if (this.opts.queueWaitMs <= 0 || this.waiters.length >= max) {
      return Promise.reject(new ToolBusyError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { grant: () => resolve(), timer: null };
      waiter.timer = this.scheduler.setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new ToolBusyError());
        }
      }, this.opts.queueWaitMs);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot over directly: `active` stays unchanged.
      if (next.timer !== null) this.scheduler.clearTimeout(next.timer);
      next.grant();
      return;
    }
    this.active -= 1;
  }
}

/** Health payload that never waits on the limiter. Merge it into the health response. */
export function healthSnapshot(limiter: ToolLimiter, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra, executor: limiter.stats() };
}

export interface WorkerTask {
  /** Worker script path/URL, or source code when `eval` is true. */
  filename: string | URL;
  eval?: boolean;
  /** Passed to the worker as `workerData`. */
  data?: unknown;
  workerOptions?: Omit<WorkerOptions, "eval" | "workerData">;
}

/**
 * Run CPU-heavy or blocking work in a worker thread. The worker should
 * `parentPort.postMessage(result)` once. Aborting the signal terminates the
 * thread; the returned promise settles only after the thread has exited, so
 * pairing it with `ToolLimiter.run` frees the slot exactly when the thread ends.
 */
export function runInWorker<T>(task: WorkerTask, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(task.filename, {
      ...task.workerOptions,
      eval: task.eval ?? false,
      workerData: task.data,
    });
    let result: { value: T } | null = null;
    let failure: unknown = null;
    const onAbort = (): void => {
      failure ??= new ToolTimeoutError("Worker terminated after abort.");
      void worker.terminate();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (value: T) => {
      result = { value };
    });
    worker.once("error", (error) => {
      failure ??= error;
    });
    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (failure !== null) reject(failure);
      else if (result !== null) resolve(result.value);
      else reject(new Error(`Worker exited with code ${code} without a result.`));
    });
  });
}
