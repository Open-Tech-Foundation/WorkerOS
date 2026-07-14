// End-to-end tests for the uutils coreutils tier (/bin/coreutils, crates/
// wsh-utils): one wasm32-wasip1 multicall binary reached through per-utility
// /bin symlinks, dispatching on argv[0]. These boot the real kernel and drive
// the utilities as processes — symlink resolution, argv passthrough, the WASI
// host's fs/stdio translation, and the PWD → chdir cwd adoption.
//
// Skipped (like the grep tests) when the binary isn't built:
// `npm -w packages/workeros-programs run build:utils`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}
const built = existsSync(
  fileURLToPath(new URL("../../workeros-programs/src/utils/coreutils.wasm", import.meta.url)),
);
const opts = {
  skip: !chromium ? "playwright not installed" : !built ? "coreutils.wasm not built" : false,
};

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

test("file utilities: touch/ln/readlink/realpath/truncate against the VFS", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/work/seed.txt", "0123456789");

      // Relative path → the guest adopted the kernel cwd (PWD chdir).
      const touch = await window.run(os, ["touch", "made.txt"], { cwd: "/work" });
      const ln = await window.run(os, ["ln", "-s", "/work/seed.txt", "/work/link"], { cwd: "/" });
      const readlink = await window.run(os, ["readlink", "/work/link"], { cwd: "/" });
      const realpath = await window.run(os, ["realpath", "link"], { cwd: "/work" });
      const truncate = await window.run(os, ["truncate", "-s", "4", "seed.txt"], { cwd: "/work" });

      const dec = new TextDecoder();
      const made = await os.fs.read("/work/made.txt").then(() => true).catch(() => false);
      const seed = dec.decode(await os.fs.read("/work/seed.txt"));
      return { touch, ln, readlink, realpath, truncate, made, seed };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.touch.code, 0, result.touch.err);
  assert.equal(result.made, true, "touch must create the file in the kernel cwd");
  assert.equal(result.ln.code, 0, result.ln.err);
  assert.equal(result.readlink.out.trim(), "/work/seed.txt");
  assert.equal(result.realpath.out.trim(), "/work/seed.txt");
  assert.equal(result.truncate.code, 0, result.truncate.err);
  assert.equal(result.seed, "0123", "truncate -s 4 must shorten the file");
});

test("text/encoding utilities: base64, cksum digests, od, nl, paste, comm", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/t/msg.txt", "hello\n");
      await os.fs.write("/t/a.txt", "apple\nboth\n");
      await os.fs.write("/t/b.txt", "banana\nboth\n");

      const b64 = await window.run(os, ["base64", "msg.txt"], { cwd: "/t" });
      const sha = await window.run(os, ["cksum", "-a", "sha256", "--untagged", "msg.txt"], { cwd: "/t" });
      const od = await window.run(os, ["od", "-An", "-c", "msg.txt"], { cwd: "/t" });
      const nl = await window.run(os, ["nl", "msg.txt"], { cwd: "/t" });
      const paste = await window.run(os, ["paste", "-d,", "a.txt", "b.txt"], { cwd: "/t" });
      const comm = await window.run(os, ["comm", "-12", "a.txt", "b.txt"], { cwd: "/t" });
      return { b64, sha, od, nl, paste, comm };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.b64.out.trim(), "aGVsbG8K");
  // sha256 of "hello\n" — a fixed vector.
  assert.match(result.sha.out, /^5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03/);
  assert.match(result.od.out, /h\s+e\s+l\s+l\s+o\s+\\n/);
  assert.match(result.nl.out, /1\thello/);
  assert.equal(result.paste.out, "apple,banana\nboth,both\n");
  assert.equal(result.comm.out.trim(), "both");
});

test("multicall dispatch: symlinked names, explicit form, unknown name", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const basename = await window.run(os, ["basename", "/a/b/c.txt"], { cwd: "/" });
      const explicit = await window.run(os, ["coreutils", "dirname", "/a/b/c.txt"], { cwd: "/" });
      const unknown = await window.run(os, ["coreutils", "nope"], { cwd: "/" });
      const viaShell = await window.run(os, ["sh", "-c", "printf '%s-%d\\n' A 7 | fold -w1"], { cwd: "/" });
      return { basename, explicit, unknown, viaShell };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.basename.out.trim(), "c.txt");
  assert.equal(result.explicit.out.trim(), "/a/b");
  assert.equal(result.unknown.code, 127);
  assert.equal(result.viaShell.out, "A\n-\n7\n");
});

test("sleep blocks on the poll_oneoff clock (thread::sleep works)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const t0 = Date.now();
      const r = await window.run(os, ["sleep", "1"], { cwd: "/" });
      return { r, elapsed: Date.now() - t0 };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.r.code, 0, result.r.err);
  assert.ok(result.elapsed >= 900, `sleep 1 returned after ${result.elapsed}ms`);
});

test("streams: seq | fold pipe in, tee out, split writes chunk files", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const dec = new TextDecoder();
      await os.fs.write("/s/six.txt", "aabbcc");

      const tee = await window.run(os, ["sh", "-c", "echo data | tee /s/teed.txt"], { cwd: "/s" });
      const teed = dec.decode(await os.fs.read("/s/teed.txt"));
      const split = await window.run(os, ["split", "-b", "2", "six.txt", "part."], { cwd: "/s" });
      const aa = dec.decode(await os.fs.read("/s/part.aa"));
      const ab = dec.decode(await os.fs.read("/s/part.ab"));
      const ac = dec.decode(await os.fs.read("/s/part.ac"));
      return { tee, teed, split, aa, ab, ac };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.tee.code, 0, result.tee.err);
  assert.equal(result.tee.out, "data\n");
  assert.equal(result.teed, "data\n");
  assert.equal(result.split.code, 0, result.split.err);
  assert.equal(result.aa + result.ab + result.ac, "aabbcc");
});
