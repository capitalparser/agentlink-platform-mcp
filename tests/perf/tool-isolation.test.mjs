import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLimiter, ToolBusyError, ToolTimeoutError, healthSnapshot, runInWorker } from '../../dist/perf/tool-isolation.js';
import { FakeTime, deferred, flush } from './fakes.mjs';

function setup(extra = {}) {
  const time = new FakeTime();
  const limiter = new ToolLimiter({ maxConcurrent: 2, queueWaitMs: 50, timeoutMs: 1000, scheduler: time.scheduler, ...extra });
  return { time, limiter };
}

test('concurrency is capped and waiting callers get a slot when one frees', async () => {
  const { limiter } = setup();
  const gates = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;
  const task = (index) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gates[index].promise;
    running -= 1;
    return index;
  };
  const results = [0, 1, 2].map((index) => limiter.run(task(index)));
  await flush();
  assert.deepEqual(limiter.stats(), { active: 2, queued: 1, maxConcurrent: 2 });
  gates[0].resolve();
  await flush();
  assert.equal(limiter.stats().queued, 0);
  gates[1].resolve();
  gates[2].resolve();
  assert.deepEqual(await Promise.all(results), [0, 1, 2]);
  assert.equal(peak, 2);
  assert.equal(limiter.stats().active, 0);
});

test('waiting longer than queueWaitMs yields a busy error', async () => {
  const { time, limiter } = setup();
  const hold = deferred();
  limiter.run(() => hold.promise);
  limiter.run(() => hold.promise);
  const waiting = limiter.run(async () => 'late');
  const assertion = assert.rejects(waiting, ToolBusyError);
  await time.advance(50);
  await assertion;
  assert.equal(limiter.stats().queued, 0);
  hold.resolve();
});

test('queueWaitMs 0 fails immediately when full', async () => {
  const { limiter } = setup({ queueWaitMs: 0 });
  const hold = deferred();
  limiter.run(() => hold.promise);
  limiter.run(() => hold.promise);
  await assert.rejects(limiter.run(async () => 1), ToolBusyError);
  hold.resolve();
});

test('timeout answers the caller but the slot stays held until the work ends', async () => {
  const { time, limiter } = setup({ maxConcurrent: 1, queueWaitMs: 0 });
  const work = deferred();
  let aborted = false;
  const call = limiter.run((signal) => {
    signal.addEventListener('abort', () => {
      aborted = true;
    });
    return work.promise;
  });
  const assertion = assert.rejects(call, ToolTimeoutError);
  await flush(); // let the call acquire its slot and arm the timer
  await time.advance(1000);
  await assertion;
  assert.equal(aborted, true);
  assert.equal(limiter.stats().active, 1); // still occupied
  await assert.rejects(limiter.run(async () => 1), ToolBusyError);
  work.reject(new Error('late failure')); // must not surface as an unhandled rejection
  await flush();
  assert.equal(limiter.stats().active, 0);
  assert.equal(await limiter.run(async () => 'free'), 'free');
});

test('task errors propagate and release the slot', async () => {
  const { limiter } = setup();
  await assert.rejects(limiter.run(async () => { throw new Error('x'); }), /x/);
  await assert.rejects(limiter.run(() => { throw new Error('sync'); }), /sync/);
  assert.equal(limiter.stats().active, 0);
});

test('health snapshot answers immediately while every slot is busy', async () => {
  const { limiter } = setup();
  const hold = deferred();
  limiter.run(() => hold.promise);
  limiter.run(() => hold.promise);
  limiter.run(() => hold.promise);
  await flush();
  const health = healthSnapshot(limiter, { version: '1' });
  assert.equal(health.ok, true);
  assert.deepEqual(health.executor, { active: 2, queued: 1, maxConcurrent: 2 });
  hold.resolve();
});

test('worker thread keeps the event loop free; timeout terminates it and frees the slot at exit', async () => {
  const limiter = new ToolLimiter({ maxConcurrent: 1, queueWaitMs: 0, timeoutMs: 150 });
  const spin = { eval: true, filename: 'const {parentPort}=require("node:worker_threads"); for(;;){}' };
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 10);
  await assert.rejects(limiter.run((signal) => runInWorker(spin, signal)), ToolTimeoutError);
  clearInterval(interval);
  assert.ok(ticks >= 3, `event loop stayed responsive (${ticks} ticks)`);
  for (let i = 0; i < 100 && limiter.stats().active > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(limiter.stats().active, 0);
  const ok = { eval: true, filename: 'const {parentPort,workerData}=require("node:worker_threads"); parentPort.postMessage(workerData*2)', data: 21 };
  assert.equal(await limiter.run((signal) => runInWorker(ok, signal)), 42);
});
