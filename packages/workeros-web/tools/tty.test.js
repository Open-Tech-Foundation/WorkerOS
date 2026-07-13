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

test("kernel cooked discipline: Backspace editing when a program reads stdin", opts, async () => {
  // The prompt uses raw-mode readline, but a program that reads stdin gets the
  // kernel's cooked line discipline — including the \b \b rub-out echo. Exercise
  // it through `cat`, which reads a line and writes it back.
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
    os.input("cat\r"); // cat now reads stdin under the cooked discipline
    await new Promise((r) => setTimeout(r, 250));
    os.input("heX");
    os.input(String.fromCharCode(0x7f)); // Backspace erases the X
    os.input("llo\r"); // commits "hello\n"; cat echoes it back
    await waitFor("hello");
    os.input(String.fromCharCode(0x04)); // Ctrl-D ends cat
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(buf.includes("\b \b"), "kernel cooked mode echoes a rub-out (\\b \\b)");
  assert.match(buf, /hello/, "cat received the edited line");
  assert.doesNotMatch(buf, /heXllo/, "the deleted char never reached the program");
});

test("prompt readline: history recall + in-line editing", opts, async () => {
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
    os.input("echo first\r");
    await waitFor("first");
    // Up-arrow recalls "echo first"; Backspace ×5 removes "first"; type "second".
    os.input("\x1b[A");
    for (let i = 0; i < 5; i++) os.input(String.fromCharCode(0x7f));
    os.input("second\r");
    await waitFor("second");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /second/, "recalled + edited command ran");
  // The edited command was `echo second`, not `echo firstsecond`.
  assert.doesNotMatch(buf, /firstsecond/, "history line was edited before running");
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

test("Ctrl-C is delivered to a node SIGINT handler (cooperative, not a kill)", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    // A program that catches SIGINT, prints, and exits 0 (not the 130 a kill gives).
    await os.fs.write(
      "/sigint.js",
      [
        "let done; const p = new Promise((r) => (done = r));",
        "process.on('SIGINT', () => { process.stdout.write('caught SIGINT\\n'); done(); });",
        "process.stdout.write('ready\\n');",
        "await p;",
        "process.stdout.write('clean-exit\\n');",
      ].join("\n"),
    );
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
    os.input("node /sigint.js\r");
    await waitFor("ready"); // program is running and has installed its handler
    os.input(String.fromCharCode(0x03)); // ^C
    await waitFor("clean-exit");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /caught SIGINT/, "the handler ran");
  assert.match(buf, /clean-exit/, "the process finished on its own terms");
  assert.doesNotMatch(buf, /\[exit 130\]/, "it was not hard-killed");
});

test("SIGWINCH reaches a node handler and refreshes stdout.columns", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write(
      "/winch.js",
      [
        "let done; const p = new Promise((r) => (done = r));",
        "process.stdout.write('cols=' + process.stdout.columns + '\\n');",
        "process.on('SIGWINCH', () => { process.stdout.write('resized=' + process.stdout.columns + '\\n'); done(); });",
        "await p;",
      ].join("\n"),
    );
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
    os.input("node /winch.js\r");
    await waitFor("cols=80");
    os.resize(30, 120); // rows, cols
    await waitFor("resized=120");
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /cols=80/, "initial columns from the default winsize");
  assert.match(buf, /resized=120/, "handler saw the new columns after resize");
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

test("child_process spawn stdio:'inherit' shares the terminal both ways", opts, async () => {
  // npm's `foregroundChild` path (how `npm create vite` runs the scaffolder):
  // a child spawned with stdio:'inherit' must write its prompt straight to the
  // display and read the user's keystrokes from the controlling terminal — not
  // through the parent's captured pipe (which would swallow the prompt and hand
  // the child an instant-EOF stdin). This drives that end to end.
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    // The child: print a prompt, then block-read one line of stdin and echo it.
    await os.fs.write(
      "/child.js",
      [
        "import { readSync } from 'node:fs';",
        "process.stdout.write('CHILD-PROMPT>');",
        "const b = Buffer.alloc(1024);",
        "const n = readSync(0, b, 0, 1024);",
        "process.stdout.write('CHILD-GOT[' + b.slice(0, n).toString().trim() + ']\\n');",
      ].join("\n"),
    );
    // The parent: spawn the child sharing this terminal, and wait for it.
    await os.fs.write(
      "/driver.js",
      [
        "import { spawn } from 'node:child_process';",
        "const c = spawn('node', ['/child.js'], { stdio: 'inherit' });",
        "await new Promise((r) => c.on('close', r));",
        "process.stdout.write('DRIVER-DONE\\n');",
      ].join("\n"),
    );
    os.startTerminal();
    const waitFor = async (s, ms = 12000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out));
    };
    await waitFor("$");
    os.input("node /driver.js\r");
    await waitFor("CHILD-PROMPT>"); // the child's output reached the display (inherit stdout)
    os.input("hello\r");
    await waitFor("CHILD-GOT[hello]"); // the child read the typed line (inherit stdin)
    await waitFor("DRIVER-DONE"); // parent saw the child close
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.match(buf, /CHILD-PROMPT>/, "the inherited-stdout child prompt reached the terminal");
  assert.match(buf, /CHILD-GOT\[hello\]/, "the inherited-stdin child read the terminal line");
  assert.match(buf, /DRIVER-DONE/, "the parent observed the child's exit");
});
