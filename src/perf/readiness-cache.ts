/**
 * Stale-while-revalidate cache for an expensive readiness check.
 *
 * - Only passing results are cached for long (`maxPassTtlMs`); failing or
 *   undetermined results are cached briefly (`failureTtlMs`, 0 disables).
 * - A passing entry past `refreshFraction` of its lifetime is served at once
 *   while exactly one background refresh recomputes it (single-flight).
 * - Results are bound to an identity supplied by the caller. If the identity
 *   changes while a check runs, the result is discarded, the check runs once
 *   more, and a second mismatch yields the caller's `unconfirmed()` value
 *   (never cached).
 * - A check may report `validityMs`, the time its pass stays truthful.
 */

import type { Clock, Scheduler, TimerHandle } from "./clock.js";
import { systemClock, systemScheduler } from "./clock.js";

export interface CheckOutcome<T> {
  value: T;
  /** True when the check passed; only passes are cached for long. */
  pass: boolean;
  /** Remaining time (ms) this pass stays valid; caps the entry lifetime. */
  validityMs?: number;
}

export interface ReadinessCacheOptions<T> {
  /** The expensive check. */
  check: () => Promise<CheckOutcome<T>>;
  /** Cache key for the inputs of the check; `null` means "unknown, do not cache". Must be cheap. */
  identity: () => string | null;
  /** Value returned when the identity kept changing during evaluation. */
  unconfirmed: () => T;
  /** Upper bound for a passing entry. */
  maxPassTtlMs: number;
  /** Lifetime of failing/undetermined entries; 0 disables caching of them. */
  failureTtlMs: number;
  /** Fraction of a pass lifetime after which reads trigger a background refresh. Default 0.8. */
  refreshFraction?: number;
  /** Delay before the warmup loop retries after an error or discarded result. Default failureTtlMs or 30000. */
  retryDelayMs?: number;
  /** Maximum number of identities kept. Default 8. */
  maxEntries?: number;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Receives isolated background errors. */
  onError?: (error: unknown) => void;
}

interface Entry<T> {
  at: number;
  value: T;
  pass: boolean;
  validityMs: number;
}

interface Evaluation<T> {
  value: T;
  confirmed: boolean;
  entry: Entry<T> | null;
}

export class ReadinessCache<T> {
  private readonly opts: ReadinessCacheOptions<T>;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly refreshFraction: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry<T>>();
  private inflight: { identity: string; promise: Promise<Evaluation<T>> } | null = null;
  private refreshing = false;
  private stopped = false;
  private warmupTimer: TimerHandle | null = null;
  private warmupStarted = false;

  constructor(options: ReadinessCacheOptions<T>) {
    this.opts = options;
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.refreshFraction = options.refreshFraction ?? 0.8;
    this.maxEntries = options.maxEntries ?? 8;
  }

  /** Current readiness: cached when fresh, otherwise computed (single-flight). */
  async get(): Promise<T> {
    for (let round = 0; round < 3; round += 1) {
      const id = this.opts.identity();
      if (id === null) return (await this.opts.check()).value;
      const hit = this.lookup(id);
      if (hit !== undefined) return hit.value;
      const running = this.inflight;
      if (running !== null && running.identity !== id) {
        // Another identity is being evaluated; let it finish, then re-read the cache.
        await running.promise.catch(() => undefined);
        continue;
      }
      const evaluation = await this.evaluateShared(id);
      return evaluation.value;
    }
    return this.opts.unconfirmed();
  }

  /** Drop all cached entries. */
  invalidate(): void {
    this.entries.clear();
  }

  /**
   * Precompute off the request path and keep fresh. Never throws and never
   * blocks the caller. Idempotent until `stop()`.
   */
  start(): void {
    if (this.warmupStarted) return;
    this.warmupStarted = true;
    this.stopped = false;
    this.scheduleWarmup(0);
  }

  /** Stop the warmup loop and any further background refreshes. */
  stop(): void {
    this.stopped = true;
    this.warmupStarted = false;
    if (this.warmupTimer !== null) {
      this.safely(() => this.scheduler.clearTimeout(this.warmupTimer as TimerHandle));
      this.warmupTimer = null;
    }
  }

  // ---- internals ----------------------------------------------------------

  private entryTtl(entry: Entry<T>): number {
    if (entry.pass) return Math.min(this.opts.maxPassTtlMs, entry.validityMs);
    return Math.min(this.opts.failureTtlMs, this.opts.maxPassTtlMs);
  }

  private lookup(id: string): Entry<T> | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    const ttl = this.entryTtl(entry);
    const age = this.clock.now() - entry.at;
    if (age >= ttl) {
      this.entries.delete(id);
      return undefined;
    }
    // LRU touch.
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (entry.pass && age >= ttl * this.refreshFraction) this.refreshInBackground(id);
    return entry;
  }

  private evaluateShared(id: string): Promise<Evaluation<T>> {
    if (this.inflight !== null && this.inflight.identity === id) return this.inflight.promise;
    const promise = this.evaluateAndStore(id).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { identity: id, promise };
    return promise;
  }

  private async evaluateAndStore(startId: string): Promise<Evaluation<T>> {
    let id: string | null = startId;
    for (let attempt = 0; attempt < 2 && id !== null; attempt += 1) {
      const outcome = await this.opts.check();
      if (this.opts.identity() === id) {
        const entry: Entry<T> = {
          at: this.clock.now(),
          value: outcome.value,
          pass: outcome.pass,
          validityMs: outcome.validityMs ?? Number.POSITIVE_INFINITY,
        };
        if (this.entryTtl(entry) > 0) this.store(id, entry);
        return { value: outcome.value, confirmed: true, entry };
      }
      // Inputs changed while evaluating: drop the result, retry under the new identity.
      id = this.opts.identity();
    }
    return { value: this.opts.unconfirmed(), confirmed: false, entry: null };
  }

  private store(id: string, entry: Entry<T>): void {
    this.entries.delete(id);
    this.entries.set(id, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  private refreshInBackground(id: string): void {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    let promise: Promise<Evaluation<T>>;
    try {
      promise = this.evaluateShared(id);
    } catch (error) {
      this.refreshing = false;
      this.report(error);
      return;
    }
    promise
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.refreshing = false;
      });
  }

  private retryDelay(): number {
    return this.opts.retryDelayMs ?? (this.opts.failureTtlMs > 0 ? this.opts.failureTtlMs : 30_000);
  }

  private scheduleWarmup(delayMs: number): void {
    if (this.stopped) return;
    try {
      this.warmupTimer = this.scheduler.setTimeout(() => void this.warmupTick(), delayMs);
    } catch (error) {
      // Could not schedule; stay usable on demand and report.
      this.warmupTimer = null;
      this.warmupStarted = false;
      this.report(error);
    }
  }

  private async warmupTick(): Promise<void> {
    this.warmupTimer = null;
    if (this.stopped) return;
    let delay = this.retryDelay();
    try {
      const id = this.opts.identity();
      if (id !== null) {
        const evaluation = await this.evaluateShared(id);
        if (evaluation.confirmed && evaluation.entry !== null) {
          const ttl = this.entryTtl(evaluation.entry);
          delay = evaluation.entry.pass && ttl > 0 ? Math.max(1, ttl * this.refreshFraction) : this.retryDelay();
        }
      }
    } catch (error) {
      this.report(error);
    }
    this.scheduleWarmup(delay);
  }

  private report(error: unknown): void {
    this.safely(() => this.opts.onError?.(error));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      /* isolated */
    }
  }
}
