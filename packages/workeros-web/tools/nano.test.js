// `nano` acceptance test (the full-screen editor), driven in a real
// cross-origin-isolated browser via Playwright.
//
// nano is the first program to take the terminal *raw* on its own behalf (via
// the tcgetattr/tcsetattr syscalls). These cases pin down the round trip: it
// receives per-keystroke raw input, writes a file through the VFS, and — the
// part that's easy to get wrong — restores the cooked line discipline on exit
// so the shell prompt is usable again afterwards.

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

test("nano: type text, ^O to write out, ^X to exit — then the shell resumes", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
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
    os.input("nano /note.txt\r");
    await waitFor("nano"); // the title bar — nano is up and in raw mode
    os.input("hello raw world"); // per-keystroke raw input
    await sleep(150);
    os.input("\x0f"); // ^O: Write Out (default filename = /note.txt)
    await waitFor("File Name to Write");
    os.input("\r"); // accept the name → save
    await waitFor("Wrote 1 line");
    os.input("\x18"); // ^X: not dirty now → exit immediately
    // Back at the shell: cooked discipline must be restored, so a normal command runs.
    await sleep(150);
    os.input("echo shell-is-back\r");
    await waitFor("shell-is-back");

    const saved = new TextDecoder().decode(await os.fs.read("/note.txt"));
    return { saved, out };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "hello raw world\n", "nano wrote the typed text (with a trailing newline)");
  assert.match(buf.out, /shell-is-back/, "the shell prompt works after nano restores the TTY");
});

test("nano: opens an existing file, edits, and saves the change", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/edit.txt", "one\ntwo\n");
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
    os.input("nano /edit.txt\r");
    await waitFor("Read 2 lines"); // existing content loaded
    os.input("\x05"); // ^E: end of the first line ("one")
    await sleep(80);
    os.input("!"); // -> "one!"
    await sleep(120);
    os.input("\x0f"); // ^O
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 2 lines");
    os.input("\x18"); // ^X
    await sleep(120);

    const saved = new TextDecoder().decode(await os.fs.read("/edit.txt"));
    return { saved };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "one!\ntwo\n", "the edit landed on the first line and the file round-tripped");
});
