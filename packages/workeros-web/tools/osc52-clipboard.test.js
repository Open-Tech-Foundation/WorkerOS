// OSC 52 → system clipboard bridge (the playground's terminal wiring).
//
// A full-screen TUI like nano copies by emitting `ESC ] 52 ; c ; <base64> ST`.
// xterm.js does not touch the system clipboard on its own, so the playground
// registers an OSC 52 handler that decodes the payload and writes it to
// navigator.clipboard. This pins that path against the *vendored* xterm build:
// that `parser.registerOscHandler(52, …)` actually fires on nano's exact
// sequence, and that the base64 payload round-trips (incl. non-ASCII) to the
// clipboard. The handler body mirrors website/app/playground/page.jsx — keep the
// two in sync.

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

test("OSC 52 from a TUI lands on the system clipboard", opts, async () => {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    // Any served HTML doc on this origin gives us a document + the vendored xterm.
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);

    const copied = await page.evaluate(async (base) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = src;
          s.onload = res;
          s.onerror = () => rej(new Error("failed to load " + src));
          document.head.appendChild(s);
        });
      await load(base + "/website/public/vendor/xterm/xterm.js");

      const el = document.createElement("div");
      document.body.appendChild(el);
      const term = new window.Terminal({ cols: 80, rows: 24 });
      term.open(el);

      // The bridge, identical to page.jsx.
      term.parser.registerOscHandler(52, (payload) => {
        const semi = payload.indexOf(";");
        const b64 = semi >= 0 ? payload.slice(semi + 1) : payload;
        if (!b64 || b64 === "?") return true;
        let text;
        try {
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          text = new TextDecoder().decode(arr);
        } catch {
          return true;
        }
        navigator.clipboard.writeText(text);
        return true;
      });

      // Exactly what nano's osc52() emits: base64 of the UTF-8 bytes, framed by
      // OSC 52 … ST. Include a non-ASCII char to prove the UTF-8 round-trip.
      const text = "select ✓ me";
      const utf8 = new TextEncoder().encode(text);
      let bin = "";
      for (const b of utf8) bin += String.fromCharCode(b);
      const b64 = btoa(bin);
      term.write("\x1b]52;c;" + b64 + "\x1b\\");

      // Let the parser drain and the async clipboard write settle.
      await new Promise((r) => setTimeout(r, 200));
      return navigator.clipboard.readText();
    }, "");

    assert.deepEqual(pageErrors, []);
    assert.equal(copied, "select ✓ me", "the OSC 52 payload reached the system clipboard, UTF-8 intact");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
