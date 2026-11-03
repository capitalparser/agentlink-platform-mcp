/** Deterministic clock and scheduler for the perf tests. */
export class FakeTime {
  constructor() {
    this.t = 0;
    this.timers = [];
    this.nextId = 1;
    this.clock = { now: () => this.t };
    this.scheduler = {
      setTimeout: (callback, delayMs) => {
        const timer = { id: this.nextId++, at: this.t + delayMs, callback };
        this.timers.push(timer);
        return timer.id;
      },
      clearTimeout: (id) => {
        this.timers = this.timers.filter((timer) => timer.id !== id);
      },
    };
  }

  /** Advance time and fire due timers in order. */
  async advance(ms) {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.callback();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

export async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A promise whose resolution the test controls. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
