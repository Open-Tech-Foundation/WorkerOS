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

test("nano: M-U undoes a typing run and M-E redoes it", opts, async () => {
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
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /u.txt\r");
    await waitFor("nano");
    os.input("hello world"); // one coalesced typing run
    await sleep(150);
    os.input("\x1bu"); // M-U (ESC u): undo → empties the buffer
    await waitFor("Undid change");
    os.input("\x1be"); // M-E (ESC e): redo → restores "hello world"
    await waitFor("Redid change");
    os.input("\x0f"); // ^O write out
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 1 line");
    os.input("\x18"); // ^X
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/u.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "hello world\n", "redo restored the text the undo removed");
});

test("nano: ^\\ search & replace, replacing all instances", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/r.txt", "foo foo foo\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /r.txt\r");
    await waitFor("Read 1 line");
    os.input("\x1c"); // ^\ : Replace
    await waitFor("Search (to replace)");
    os.input("foo\r");
    await waitFor("Replace with");
    os.input("bar\r");
    await waitFor("Replace this instance?");
    os.input("a"); // All
    await waitFor("Replaced 3 instances");
    os.input("\x0f"); // ^O
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 1 line");
    os.input("\x18");
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/r.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "bar bar bar\n", "every instance was replaced");
});

test("nano: wide glyphs and emoji round-trip; Backspace deletes whole code points", opts, async () => {
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
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /w.txt\r");
    await waitFor("nano");
    os.input("日本😀"); // two CJK (wide) + one astral emoji (surrogate pair)
    await sleep(150);
    os.input("\x7f"); // Backspace: must remove the whole emoji (2 UTF-16 units)
    await sleep(120);
    os.input("\x0f");
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 1 line");
    os.input("\x18");
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/w.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  // The emoji was deleted cleanly (no lone surrogate corrupting the UTF-8).
  assert.equal(buf.saved, "日本\n", "wide text round-trips and Backspace removes a full code point");
});

test("nano: a mouse click positions the cursor", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/m.txt", "0123456789\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /m.txt\r");
    await waitFor("Read 1 line");
    os.input("\x1bn"); // M-N: turn the line-number gutter off so column math is 1:1
    await waitFor("Line numbers off");
    // SGR mouse: left-press at column 5, row 2 (the first text row) → index 4.
    os.input("\x1b[<0;5;2M\x1b[<0;5;2m");
    await sleep(120);
    os.input("X"); // insert at the clicked position
    await sleep(120);
    os.input("\x0f"); // ^O
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 1 line");
    os.input("\x18");
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/m.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "0123X456789\n", "the click landed the cursor between '3' and '4'");
});

test("nano: click-drag selects a range the ^K cut removes", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/m.txt", "0123456789\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /m.txt\r");
    await waitFor("Read 1 line");
    os.input("\x1bn"); // M-N: gutter off so column math is 1:1
    await waitFor("Line numbers off");
    // Press at col 2 (index 1), drag (motion, button+32) to col 6 (index 5), release.
    os.input("\x1b[<0;2;2M\x1b[<32;6;2M\x1b[<0;6;2m");
    await sleep(120);
    os.input("\x0b"); // ^K: cut the drag-selected range "1234"
    await sleep(120);
    os.input("\x0f"); // ^O
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 1 line");
    os.input("\x18");
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/m.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "056789\n", "the drag selected '1234' and ^K cut it");
});

test("nano: double-click selects the word under the cursor", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/m.txt", "hello world foo\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /m.txt\r");
    await waitFor("Read 1 line");
    os.input("\x1bn"); // M-N: gutter off so column math is 1:1
    await waitFor("Line numbers off");
    // Two quick presses on col 9 (index 8, inside "world") → double-click selects the word.
    os.input("\x1b[<0;9;2M\x1b[<0;9;2m\x1b[<0;9;2M\x1b[<0;9;2m");
    await sleep(120);
    os.input("\x0b"); // ^K: cut the selected word
    await sleep(120);
    os.input("\x0f"); // ^O
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 1 line");
    os.input("\x18");
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/m.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "hello  foo\n", "double-click selected 'world' and ^K cut it");
});

test("nano: line-number gutter renders in 24-bit color", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/g.txt", "alpha\nbeta\ngamma\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /g.txt\r");
    await waitFor("Read 3 lines");
    await sleep(150);
    return { out };
  });
  assert.deepEqual(pageErrors, []);
  // The gutter emits true-color SGR: the accent for the current line, dim for others.
  assert.match(buf.out, /38;2;255;150;80/, "current-line number uses a 24-bit accent color");
  assert.match(buf.out, /38;2;105;112;128/, "other line numbers use a 24-bit dim color");
});

test("nano: a CRLF (DOS) file round-trips and doesn't corrupt the display", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/dos.txt", "one\r\ntwo\r\n"); // DOS line endings
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(s)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-400)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /dos.txt\r");
    await waitFor("Read 2 lines [DOS]"); // the DOS format was detected
    os.input("\x05"); // ^E end of line 1 ("one") — the stray CR was stripped
    await sleep(80);
    os.input("!");
    await sleep(120);
    os.input("\x0f");
    await waitFor("File Name to Write");
    os.input("\r");
    await waitFor("Wrote 2 lines");
    os.input("\x18");
    await sleep(120);
    return { saved: new TextDecoder().decode(await os.fs.read("/dos.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "one!\r\ntwo\r\n", "CRLF endings are preserved and the edit landed at real EOL");
});

// Shared boilerplate can't be a closure (page.evaluate serializes the fn), so
// each case inlines boot + waitFor. These cover the Commit-2 editing features.

test("nano: mark (^6) + copy (M-6) + paste (^U) duplicates a selection", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /sel.txt\r");
    await waitFor("nano");
    os.input("hello world");
    await sleep(100);
    os.input("\x01");   // ^A home → set mark here
    os.input("\x1e");   // ^6 set mark
    os.input("\x05");   // ^E end → selection = whole line
    os.input("\x1b6");  // M-6 copy
    await sleep(80);
    os.input("\r");     // newline → cursor on the new empty line 2
    os.input("\x15");   // ^U paste the copied text there
    await sleep(120);
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/sel.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "hello world\nhello world\n", "the copied selection was pasted on the new line");
});

test("nano: ^P fuzzy file finder opens the picked file into the buffer", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    // A few files in the cwd tree for the finder to discover.
    await os.fs.write("/proj/alpha.txt", "ALPHA CONTENTS\n");
    await os.fs.write("/proj/sub/beta.js", "const beta = 1;\n");
    await os.fs.write("/proj/readme.md", "# readme\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("cd /proj\r");
    await sleep(120);
    os.input("nano alpha.txt\r"); // start on alpha.txt
    await waitFor("ALPHA CONTENTS");
    os.input("\x10"); // ^P open the finder
    await waitFor("Open File");
    os.input("beta"); // fuzzy → proj/sub/beta.js
    await sleep(150);
    const listedBeta = out.includes("beta.js");
    os.input("\r"); // open it
    await waitFor("beta = "); // beta.js content now in the buffer (plain span, survives highlighting)
    await sleep(80);
    const openedBeta = out.includes("beta = ");
    os.input("\x18"); await sleep(100); // clean buffer → exits
    return { listedBeta, openedBeta };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.listedBeta, true, "the finder listed the fuzzy-matched file");
  assert.equal(buf.openedBeta, true, "picking it loaded that file into the buffer");
});

test("nano: status bar shows Ln/Col, language, and EOL segments", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/sb.js", "let a = 1;\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /sb.js\r");
    await waitFor("nano");
    await sleep(120);
    const atOpen = { pos: out.includes("Ln 1, Col 1"), lang: out.includes("JavaScript"), eol: out.includes("LF") };
    out = "";
    os.input("xy"); // move the cursor to column 3
    await sleep(120);
    const afterType = out.includes("Ln 1, Col 3");
    os.input("\x18"); // ^X — buffer is dirty; answer No to discard
    await sleep(80);
    os.input("n");
    await sleep(80);
    return { atOpen, afterType };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.atOpen.pos, true, "status bar shows Ln 1, Col 1 at open");
  assert.equal(buf.atOpen.lang, true, "status bar shows the detected language (JavaScript)");
  assert.equal(buf.atOpen.eol, true, "status bar shows the EOL (LF)");
  assert.equal(buf.afterType, true, "the Col segment tracks the cursor");
});

test("nano: ^G opens a shortcuts dialog; any key dismisses it", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /d.txt\r");
    await waitFor("nano");
    os.input("\x07"); // ^G
    await waitFor("Shortcuts");
    const box = out.includes("┌") && out.includes("Write Out") && out.includes("Command Palette");
    out = "";
    os.input(" "); // any key dismisses
    await sleep(120);
    const dismissed = !out.includes("Shortcuts");
    os.input("\x18"); await sleep(100); // clean buffer, exits
    return { box, dismissed };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.box, true, "the dialog renders a box with shortcut labels");
  assert.equal(buf.dismissed, true, "a keypress closes the dialog and the editor repaints");
});

test("nano: M-p command palette filters and runs a command", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /p.txt\r");
    await waitFor("nano");
    os.input("\x1bp"); // M-p
    await waitFor("Command Palette");
    os.input("soft"); // fuzzy-filters to "Toggle Soft Wrap"
    await sleep(120);
    os.input("\r"); // run it
    await waitFor("Soft wrap on");
    os.input("\x18"); await sleep(100);
    return { ok: true };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.ok, true);
});

test("nano: Tab inserts spaces by default (VSCode-style) and shows the indicator", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /indent.txt\r");
    await waitFor("nano");
    const hadIndicator = out.includes("Spaces: 4"); // default indicator on the message bar
    os.input("\tx");    // Tab then 'x' — Tab should become 4 spaces, not a \t
    await sleep(100);
    os.input("\x7f");   // Backspace over 'x'
    os.input("\x7f");   // Backspace at the soft-tab → removes all 4 spaces at once
    await sleep(100);
    os.input("done");   // prove the line is back at column 0
    await sleep(80);
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/indent.txt")), hadIndicator };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.hadIndicator, true, "the message bar shows the VSCode-style 'Spaces: 4' indicator");
  // Tab→4 spaces, Backspace removes 'x', a second Backspace clears the whole 4-space
  // soft-tab, leaving column 0 for "done".
  assert.equal(buf.saved, "done\n");
});

test("nano: syntax highlighting colors a .js file (and M-y toggles it off)", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    // A .js file so the extension selects the JS ruleset.
    await os.fs.write("/hi.js", 'const greeting = "hello";\n');
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /hi.js\r");
    await waitFor("greeting");
    await sleep(120);
    // The keyword color (256-color SGR 111 = blue) should be emitted for `const`.
    const litOn = out.includes("\x1b[38;5;111m");
    out = "";
    os.input("\x1by"); // M-y toggles highlighting off
    await waitFor("Syntax highlighting off");
    await sleep(120);
    const litOff = out.includes("\x1b[38;5;111m");
    os.input("\x18"); await sleep(100); // ^X (clean buffer, no prompt)
    return { litOn, litOff };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.litOn, true, "keyword color SGR was emitted while highlighting is on");
  assert.equal(buf.litOff, false, "no syntax color is emitted after M-y turns it off");
});

test("nano: copy (M-6) mirrors the selection to the OS clipboard via OSC 52", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /clip.txt\r");
    await waitFor("nano");
    os.input("hello world");
    await sleep(100);
    out = ""; // discard the render up to here; capture only what the copy emits
    os.input("\x01");   // ^A home → set mark here
    os.input("\x1e");   // ^6 set mark
    os.input("\x05");   // ^E end → selection = whole line
    os.input("\x1b6");  // M-6 copy
    await sleep(120);
    // Grab the OSC 52 payload: ESC ] 52 ; c ; <base64> ST(ESC \).
    const m = out.match(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x1b\\/);
    os.input("\x18"); await sleep(100); // ^X exit (buffer is clean — no prompt)
    return { b64: m ? m[1] : null };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.b64, Buffer.from("hello world", "utf8").toString("base64"),
    "the copied text was emitted as a base64 OSC 52 clipboard write");
});

test("nano: bracketed paste keeps indentation literal (no auto-indent staircase)", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /paste.js\r");
    await waitFor("nano");
    // Already-indented code, delivered as a bracketed-paste block (ESC[200~ … ESC[201~).
    // Without bracketed paste each newline would auto-indent, stair-stepping the body.
    const code = "function f() {\n  if (x) {\n    return 1;\n  }\n}";
    os.input("\x1b[200~" + code + "\x1b[201~");
    await sleep(150);
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/paste.js")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(
    buf.saved,
    "function f() {\n  if (x) {\n    return 1;\n  }\n}\n",
    "the pasted block kept its original indentation",
  );
});

test("nano: M-Backspace deletes the word before the cursor", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /wd.txt\r");
    await waitFor("nano");
    os.input("foo bar baz");
    await sleep(100);
    os.input("\x1b\x7f"); // M-Backspace (ESC DEL): delete "baz"
    await sleep(120);
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/wd.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "foo bar \n", "the last word was deleted, leaving the trailing space");
});

test("nano: ^R inserts another file at the cursor", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/inc.txt", "INCLUDED\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /main.txt\r");
    await waitFor("nano");
    os.input("start ");
    await sleep(80);
    os.input("\x12"); // ^R insert file
    await waitFor("File to insert");
    os.input("inc.txt\r");
    await waitFor("Inserted");
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/main.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "start INCLUDED\n", "the file contents were inserted at the cursor");
});

test("nano: Enter auto-indents to match the current line", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /ai.txt\r");
    await waitFor("nano");
    os.input("  foo"); // two leading spaces
    os.input("\r");    // Enter → new line should inherit "  "
    os.input("bar");
    await sleep(120);
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/ai.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "  foo\n  bar\n", "the new line inherited the leading whitespace");
});

test("nano: in-prompt editing (←) inserts mid-filename for Save-As", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/orig.txt", "data\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /orig.txt\r");
    await waitFor("Read 1 line");
    os.input("\x0f"); // ^O — prompt prefilled with "/orig.txt", cursor at end
    await waitFor("File Name to Write");
    // Move left 4 (past ".txt") and insert "2" → "/orig2.txt".
    os.input("\x1b[D\x1b[D\x1b[D\x1b[D");
    os.input("2");
    os.input("\r");
    await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/orig2.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "data\n", "the mid-prompt insert produced /orig2.txt");
});

test("nano: Tab completes a filename in the write-out prompt", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/complete-me.txt", "old\n"); // the completion target
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano\r"); // no filename → a New Buffer, so ^O starts with an empty field
    await waitFor("New Buffer");
    os.input("x");
    await sleep(80);
    os.input("\x0f"); // ^O
    await waitFor("File Name to Write");
    os.input("/complete"); // type a prefix, then Tab-complete

    os.input("\t"); // Tab → completes to /complete-me.txt
    await sleep(120);
    os.input("\r");
    await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/complete-me.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "x\n", "Tab completed the name and the buffer saved over it");
});

test("nano: regex replace-all (M-R) replaces every match", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/rx.txt", "a1b2c3\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /rx.txt\r");
    await waitFor("Read 1 line");
    os.input("\x1c"); // ^\ replace
    await waitFor("Search (to replace)");
    os.input("\x1br"); // M-R: enable regex
    await sleep(60);
    os.input("[0-9]\r"); // the pattern
    await waitFor("Replace with");
    os.input("-\r");
    await waitFor("Replace this instance?");
    os.input("a"); // All
    await waitFor("Replaced 3");
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/rx.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "a-b-c-\n", "every digit was replaced via the regex");
});

test("nano: repeat search (^W then empty) finds the next match", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/rep.txt", "x foo\ny foo\n");
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitFor("$");
    os.input("nano /rep.txt\r");
    await waitFor("Read 2 lines");
    os.input("\x17"); await waitFor("Search"); os.input("foo\r"); // find #1 on line 1
    await waitFor("Found: foo");
    os.input("\x17"); await waitFor("Search [foo]"); os.input("\r"); // empty → repeat
    await sleep(120);
    out = ""; // clear, then ask for the cursor position
    os.input("\x03"); // ^C cursor position
    await waitFor("line 2");
    return { ok: true };
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(buf.ok, "the repeated search advanced to the match on line 2");
});

test("nano: soft-wrap (M-$) — a click on the wrapped row maps to the far column", opts, async () => {
  const { buf, pageErrors } = await withTerminal(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    let out = "";
    os.onOutput((b) => (out += dec.decode(b)));
    await os.fs.write("/wrap.txt", "........................######\n"); // 24 dots + 6 hashes
    os.startTerminal();
    const waitFor = async (s, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (out.includes(s)) return; await new Promise((r) => setTimeout(r, 40)); }
      throw new Error("timeout " + JSON.stringify(s) + " :: " + JSON.stringify(out.slice(-300)));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    os.resize(12, 24); // 24 columns
    await waitFor("$");
    os.input("nano /wrap.txt\r");
    await waitFor("Read 1 line");
    os.input("\x1bn"); // M-N: gutter off → text width is the full 24 columns
    await waitFor("Line numbers off");
    os.input("\x1b$"); // M-$: soft wrap on → line wraps at 24 → row2 shows the "######"
    await waitFor("Soft wrap on");
    // Click screen row 3 (the wrapped continuation), column 1 → render col 24.
    os.input("\x1b[<0;1;3M");
    await sleep(120);
    os.input("X"); // insert at the wrap boundary (between dots and hashes)
    await sleep(120);
    os.input("\x0f"); await waitFor("File Name to Write"); os.input("\r"); await waitFor("Wrote");
    os.input("\x18"); await sleep(100);
    return { saved: new TextDecoder().decode(await os.fs.read("/wrap.txt")) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(buf.saved, "........................X######\n", "the click on the wrapped row landed at column 24");
});
