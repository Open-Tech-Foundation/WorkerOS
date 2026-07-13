// The kernel tracer (os.trace) — the debugging surface for watching what a guest
// does: syscalls (sync + async), process spawn/exit, and stdin feeds. Off by
// default; turned on from the main thread, it records a ring buffer the harness
// (and a developer) can read back to locate a hang or a bad fs access.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

test("os.trace records spawn + syscalls + exit for a guest program", { skip: chromium ? false : "playwright not installed", timeout: 30000 }, async () => {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 20000 });

    const res = await page.evaluate(async () => {
      const os = await window.__wos.boot();
      const off = await os.trace({ on: true, clear: true });
      await os.fs.write("/t/p.js", "require('fs').writeFileSync('/t/out.txt','hi');process.stdout.write('done');");
      const dec = new TextDecoder();
      const proc = await os.spawn(["node", "/t/p.js"], { cwd: "/t" });
      let out = "";
      proc.onStdout((b) => (out += dec.decode(b)));
      await proc.exited;
      const dump = await os.trace({ dump: true, procs: true });
      return { offOn: off.on, out, events: dump.events, hasProcs: Array.isArray(dump.procs) };
    });

    assert.equal(res.offOn, true, "trace toggles on");
    assert.equal(res.out, "done");
    assert.ok(res.events.length > 0, "events were recorded");
    const kinds = new Set(res.events.map((e) => e.kind));
    assert.ok(kinds.has("proc"), "process spawn/exit recorded");
    assert.ok(kinds.has("sync") || kinds.has("async"), "syscalls recorded");
    // The spawn of our program and its write of /t/out.txt should both appear.
    assert.ok(res.events.some((e) => e.kind === "proc" && e.call === "spawn" && /p\.js/.test(e.info)), "our spawn is in the trace");
    assert.ok(res.events.some((e) => /out\.txt/.test(e.info || "")), "the file write is in the trace");
    assert.ok(res.events.some((e) => e.kind === "proc" && e.call === "exit"), "exit is in the trace");
    assert.equal(res.hasProcs, true, "process snapshot returned");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
