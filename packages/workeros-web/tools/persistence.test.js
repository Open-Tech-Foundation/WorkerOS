// Persistence acceptance test (ADR-022), driven in a real browser via Playwright.
// Proves the headline durability contract end-to-end: a file on a persistent
// path survives a full page reload (fresh worker + fresh kernel, rehydrated from
// IndexedDB), while a file under an ephemeral path (`/tmp`) is discarded — the
// "scaffold a project in /tmp, try it, throw it away on close" workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

const opts = { skip: chromium ? false : "playwright not installed" };

test("durable paths survive reload; /tmp is ephemeral (ADR-022)", opts, async () => {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    const url = `http://localhost:${port}/packages/workeros-web/tools/mvp.html`;
    await page.goto(url);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });

    // Session 1 — write a durable file and an ephemeral one, then flush to disk.
    await page.evaluate(async () => {
      const os = await window.__wos.boot();
      await os.fs.write("/keep.txt", "durable data");
      await os.fs.write("/tmp/scratch.txt", "ephemeral data");
      await os.flush(); // await the IndexedDB write before we reload
    });

    // Reload: the worker is torn down and reborn; the kernel boots empty and
    // rehydrates from IndexedDB (same origin → the store persists across reload).
    await page.reload();
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });

    // Session 2 — a brand-new kernel. Read both paths back.
    const res = await page.evaluate(async () => {
      const os = await window.__wos.boot();
      const dec = new TextDecoder();
      const keep = dec.decode(await os.fs.read("/keep.txt"));
      let scratchErr = false;
      let scratch = null;
      try {
        scratch = dec.decode(await os.fs.read("/tmp/scratch.txt"));
      } catch {
        scratchErr = true;
      }
      return { keep, scratch, scratchErr };
    });

    assert.deepEqual(pageErrors, []);
    assert.equal(res.keep, "durable data", "durable file survived the reload");
    assert.ok(
      res.scratchErr || res.scratch !== "ephemeral data",
      "ephemeral /tmp file was discarded",
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

test("multi-chunk binary file survives reload via the block store (ADR-022)", opts, async () => {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    const url = `http://localhost:${port}/packages/workeros-web/tools/mvp.html`;
    await page.goto(url);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });

    // Session 1: write a 200 KiB deterministic file (≥3 chunks) and flush.
    const digest1 = await page.evaluate(async () => {
      const os = await window.__wos.boot();
      const data = new Uint8Array(200 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
      await os.fs.write("/big.bin", data);
      await os.flush();
      // Simple checksum to compare across the reload.
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum = (sum + data[i] * (i + 1)) >>> 0;
      return sum;
    });

    await page.reload();
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });

    const res = await page.evaluate(async () => {
      const os = await window.__wos.boot();
      const got = await os.fs.read("/big.bin");
      let sum = 0;
      for (let i = 0; i < got.length; i++) sum = (sum + got[i] * (i + 1)) >>> 0;
      return { len: got.length, sum };
    });

    assert.deepEqual(pageErrors, []);
    assert.equal(res.len, 200 * 1024, "full length restored");
    assert.equal(res.sum, digest1, "byte-exact after chunk/compress/reassemble");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
