// End-to-end: the *real* npm CLI (vendored into the OS image; tools/vendor-npm.mjs)
// runs under /bin/node. On first invocation the /bin/npm launcher unpacks
// /lib/workeros-npm/npm.tgz into the persistent /usr/lib/npm, then execs
// `node /usr/lib/npm/bin/npm-cli.js`. This exercises the whole stack: the vendored
// tarball, the launcher's gunzip+untar, and Node-compat deep enough to boot npm
// and its ~130 bundled dependencies.
//
// We assert against `node` run directly on the CLI (its stdout is the captured
// process). The launcher itself execs via sys.exec, whose child inherits the TTY
// rather than this capture pipe, so we only check its exit code.

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
    return await fn(page);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

const opts = { skip: chromium ? false : "playwright not installed", timeout: 60000 };

test("real npm: vendored CLI boots and runs `--version` + `config get`", opts, async () => {
  const res = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const flags = ["--no-update-notifier", "--cache", "/tmp/npmc"];
      const CLI = "/usr/lib/npm/bin/npm-cli.js";
      // First `npm` invocation drives the launcher's unpack into /usr/lib/npm. Its
      // own stdout goes to the TTY (uncaptured) and the exit code depends on the
      // update-notifier's network reachability, so we assert the unpack landed
      // rather than the launcher's code.
      await window.run(os, ["npm", "--version", ...flags], { cwd: "/" });
      let unpacked = false;
      try { unpacked = !!(await os.fs.read(CLI)); } catch {}
      // Run the real CLI directly so its stdout is the captured process.
      const version = await window.run(os, ["node", CLI, "--version", ...flags], { cwd: "/" });
      const registry = await window.run(os, ["node", CLI, "config", "get", "registry", ...flags], { cwd: "/" });
      return { unpacked, version, registry };
    }),
  );

  assert.ok(res.unpacked, "launcher should unpack the real npm into /usr/lib/npm");
  assert.equal(res.version.code, 0, res.version.err);
  assert.match(res.version.out.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(res.registry.code, 0, res.registry.err);
  assert.equal(res.registry.out.trim(), "https://registry.npmjs.org/");
});
