// Multi-PTY acceptance test: two independent terminals opened on one WorkerOS
// instance must never cross-talk — each owns its own shell session (cwd/env),
// line discipline, and foreground job. Driven in a real cross-origin-isolated
// browser via Playwright, through the public client API (`os.startTerminal` for
// the primary terminal + `os.openTerminal()` for a second one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

async function inBrowser(body) {
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
    const result = await page.evaluate(body);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

const opts = { skip: chromium ? false : "playwright not installed" };

test("two terminals keep independent shell sessions with no cross-talk", opts, async () => {
  const { result, pageErrors } = await inBrowser(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();

    // Primary terminal.
    let outA = "";
    os.onOutput((b) => (outA += dec.decode(b)));
    os.startTerminal();

    // A second, independent terminal.
    const term = await os.openTerminal();
    let outB = "";
    term.onOutput((b) => (outB += dec.decode(b)));
    term.start();

    const waitFor = async (get, s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (get().includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(get()));
    };

    await waitFor(() => outA, "$");
    await waitFor(() => outB, "$");

    // Send each terminal to a different existing directory, then `pwd` in each.
    // The two dir names ("bin" vs "tmp") double as cross-talk discriminators:
    // neither name is ever typed into the other terminal, so it must never appear
    // in the other's stream (prompt or output) if sessions are truly isolated.
    os.input("cd /bin\r");
    term.input("cd /tmp\r");
    os.input("pwd\r");
    term.input("pwd\r");
    await waitFor(() => outA, "/bin");
    await waitFor(() => outB, "/tmp");
    // Let any (erroneous) cross-delivered echo arrive before we snapshot.
    await new Promise((r) => setTimeout(r, 250));

    return {
      outA,
      outB,
      aHasTmp: outA.includes("tmp"),
      bHasBin: outB.includes("bin"),
    };
  });

  assert.deepEqual(pageErrors, []);
  assert.match(result.outA, /\/bin/, "primary terminal is in /bin");
  assert.match(result.outB, /\/tmp/, "second terminal is in /tmp");
  // No cross-talk: term 2's directory never surfaces in term 1's stream, or v.v.
  assert.equal(result.aHasTmp, false, "primary stream free of term 2 (tmp)");
  assert.equal(result.bHasBin, false, "second stream free of term 1 (bin)");
});

test("input routes to the addressed terminal only", opts, async () => {
  const { result, pageErrors } = await inBrowser(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let outA = "";
    os.onOutput((b) => (outA += dec.decode(b)));
    os.startTerminal();
    const term = await os.openTerminal();
    let outB = "";
    term.onOutput((b) => (outB += dec.decode(b)));
    term.start();

    const waitFor = async (get, s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (get().includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(get()));
    };
    await waitFor(() => outA, "$");
    await waitFor(() => outB, "$");

    // Type only into the second terminal; the primary must stay silent.
    term.input("echo only-in-B\r");
    await waitFor(() => outB, "only-in-B");
    await new Promise((r) => setTimeout(r, 200)); // give any stray echo time to arrive

    // Close the second terminal cleanly.
    term.close();
    return { outA, outB };
  });

  assert.deepEqual(pageErrors, []);
  assert.match(result.outB, /only-in-B/, "second terminal echoed its own input");
  assert.ok(!result.outA.includes("only-in-B"), "primary terminal received none of it");
});
