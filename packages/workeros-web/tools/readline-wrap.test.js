// Soft-wrap acceptance test for the interactive shell prompt, driven in a real
// cross-origin-isolated browser via Playwright.
//
// The raw-mode line editor repaints the prompt + line across multiple terminal
// rows when it's wider than the window. The failure mode this pins down is a
// *corrupted buffer*: if the multi-line cursor math is wrong, a command longer
// than the terminal width (or one edited across a live resize) submits garbled.
// We type such commands at a deliberately narrow width and assert the command
// actually ran — the output token only exists if the whole line arrived intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

async function withTerminal(body) {
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
    const buf = await page.evaluate(body);
    return { buf, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

const opts = { skip: chromium ? false : "playwright not installed" };

test("a command wider than the terminal submits and runs intact", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.resize(10, 20); // a narrow, 20-column terminal
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out));
    };
    await waitFor("$");
    // ~40 columns of command across a 20-column window (2+ rows). The output
    // token `got=abc…` is produced only by expansion, so it can't come from the
    // echoed keystrokes — it appears only if the wrapped line submitted whole.
    os.input("X=abcdefghijklmnopqrstuvwxyz; echo got=$X\r");
    await waitFor("got=abcdefghijklmnopqrstuvwxyz");
    return { out };
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf.out, /got=abcdefghijklmnopqrstuvwxyz/);
});

test("resizing the terminal mid-edit keeps the line intact", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.resize(24, 80); // start wide — the line fits on one row
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("Y=0123456789abcdefghij; echo out=$Y"); // typed, not submitted
    await sleep(120);
    os.resize(24, 16); // shrink under the half-typed line → forces a re-wrap
    await sleep(120);
    os.input("\r"); // submit the re-wrapped line
    await waitFor("out=0123456789abcdefghij");
    return { out };
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf.out, /out=0123456789abcdefghij/);
});
