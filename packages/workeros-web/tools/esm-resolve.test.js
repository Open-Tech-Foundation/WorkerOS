// End-to-end test for the ESM gate (PLAN Phase 5·C-ESM / D), driven in a real
// browser via Playwright. An ESM script run under /bin/node uses:
//   * `import … from 'node:fs'` — a kernel-marked *builtin* edge, wired to the
//     guest runtime by /bin/node's synthetic-module stitch (C-ESM), and
//   * `import … from 'pkg'` / `'@scope/util/str'` — bare packages the kernel
//     resolves through `node_modules` (main + subpath `exports`) (D).
// Exercises the Rust resolver, the DTO, and the ESM stitch end to end.

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

test("ESM: node: builtin edges + node_modules resolution (main + subpath exports)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        "/proj/app.js": [
          "import { writeFileSync, readFileSync } from 'node:fs';",
          "import greet from 'greeter';",
          "import { upper } from '@scope/util/str';",
          "writeFileSync('/out.txt', 'esm ok');",
          "console.log('fs:', readFileSync('/out.txt', 'utf8'));",
          "console.log('greet:', greet('world'));",
          "console.log('upper:', upper('hey'));",
        ].join("\n"),
        // A bare ESM package resolved via package.json "main".
        "/proj/node_modules/greeter/package.json": '{"type":"module","main":"index.js"}',
        "/proj/node_modules/greeter/index.js": "export default (n) => 'hi ' + n;\n",
        // A scoped package with a subpath export map.
        "/proj/node_modules/@scope/util/package.json":
          '{"exports":{"./str":"./lib/str.js"}}',
        "/proj/node_modules/@scope/util/lib/str.js":
          "export const upper = (s) => s.toUpperCase();\n",
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), [
    "fs: esm ok",
    "greet: hi world",
    "upper: HEY",
  ]);
});

test("ESM: an uninstalled bare package fails honestly (not a silent stub)", opts, async () => {
  const { result } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/proj/app.js", "import _ from 'does-not-exist';\n");
      return await window.run(os, ["node", "app.js"], { cwd: "/proj" });
    }),
  );
  assert.notEqual(result.code, 0);
  assert.match(result.err, /does-not-exist/);
});
