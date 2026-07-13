// End-to-end tests for the net-egress capability (ADR-024), driven in a real
// browser via Playwright. Outbound network in WorkerOS is the browser's ambient
// `fetch` (ADR-008) — which used to bypass the capability broker entirely. The
// kernel now owns a per-process `net_egress` bit (inherited by children like
// POSIX credentials); the program worker enforces a denial by removing the
// egress globals (fetch, WebSocket, XHR, …) before any guest code runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const opts = { skip: chromium ? false : "playwright not installed" };

async function withOs(fn) {
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
    const result = await page.evaluate(fn);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

const PROBE =
  "const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker'];\n" +
  "const denied = names.filter((n) => typeof globalThis[n] === 'undefined');\n" +
  "console.log(denied.length === names.length ? 'DENIED' : denied.length === 0 ? 'ALLOWED' : 'PARTIAL:' + denied);\n";

async function runProbe(os, spawnOpts) {
  const dec = new TextDecoder();
  let out = "";
  const proc = await os.spawn(["node", "/probe.js"], spawnOpts);
  proc.onStdout((b) => (out += dec.decode(b)));
  const code = await Promise.race([
    proc.exited,
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 8000)),
  ]);
  return { code, out: out.trim() };
}

test("a default spawn keeps ambient fetch (the npm-install model)", opts, async () => {
  const { result, pageErrors } = await withOs(async () => {
    const os = await window.__wos.boot();
    await os.fs.write("/probe.js",
      "const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker'];\n" +
      "const denied = names.filter((n) => typeof globalThis[n] === 'undefined');\n" +
      "console.log(denied.length === names.length ? 'DENIED' : denied.length === 0 ? 'ALLOWED' : 'PARTIAL:' + denied);\n");
    const dec = new TextDecoder();
    let out = "";
    const proc = await os.spawn(["node", "/probe.js"], {});
    proc.onStdout((b) => (out += dec.decode(b)));
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 8000))]);
    return { code, out: out.trim() };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.out, "ALLOWED", JSON.stringify(result));
  assert.equal(result.code, 0);
});

test("spawn({ net: false }) strips every egress global before guest code runs", opts, async () => {
  const { result, pageErrors } = await withOs(async () => {
    const os = await window.__wos.boot();
    await os.fs.write("/probe.js",
      "const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker'];\n" +
      "const denied = names.filter((n) => typeof globalThis[n] === 'undefined');\n" +
      "console.log(denied.length === names.length ? 'DENIED' : denied.length === 0 ? 'ALLOWED' : 'PARTIAL:' + denied);\n");
    const dec = new TextDecoder();
    let out = "";
    const proc = await os.spawn(["node", "/probe.js"], { net: false });
    proc.onStdout((b) => (out += dec.decode(b)));
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 8000))]);
    return { code, out: out.trim() };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.out, "DENIED", JSON.stringify(result));
  assert.equal(result.code, 0);
});

test("denial is inherited: a netless guest cannot shell out to regain fetch", opts, async () => {
  const { result, pageErrors } = await withOs(async () => {
    const os = await window.__wos.boot();
    await os.fs.write("/probe.js",
      "const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker'];\n" +
      "const denied = names.filter((n) => typeof globalThis[n] === 'undefined');\n" +
      "console.log(denied.length === names.length ? 'DENIED' : denied.length === 0 ? 'ALLOWED' : 'PARTIAL:' + denied);\n");
    // The denied parent re-runs the probe through the shell (`sys.exec` — the
    // `npm run`/`sh -c` path) and through child_process.execSync.
    await os.fs.write("/parent.js",
      "const { execSync } = require('child_process');\n" +
      "const viaExec = execSync('node /probe.js').toString().trim();\n" +
      "console.log('CHILD:' + viaExec);\n");
    const dec = new TextDecoder();
    let out = "";
    const proc = await os.spawn(["node", "/parent.js"], { net: false });
    proc.onStdout((b) => (out += dec.decode(b)));
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 10000))]);
    return { code, out: out.trim() };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.out, "CHILD:DENIED", JSON.stringify(result));
  assert.equal(result.code, 0);
});
