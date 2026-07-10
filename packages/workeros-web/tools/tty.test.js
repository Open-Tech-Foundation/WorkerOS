// TTY layer acceptance test (PLAN.md Phase 3 — the terminal binding), driven in
// a real cross-origin-isolated browser via Playwright.
//
// It exercises the kernel-owned line discipline + interactive REPL end to end
// through the public client API (`os.onOutput` / `os.input` / `os.startTerminal`)
// — no xterm.js needed here: the emulator is a website concern, whereas the
// terminal *semantics* (echo, editing, control-key handling, blocking reads)
// belong to the kernel and are what this test pins down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

// Boot a fresh instance, wire a terminal, and run `fn(page)` against it. Each
// test drives everything inside a single `page.evaluate` and returns the
// accumulated terminal output (a decoded string of every `TERM_OUTPUT` byte).
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

// Runs in the browser: boot, start the terminal, capture output, and expose a
// `type`/`waitFor` pair to the test body via the returned closure source. We
// inline it per-test to keep each case a single serializable function.
const opts = { skip: chromium ? false : "playwright not installed" };

test("cooked prompt: echoes typed input and runs a pipeline", opts, async () => {
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
    await waitFor("$"); // the prompt
    os.input("echo hello | cat\r");
    await waitFor("hello");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /\$ /, "shows a prompt");
  assert.match(buf, /echo hello \| cat/, "echoes the typed command line");
  assert.match(buf, /hello/, "runs the pipeline and shows its output");
});

test("line editing: Backspace rubs out the last character", opts, async () => {
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
    await waitFor("$");
    // "echX" then DEL (0x7f) then "o edited" → runs `echo edited`.
    os.input("echX");
    os.input(String.fromCharCode(0x7f));
    os.input("o edited\r");
    await waitFor("edited");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  // The rubout is echoed as backspace-space-backspace (the raw stream still
  // contains the typed "X" — that is what a real terminal emits — but it is
  // immediately erased)…
  assert.ok(buf.includes("\b \b"), "Backspace echoes a rub-out (\\b \\b)");
  // …and, crucially, the command that ran was `echo edited`, not a corrupted
  // `echXo`: the output is clean and there is no command-not-found.
  assert.match(buf, /edited/);
  assert.doesNotMatch(buf, /echXo|not found|NotFound/, "the edited-out char never reached argv");
});

test("control bytes and arrow keys never leak into argv", opts, async () => {
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
    await waitFor("$");
    // A stray ^V (0x16) mid-word and an Up-arrow (ESC [ A) must be dropped.
    os.input("e");
    os.input(String.fromCharCode(0x16));
    os.input("ch");
    os.input("\x1b[A");
    os.input("o clean\r");
    await waitFor("clean");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /clean/);
  assert.doesNotMatch(buf, /NotFound/, "no corrupted argv[0] (regression: \\u0016echo)");
  assert.doesNotMatch(buf, /\[A/, "the arrow-key escape was swallowed, not inserted");
});

test("Ctrl-C cancels the current line without running it", opts, async () => {
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
    await waitFor("$");
    os.input("nonexistent-cmd-xyz");
    os.input(String.fromCharCode(0x03)); // ^C
    os.input("echo afterctrlc\r");
    await waitFor("afterctrlc");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /\^C/, "the interrupt is echoed");
  assert.match(buf, /afterctrlc/, "a fresh command runs after the cancel");
  assert.doesNotMatch(buf, /nonexistent-cmd-xyz: /, "the cancelled line was never executed");
});

test("node sees process.stdout.isTTY on a terminal, false when redirected", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    const run = async (line) => {
      let out = "";
      await os.exec(line, { onStdout: (b) => (out += dec.decode(b)), onStderr: (b) => (out += dec.decode(b)) });
      return out;
    };
    await os.fs.write(
      "/tty.js",
      'process.stdout.write(process.stdout.isTTY + " " + process.stdout.columns + "x" + process.stdout.rows);',
    );
    const term = await run("node /tty.js");
    // A redirect binds fd 1 to a file, so isatty(1) is false there.
    await run("node /tty.js > /out.txt");
    const redirected = new TextDecoder().decode(await os.fs.read("/out.txt"));
    return { term, redirected };
  });
  assert.deepEqual(pageErrors, []);
  // Directly on the terminal: a TTY, with the kernel's window size (default 80x24).
  assert.match(buf.term, /^true 80x24/, `expected TTY on terminal, got ${JSON.stringify(buf.term)}`);
  // Redirected to a file, stdout is not a terminal and has no columns.
  assert.match(buf.redirected, /^false /, `expected non-TTY when redirected, got ${JSON.stringify(buf.redirected)}`);
});

test("echo -e emits real ANSI escapes to the terminal stream", opts, async () => {
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
    await waitFor("$");
    os.input('echo -e "\\e[31mRED\\e[0m"\r');
    await waitFor("RED");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  // The program's output line must contain a real ESC (0x1b) + SGR, not literal
  // backslash-e. (The command-echo line still shows the literal text the user typed.)
  assert.ok(buf.includes("\x1b[31mRED\x1b[0m"), "output carries a real ANSI SGR sequence");
});
