// End-to-end test for the `node:os`/`node:url`/`node:module` builtins and the
// grown `process` (PLAN Phase 5·B), driven in a real browser via Playwright.
// The headline: `require('module').createRequire(__filename)('./helper')` does a
// real *synchronous* on-demand module load over the SAB sync-fs channel — a file
// the ahead-of-time prefetch runtime never saw. Exercises the whole stack.

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

test("os/url/module builtins + grown process work end-to-end under /bin/node", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/proj/helper.js", "module.exports = (a, b) => a + b;\n");
      await os.fs.write(
        "/proj/app.js",
        [
          "const os = require('os');",
          "const url = require('node:url');",
          "const { createRequire } = require('module');",
          // A real synchronous on-demand require of a file that was never prefetched:
          "const require2 = createRequire(__filename);",
          "const add = require2('./helper');",
          "console.log('sum:', add(2, 3));",
          "console.log('eol:', JSON.stringify(os.EOL), 'platform:', os.platform());",
          "console.log('tmp:', os.tmpdir(), 'cpus>=1:', os.cpus().length >= 1);",
          "console.log('path:', url.fileURLToPath('file:///a/b c.txt'));",
          "console.log('node:', process.versions.node, 'arch:', process.arch);",
          "console.log('hrtime:', Array.isArray(process.hrtime()), 'bigint:', typeof process.hrtime.bigint());",
          "let ticked = false; process.nextTick(() => { ticked = true; });",
          "Promise.resolve().then(() => console.log('nextTick:', ticked));",
        ].join("\n"),
      );
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  const lines = result.out.trim().split("\n");
  assert.deepEqual(lines, [
    "sum: 5",
    'eol: "\\n" platform: workeros',
    "tmp: /tmp cpus>=1: true",
    "path: /a/b c.txt",
    "node: 22.23.1 arch: wasm32",
    "hrtime: true bigint: bigint",
    "nextTick: true",
  ]);
});

test("require.main === module in the CJS entry, and is the same object in a dep", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        // A CommonJS entry: `require.main === module` is Node's "am I the entry?" idiom.
        "/proj/app.js": [
          "const dep = require('./dep');",
          "console.log('entry-is-main:', require.main === module);",
          "console.log('dep-sees-main:', dep.mainIsEntry(module));",
          "console.log('main-id:', require.main.id, 'main-file:', require.main.filename);",
        ].join("\n"),
        // A dependency sees the SAME require.main (the entry), not itself.
        "/proj/dep.js": [
          "exports.mainIsEntry = (entryModule) =>",
          "  require.main !== module && require.main === entryModule;",
        ].join("\n"),
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), [
    "entry-is-main: true",
    "dep-sees-main: true",
    "main-id: . main-file: /proj/app.js",
  ]);
});

test("node:vm contextifies a sandbox and runs code end-to-end under /bin/node", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      // An ESM entry so this drives the `node:vm` ESM-stitch registration path (the
      // synthesized re-export blob for `import { … } from 'node:vm'`), the more
      // failure-prone of the two registration paths. The headline is contextify: a
      // sandbox object gains and keeps globals across runs, while `runInThisContext`
      // runs in /bin/node's own global scope, seeing none of them.
      await os.fs.write(
        "/proj/app.mjs",
        [
          "import vm, { runInThisContext, isContext } from 'node:vm';",
          "const sandbox = { x: 5, count: 0 };",
          "vm.createContext(sandbox);",
          "console.log('is-context:', isContext(sandbox));",
          "console.log('read:', vm.runInContext('x + 1', sandbox));",
          "vm.runInContext('count += 10; y = 99', sandbox);",
          "console.log('write:', sandbox.count, sandbox.y);",
          "console.log('new-context:', vm.runInNewContext('a * b', { a: 6, b: 7 }));",
          "console.log('this-context:', runInThisContext('typeof sandbox'));",
          "console.log('script:', new vm.Script('Math.abs(-9)').runInThisContext());",
          "console.log('compile:', vm.compileFunction('return a + b', ['a', 'b'])(2, 3));",
        ].join("\n"),
      );
      return await window.run(os, ["node", "app.mjs"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), [
    "is-context: true",
    "read: 6",
    "write: 10 99",
    "new-context: 42",
    // `runInThisContext` runs in /bin/node's global scope, which has no `sandbox`.
    "this-context: undefined",
    "script: 9",
    "compile: 5",
  ]);
});
