// End-to-end test for CJS-in-an-ESM-graph interop (PLAN Phase 5·D follow-up),
// driven in a real browser via Playwright. An ESM entry `import`s a CommonJS
// package (module.exports + its own `require` subtree). The kernel resolves the
// CJS file into the ESM graph; /bin/node's stitch stands it up with a synthetic
// module backed by the synchronous CJS loader — so `import cjs from 'pkg'`
// (default) and `import { named } from 'pkg'` (interop) both work.

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

test("ESM entry imports a CJS package (default + named interop, nested require)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        "/proj/app.js": [
          "import cjs from 'cjslib';",
          "import { addOne } from 'cjslib';",
          "console.log('default:', cjs.hello());",
          "console.log('named:', addOne(41));",
        ].join("\n"),
        "/proj/node_modules/cjslib/package.json": '{"main":"index.js"}',
        "/proj/node_modules/cjslib/index.js": [
          "const dep = require('./dep');",
          "module.exports = { hello: () => 'hi ' + dep.who(), addOne: (n) => n + 1 };",
        ].join("\n"),
        "/proj/node_modules/cjslib/dep.js": "module.exports = { who: () => 'cjs' };\n",
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), ["default: hi cjs", "named: 42"]);
});

test("CJS entry dynamically import()s an ESM module (reverse interop)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        // A CommonJS entry (require + module-scope) that pulls in an ESM module via
        // dynamic import() — the specifier resolves + loads lazily out of the VFS.
        "/proj/app.js": [
          "const dep = require('./cjsdep');",
          "console.log('req:', dep.tag);",
          "import('./esmdep.js').then((m) => {",
          "  console.log('imp-default:', m.default(3));",
          "  console.log('imp-named:', m.tri(3));",
          "});",
        ].join("\n"),
        "/proj/cjsdep.js": "module.exports = { tag: 'cjs-dep' };\n",
        "/proj/esmdep.js": "export default (n) => n * 2;\nexport const tri = (n) => n * 3;\n",
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), ["req: cjs-dep", "imp-default: 6", "imp-named: 9"]);
});

test("CJS entry require()s an ES module synchronously (require(esm))", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        // A CommonJS entry that synchronously require()s an ES module — Node allows
        // this for ESM without top-level await. Returns the module namespace.
        "/proj/app.js": [
          "const esm = require('./mod.mjs');",
          "console.log('default:', esm.default);",
          "console.log('named:', esm.add(2, 3));",
          "console.log('keys:', Object.keys(esm).sort().join(','));",
        ].join("\n"),
        "/proj/mod.mjs": [
          "import { base } from './base.mjs';",
          "export const add = (a, b) => a + b + base;",
          "export default 'esm-default';",
        ].join("\n"),
        "/proj/base.mjs": "export const base = 0;\n",
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), [
    "default: esm-default",
    "named: 5",
    "keys: add,default",
  ]);
});
