// End-to-end test for synchronous `node:fs` (PLAN Phase 5·A), driven in a real
// browser via Playwright: a CJS script run under /bin/node does real runtime file
// I/O (writeFileSync/readFileSync/mkdirSync/statSync) through the SAB sync-syscall
// channel, plus require('path'). Exercises the whole stack — kernel worker,
// program worker, sync channel, node runtime, builtins — end to end.

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

test("require('fs') does real synchronous file I/O; require('path') works", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/app.js",
        [
          "const fs = require('fs');",
          "const path = require('node:path');",
          "fs.writeFileSync('/data.txt', 'from sync fs');",
          "console.log('read:', fs.readFileSync('/data.txt', 'utf8'));",
          "console.log('exists:', fs.existsSync('/data.txt'), fs.existsSync('/nope'));",
          "fs.mkdirSync('/d/e', { recursive: true });",
          "console.log('isdir:', fs.statSync('/d/e').isDirectory());",
          "fs.appendFileSync('/data.txt', '!');",
          "console.log('appended:', fs.readFileSync('/data.txt', 'utf8'));",
          "console.log('join:', path.join('/a', 'b', '..', 'c'));",
        ].join("\n"),
      );
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  const lines = result.out.trim().split("\n");
  assert.deepEqual(lines, [
    "read: from sync fs",
    "exists: true false",
    "isdir: true",
    "appended: from sync fs!",
    "join: /a/c",
  ]);
});

test("symlinkSync/readlinkSync/lstatSync + real mtime through node:fs", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/link.js",
        [
          "const fs = require('fs');",
          "fs.writeFileSync('/t.txt', 'payload');",
          "fs.symlinkSync('/t.txt', '/l');",
          "console.log('readlink:', fs.readlinkSync('/l'));",
          "console.log('stat.isFile:', fs.statSync('/l').isFile());",
          "console.log('lstat.isSymlink:', fs.lstatSync('/l').isSymbolicLink());",
          "console.log('through:', fs.readFileSync('/l', 'utf8'));",
          "const m = fs.statSync('/t.txt').mtimeMs;",
          "console.log('mtime>0:', m > 0);",
        ].join("\n"),
      );
      return await window.run(os, ["node", "link.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), [
    "readlink: /t.txt",
    "stat.isFile: true",
    "lstat.isSymlink: true",
    "through: payload",
    "mtime>0: true",
  ]);
});

test("fs.watch delivers a change event to a running node process", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/watch.js",
        [
          "const fs = require('fs');",
          "fs.mkdirSync('/w', { recursive: true });",
          "const w = fs.watch('/w', (type, file) => {",
          "  console.log('EVENT', type, file);",
          "  w.close();",
          "  process.exit(0);",
          "});",
          // Mutate on a turn of the loop, after the watcher is registered; the
          // event is delivered asynchronously (kernel → worker → listener).
          "setTimeout(() => fs.writeFileSync('/w/a.txt', 'hi'), 50);",
          "setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 4000);",
        ].join("\n"),
      );
      return await window.run(os, ["node", "watch.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  const line = result.out.trim();
  assert.match(line, /^EVENT (rename|change) a\.txt$/, line);
});

test("readFileSync on a missing file throws ENOENT with a Node-shaped error", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/e.js",
        [
          "const fs = require('fs');",
          "try { fs.readFileSync('/missing.txt'); }",
          "catch (e) { console.log(e.code, e.syscall); }",
        ].join("\n"),
      );
      return await window.run(os, ["node", "e.js"]);
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.out.trim(), "ENOENT open");
});
