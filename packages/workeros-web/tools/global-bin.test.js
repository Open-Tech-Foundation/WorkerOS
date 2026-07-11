// End-to-end test for global (`npm install -g`) bin resolution, driven in a real
// browser via Playwright. A `-g` install puts the package in the persistent
// global store `/.node_modules` and a generated launcher in `/.node_modules/.bin`.
// The OS ships a default `/etc/profile` that the login shell sources at startup,
// putting `/.node_modules/.bin` on `$PATH` — so a global bin runs as a bare
// command from any cwd, while the kernel resolver still knows only `/bin:/sbin`
// (INV-1). This mirrors what `npm install -g` writes (the test can't reach the
// real registry) and runs it through the shell that applies the profile.

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

test("a global (-g) bin runs as a bare command from any cwd via /etc/profile PATH", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(
      async ({ launcher }) => {
        const os = await window.__wos.boot();
        const dec = new TextDecoder();
        // What `npm install -g toolg` writes: the package under the persistent
        // global store, and a launcher in the global `.bin` (on PATH via profile).
        await os.fs.write(
          "/.node_modules/toolg/bin/cli.js",
          "console.log('toolg says', process.argv.slice(2).join(' '));\nprocess.exit(7);\n",
        );
        await os.fs.write("/.node_modules/.bin/toolg", launcher);
        await os.fs.write("/work/.keep", ""); // an unrelated cwd, no local node_modules
        // Bare command from /work: it resolves only because /etc/profile put the
        // global `.bin` on PATH (otherwise the shell search misses → code 127).
        let out = "";
        const { code } = await os.exec("cd /work && toolg hi there", {
          onStdout: (b) => (out += dec.decode(b)),
        });
        return { out, code };
      },
      { launcher: LAUNCHER("/.node_modules/toolg/bin/cli.js") },
    ),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.out.trim(), "toolg says hi there");
  assert.equal(result.code, 7, "the global bin's exit code is forwarded");
});
