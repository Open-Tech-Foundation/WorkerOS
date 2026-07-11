// End-to-end test for `node:child_process`, driven in a real browser via
// Playwright. A child here is an ordinary command run through the same `wsh`
// driver a terminal uses, reached via two syscalls the runtime adds on top of
// `exec`: `execCapture` (async) and `execCaptureSync` (blocking, over the SAB
// channel). This exercises the whole stack — /bin/node loading the builtin, the
// program worker's sys surface, the kernel worker spawning + capturing a child,
// stdin framing, and the synchronous park/wake path.

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
        let out = "";
        let err = "";
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

test("child_process runs sub-commands end-to-end under /bin/node", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/app.js",
        [
          "const cp = require('child_process');",
          // The synchronous forms (execSync/spawnSync) block inline; the async ones
          // (exec/spawn) run in an async IIFE — a CJS module can't top-level await.
          "const hi = cp.execSync('echo hello').toString().trim();",
          "console.log('execSync:', hi);",
          // execSync with stdin `input`, piped to `cat`.
          "const echoed = cp.execSync('cat', { input: 'piped-in' }).toString();",
          "console.log('stdin:', echoed);",
          // A non-zero exit throws, carrying `.status`.
          "let threw = 'no';",
          "try { cp.execSync('false'); } catch (e) { threw = 'status=' + e.status; }",
          "console.log('nonzero:', threw);",
          // spawnSync object shape.
          "const r = cp.spawnSync('echo', ['a', 'b']);",
          "console.log('spawnSync:', r.status, JSON.stringify(r.stdout.toString().trim()));",
          "(async () => {",
          // Async exec via callback -> resolve a promise so we can await it.
          "  const asyncOut = await new Promise((res) =>",
          "    cp.exec('echo async-out', (e, out) => res(out.trim())));",
          "  console.log('exec:', asyncOut);",
          // spawn: buffered streaming + close event.
          "  const spawnOut = await new Promise((res) => {",
          "    const child = cp.spawn('echo', ['streamed']);",
          "    let buf = '';",
          "    child.stdout.on('data', (d) => (buf += d.toString()));",
          "    child.on('close', (code) => res(buf.trim() + '#' + code));",
          "  });",
          "  console.log('spawn:', spawnOut);",
          "})();",
        ].join("\n"),
      );
      return window.run(os, ["node", "/proj/app.js"], { cwd: "/proj" });
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  const lines = result.out.trim().split("\n");
  assert.ok(lines.includes("execSync: hello"), result.out);
  assert.ok(lines.includes("stdin: piped-in"), result.out);
  assert.ok(lines.includes("nonzero: status=1"), result.out);
  assert.ok(lines.includes('spawnSync: 0 "a b"'), result.out);
  assert.ok(lines.includes("exec: async-out"), result.out);
  assert.ok(lines.includes("spawn: streamed#0"), result.out);
});
