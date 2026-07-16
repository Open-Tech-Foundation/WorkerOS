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

test("hard links + realpath through node:fs (pnpm-style store layout)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/proj/link.js",
        [
          "const fs = require('fs');",
          // Hard link: a second name for the same file (pnpm store → project).
          "fs.writeFileSync('/store', 'payload');",
          "fs.linkSync('/store', '/project-copy');",
          "console.log('hardlink:', fs.readFileSync('/project-copy','utf8'), fs.statSync('/store').nlink);",
          // Unlink one name; content survives via the other.
          "fs.unlinkSync('/store');",
          "console.log('survives:', fs.readFileSync('/project-copy','utf8'));",
          // realpath: resolve a symlinked package dir (pnpm .pnpm layout).
          "fs.mkdirSync('/.pnpm/foo@1/node_modules/foo', { recursive: true });",
          "fs.writeFileSync('/.pnpm/foo@1/node_modules/foo/index.js', 'module.exports=1');",
          "fs.mkdirSync('/node_modules', { recursive: true });",
          "fs.symlinkSync('/.pnpm/foo@1/node_modules/foo', '/node_modules/foo');",
          "console.log('realpath:', fs.realpathSync('/node_modules/foo/index.js'));",
        ].join("\n"),
      );
      return await window.run(os, ["node", "link.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), [
    "hardlink: payload 2",
    "survives: payload",
    "realpath: /.pnpm/foo@1/node_modules/foo/index.js",
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

// The host-side write path (the playground editor saving a file) must feed
// fs.watch just like a guest write — otherwise Vite's watcher never sees an edit
// and HMR never fires. The trigger here is `os.fs.write` (client), not a guest write.
test("fs.watch sees a host-side (editor) write, not just guest writes", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/w/seed.txt", "seed"); // ensure /w exists
      await os.fs.write(
        "/proj/watch.js",
        [
          "const fs = require('fs');",
          "const w = fs.watch('/w', (type, file) => {",
          "  if (file === 'edit.txt') { console.log('EVENT', type, file); w.close(); process.exit(0); }",
          "});",
          "setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);",
        ].join("\n"),
      );
      const dec = new TextDecoder();
      const proc = await os.spawn(["node", "watch.js"], { cwd: "/proj" });
      let out = "";
      proc.onStdout((b) => (out += dec.decode(b)));
      // Give the watcher a turn to register, then edit via the *client* API.
      await new Promise((r) => setTimeout(r, 400));
      await os.fs.write("/w/edit.txt", "changed-by-editor");
      const code = await proc.exited;
      return { out, code };
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out.trim(), /^EVENT (rename|change) edit\.txt$/, result.out);
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

// A file larger than the sync channel's 1 MiB payload must read back WHOLE. The
// kernel advances the fd offset by what it reads, so a single `read` request for
// more than the channel can carry would silently skip the remainder — the bug
// that truncated npm's cached packuments at exactly 1 MiB and broke installs of
// large trees (a Vite scaffold) with EBADSIZE. Every read path must reassemble
// the full file: readFileSync (loops), a single big readSync (fills the buffer),
// and createReadStream (drains).
test("files larger than the 1 MiB sync channel read back whole (no truncation)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write(
        "/big.js",
        [
          "const fs = require('fs');",
          "const N = 3 * 1024 * 1024 + 12345;", // ~3 MiB, not a channel multiple
          "const buf = Buffer.alloc(N, 0xab);",
          "fs.writeFileSync('/big.bin', buf);",
          "const stat = fs.statSync('/big.bin').size;",
          "const rfs = fs.readFileSync('/big.bin');",
          "const fd = fs.openSync('/big.bin', 'r');",
          "const one = Buffer.alloc(N);",
          "const br = fs.readSync(fd, one, 0, N, 0);",
          "fs.closeSync(fd);",
          "let streamed = 0, ok = true;",
          "const rs = fs.createReadStream('/big.bin');",
          "rs.on('data', (c) => { streamed += c.length; });",
          "rs.on('end', () => {",
          "  ok = ok && rfs.length === N && rfs.every((b) => b === 0xab);",
          "  ok = ok && one.every((b) => b === 0xab);",
          "  console.log(JSON.stringify({ stat, rfs: rfs.length, br, streamed, N, ok }));",
          "});",
        ].join("\n"),
      );
      return await window.run(os, ["node", "big.js"]);
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  const r = JSON.parse(result.out.trim());
  assert.equal(r.stat, r.N, "statSync size");
  assert.equal(r.rfs, r.N, "readFileSync length");
  assert.equal(r.br, r.N, "single readSync bytesRead fills the buffer");
  assert.equal(r.streamed, r.N, "createReadStream drains fully");
  assert.equal(r.ok, true, "every byte intact");
});
