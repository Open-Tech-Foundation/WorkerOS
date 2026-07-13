// Process groups + the terminal's foreground pgrp (job control, ADR-025),
// driven in a real browser via Playwright. The foreground pipeline used to be a
// host-side Set of pids; it is now kernel state — a `pgid` on every process
// record (POSIX placement: pipelines share a leader-headed group, children
// inherit their parent's group) plus a tcsetpgrp/tcgetpgrp foreground group on
// the controlling terminal. Control-key signals (^C/^Z/SIGWINCH) are delivered
// to the *group*, so they reach exec'd grandchildren too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const opts = { skip: chromium ? false : "playwright not installed" };

async function withTerminal(body) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });
    const result = await page.evaluate(body);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

test("pipeline stages share one process group (pgid = leader pid) in ps", opts, async () => {
  const { result, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out));
    };
    await waitFor("$");
    // Two long-lived stages so ps can observe them mid-flight.
    await os.fs.write("/slowa.js", "setInterval(() => process.stdout.write('a'), 50); setTimeout(() => process.exit(0), 3000);\n");
    await os.fs.write("/slowb.js", "process.stdin.on('data', () => {}); setTimeout(() => process.exit(0), 3000);\n");
    os.input("node /slowa.js | node /slowb.js\r");
    await new Promise((r) => setTimeout(r, 700)); // let both stages spawn
    const procs = await os.ps();
    const stages = procs.filter((p) => p.argv.join(" ").includes("slow"));
    return { stages: stages.map((p) => ({ pid: p.pid, pgid: p.pgid })) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.stages.length, 2, JSON.stringify(result));
  const [a, b] = result.stages;
  assert.equal(a.pgid, b.pgid, "pipeline stages share one process group");
  assert.equal(a.pgid, Math.min(a.pid, b.pid), "the group leader is the first stage");
});

test("^C interrupts the whole pipeline and returns the prompt", opts, async () => {
  const { result, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out));
    };
    await waitFor("$");
    // Both stages run forever; only a group-wide ^C can end the pipeline.
    // (Stage 1's stdout feeds the pipe; the *last* stage owns the terminal, so
    // it announces liveness there.)
    await os.fs.write("/fore.js", "setInterval(() => process.stdout.write('x\\n'), 100);\n");
    await os.fs.write("/aft.js",
      "let seen = false;\n" +
      "process.stdin.on('data', () => { if (!seen) { seen = true; console.log('AFT-LIVE'); } });\n");
    os.input("node /fore.js | node /aft.js\r");
    await waitFor("AFT-LIVE"); // pipeline is live end-to-end
    os.input("\x03"); // ^C → SIGINT to the foreground process group
    // The prompt returns only after the shell reaps the whole pipeline.
    const before = out.length;
    await waitFor("$ ", 8000 /* a fresh prompt after the ^C */);
    await new Promise((r) => setTimeout(r, 300));
    const procs = await os.ps();
    const leftovers = procs.filter((p) => p.argv.join(" ").match(/fore|aft/));
    return { leftovers: leftovers.length, tailAfterInterrupt: out.slice(before) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.leftovers, 0, "both stages must be gone after ^C");
});

test("^C reaches an exec'd grandchild (it inherited the foreground group)", opts, async () => {
  const { result, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 10000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out));
    };
    await waitFor("$");
    // grand.js catches SIGINT and reports; parent.js runs it via the
    // child_process inherit path (the `npm run dev` shape).
    await os.fs.write("/grand.js",
      "process.on('SIGINT', () => { console.log('GRAND-CAUGHT'); process.exit(0); });\n" +
      "console.log('GRAND-UP');\n" +
      "setInterval(() => {}, 1000);\n");
    await os.fs.write("/parent.js",
      "const { spawn } = require('child_process');\n" +
      "const c = spawn('node', ['/grand.js'], { stdio: 'inherit' });\n" +
      "c.on('exit', (code) => process.exit(code | 0));\n");
    os.input("node /parent.js\r");
    await waitFor("GRAND-UP");
    os.input("\x03"); // ^C → the whole foreground group, grandchild included
    await waitFor("GRAND-CAUGHT");
    return { out };
  });
  assert.deepEqual(pageErrors, []);
  assert.match(result.out, /GRAND-CAUGHT/);
});
