// End-to-end test for running TypeScript directly under /bin/node, driven in a
// real browser via Playwright. `.ts`/`.mts`/`.cts`/`.tsx` are transpiled by the
// oxc node-bundler wasm (crates/workeros-node-bundler): types are stripped and
// non-erasable syntax (`enum`, `namespace`, parameter properties) is lowered to
// runtime JS — no type checking, like Node's strip-types but full-transform.
//
// Covers: a TS ESM graph (type-only imports elided, value imports + a node:
// builtin linked, enum/interface used), the TS `import './x.js'` → `x.ts`
// resolution fallback, and a CommonJS `.cts` entry (require + module.exports kept).

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

test("TS ESM: type-only imports elided, value + builtin imports linked, enum/interface used", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        "/proj/package.json": '{"type":"module"}',
        "/proj/app.ts": [
          "import { greet } from './lib/greet.ts';",
          "import type { User } from './types.ts';", // elided — never resolved
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "enum Role { Admin, Editor }",
          "interface Wrapped { role: Role }",
          "const u: User = { name: 'Ada' };",
          "const w: Wrapped = { role: Role.Editor };",
          "writeFileSync('/out.txt', greet(u.name) + ' role=' + w.role);",
          "console.log(readFileSync('/out.txt', 'utf8'));",
        ].join("\n"),
        "/proj/lib/greet.ts": "export const greet = (n: string): string => 'hi ' + n;\n",
        "/proj/types.ts": "export interface User { name: string }\n", // types only — no runtime output
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.ts"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim(), "hi Ada role=1");
});

test("TS ESM: `import './x.js'` resolves to x.ts (TS emitted-extension fallback)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        "/proj/package.json": '{"type":"module"}',
        // Written with `.js` (what TS emits) but the source file is `math.ts`.
        "/proj/main.ts": "import add from './math.js';\nconsole.log('sum', add(2, 3));\n",
        "/proj/math.ts": "export default (a: number, b: number): number => a + b;\n",
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "main.ts"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim(), "sum 5");
});

test("TS CJS: a .cts entry keeps require/module.exports and lowers enum", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const files = {
        "/proj/app.cts": [
          "const path = require('node:path');",
          "enum Color { Red = 1, Green = 2 }",
          "const c: Color = Color.Green;",
          "const base: string = path.basename('/a/b.txt');",
          "console.log(base, c);",
        ].join("\n"),
      };
      for (const [p, src] of Object.entries(files)) await os.fs.write(p, src);
      return await window.run(os, ["node", "app.cts"], { cwd: "/proj" });
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim(), "b.txt 2");
});
