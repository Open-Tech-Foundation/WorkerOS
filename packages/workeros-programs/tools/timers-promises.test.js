import test from "node:test";
import assert from "node:assert/strict";
import { createEventLoop } from "../src/node/event-loop.js";
import { createTimersPromises } from "../src/node/timers-promises.js";
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

test("setTimeout and setImmediate resolve with the provided value", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  const timers = createTimersPromises(g);
  assert.equal(await timers.setTimeout(5, "ok"), "ok");
  assert.equal(await timers.setImmediate("imm"), "imm");
});

test("setTimeout honors AbortSignal", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  const timers = createTimersPromises(g);
  const ac = new AbortController();
  const p = timers.setTimeout(20, "nope", { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e && e.name === "AbortError" && e.code === "ABORT_ERR");
});

test("setInterval is an async iterable and scheduler helpers work", async () => {
  const loop = createEventLoop(nativeTimers);
  const g = {};
  loop.install(g);
  const timers = createTimersPromises(g);
  const seen = [];
  for await (const value of timers.setInterval(5, "tick")) {
    seen.push(value);
    if (seen.length === 2) break;
  }
  assert.deepEqual(seen, ["tick", "tick"]);
  await timers.scheduler.wait(1);
  await timers.scheduler.yield();
});

test("guest require resolves timers/promises as a builtin", async () => {
  const sys = fakeSys();
  const main = [
    "(async () => {",
    "  const timers = require('timers/promises');",
    "  const fs = require('fs');",
    "  const a = await timers.setTimeout(5, 'ok');",
    "  const b = await timers.setImmediate('imm');",
    "  const out = [a, b];",
    "  for await (const v of timers.setInterval(5, 'tick')) { out.push(v); if (out.length === 4) break; }",
    "  await timers.scheduler.wait(1);",
    "  fs.writeFileSync('/timers-promises-ok', out.join(','));",
    "})();",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(createFs(sys.syncFs).readFileSync("/timers-promises-ok", "utf8"), "ok,imm,tick,tick");
});
