import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerThreads } from "../src/node/worker-threads.js";

// A fake `sys` for the worker_threads surface: records spawn/post/kill calls and
// lets a test push inbound traffic via `_dispatch(fromThreadId, kind, payload)`.
function fakeSys() {
  let dispatch = null;
  const posts = [];
  const kills = [];
  const spawns = [];
  return {
    cwd: "/",
    onWorkerEvent: (cb) => { dispatch = cb; },
    spawnWorker: async (opts) => { spawns.push(opts); return { threadId: 42 }; },
    workerPost: (to, data) => posts.push({ to, data }),
    childKill: (pid, sig) => kills.push({ pid, sig }),
    _dispatch: (...a) => dispatch(...a),
    posts, kills, spawns,
  };
}

test("main thread reports isMainThread with no parentPort", () => {
  const wt = createWorkerThreads(fakeSys(), { isMainThread: true, threadId: 0, workerData: null });
  assert.equal(wt.isMainThread, true);
  assert.equal(wt.parentPort, null);
  assert.equal(wt.threadId, 0);
});

test("Worker resolves a relative file against the guest cwd, and emits online", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, { isMainThread: true });
  // The runtime resolves the worker path against process.cwd(); stub it (this test
  // runs under real Node, whose cwd is the repo) so the resolution is deterministic.
  const realProc = globalThis.process;
  globalThis.process = { cwd: () => "/app", env: {} };
  let w;
  try {
    w = new wt.Worker("./task.js", { workerData: { n: 7 } }); // reads cwd synchronously
  } finally {
    globalThis.process = realProc;
  }
  await new Promise((r) => w.on("online", r));
  assert.equal(w.threadId, 42);
  assert.equal(sys.spawns[0].file, "/app/task.js");
  assert.equal(sys.spawns[0].eval, false);
  assert.deepEqual(sys.spawns[0].workerData, { n: 7 });
});

test("Worker eval mode passes the source verbatim", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, {});
  const w = new wt.Worker("console.log(1)", { eval: true });
  await new Promise((r) => w.on("online", r));
  assert.equal(sys.spawns[0].eval, true);
  assert.equal(sys.spawns[0].file, "console.log(1)");
});

test("main→worker postMessage routes by threadId; inbound routes to the Worker", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, {});
  const w = new wt.Worker("/w.js");
  // A message posted before 'online' goes out *now*, addressed by the spawn token
  // the kernel registered while servicing spawnWorker — buffering it here until
  // the reply lands would need this thread's event loop, which deadlocks a caller
  // that posts and then blocks (a wasm thread pool does exactly that).
  w.postMessage({ early: true });
  const early = sys.posts.at(-1);
  assert.deepEqual(early.data, { early: true });
  assert.equal(typeof early.to.token, "number");
  await new Promise((r) => w.on("online", r));
  // Once online, the threadId addresses it directly.
  w.postMessage({ hi: 1 });
  assert.deepEqual(sys.posts.at(-1), { to: 42, data: { hi: 1 } });
  const got = await new Promise((r) => { w.on("message", r); sys._dispatch(42, "message", { pong: 2 }); });
  assert.deepEqual(got, { pong: 2 });
});

test("worker side: parentPort posts to \"parent\" and receives from thread 0", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, { isMainThread: false, threadId: 42, workerData: { a: 1 } });
  assert.equal(wt.isMainThread, false);
  assert.deepEqual(wt.workerData, { a: 1 });
  wt.parentPort.postMessage({ done: true });
  assert.deepEqual(sys.posts.at(-1), { to: "parent", data: { done: true } });
  const got = await new Promise((r) => { wt.parentPort.on("message", r); sys._dispatch(0, "message", { task: 5 }); });
  assert.deepEqual(got, { task: 5 });
});

test("exit event fires with the code and clears the worker", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, {});
  const w = new wt.Worker("/w.js");
  await new Promise((r) => w.on("online", r));
  const code = await new Promise((r) => { w.on("exit", r); sys._dispatch(42, "exit", { code: 0 }); });
  assert.equal(code, 0);
  // A later message for the gone worker is dropped (no throw).
  sys._dispatch(42, "message", { late: true });
});

test("terminate signals the worker and resolves on exit", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, {});
  const w = new wt.Worker("/w.js");
  await new Promise((r) => w.on("online", r));
  const p = w.terminate();
  assert.deepEqual(sys.kills.at(-1), { pid: 42, sig: 15 });
  sys._dispatch(42, "exit", { code: 143 });
  assert.equal(await p, 143);
});

test("spawn failure emits 'error'", async () => {
  const sys = fakeSys();
  sys.spawnWorker = async () => { throw new Error("ENOENT worker.js"); };
  const wt = createWorkerThreads(sys, {});
  const w = new wt.Worker("/missing.js");
  const err = await new Promise((r) => w.on("error", r));
  assert.match(err.message, /ENOENT/);
});

test("MessageChannel delivers between its two in-thread ports", async () => {
  const wt = createWorkerThreads(fakeSys(), {});
  const { port1, port2 } = new wt.MessageChannel();
  const got = await new Promise((r) => { port2.on("message", r); port1.postMessage("ping"); });
  assert.equal(got, "ping");
});

test("a worker's uncaught error is delivered to worker.on('error')", async () => {
  const sys = fakeSys();
  const wt = createWorkerThreads(sys, {});
  const w = new wt.Worker("/w.js");
  await new Promise((r) => w.on("online", r));
  const err = await new Promise((r) => {
    w.on("error", r);
    sys._dispatch(42, "error", { message: "kaboom", name: "TypeError", stack: "TypeError: kaboom\n  at w.js:1" });
  });
  assert.ok(err instanceof Error);
  assert.equal(err.message, "kaboom");
  assert.equal(err.name, "TypeError");
  assert.match(err.stack, /w\.js:1/);
});

test("receiveMessageOnPort drains a queued message, else undefined", async () => {
  const wt = createWorkerThreads(fakeSys(), {});
  const { port1, port2 } = new wt.MessageChannel();
  port1.postMessage("a");
  port1.postMessage("b");
  await Promise.resolve(); // let the queue settle
  assert.deepEqual(wt.receiveMessageOnPort(port2), { message: "a" });
  assert.deepEqual(wt.receiveMessageOnPort(port2), { message: "b" });
  assert.equal(wt.receiveMessageOnPort(port2), undefined);
});

test("MessagePort keep-alive matches Node: last write (ref/unref/listener) wins", () => {
  // emnapi's async-work counter holds `new MessageChannel().port1` and ref()s it
  // while napi work is outstanding, so a live ref must bump the guest event loop
  // exactly as a real MessagePort does. Drive it with a fake __workerosLoop and
  // assert net keep-alive (held?) against Node's observed semantics.
  let held = 0;
  const realLoop = globalThis.__workerosLoop;
  globalThis.__workerosLoop = { ref: () => { held++; }, unref: () => { held--; } };
  try {
    const wt = createWorkerThreads(fakeSys(), {});
    const port = () => new wt.MessagePort();
    const isHeld = (p) => held > 0;

    // A) untouched → no hold.
    let p = port(); assert.equal(isHeld(p), false);
    // B) a `message` listener holds.
    p = port(); p.on("message", () => {}); assert.equal(isHeld(p), true); p.close();
    // C) ref() with no listener holds.
    p = port(); p.ref(); assert.equal(isHeld(p), true); p.close();
    // D) ref() then unref() releases.
    p = port(); p.ref(); p.unref(); assert.equal(isHeld(p), false);
    // F) listener then unref() releases — last write wins, not listener-count.
    p = port(); p.on("message", () => {}); p.unref(); assert.equal(isHeld(p), false);
    // G) unref() then listener holds.
    p = port(); p.unref(); p.on("message", () => {}); assert.equal(isHeld(p), true); p.close();
    // close() releases whatever a port was holding, and it can't re-hold after.
    p = port(); p.ref(); assert.equal(held, 1); p.close(); assert.equal(held, 0);
    p.ref(); assert.equal(held, 0);
    // Every port balanced out.
    assert.equal(held, 0);
  } finally {
    globalThis.__workerosLoop = realLoop;
  }
});
