// Headless-browser smoke test (Phase 0 exit criterion): serve the package with
// COOP/COEP, load the harness in Chromium, and assert the kernel boots and the
// SAB ring buffer round-trips. Uses node:test + Playwright.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

// Playwright is a devDependency; skip cleanly if it isn't installed so
// `npm test` degrades gracefully in minimal environments (CI installs it).
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

test("kernel boots and ring buffer round-trips in a real browser", { skip: chromium ? false : "playwright not installed" }, async () => {
  const server = createDevServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://localhost:${port}/tools/harness.html`);

    await page.waitForFunction(() => window.__workeros_results && window.__workeros_results.done, {
      timeout: 15000,
    });
    const results = await page.evaluate(() => window.__workeros_results);

    assert.equal(results.crossOriginIsolated, true, "page must be cross-origin isolated");
    for (const check of results.checks) {
      assert.ok(check.pass, `check "${check.name}" failed: ${check.detail}`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
