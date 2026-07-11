import { test } from "node:test";
import assert from "node:assert/strict";
import perfHooks, {
  performance,
  createHistogram,
  monitorEventLoopDelay,
} from "../src/node/perf-hooks.js";
import { makeBuiltins } from "../src/node/require-runtime.js";

test("exports the host performance clock and Node module shape", () => {
  assert.equal(performance, globalThis.performance);
  assert.equal(typeof performance.now, "function");
  assert.equal(typeof performance.timerify, "function");
  assert.equal(typeof performance.eventLoopUtilization, "function");
  assert.equal(perfHooks.performance, performance);
  assert.ok("PerformanceNodeTiming" in perfHooks);
  assert.ok("PerformanceObserverEntryList" in perfHooks);
  assert.equal(perfHooks.constants.NODE_PERFORMANCE_GC_MAJOR, 4);
});

test("createHistogram records values, deltas, percentiles, and other histograms", () => {
  const h = createHistogram();
  h.record(10);
  h.record(30n);
  assert.equal(h.count, 2);
  assert.equal(h.min, 10);
  assert.equal(h.max, 30);
  assert.equal(h.mean, 20);
  assert.equal(h.percentile(50), 10);
  const other = createHistogram();
  other.record(50);
  h.add(other);
  assert.equal(h.maxBigInt, 50n);
  h.reset();
  assert.equal(h.count, 0);
});

test("timerify records synchronous and asynchronous calls", async () => {
  const histogram = createHistogram();
  assert.equal(performance.timerify((a, b) => a + b, { histogram })(2, 3), 5);
  await performance.timerify(async () => 7, { histogram })();
  assert.equal(histogram.count, 2);
});

test("monitorEventLoopDelay samples and can be disabled", async () => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  assert.equal(histogram.enable(), true);
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(histogram.disable(), true);
  assert.ok(histogram.count > 0);
  assert.throws(() => monitorEventLoopDelay({ resolution: 0 }), RangeError);
});

test("builtin registry exposes perf_hooks", () => {
  const builtins = makeBuiltins({ syncFs: {} });
  assert.equal(builtins.get("perf_hooks"), perfHooks);
});
