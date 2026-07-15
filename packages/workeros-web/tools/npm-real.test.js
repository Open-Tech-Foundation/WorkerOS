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

test("real npm: `init -y` scaffolds and `install <pkg>` unpacks a real tarball", opts, async () => {
  const res = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const flags = ["--no-update-notifier", "--no-audit", "--no-fund", "--cache", "/tmp/npmc", "--loglevel", "warn"];
      const CLI = "/usr/lib/npm/bin/npm-cli.js";
      await window.run(os, ["npm", "--version", ...flags], { cwd: "/" }); // drive the launcher unpack
      await window.run(os, ["node", "-e", "require('fs').mkdirSync('/app',{recursive:true})"], { cwd: "/" });
      // `init -y` writes a package.json (regression: promzard needs a constructable
      // `require('module').Module`).
      const init = await window.run(os, ["node", CLI, "init", "-y", ...flags], { cwd: "/app" });
      // `install <pkg>` fetches + extracts a real tarball, whose integrity write goes
      // through cacache's `events.once(stream, 'size')` — the deadlock this guards.
      const install = await window.run(os, ["node", CLI, "install", "is-number@7.0.0", ...flags], { cwd: "/app" });
      // Verify the on-disk result from inside the guest (real fs).
      const check = await window.run(os, ["node", "-e",
        "const fs=require('fs');" +
        "const pj=JSON.parse(fs.readFileSync('/app/package.json','utf8'));" +
        "const v=JSON.parse(fs.readFileSync('/app/node_modules/is-number/package.json','utf8')).version;" +
        "process.stdout.write(JSON.stringify({dep:pj.dependencies&&pj.dependencies['is-number'],version:v}));",
      ], { cwd: "/app" });
      return { init, install, check };
    }),
  );

  assert.equal(res.init.code, 0, res.init.err);
  assert.equal(res.install.code, 0, res.install.err);
  assert.equal(res.check.code, 0, res.check.err);
  const parsed = JSON.parse(res.check.out.trim());
  assert.equal(parsed.version, "7.0.0", "is-number@7.0.0 should be unpacked into node_modules");
  assert.match(parsed.dep, /7\.0\.0/, "package.json dependencies should record the install");
});

test("real npx: /bin/npx launcher execs the npx CLI bundled in npm's tarball", opts, async () => {
  const res = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const flags = ["--no-update-notifier", "--cache", "/tmp/npmc"];
      const NPX = "/usr/lib/npm/bin/npx-cli.js";
      // First `npx` invocation shares npm's launcher and drives the unpack (its
      // own stdout goes to the TTY, so assert the CLI landed + the exit code).
      const viaBin = await window.run(os, ["npx", "--version", ...flags], { cwd: "/" });
      let present = false;
      try { present = !!(await os.fs.read(NPX)); } catch {}
      // Run the real npx CLI directly so its stdout is the captured process.
      const version = await window.run(os, ["node", NPX, "--version", ...flags], { cwd: "/" });
      return { present, viaBin, version };
    }),
  );

  assert.ok(res.present, "launcher should unpack npx-cli.js alongside npm-cli.js");
  assert.equal(res.viaBin.code, 0, res.viaBin.err);
  assert.equal(res.version.code, 0, res.version.err);
  assert.match(res.version.out.trim(), /^\d+\.\d+\.\d+$/);
});
