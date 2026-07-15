// End-to-end test for `node:worker_threads`, driven in a real browser via
// Playwright. A Worker is a real `/bin/node` process the kernel spawns, with a
// structured-clone message channel relayed through the kernel worker. This
// exercises the whole stack — spawnWorker, workerInit (the child learning it is a
// worker + its workerData), the bidirectional workerPost relay, keep-alive while a
// worker runs, and terminate().

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

async function withPage(fn) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
    await page.addInitScript(() => {
      const dec = new TextDecoder();
      window.run = async (os, argv, opts) => {
        const proc = await os.spawn(argv, opts);
        let out = "", err = "";
        proc.onStdout((b) => (out += dec.decode(b)));
        proc.onStderr((b) => (err += dec.decode(b)));
        const code = await proc.exited;
        return { out, err, code };
      };
    });
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });
    const result = await fn(page);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

const opts = { skip: chromium ? false : "playwright not installed" };

test("worker_threads: round-trip, workerData, isMainThread, terminate", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      // The worker: reads workerData, replies with a computed message, and echoes
      // that it is NOT the main thread + its own threadId.
      await os.fs.write(
        "/proj/worker.js",
        [
          "const { parentPort, workerData, isMainThread, threadId } = require('worker_threads');",
          "parentPort.on('message', (m) => {",
          "  parentPort.postMessage({ sum: workerData.a + workerData.b, echo: m, isMain: isMainThread, tid: threadId });",
          "});",
        ].join("\n"),
      );
      // A worker that never exits on its own — for the terminate() path.
      await os.fs.write("/proj/spin.js", "setInterval(() => {}, 1000);\n");
      // A worker that throws at load — for the error() path.
      await os.fs.write("/proj/boom.js", "throw new Error('boom-from-worker');\n");
      await os.fs.write(
        "/proj/main.js",
        [
          "const { Worker, isMainThread } = require('worker_threads');",
          "(async () => {",
          "  const reply = await new Promise((res, rej) => {",
          "    const w = new Worker('/proj/worker.js', { workerData: { a: 6, b: 7 } });",
          "    w.on('message', (m) => { res(m); w.terminate(); });",
          "    w.on('error', rej);",
          "    w.postMessage('ping');",
          "  });",
          "  console.log('reply:', JSON.stringify(reply));",
          "  console.log('main-isMain:', isMainThread);",
          // terminate() a long-running worker → resolves with the exit code.
          "  const code = await new Promise((res) => {",
          "    const w = new Worker('/proj/spin.js');",
          "    w.on('online', async () => res(await w.terminate()));",
          "  });",
          "  console.log('terminated-code:', code);",
          // A worker that throws → the parent's 'error' event fires with the message.
          "  const errMsg = await new Promise((res) => {",
          "    const w = new Worker('/proj/boom.js');",
          "    w.on('error', (e) => res(e.message));",
          "  });",
          "  console.log('worker-error:', errMsg);",
          "})();",
        ].join("\n"),
      );
      return window.run(os, ["node", "/proj/main.js"], { cwd: "/proj" });
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  const lines = result.out.trim().split("\n");
  // The worker computed 6+7, echoed our ping, and knew it wasn't the main thread.
  const reply = JSON.parse(lines.find((l) => l.startsWith("reply:")).slice("reply:".length).trim());
  assert.equal(reply.sum, 13, result.out);
  assert.equal(reply.echo, "ping", result.out);
  assert.equal(reply.isMain, false, result.out);
  assert.ok(reply.tid > 0, result.out);
  assert.ok(lines.includes("main-isMain: true"), result.out);
  // terminate() delivered SIGTERM → the worker exited 128+15 = 143.
  assert.ok(lines.includes("terminated-code: 143"), result.out);
  // A worker that threw surfaced its real message on the parent's 'error' event.
  assert.ok(lines.includes("worker-error: boom-from-worker"), result.out);
});

// A message posted before the worker is online must not need the *poster's* event
// loop to be delivered. Real Node buffers it on the port; a wasm thread pool
// (rolldown's, via emnapi) posts its module/memory and then parks in Atomics.wait
// for the thread to come up — if delivery waited for a turn of the loop that never
// comes, that wait deadlocks and the watchdog reaps the process as "CPU time".
test("worker_threads: a message posted before online reaches a parent that then blocks", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/w.js",
        [
          "const { parentPort } = require('worker_threads');",
          "parentPort.on('message', (m) => {",
          "  const view = new Int32Array(m.sab);",
          "  Atomics.store(view, 0, 42);",
          "  Atomics.notify(view, 0);",
          "});",
        ].join("\n"),
      );
      await os.fs.write(
        "/proj/main.js",
        [
          "const { Worker } = require('worker_threads');",
          "const sab = new SharedArrayBuffer(16);",
          "const view = new Int32Array(sab);",
          "const w = new Worker('/proj/w.js');",
          "w.postMessage({ sab }); // before 'online' — no threadId yet",
          "// Park this thread: from here the event loop cannot deliver anything.",
          "const r = Atomics.wait(view, 0, 0, 10000);",
          "console.log('wait:', r, 'value:', Atomics.load(view, 0));",
          "process.exit(0);",
        ].join("\n"),
      );
      return window.run(os, ["node", "/proj/main.js"], { cwd: "/proj" });
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  // "ok" (not "timed-out"): the worker got the message and woke the parked parent.
  assert.match(result.out, /wait: ok value: 42/, result.out);
});

// A guest shares the program worker's realm, and real Node programs assign the
// worker globals: rolldown's wasi worker does `Object.assign(globalThis, { self:
// globalThis, postMessage })` to look like a web worker. That must not capture the
// kernel's own channel — when it did, the kernel's traffic re-entered the guest's
// postMessage (→ sys.workerPost → kernel.postMessage → …) and the process died of
// "Maximum call stack size exceeded".
test("worker_threads: a guest assigning globalThis.postMessage cannot capture the kernel channel", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/clobber.js",
        [
          "let stolen = 0;",
          "Object.assign(globalThis, {",
          "  self: globalThis,",
          "  postMessage: function () { stolen++; },",
          "});",
          "// Each of these is a syscall over the kernel channel: they must still work,",
          "// and must not land in the guest's function above.",
          "console.log('stdout-still-works');",
          "const fs = require('fs');",
          "fs.writeFileSync('/proj/probe.txt', 'written');",
          "console.log('fs:', fs.readFileSync('/proj/probe.txt', 'utf8'));",
          "console.log('stolen:', stolen);",
          "process.exit(0);",
        ].join("\n"),
      );
      return window.run(os, ["node", "/proj/clobber.js"], { cwd: "/proj" });
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /stdout-still-works/, result.out);
  assert.match(result.out, /fs: written/, result.out);
  // The kernel's traffic never went through the guest's postMessage.
  assert.match(result.out, /stolen: 0/, result.out);
});
