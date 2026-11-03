import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessCache } from '../../dist/perf/readiness-cache.js';
import { FakeTime, deferred, flush } from './fakes.mjs';

function setup(overrides = {}) {
  const time = new FakeTime();
  const state = { identity: 'v1', calls: 0, result: { value: 'ready', pass: true }, errors: [] };
  const cache = new ReadinessCache({
    check: async () => {
      state.calls += 1;
      return state.result;
    },
    identity: () => state.identity,
    unconfirmed: () => 'unconfirmed',
    maxPassTtlMs: 1000,
    failureTtlMs: 100,
    clock: time.clock,
    scheduler: time.scheduler,
    onError: (error) => state.errors.push(error),
    ...overrides,
  });
  return { time, state, cache };
}

test('pass is cached until expiry, then recomputed', async () => {
  const { time, state, cache } = setup();
  assert.equal(await cache.get(), 'ready');
  assert.equal(await cache.get(), 'ready');
  assert.equal(state.calls, 1);
  await time.advance(1000);
  assert.equal(await cache.get(), 'ready');
  assert.equal(state.calls, 2);
});

test('near expiry the stale value is served at once and refreshed once in the background', async () => {
  const { time, state, cache } = setup();
  await cache.get();
  await time.advance(850);
  const gate = deferred();
  state.result = { value: 'ready-2', pass: true };
  const original = state.result;
  cache.opts.check = async () => {
    state.calls += 1;
    await gate.promise;
    return original;
  };
  assert.equal(await cache.get(), 'ready'); // stale, immediate
  assert.equal(await cache.get(), 'ready'); // second read does not start a second refresh
  assert.equal(state.calls, 2);
  gate.resolve();
  await flush();
  assert.equal(await cache.get(), 'ready-2');
  assert.equal(state.calls, 2);
});

test('concurrent cold callers share one evaluation', async () => {
  const gate = deferred();
  let calls = 0;
  const time = new FakeTime();
  const cache = new ReadinessCache({
    check: async () => {
      calls += 1;
      await gate.promise;
      return { value: 'x', pass: true };
    },
    identity: () => 'id',
    unconfirmed: () => 'u',
    maxPassTtlMs: 1000,
    failureTtlMs: 0,
    clock: time.clock,
    scheduler: time.scheduler,
  });
  const all = Promise.all([cache.get(), cache.get(), cache.get()]);
  await flush();
  gate.resolve();
  assert.deepEqual(await all, ['x', 'x', 'x']);
  assert.equal(calls, 1);
});

test('failures are cached only for failureTtl; zero disables caching', async () => {
  const { time, state, cache } = setup();
  state.result = { value: 'bad', pass: false };
  await cache.get();
  await cache.get();
  assert.equal(state.calls, 1);
  await time.advance(100);
  await cache.get();
  assert.equal(state.calls, 2);

  const zero = setup({ failureTtlMs: 0 });
  zero.state.result = { value: 'bad', pass: false };
  await zero.cache.get();
  await zero.cache.get();
  assert.equal(zero.state.calls, 2);
});

test('validityMs caps a pass lifetime', async () => {
  const { time, state, cache } = setup({ refreshFraction: 1 });
  state.result = { value: 'ready', pass: true, validityMs: 200 };
  await cache.get();
  await time.advance(199);
  await cache.get();
  assert.equal(state.calls, 1);
  await time.advance(2);
  await cache.get();
  assert.equal(state.calls, 2);
});

test('identity change selects a separate entry', async () => {
  const { state, cache } = setup();
  await cache.get();
  state.identity = 'v2';
  await cache.get();
  assert.equal(state.calls, 2);
  state.identity = 'v1';
  await cache.get();
  assert.equal(state.calls, 2);
});

test('identity changing during evaluation: result dropped, one retry, then unconfirmed and not cached', async () => {
  const { state, cache } = setup();
  let n = 0;
  cache.opts.check = async () => {
    state.calls += 1;
    n += 1;
    state.identity = `moving-${n}`;
    return { value: 'stale-input', pass: true };
  };
  assert.equal(await cache.get(), 'unconfirmed');
  assert.equal(state.calls, 2);
  assert.equal(cache.entries.size, 0);
});

test('identity changing once is recovered by the single retry', async () => {
  const { state, cache } = setup();
  cache.opts.check = async () => {
    state.calls += 1;
    if (state.calls === 1) state.identity = 'v2';
    return { value: `r${state.calls}`, pass: true };
  };
  assert.equal(await cache.get(), 'r2');
  assert.equal(await cache.get(), 'r2');
  assert.equal(state.calls, 2);
});

test('null identity bypasses the cache', async () => {
  const { state, cache } = setup();
  state.identity = null;
  await cache.get();
  await cache.get();
  assert.equal(state.calls, 2);
});

test('warmup precomputes, refreshes before expiry, and survives errors; stop halts it', async () => {
  const { time, state, cache } = setup();
  cache.start();
  await time.advance(0);
  assert.equal(state.calls, 1);
  assert.equal(await cache.get(), 'ready');
  assert.equal(state.calls, 1); // served from the warmed entry
  await time.advance(800);
  assert.equal(state.calls, 2);

  const failing = cache.opts.check;
  cache.opts.check = async () => {
    state.calls += 1;
    throw new Error('boom');
  };
  await time.advance(800);
  assert.equal(state.errors.length, 1); // isolated, loop continues
  cache.opts.check = failing;
  const before = state.calls;
  cache.stop();
  await time.advance(10_000);
  assert.equal(state.calls, before);
});

test('scheduler start failure is reported and does not throw', async () => {
  const { state, cache } = setup({
    scheduler: {
      setTimeout: () => {
        throw new Error('cannot start');
      },
      clearTimeout() {},
    },
  });
  assert.doesNotThrow(() => cache.start());
  assert.equal(state.errors.length, 1);
  assert.equal(await cache.get(), 'ready'); // still usable on demand
});
