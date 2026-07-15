// Unit tests for the userland `node:events` EventEmitter (src/node/events.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import EventEmitter, { once, on } from "../src/node/events.js";

test("the module is the constructor, with statics", () => {
  assert.equal(typeof EventEmitter, "function");
  assert.equal(EventEmitter.EventEmitter, EventEmitter);
  assert.equal(typeof EventEmitter.once, "function");
});

test("on/emit with args and return value", () => {
  const ee = new EventEmitter();
  const seen = [];
  assert.equal(ee.emit("x"), false); // no listeners
  ee.on("x", (a, b) => seen.push([a, b]));
  assert.equal(ee.emit("x", 1, 2), true);
  assert.deepEqual(seen, [[1, 2]]);
});

test("once fires exactly once and removeListener(original) works", () => {
  const ee = new EventEmitter();
  let n = 0;
  const fn = () => n++;
  ee.once("e", fn);
  ee.emit("e"); ee.emit("e");
  assert.equal(n, 1);
  // once wrapper removable by the original reference before firing
  const g = () => n++;
  ee.once("e", g);
  ee.removeListener("e", g);
  ee.emit("e");
  assert.equal(n, 1);
});

test("listeners / listenerCount / eventNames / rawListeners", () => {
  const ee = new EventEmitter();
  const a = () => {}, b = () => {};
  ee.on("z", a); ee.once("z", b);
  assert.equal(ee.listenerCount("z"), 2);
  assert.deepEqual(ee.listeners("z"), [a, b]); // once unwrapped to original
  assert.equal(ee.rawListeners("z").length, 2);
  assert.deepEqual(ee.eventNames(), ["z"]);
  assert.equal(ee.listenerCount("z", a), 1);
});

test("prependListener / prependOnceListener order", () => {
  const ee = new EventEmitter();
  const order = [];
  ee.on("p", () => order.push("second"));
  ee.prependListener("p", () => order.push("first"));
  ee.emit("p");
  assert.deepEqual(order, ["first", "second"]);
});

test("removeAllListeners", () => {
  const ee = new EventEmitter();
  ee.on("a", () => {}); ee.on("b", () => {});
  ee.removeAllListeners("a");
  assert.deepEqual(ee.eventNames(), ["b"]);
  ee.removeAllListeners();
  assert.deepEqual(ee.eventNames(), []);
});

test("newListener / removeListener meta-events fire", () => {
  const ee = new EventEmitter();
  const events = [];
  // Register the meta spies first so adding them doesn't itself emit 'newListener'
  // (adding a listener while a 'newListener' listener exists would — Node behavior).
  ee.on("removeListener", (type) => events.push(["rm", type]));
  ee.on("newListener", (type) => events.push(["new", type]));
  const fn = () => {};
  ee.on("data", fn);
  ee.removeListener("data", fn);
  assert.deepEqual(events, [["new", "data"], ["rm", "data"]]);
});

test("emitting 'error' with no listener throws", () => {
  const ee = new EventEmitter();
  assert.throws(() => ee.emit("error", new Error("boom")), /boom/);
  let caught;
  ee.on("error", (e) => { caught = e; });
  ee.emit("error", new Error("handled"));
  assert.equal(caught.message, "handled");
});

test("setMaxListeners/getMaxListeners", () => {
  const ee = new EventEmitter();
  assert.equal(ee.getMaxListeners(), 10);
  ee.setMaxListeners(2);
  assert.equal(ee.getMaxListeners(), 2);
});

test("subclassing via extends works", () => {
  class Bus extends EventEmitter {}
  const bus = new Bus();
  let hit = false;
  bus.on("go", () => { hit = true; });
  bus.emit("go");
  assert.equal(hit, true);
});

test("once() delegates to a subclass on() override (ssri replay pattern)", async () => {
  // `once`/`prependOnceListener` must register through the public `on`/`prependListener`,
  // so a subclass that overrides `on` sees the registration. ssri's integrity stream
  // relies on this to REPLAY an already-emitted 'size'/'integrity' to a late listener;
  // cacache attaches that listener with `events.once`. When `once` bypassed `on`, the
  // replay never fired and every `npm install` of a tarball hung. Guard it here.
  class Replayer extends EventEmitter {
    #done;
    complete(v) { this.#done = v; }
    on(ev, handler) {
      if (ev === "size" && this.#done !== undefined) { handler(this.#done); return this; }
      return super.on(ev, handler);
    }
  }
  const r = new Replayer();
  r.complete(2774); // value already emitted before anyone listens
  // Instance .once() must see the replay…
  let viaInstance;
  r.once("size", (v) => { viaInstance = v; });
  assert.equal(viaInstance, 2774);
  // …and so must the static events.once() helper (what cacache uses).
  assert.equal(await once(r, "size").then((a) => a[0]), 2774);
});

test("static once() resolves with the event args", async () => {
  const ee = new EventEmitter();
  queueMicrotask(() => ee.emit("ready", 42, "ok"));
  const args = await once(ee, "ready");
  assert.deepEqual(args, [42, "ok"]);
});

test("static once() rejects on 'error'", async () => {
  const ee = new EventEmitter();
  queueMicrotask(() => ee.emit("error", new Error("nope")));
  await assert.rejects(once(ee, "ready"), /nope/);
});

test("static on() yields events as an async iterator", async () => {
  const ee = new EventEmitter();
  const it = on(ee, "tick");
  ee.emit("tick", 1);
  ee.emit("tick", 2);
  assert.deepEqual((await it.next()).value, [1]);
  assert.deepEqual((await it.next()).value, [2]);
  await it.return();
});
