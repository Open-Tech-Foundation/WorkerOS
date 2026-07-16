// End-to-end tests for the temporal watchdog (INV-6, ADR-020), driven in a real
// browser via Playwright. The kernel worker — the only agent with a clock and
// worker.terminate() — reaps a synchronous spin (`for(;;)`) after a continuous-
// unresponsiveness budget, with exit 152 (128+SIGXCPU) and the kernel-recorded
// reason "CPU time". Liveness = syscalls, PONGs to the periodic PING, or being
// parked in a blocking `Atomics.wait` (SAB non-idle) — a kernel-serviced syscall or
// a guest-level wait (rolldown's idle thread pool) — so long-lived but healthy
// processes (servers, blocked readers, parked worker pools) are never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const opts = { skip: chromium ? false : "playwright not installed" };

async function withOs(fn, arg) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });
    const result = await page.evaluate(fn, arg);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

// A tight budget so the test runs in seconds; production defaults are 30s/2s.
const FAST = { wallTimeMs: 1200, graceMs: 300, sampleMs: 150 };

test("a synchronous infinite loop is reaped with 152 and reason 'CPU time'", opts, async () => {
  const { result, pageErrors } = await withOs(async (wd) => {
    const os = await window.__wos.boot({ watchdog: wd });
    const dec = new TextDecoder();
    await os.fs.write("/spin.js", "for (;;);\n");
    let err = "";
    const code = await Promise.race([
      new Promise((resolve) =>
        os.exec("node /spin.js", { onStderr: (b) => (err += dec.decode(b)) }).then((r) => resolve(r.code))),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 15000)),
    ]);
    return { code, err };
  }, FAST);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 152, `spin must be reaped as 128+SIGXCPU: ${JSON.stringify(result)}`);
  assert.match(result.err, /Killed \(CPU time\)/);
});

test("a long-lived but responsive process outlives the budget untouched", opts, async () => {
  const { result, pageErrors } = await withOs(async (wd) => {
    const os = await window.__wos.boot({ watchdog: wd });
    // Alive for 3× the budget, doing nothing but letting its event loop turn.
    await os.fs.write("/idle.js", "setTimeout(() => process.exit(0), 3600);\n");
    const code = await Promise.race([
      os.exec("node /idle.js", {}).then((r) => r.code),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 15000)),
    ]);
    return { code };
  }, FAST);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, "an idle-but-responsive process must not be watchdog-killed");
});

test("a process parked in a blocking read outlives the budget, then completes", opts, async () => {
  const { result, pageErrors } = await withOs(async (wd) => {
    const os = await window.__wos.boot({ watchdog: wd });
    const dec = new TextDecoder();
    await os.fs.write("/reader.js",
      "process.stdin.on('data', (d) => { console.log('GOT:' + ('' + d).trim()); process.exit(0); });\n");
    let out = "";
    const proc = await os.spawn(["node", "/reader.js"], {});
    proc.onStdout((b) => (out += dec.decode(b)));
    // Wait well past the watchdog budget while it blocks on stdin, then feed it.
    await new Promise((r) => setTimeout(r, 3600));
    proc.writeStdin("late\n");
    const code = await Promise.race([
      proc.exited,
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 8000)),
    ]);
    return { code, out };
  }, FAST);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, `blocked-on-stdin is waiting, not spinning: ${JSON.stringify(result)}`);
  assert.match(result.out, /GOT:late/);
});

test("a process parked in a guest Atomics.wait outlives the budget, then wakes", opts, async () => {
  const { result, pageErrors } = await withOs(async (wd) => {
    const os = await window.__wos.boot({ watchdog: wd });
    const dec = new TextDecoder();
    // A guest thread blocked in its *own* Atomics.wait (not a kernel syscall) — the
    // shape of rolldown's idle thread pool. The wait times out at 3× the budget; the
    // process must survive to wake ('timed-out'), not be reaped as a spin.
    await os.fs.write("/wait.js",
      "const v = new Int32Array(new SharedArrayBuffer(16));\n" +
      "console.log('WOKE:' + Atomics.wait(v, 0, 0, 3600));\n");
    let out = "", err = "";
    const code = await Promise.race([
      new Promise((resolve) =>
        os.exec("node /wait.js", { onStdout: (b) => (out += dec.decode(b)), onStderr: (b) => (err += dec.decode(b)) })
          .then((r) => resolve(r.code))),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 15000)),
    ]);
    return { code, out, err };
  }, FAST);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, `a guest Atomics.wait is waiting, not spinning: ${JSON.stringify(result)}`);
  assert.match(result.out, /WOKE:timed-out/);
});

test("a worker_threads child is exempt from the CPU-time watchdog (governed by its parent)", opts, async () => {
  const { result, pageErrors } = await withOs(async (wd) => {
    const os = await window.__wos.boot({ watchdog: wd });
    const dec = new TextDecoder();
    // A rolldown pool worker parks in a wasm-level wait we can't observe; the model
    // is a worker that is unresponsive to the watchdog. Use the strongest form — a
    // real synchronous spin — inside a Worker. The parent stays responsive and exits
    // after 3× the budget. The worker must NOT be reaped as "CPU time" (that would
    // print to the parent's stdout and/or crash it); only tree roots are watched.
    await os.fs.write("/main.js",
      "const { Worker } = require('worker_threads');\n" +
      "new Worker('for(;;){}', { eval: true });\n" +
      "setTimeout(() => process.exit(0), 3600);\n");
    let out = "", err = "";
    const code = await Promise.race([
      new Promise((resolve) =>
        os.exec("node /main.js", { onStdout: (b) => (out += dec.decode(b)), onStderr: (b) => (err += dec.decode(b)) })
          .then((r) => resolve(r.code))),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 15000)),
    ]);
    return { code, out, err };
  }, FAST);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, `parent must outlive its spinning worker: ${JSON.stringify(result)}`);
  assert.doesNotMatch(result.out + result.err, /CPU time/, "the worker child must not be watchdog-reaped");
});

test("a memory hog is reaped with 137 and reason 'out of memory' (where measurable)", opts, async () => {
  const { result, pageErrors } = await withOs(async (wd) => {
    // Feature gate: the self-sampler needs measureUserAgentSpecificMemory in a
    // dedicated worker; skip (not fail) where the browser doesn't expose it.
    const probe = new Worker(URL.createObjectURL(new Blob([
      "postMessage(typeof performance.measureUserAgentSpecificMemory)",
    ])));
    const kind = await new Promise((r) => (probe.onmessage = (e) => r(e.data)));
    probe.terminate();
    if (kind !== "function") return { skip: "measureUserAgentSpecificMemory unavailable in workers" };

    const os = await window.__wos.boot({ watchdog: wd });
    const dec = new TextDecoder();
    // Allocate ~8 MiB per tick with the event loop turning (so it stays
    // "responsive" — only the memory ceiling may reap it).
    await os.fs.write("/hog.js",
      "const hold = [];\n" +
      "setInterval(() => { hold.push(new Uint8Array(8 << 20).fill(1)); }, 25);\n");
    let err = "";
    const code = await Promise.race([
      new Promise((resolve) =>
        os.exec("node /hog.js", { onStderr: (b) => (err += dec.decode(b)) }).then((r) => resolve(r.code))),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 30000)),
    ]);
    return { code, err };
  }, { ...FAST, wallTimeMs: 60000, memHighWaterBytes: 96 * 1024 * 1024 });
  assert.deepEqual(pageErrors, []);
  if (result.skip) {
    test.skip?.(result.skip);
    return;
  }
  assert.equal(result.code, 137, `hog must be OOM-reaped: ${JSON.stringify(result)}`);
  assert.match(result.err, /Killed \(out of memory\)/);
});
