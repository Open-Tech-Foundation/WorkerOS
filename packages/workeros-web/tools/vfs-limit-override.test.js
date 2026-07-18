// End-to-end test for the boot-time VFS quota override (ADR-020). `boot({ limits })`
// forwards a partial resource-cap override through client → kernel-worker →
// WebKernel.bootWithLimits → Kernel::boot_with_limits. Proves the override
// actually reaches the kernel's MemVfs: a tight `vfsMaxBytes` rejects a write the
// default ceiling would accept, and a raised ceiling accepts it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const opts = { skip: chromium ? false : "playwright not installed" };

async function withOs(fn, arg) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });
    const result = await page.evaluate(fn, arg);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

// Boot with `vfsMaxBytes` and try to write `writeBytes` in one file; report "ok"
// or the error. Both caps boot fine (the OS base install is ~8-16 MiB) — only the
// write is meant to differ, isolating the quota from the boot-time install.
const probe = async ([vfsMaxBytes, writeBytes]) => {
  const os = await window.__wos.boot({ limits: { vfsMaxBytes } });
  try {
    await os.fs.write("/big.bin", new Uint8Array(writeBytes));
    return "ok";
  } catch (e) {
    return String(e.message || e);
  }
};

test("a tight vfsMaxBytes override enforces an over-quota write (ENOSPC)", opts, async () => {
  // 16 MiB boots (base install fits); a single 32 MiB write cannot — proving the
  // override reached the kernel's MemVfs, not the fabricated statfs free space.
  const { result, pageErrors } = await withOs(probe, [16 * 1024 * 1024, 32 * 1024 * 1024]);
  assert.deepEqual(pageErrors, []);
  assert.match(result, /ENOSPC|Nospc/, "a 32 MiB write must exceed a 16 MiB VFS cap");
});

test("a raised vfsMaxBytes override accepts a write the tight cap rejected", opts, async () => {
  // Same 32 MiB write, now under a 128 MiB cap → succeeds. Confirms the raised
  // ceiling (and that absent fields — procs/fds — inherit sane defaults).
  const { result, pageErrors } = await withOs(probe, [128 * 1024 * 1024, 32 * 1024 * 1024]);
  assert.deepEqual(pageErrors, []);
  assert.equal(result, "ok", "a 32 MiB write fits comfortably in a 128 MiB VFS cap");
});
