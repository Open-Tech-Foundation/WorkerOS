// End-to-end test for npm bin-linking + PATH (PLAN Phase 5·E), driven in a real
// browser via Playwright. A package's `bin` is a generated launcher at
// `node_modules/.bin/<name>`; the kernel now searches `node_modules/.bin` ahead
// of PATH, so the bin runs as a bare command from anywhere in the project. (This
// installs the launcher directly — mirroring what `npm install` writes — since
// the test can't reach the real registry.)

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

// Mirrors npm-program.js `binLauncherSource` (backticks keep the quoting sane).
const LAUNCHER = (target) =>
  `const q = (s) => "'" + String(s).replace(/'/g, "'\\\\''") + "'";\n` +
  `const target = ${JSON.stringify(target)};\n` +
  `const line = ["node", q(target)].concat(sys.argv.slice(1).map(q)).join(" ");\n` +
  `sys.exit(await sys.exec(line));\n`;

test("an installed bin runs as a bare command, forwarding args + exit code", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(
      async ({ launcher }) => {
        const os = await window.__wos.boot();
        await os.fs.write(
          "/proj/node_modules/mytool/bin/cli.js",
          "console.log('mytool args:', process.argv.slice(2).join(','));\nprocess.exit(3);\n",
        );
        await os.fs.write("/proj/node_modules/.bin/mytool", launcher);
        // Bare command name, resolved from a subdirectory of the project.
        return await window.run(os, ["mytool", "a", "b"], { cwd: "/proj/sub" });
      },
      { launcher: LAUNCHER("/proj/node_modules/mytool/bin/cli.js") },
    ),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.out.trim(), "mytool args: a,b");
  assert.equal(result.code, 3, "the bin's exit code is forwarded");
});
