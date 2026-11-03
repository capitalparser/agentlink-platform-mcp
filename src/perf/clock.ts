/** Injectable time and timer sources so cache and limiter behavior is testable without real waiting. */

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
}

export type TimerHandle = unknown;

export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
};

export const systemScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    // Background timers must never keep the process alive.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
