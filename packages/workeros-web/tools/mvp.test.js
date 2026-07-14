// Phase 2 MVP acceptance test (PLAN.md Phase 2 exit criteria), driven in a real
// browser via Playwright. Each scenario runs inside the page; assertions are
// made here in node:test.

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
    // Provide a `run(os, argv, opts)` helper inside the page for every scenario.
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

test("criteria 1 & 2: spawn node main.js, relative import resolves, stdio + exit stream back", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/proj/util.js", "export const greet = (n) => 'hello ' + n;");
      await os.fs.write(
        "/proj/main.js",
        [
          "import { greet } from './util.js';",
          "console.log(greet('workeros'));",
          "console.error('diagnostic');",
          "process.exit(7);",
        ].join("\n"),
      );
      return await window.run(os, ["node", "main.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.out.trim(), "hello workeros");
  assert.equal(result.err.trim(), "diagnostic");
  assert.equal(result.code, 7, "process.exit code flows back");
});

test("criterion 3: an infinite-loop process is killable without freezing the kernel", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/loop.js", "while (true) {}");
      const loop = await os.spawn(["node", "loop.js"]);
      await new Promise((r) => setTimeout(r, 150));
      loop.kill(9);
      const killedCode = await loop.exited;

      await os.fs.write("/ok.js", "console.log('still alive')");
      const after = await window.run(os, ["node", "ok.js"]);
      return { killedCode, afterOut: after.out.trim(), afterCode: after.code };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.killedCode, 137, "SIGKILL → 128 + 9");
  assert.equal(result.afterOut, "still alive", "kernel survives the kill");
  assert.equal(result.afterCode, 0);
});

test("criterion 4: two processes run concurrently in separate workers", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/a.js", "for (let i=0;i<3;i++) console.log('A'+i);");
      await os.fs.write("/b.js", "for (let i=0;i<3;i++) console.log('B'+i);");
      const [a, b] = await Promise.all([
        window.run(os, ["node", "a.js"]),
        window.run(os, ["node", "b.js"]),
      ]);
      return { a, b };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.a.code, 0);
  assert.equal(result.b.code, 0);
  assert.deepEqual(result.a.out.trim().split("\n"), ["A0", "A1", "A2"]);
  assert.deepEqual(result.b.out.trim().split("\n"), ["B0", "B1", "B2"]);
});

test("client fs.list enumerates a directory (name + is_dir)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/lsdir/a.txt", "a");
      await os.fs.write("/lsdir/b.txt", "b");
      await os.fs.write("/lsdir/sub/c.txt", "c");
      const entries = await os.fs.list("/lsdir");
      return entries
        .map((e) => ({ name: e.name, is_dir: !!e.is_dir }))
        .sort((x, y) => (x.name < y.name ? -1 : 1));
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result, [
    { name: "a.txt", is_dir: false },
    { name: "b.txt", is_dir: false },
    { name: "sub", is_dir: true },
  ]);
});
