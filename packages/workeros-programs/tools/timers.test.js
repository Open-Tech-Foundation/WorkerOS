import test from "node:test";
import assert from "node:assert/strict";
import { createEventLoop } from "../src/node/event-loop.js";
import { createTimers } from "../src/node/timers.js";
import { createNodeRuntime } from "../src/node/require-runtime.js";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

const nativeTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

function fakeSys() {
  const syncFs = createFakeSyncFs();
  return {
    syncFs,
    open: async (p, o = {}) => syncFs.open(p, o),
    read: async (fd, max) => syncFs.read(fd, max),
    close: async (fd) => syncFs.close(fd),
    stat: async (p) => syncFs.stat(p),
  };
}

test("createTimers exposes the standard timer functions over installed globals", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  const timers = createTimers(g);
  const order = [];
  const immediate = timers.setImmediate(() => order.push("immediate"));
  const timeout = timers.setTimeout(() => order.push("timeout"), 5);
  assert.equal(typeof immediate.unref, "function");
  assert.equal(typeof timeout.ref, "function");
  timers.active(timeout);
  timers.enroll(timeout, 5);
  assert.equal(timeout._idleTimeout, 5);
  await loop.whenIdle();
  assert.deepEqual(order.sort(), ["immediate", "timeout"]);
});

test("clear helpers accept the installed timer handles", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  const timers = createTimers(g);
  let ran = false;
  const timeout = timers.setTimeout(() => { ran = true; }, 20);
  timers.clearTimeout(Number(timeout));
  await loop.whenIdle();
  assert.equal(ran, false);
});

test("guest require resolves timers as a builtin", async () => {
  const sys = fakeSys();
  const main = [
    "const timers = require('timers');",
    "const fs = require('fs');",
    "const h = timers.setTimeout(() => fs.writeFileSync('/timers-ok', String(Number(h) > 0) + ':' + String(typeof h.unref === 'function')), 5);",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(createFs(sys.syncFs).readFileSync("/timers-ok", "utf8"), "true:true");
});
