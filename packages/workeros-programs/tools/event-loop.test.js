// Unit tests for the Node event-loop keep-alive (src/node/event-loop.js). Uses
// real timers (short delays) so the drain/keep-alive behavior is exercised for
// real, not mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventLoop } from "../src/node/event-loop.js";

const nativeTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

test("whenIdle resolves only after a pending setTimeout has fired", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  let fired = false;
  g.setTimeout(() => { fired = true; }, 10);
  assert.equal(loop.activeRefs(), 1); // keeps the loop alive
  await loop.whenIdle();
  assert.equal(fired, true);
  assert.equal(loop.activeRefs(), 0);
});

test("whenIdle is immediate when nothing is scheduled", async () => {
  const loop = createEventLoop(nativeTimers);
  await loop.whenIdle(); // must not hang
  assert.equal(loop.activeRefs(), 0);
});

test("a setInterval keeps the loop alive until cleared", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  let ticks = 0;
  const h = g.setInterval(() => {
    if (++ticks === 3) g.clearInterval(h); // clears itself after 3 ticks
  }, 5);
  assert.equal(loop.activeRefs(), 1);
  await loop.whenIdle();
  assert.equal(ticks, 3);
  assert.equal(loop.activeRefs(), 0);
});

test("clearTimeout/clearInterval accept the handle or its numeric id", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  let a = false, b = false;
  const h1 = g.setTimeout(() => { a = true; }, 10);
  const h2 = g.setTimeout(() => { b = true; }, 10);
  g.clearTimeout(h1);          // by handle
  g.clearTimeout(Number(h2));  // by numeric id (Symbol.toPrimitive)
  assert.equal(loop.activeRefs(), 0);
  await loop.whenIdle();
  assert.equal(a, false);
  assert.equal(b, false);
});

test("unref drops a timer from keep-alive without cancelling it", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  let ran = false;
  const h = g.setTimeout(() => { ran = true; }, 15);
  assert.equal(h.hasRef(), true);
  h.unref();
  assert.equal(h.hasRef(), false);
  assert.equal(loop.activeRefs(), 0);
  await loop.whenIdle(); // resolves at once — the timer no longer holds the loop
  assert.equal(ran, false);
  // ...but the timer is still live and eventually fires.
  await new Promise((r) => nativeTimers.setTimeout(r, 20));
  assert.equal(ran, true);
  h.ref(); // ref after settle is a no-op (already fired)
  assert.equal(h.hasRef(), false);
});

test("a timer scheduled from inside a callback keeps the loop alive (no early idle)", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  const order = [];
  g.setTimeout(() => {
    order.push("first");
    g.setTimeout(() => { order.push("second"); }, 5); // scheduled mid-callback
  }, 5);
  await loop.whenIdle();
  assert.deepEqual(order, ["first", "second"]);
});

test("a ProcessExit thrown from a timer callback is swallowed (exit already reported)", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  class ProcessExit extends Error { constructor() { super("exit"); this.name = "ProcessExit"; } }
  g.setTimeout(() => { throw new ProcessExit(); }, 5);
  await assert.doesNotReject(loop.whenIdle());
  assert.equal(loop.activeRefs(), 0);
});
