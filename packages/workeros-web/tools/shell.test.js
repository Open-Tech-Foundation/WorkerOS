// Phase 3 acceptance test (PLAN.md Phase 3 exit criteria + coreutils behavior),
// driven in a real browser via Playwright.

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
    // A `sh(os, line)` helper that runs a wsh line and captures its output.
    await page.addInitScript(() => {
      const dec = new TextDecoder();
      window.sh = async (os, line) => {
        let out = "";
        let err = "";
        const { code } = await os.exec(line, {
          onStdout: (b) => (out += dec.decode(b)),
          onStderr: (b) => (err += dec.decode(b)),
        });
        return { out, err, code };
      };
      window.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

test("criterion 1: echo hi | cat > f && cat f produces hi", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      // The whole headline line at once.
      const combined = await window.sh(os, "echo hi | cat > f && cat f");
      // And prove f really holds it.
      const fileHas = new TextDecoder().decode(await os.fs.read("/f"));
      return { combined, fileHas };
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.combined.out, "hi\n");
  assert.equal(result.combined.code, 0);
  assert.equal(result.fileHas, "hi\n");
});

test("coreutils behavior suite", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const sh = (l) => window.sh(os, l);
      const r = {};
      r.echo = await sh("echo hello world");
      r.echoN = await sh("echo -n x");
      r.pwd = await sh("pwd");
      r.mkdirLs = await (async () => {
        await sh("mkdir -p a/b/c");
        return sh("ls a");
      })();
      r.cpCat = await (async () => {
        await sh("echo content > src.txt");
        await sh("cp src.txt dst.txt");
        return sh("cat dst.txt");
      })();
      r.mv = await (async () => {
        await sh("echo m > m1.txt");
        await sh("mv m1.txt m2.txt");
        return sh("cat m2.txt");
      })();
      r.rm = await (async () => {
        await sh("echo x > gone.txt");
        await sh("rm gone.txt");
        return sh("cat gone.txt"); // should fail (nonzero)
      })();
      r.andor = await sh("false || echo rescued");
      r.andTrue = await sh("true && echo ok");
      r.trueCode = (await sh("true")).code;
      r.falseCode = (await sh("false")).code;
      r.pipe3 = await sh("echo hello | cat | cat");
      r.glob = await (async () => {
        await sh("echo A > g1.txt");
        await sh("echo B > g2.txt");
        return sh("echo g1.txt g2.txt | cat"); // sanity
      })();
      r.globExpand = await (async () => {
        return sh("ls *.txt");
      })();
      r.cdPwd = await sh("cd a && pwd");
      return r;
    }),
  );

  assert.deepEqual(pageErrors, []);
  const r = result;
  assert.equal(r.echo.out, "hello world\n");
  assert.equal(r.echoN.out, "x");
  assert.equal(r.pwd.out, "/\n");
  assert.equal(r.mkdirLs.out, "b\n");
  assert.equal(r.cpCat.out, "content\n");
  assert.equal(r.mv.out, "m\n");
  assert.notEqual(r.rm.code, 0, "cat of removed file fails");
  assert.equal(r.andor.out, "rescued\n");
  assert.equal(r.andTrue.out, "ok\n");
  assert.equal(r.trueCode, 0);
  assert.equal(r.falseCode, 1);
  assert.equal(r.pipe3.out, "hello\n");
  assert.ok(r.globExpand.out.includes("g1.txt") && r.globExpand.out.includes("g2.txt"), "glob expands *.txt");
  assert.equal(r.cdPwd.out, "/a\n", "cd changes the shell cwd");
});

test("criterion 2 & 3: ps lists live processes; a backgrounded job survives and is killable", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/loop.js", "while (true) {}");

      // Background job via the shell.
      const done = await os.exec("node loop.js &");
      // ps should list the still-running background loop.
      await window.sleep(80);
      const procs = await os.ps();
      const loop = procs.find((p) => p.argv.join(" ").includes("loop.js"));

      let killedGone = false;
      if (loop) {
        os.kill(loop.pid, 9);
        await window.sleep(80);
        const after = await os.ps();
        killedGone = !after.find((p) => p.pid === loop.pid);
      }
      return { backgroundCode: done.code, sawLoop: !!loop, killedGone };
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.backgroundCode, 0, "background statement returns promptly");
  assert.ok(result.sawLoop, "ps lists the backgrounded process");
  assert.ok(result.killedGone, "the background job is killable");
});

test("interpreter: expansion, control flow, functions, and $() end-to-end", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const sh = (l) => window.sh(os, l);
      const r = {};
      // parameter expansion + defaults + suffix strip
      r.param = await sh('f=archive.tar.gz; echo "${f%.gz} ${MISSING:-none}"');
      // command substitution feeding a for-loop, with a function + case
      r.script = await sh([
        'detect() { case "$1" in *.txt) echo text ;; *) echo other ;; esac; }',
        'for f in a.txt b.log; do echo "$f is $(detect $f)"; done',
      ].join("\n"));
      // arithmetic + while
      r.count = await sh('i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done');
      // pipe into a builtin consumer
      r.readloop = await sh('printf "x\\ny\\n" | while read v; do echo "[$v]"; done');
      return r;
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.param.out, "archive.tar none\n");
  assert.equal(result.script.out, "a.txt is text\nb.log is other\n");
  assert.equal(result.count.out, "0\n1\n2\n");
  assert.equal(result.readloop.out, "[x]\n[y]\n");
});

test("sh/bash program: -c, script file, and piped stdin (curl | bash idiom)", opts, async () => {
  const { result, pageErrors } = await withPage((page) =>
    page.evaluate(async () => {
      const os = await window.__wos.boot();
      const sh = (l) => window.sh(os, l);
      const r = {};
      r.dashC = await sh(`bash -c 'for i in 1 2 3; do echo $i; done'`);
      await os.fs.write("/setup.sh", "#!/bin/bash\necho \"hello from $1\"\n");
      r.file = await sh("sh /setup.sh world");
      // The installer idiom: a producer piping a script into bash on stdin.
      r.piped = await sh(`echo 'echo piped-ok' | bash`);
      return r;
    }),
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(result.dashC.out, "1\n2\n3\n");
  assert.equal(result.file.out, "hello from world\n");
  assert.equal(result.piped.out, "piped-ok\n");
});
