// End-to-end test for npm bin-linking + PATH (PLAN Phase 5·E), driven in a real
// browser via Playwright. A package's `bin` is a generated launcher at
// `node_modules/.bin/<name>`. The policy lives in userland: `wsh` prepends the
// `node_modules/.bin` chain (cwd up) to `$PATH`, and the kernel just does a plain
// `$PATH` search — so the bin runs as a bare command through the shell. (This
// installs the launcher directly — mirroring what `npm install` writes — since
// the test can't reach the real registry, and runs it via `os.exec` so it goes
// through the shell that sets PATH.)

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

test("an installed bin runs as a bare command through the shell (PATH), from a subdir", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(
      async ({ launcher }) => {
        const os = await window.__wos.boot();
        const dec = new TextDecoder();
        await os.fs.write(
          "/proj/node_modules/mytool/bin/cli.js",
          "console.log('mytool args:', process.argv.slice(2).join(','));\nprocess.exit(3);\n",
        );
        await os.fs.write("/proj/node_modules/.bin/mytool", launcher);
        await os.fs.write("/proj/sub/.keep", ""); // create the subdir to run from
        // Bare command, run through the shell from a subdir — the shell prepends
        // the ancestor `node_modules/.bin` chain to PATH; the kernel just searches.
        let out = "";
        const { code } = await os.exec("cd /proj/sub && mytool a b", {
          onStdout: (b) => (out += dec.decode(b)),
        });
        return { out, code };
      },
      { launcher: LAUNCHER("/proj/node_modules/mytool/bin/cli.js") },
    ),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.out.trim(), "mytool args: a,b");
  assert.equal(result.code, 3, "the bin's exit code is forwarded");
});

test("a #!/usr/bin/env node symlinked bin runs under node, resolving relative imports", opts, async () => {
  // How the *real* npm's bin-links installs a package bin: a `node_modules/.bin/<name>`
  // symlink to a `#!/usr/bin/env node` script (this is the `npm create vite` path).
  // The kernel must honor the shebang (run it through /bin/node, not the bare `sys`
  // surface) and /bin/node must realpath the symlinked entry so the script's own
  // `import './dist/...'` resolves against the real package dir, not `.bin/`.
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const dec = new TextDecoder();
      await os.fs.write("/proj/node_modules/tool/package.json", '{"type":"module"}');
      await os.fs.write(
        "/proj/node_modules/tool/index.js",
        "#!/usr/bin/env node\nimport './dist/main.js'\n",
      );
      await os.fs.write(
        "/proj/node_modules/tool/dist/main.js",
        "import { styleText } from 'node:util';\n" +
          "console.log('tool-ran', styleText('none', process.argv.slice(2).join(',')));\n",
      );
      // The relative symlink, as bin-links writes it.
      await os.fs.write(
        "/mk.js",
        "import { symlinkSync, mkdirSync } from 'node:fs';\n" +
          "mkdirSync('/proj/node_modules/.bin', { recursive: true });\n" +
          "symlinkSync('../tool/index.js', '/proj/node_modules/.bin/tool');\n",
      );
      const p = await os.spawn(["node", "/mk.js"], {});
      await p.exited;
      let out = "";
      const { code } = await os.exec("cd /proj && tool one two", {
        onStdout: (b) => (out += dec.decode(b)),
        onStderr: (b) => (out += dec.decode(b)),
      });
      return { out: out.trim(), code };
    }),
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(result.out, "tool-ran one,two", "ran under node; relative import + node:util resolved");
  assert.equal(result.code, 0);
});
