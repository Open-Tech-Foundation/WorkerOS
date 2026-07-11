// End-to-end tests for a real `process.stdin` in the WorkerOS Node runtime,
// driven in a real browser via Playwright. Before this, `process.stdin` never
// read fd 0, so `on('data')` was silent and interactive programs (readline,
// prompt libraries, `npm create` scaffolders) hung. These drive the actual TTY.

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

test("process.stdin flowing mode delivers a typed line", opts, async () => {
  const { result, pageErrors } = await withOs(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    await os.fs.write("/reader.js",
      "process.stdin.setEncoding('utf8');\n" +
      "process.stdin.on('data', (d) => { console.log('GOT:' + d.trim()); process.exit(0); });\n");
    let out = "";
    const proc = await os.spawn(["node", "/reader.js"], {});
    proc.onStdout((b) => (out += dec.decode(b)));
    await new Promise((r) => setTimeout(r, 400)); // let it start & block on stdin
    os.input("hello world\n");
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 4000))]);
    return { out: out.trim(), code };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.out, "GOT:hello world");
  assert.equal(result.code, 0);
});

test("an exec'd child (the npm-create path) reads interactive stdin", opts, async () => {
  const { result, pageErrors } = await withOs(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    // child reads a line; parent runs it via sys.exec — exactly how `npm create`
    // launches an initializer's bin under /bin/node.
    await os.fs.write("/child.js",
      "process.stdin.setEncoding('utf8');\n" +
      "process.stdin.on('data', (d) => { console.log('CHILD:' + d.trim()); process.exit(0); });\n");
    await os.fs.write("/parent.js", "sys.exit(await sys.exec('node /child.js'));\n");
    let out = "";
    const proc = await os.spawn(["node", "/parent.js"], {});
    proc.onStdout((b) => (out += dec.decode(b)));
    await new Promise((r) => setTimeout(r, 500));
    os.input("scaffold-me\n");
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 5000))]);
    return { out: out.trim(), code };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.out, "CHILD:scaffold-me");
  assert.equal(result.code, 0);
});

test("raw mode delivers individual keystrokes (arrow-key menus)", opts, async () => {
  const { result, pageErrors } = await withOs(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    // raw mode: each byte arrives immediately (no line buffering) — what prompt
    // libraries use to read arrow keys. Collect bytes until we've seen an ESC seq.
    await os.fs.write("/raw.js",
      "process.stdin.setRawMode(true);\n" +
      "let seen = '';\n" +
      "process.stdin.on('data', (d) => {\n" +
      "  for (const b of d) seen += b + ',';\n" +
      "  if (seen.includes('27,')) { console.log('RAW:' + seen); process.exit(0); }\n" +
      "});\n");
    let out = "";
    const proc = await os.spawn(["node", "/raw.js"], {});
    proc.onStdout((b) => (out += dec.decode(b)));
    await new Promise((r) => setTimeout(r, 400));
    os.input("\x1b[B"); // Down arrow: ESC [ B — no newline, must arrive in raw mode
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 4000))]);
    return { out: out.trim(), code };
  });
  assert.deepEqual(pageErrors, []);
  // ESC=27, '['=91, 'B'=66 arrive as raw bytes (cooked mode would swallow them).
  assert.equal(result.code, 0, "raw-mode reader saw the ESC sequence and exited");
  assert.match(result.out, /^RAW:27,91,66,/);
});
