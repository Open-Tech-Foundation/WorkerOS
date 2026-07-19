// Persistence acceptance test (ADR-022), driven in a real browser via Playwright.
// Proves the headline durability contract end-to-end: a file on a persistent disk
// (`/home` — WorkerOS is an immutable OS image where root `/` is ephemeral and
// only the disks `/home`,`/.system`,`/.apps` persist) survives a full page reload
// (fresh worker + fresh kernel, rehydrated from IndexedDB), while a file under an
// ephemeral path (`/tmp`, or the reshipped OS image at `/`) is discarded.

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
      await os.fs.write("/home/keep.txt", "durable data");
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
      const keep = dec.decode(await os.fs.read("/home/keep.txt"));
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
      // Vary the pattern per 64 KiB chunk so the chunks are genuinely distinct
      // (not deduped) — this exercises multi-chunk store + reassembly.
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 31 + 7 + Math.floor(i / (64 * 1024)) * 101) & 0xff;
      }
      await os.fs.write("/home/big.bin", data);
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
      const got = await os.fs.read("/home/big.bin");
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

test("mark-sweep GC reclaims the chunks of overwritten data (ADR-022)", opts, async () => {
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

    const res = await page.evaluate(async () => {
      // Count the chunks stored in the content-addressed block store by reading
      // the same-origin IndexedDB the worker writes to.
      const countChunks = () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("workeros", 2);
          req.onsuccess = () => {
            const db = req.result;
            const t = db.transaction("chunks", "readonly");
            const c = t.objectStore("chunks").count();
            c.onsuccess = () => {
              db.close();
              resolve(c.result);
            };
            c.onerror = () => reject(c.error);
          };
          req.onerror = () => reject(req.error);
        });

      const os = await window.__wos.boot();
      // A 256 KiB file → four *distinct* 64 KiB chunks. The per-chunk term
      // (chunk index × 101) breaks the 256-periodicity of `i & 0xff`, which
      // would otherwise make every aligned chunk identical and dedup to one.
      const big = new Uint8Array(256 * 1024);
      for (let i = 0; i < big.length; i++) {
        big[i] = (i * 31 + 7 + Math.floor(i / (64 * 1024)) * 101) & 0xff;
      }
      await os.fs.write("/home/doc.bin", big);
      await os.flush();
      const afterBig = await countChunks();

      // Overwrite the same path with a tiny body: the big chunks are now
      // unreferenced by the working tree (and no snapshot holds them within the
      // test window), so the next flush mark-sweeps them out of the store.
      await os.fs.write("/home/doc.bin", "small");
      await os.flush();
      const afterSmall = await countChunks();

      return { afterBig, afterSmall };
    });

    assert.deepEqual(pageErrors, []);
    assert.ok(res.afterBig >= 4, `big file stored several chunks (${res.afterBig})`);
    assert.ok(
      res.afterSmall < res.afterBig,
      `GC reclaimed unreferenced chunks (${res.afterBig} → ${res.afterSmall})`,
    );
    assert.equal(res.afterSmall, 1, "only the surviving small chunk remains");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
