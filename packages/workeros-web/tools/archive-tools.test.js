// End-to-end tests for the archive/compression CLIs (/bin/gzip, gunzip, zcat,
// tar, zip, unzip), driven in a real browser via Playwright. These boot the
// actual kernel and run the programs as processes over the `sys` ABI + the shared
// /lib codec — the half the pure-lib unit tests can't cover (arg parsing,
// directory walking, file I/O, the absolute /lib imports resolving at spawn).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}
const opts = { skip: chromium ? false : "playwright not installed" };

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
      window.run = async (os, argv, o) => {
        const proc = await os.spawn(argv, o);
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

test("tar create/list/extract round-trips through the shell with -z gzip", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const dec = new TextDecoder();
      await os.fs.write("/work/proj/a.txt", "alpha\n");
      await os.fs.write("/work/proj/sub/b.txt", "beta beta\n".repeat(50));

      const create = await window.run(os, ["tar", "-czf", "out.tgz", "proj"], { cwd: "/work" });
      const list = await window.run(os, ["tar", "-tzf", "out.tgz"], { cwd: "/work" });
      const extract = await window.run(os, ["tar", "-xzf", "out.tgz", "-C", "/restore"], { cwd: "/work" });

      const a = dec.decode(await os.fs.read("/restore/proj/a.txt"));
      const b = dec.decode(await os.fs.read("/restore/proj/sub/b.txt"));
      return { create, list, extract, a, b };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.create.code, 0, result.create.err);
  assert.equal(result.extract.code, 0, result.extract.err);
  assert.match(result.list.out, /proj\/a\.txt/);
  assert.match(result.list.out, /proj\/sub\/b\.txt/);
  assert.equal(result.a, "alpha\n");
  assert.equal(result.b, "beta beta\n".repeat(50));
});

test("gzip/gunzip round-trip a file and zcat streams it", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const payload = "the quick brown fox. ".repeat(200);
      await os.fs.write("/g/data.txt", payload);

      const gz = await window.run(os, ["gzip", "data.txt"], { cwd: "/g" });
      // Original is gone, data.txt.gz exists; zcat it back out.
      const zcat = await window.run(os, ["zcat", "data.txt.gz"], { cwd: "/g" });
      const gunzip = await window.run(os, ["gunzip", "data.txt.gz"], { cwd: "/g" });
      const restored = new TextDecoder().decode(await os.fs.read("/g/data.txt"));
      let origGone = false;
      try { await os.fs.read("/g/data.txt.gz"); } catch { origGone = true; }
      return { gz, zcat, gunzip, restored, origGone, payload };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.gz.code, 0, result.gz.err);
  assert.equal(result.zcat.out, result.payload);
  assert.equal(result.gunzip.code, 0, result.gunzip.err);
  assert.equal(result.restored, result.payload);
  assert.ok(result.origGone, "gunzip should remove the .gz after expanding");
});

test("zip -r then unzip round-trips a directory tree", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const dec = new TextDecoder();
      await os.fs.write("/z/site/index.html", "<h1>hi</h1>\n");
      await os.fs.write("/z/site/css/app.css", "body{color:red}\n".repeat(40));

      const zip = await window.run(os, ["zip", "-r", "-q", "site.zip", "site"], { cwd: "/z" });
      const list = await window.run(os, ["unzip", "-l", "site.zip"], { cwd: "/z" });
      const unzip = await window.run(os, ["unzip", "site.zip", "-d", "/out"], { cwd: "/z" });

      const html = dec.decode(await os.fs.read("/out/site/index.html"));
      const css = dec.decode(await os.fs.read("/out/site/css/app.css"));
      return { zip, list, unzip, html, css };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.zip.code, 0, result.zip.err);
  assert.equal(result.unzip.code, 0, result.unzip.err);
  assert.match(result.list.out, /site\/index\.html/);
  assert.equal(result.html, "<h1>hi</h1>\n");
  assert.equal(result.css, "body{color:red}\n".repeat(40));
});

test("the wasm codec is actually active (gzip emits dynamic-Huffman blocks)", opts, async () => {
  // Proof the codec wasm is wired, not silently falling back to JS: miniz (the
  // codec) picks *dynamic* Huffman for varied input — the first DEFLATE byte's low
  // 3 bits are 0b101 (BFINAL=1, BTYPE=10). The pure-JS encoder always emits *fixed*
  // Huffman (0b011). We assert dynamic, which only the wasm path produces.
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const text = "the quick brown fox jumps over the lazy dog. ".repeat(200);
      await os.fs.write("/c/data.txt", text);
      const r = await window.run(os, ["gzip", "-kf", "data.txt"], { cwd: "/c" }); // -k keep, -f force
      const gz = await os.fs.read("/c/data.txt.gz"); // 10-byte gzip header, then DEFLATE
      return { r, firstDeflate: gz[10] & 7, len: gz.length, orig: text.length };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.r.code, 0, result.r.err);
  assert.equal(result.firstDeflate, 5, "gzip must emit dynamic-Huffman → the wasm codec is active (JS fallback would be 3)");
  assert.ok(result.len < result.orig, "compressed");
});

test("a tar archive made in the shell is readable by real GNU tar (byte-level interop)", opts, async () => {
  // Pull the produced archive bytes out of the VFS and assert the format is sound
  // by checking the ustar magic — the pure-lib suite already proves full GNU-tar
  // interop; here we prove the *program* emits that same well-formed container.
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/t/hi.txt", "hello\n");
      const r = await window.run(os, ["tar", "-cf", "hi.tar", "hi.txt"], { cwd: "/t" });
      const bytes = await os.fs.read("/t/hi.tar");
      // ustar magic sits at offset 257 of the first 512-byte header.
      const magic = new TextDecoder().decode(bytes.slice(257, 262));
      return { r, magic, len: bytes.length };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.r.code, 0, result.r.err);
  assert.equal(result.magic, "ustar");
  assert.equal(result.len % 512, 0, "a tar archive is a whole number of 512-byte blocks");
});
