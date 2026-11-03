# MCP performance and stability playbook

Patterns that keep an MCP server fast and responsive under real traffic, plus a
repeatable way to find out which one you need. The examples use generic tool
names (`search_items`, `get_item`); numbers are illustrative, rounded values
from production-style measurements.

## 1. Measure first: per-tool duration from operation logs

Log one structured line per tool call, for example
`{"event":"tool_call","tool":"search_items","duration_ms":812,"ok":true}`.
Aggregate per tool before changing anything. Averages hide the problem; use
p50, p95 and max.

```sh
# p50 / p95 / max per tool from JSON lines (requires jq)
jq -r 'select(.event=="tool_call") | [.tool, .duration_ms] | @tsv' app.log \
| sort -k1,1 -k2,2n \
| awk -F'\t' '
    { v[$1,++n[$1]] = $2 }
    END { for (t in n) {
            i50 = int(n[t]*0.50 + 0.5); i95 = int(n[t]*0.95 + 0.5);
            printf "%-24s n=%-6d p50=%-8s p95=%-8s max=%s\n", t, n[t], v[t,i50], v[t,i95], v[t,n[t]]
          } }' | sort
```

Read the table by shape, not only by size:

| Shape | Usual cause |
| --- | --- |
| p50 low, p95/max huge | cold I/O after idle, or a periodic expensive gate |
| p50 and p95 both high | the query itself is slow (missing index, wrong plan, N+1) |
| duration grows with concurrency | a shared lock, a saturated pool, or work blocking the event loop |
| only the first call after idle is slow | page cache / connection / lazy-init cold start |

## 2. Diagnosis procedure

1. **Cold I/O.** Run the same call twice after an idle period. A first call of
   13 s followed by 20 ms means the data was not in memory. Fix by warming
   (read the hot files or run a cheap representative query at startup and
   periodically), not by caching responses.
2. **Readiness gate.** If many tools share a precondition check ("is the
   dataset ready"), time that check alone. If it is expensive, it is paid by
   whichever caller arrives first after expiry. Use the stale-while-revalidate
   readiness cache (section 3.1) and precompute at startup.
3. **N+1.** Count backend queries per tool call (log the count next to
   `duration_ms`). A call that issues one query per returned row needs a
   batched or joined query.
4. **Planner mis-choice.** With missing or stale statistics, the planner may
   pick a full scan or the wrong index for a selective filter. Confirm with the
   backend's `EXPLAIN` output; if statistics cannot be collected, add an
   explicit index hint for that one query and record why in a comment.
5. **Unbounded scans.** A search with no narrowing argument that touches every
   row is a request-shaped denial of service. Add a scope guard (3.2).
6. **Event-loop blocking.** If health checks are slow while a tool runs, the
   tool is blocking the loop. Move it off the loop (3.3).

Re-measure after each change; keep the before/after table in the pull request.

## 3. The three patterns

The modules live in ``src/perf/``.

### 3.1 Stale-while-revalidate readiness cache (`readiness-cache.ts`)

```ts
import { ReadinessCache } from "./perf/readiness-cache.js";

const readiness = new ReadinessCache<{ ready: boolean }>({
  check: async () => {
    const ready = await runExpensiveCheck();
    // validityMs: how long a pass stays truthful (optional)
    return { value: { ready }, pass: ready, validityMs: msUntilNextDeadline() };
  },
  identity: () => currentDataVersion(), // cheap; null = unknown, do not cache
  unconfirmed: () => ({ ready: false }),
  maxPassTtlMs: 60 * 60_000,
  failureTtlMs: 30_000, // 0 disables caching of failures
});
readiness.start();             // precompute at startup, off the request path
const state = await readiness.get();
// on shutdown: readiness.stop();
```

Behavior: passes are cached up to `maxPassTtlMs` (or `validityMs` if smaller);
failures for `failureTtlMs`. After 80% of a pass lifetime reads return the
cached value immediately and trigger one background refresh. Errors in
background work go to `onError` and never throw into callers. `clock` and
`scheduler` can be injected for deterministic tests.

### 3.2 Scope guard (`scope-guard.ts`)

```ts
import { withScopeGuard } from "./perf/scope-guard.js";

const searchItems = withScopeGuard(rawSearchItems, {
  scopeFields: ["group", "category_prefix"],
  messageTemplate: 'Searching "{subject}" across everything is too broad. Provide one of: {fields}.',
  subjectField: "keyword",
  appliesTo: (args) => Boolean(args.keyword),
  bypassEnvVar: "MYSERVER_ALLOW_UNSCOPED_SEARCH", // operator override
});
```

When no scope field has a value the backend is not called; the caller receives
`{ error: "scope_required", transient: true, message, required_any_of }`.

### 3.3 Tool execution isolation (`tool-isolation.ts`)

```ts
import { ToolLimiter, healthSnapshot, runInWorker } from "./perf/tool-isolation.js";

const limiter = new ToolLimiter({ maxConcurrent: 4, queueWaitMs: 2000, timeoutMs: 30_000 });

// (a) Pure async I/O tool: limiter and timeout only.
const result = await limiter.run((signal) => fetchSomething({ signal }));

// (b) CPU-heavy or synchronous work: run it in a worker thread.
const heavy = await limiter.run((signal) =>
  runInWorker({ filename: new URL("./heavy-worker.js", import.meta.url), data: input }, signal));

// Health: synchronous, never takes a slot.
const health = healthSnapshot(limiter, { version });
```

Errors: `ToolBusyError` (`TOOL_BUSY`, no slot within `queueWaitMs`) and
`ToolTimeoutError` (`TOOL_TIMEOUT`); both are transient. Map them to your
protocol's error shape at the edge.

Limits (single event loop): the limiter cannot interrupt synchronous code. A
tool that blocks the loop blocks every request, health included, so such work
must go through `runInWorker` or an injected executor. Async tools that ignore
the abort signal keep their slot until they finish; worker-thread tools are
terminated and release the slot when the thread exits.

## 4. Common pitfalls

- **Cache identity.** The key must capture everything the check reads (file
  version, schema version, configuration generation). A key that is too coarse
  serves answers for inputs that no longer exist; compute it cheaply, it runs on
  every read. Return `null`/`None` when the identity cannot be determined: the
  cache then steps aside instead of guessing.
- **Cache only passes for long.** A cached failure keeps a healthy service
  looking broken after the fix. Keep `failureTtl` short (or 0) and bound passes
  by `maxPassTtl` and by any validity hint the check can give.
- **Result computed under an old identity.** If the inputs changed during the
  check, never store the result; re-evaluate once, then report "unconfirmed"
  rather than a stale pass.
- **Timeout is not cancellation.** Answering the caller on timeout does not stop
  the work. If the slot is released at that moment, abandoned work accumulates
  and the limiter stops limiting. Hold the slot until the work really ends.
- **Health must not queue.** Health and readiness endpoints answer from a
  synchronous snapshot and never take an execution slot, otherwise a saturated
  server is reported dead and restarted in a loop.
- **A limiter does not unblock a blocked loop.** CPU-bound or synchronous work
  needs a thread/worker; concurrency limits alone only bound how many callers
  suffer.
- **Guard leaks.** Do not put operator-only environment variable names into
  user-facing guidance unless you mean to.

## 5. Checklist

- [ ] Per-tool `duration_ms` is logged; p50/p95/max reviewed per tool.
- [ ] First call after idle measured; warmup in place if it differs from steady state.
- [ ] Shared preconditions use the readiness cache with a startup precompute.
- [ ] Cache identity covers every input; `failureTtl` short; `maxPassTtl` set.
- [ ] Queries per call counted; no per-row queries.
- [ ] Selective filters verified with `EXPLAIN`; hints documented.
- [ ] Every search that can scan everything has a scope guard and a test.
- [ ] Execution slots are bounded; wait limit and timeout set; slot held until work ends.
- [ ] Health endpoint answers without taking a slot, tested while all slots are busy.
- [ ] Before/after numbers recorded in the pull request.
