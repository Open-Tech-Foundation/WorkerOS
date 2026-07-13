// Unit tests for the node:async_hooks shim (AsyncLocalStorage / AsyncResource).
// Best-effort, synchronous-scope semantics (INV-5): getStore() tracks run/enterWith
// within a synchronous frame — enough for the "wrap work in run(), read the store
// in the handler" pattern that libraries (and hono) rely on.

import { test } from "node:test";
import assert from "node:assert/strict";
import asyncHooks, {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  triggerAsyncId,
} from "../src/node/async-hooks.js";

test("default export exposes the named API", () => {
  assert.equal(asyncHooks.AsyncLocalStorage, AsyncLocalStorage);
  assert.equal(asyncHooks.AsyncResource, AsyncResource);
  assert.equal(typeof asyncHooks.createHook, "function");
});

test("AsyncLocalStorage.run makes getStore return the store, then restores", () => {
  const als = new AsyncLocalStorage();
  assert.equal(als.getStore(), undefined);
  const ret = als.run({ id: 42 }, () => {
    assert.deepEqual(als.getStore(), { id: 42 });
    return "result";
  });
  assert.equal(ret, "result");
  assert.equal(als.getStore(), undefined); // restored after run
});

test("run passes extra args and nests correctly", () => {
  const als = new AsyncLocalStorage();
  als.run("outer", () => {
    assert.equal(als.getStore(), "outer");
    als.run("inner", (a, b) => {
      assert.equal(als.getStore(), "inner");
      assert.equal(a + b, 3);
    }, 1, 2);
    assert.equal(als.getStore(), "outer"); // inner restored to outer
  });
});

test("enterWith sets the store; exit clears it for the callback; disable turns it off", () => {
  const als = new AsyncLocalStorage();
  als.enterWith({ v: 1 });
  assert.deepEqual(als.getStore(), { v: 1 });
  als.exit(() => assert.equal(als.getStore(), undefined));
  assert.deepEqual(als.getStore(), { v: 1 }); // restored after exit
  als.disable();
  assert.equal(als.getStore(), undefined);
});

test("AsyncResource.runInAsyncScope invokes with thisArg + args", () => {
  const res = new AsyncResource("test");
  const obj = { mult: 3 };
  const out = res.runInAsyncScope(function (n) { return this.mult * n; }, obj, 4);
  assert.equal(out, 12);
  assert.equal(typeof res.asyncId(), "number");
});

// The behaviour @inquirer/core depends on: the store survives async hops. Without
// this, hook-based prompts throw "Hook functions can only be called from within a
// prompt" the moment a keystroke or the resolving promise chain runs.
test("store propagates across a .then() continuation", async () => {
  const als = new AsyncLocalStorage();
  const seen = await als.run({ id: "p" }, () => Promise.resolve().then(() => als.getStore()));
  assert.deepEqual(seen, { id: "p" });
});

test("store propagates across setTimeout/queueMicrotask scheduled inside run", async () => {
  const als = new AsyncLocalStorage();
  const viaTimer = await als.run({ id: "t" }, () => new Promise((res) => setTimeout(() => res(als.getStore()), 1)));
  assert.deepEqual(viaTimer, { id: "t" });
  const viaMicro = await als.run({ id: "m" }, () => new Promise((res) => queueMicrotask(() => res(als.getStore()))));
  assert.deepEqual(viaMicro, { id: "m" });
});

test("AsyncResource.bind captures the store at bind time and restores it on call", () => {
  const als = new AsyncLocalStorage();
  let bound;
  als.run({ id: "r" }, () => { bound = AsyncResource.bind(() => als.getStore()); });
  assert.equal(als.getStore(), undefined); // outside the run now
  assert.deepEqual(bound(), { id: "r" }); // but the bound fn still sees the store
});

test("createHook / execution ids are inert but present", () => {
  const hook = createHook({ init() {} });
  assert.equal(hook.enable(), hook);
  assert.equal(hook.disable(), hook);
  assert.equal(typeof executionAsyncId(), "number");
  assert.equal(typeof triggerAsyncId(), "number");
});
