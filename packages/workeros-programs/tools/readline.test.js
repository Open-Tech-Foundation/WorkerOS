import test from "node:test";
import assert from "node:assert/strict";
import { readline } from "../src/node/readline.js";
import { EventEmitter } from "../src/node/events.js";
import { createNodeRuntime } from "../src/node/require-runtime.js";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

function fakeSys(stdinText = "") {
  const syncFs = createFakeSyncFs();
  let stdin = new TextEncoder().encode(stdinText);
  let stdinDone = false;
  return {
    syncFs,
    open: async (p, o = {}) => syncFs.open(p, o),
    read: async (fd, max) => {
      if (fd === 0) {
        if (stdinDone) return new Uint8Array(0);
        stdinDone = true;
        return stdin.subarray(0, max);
      }
      return syncFs.read(fd, max);
    },
    close: async (fd) => syncFs.close(fd),
    stat: async (p) => syncFs.stat(p),
  };
}

test("createInterface question reads one line from a data-emitting input stream", async () => {
  const input = new EventEmitter();
  input.resume = () => {};
  const writes = [];
  const output = { write(chunk) { writes.push(String(chunk)); return true; } };
  const rl = readline.createInterface({ input, output, terminal: false });
  const asked = rl.question("name? ");
  input.emit("data", new TextEncoder().encode("workeros\n"));
  assert.equal(await asked, "workeros");
  assert.equal(writes.join(""), "name? ");
});

function mockTty() {
  const em = new EventEmitter();
  em.isTTY = true;
  em.resume = () => {};
  em.pause = () => {};
  em.setRawMode = () => {};
  return em;
}

test("terminal Interface maintains line/cursor from keypresses and emits 'line' on Enter", () => {
  // What @clack/prompts, inquirer, and prompts read back to build the prompt.
  const input = mockTty();
  const rl = readline.createInterface({ input, terminal: true });
  const type = (ch) => input.emit("keypress", ch, { name: /^[a-z]$/.test(ch) ? ch : undefined, sequence: ch });
  for (const ch of "abc") type(ch);
  assert.equal(rl.line, "abc");
  assert.equal(rl.cursor, 3);
  input.emit("keypress", "\x7f", { name: "backspace" });
  assert.equal(rl.line, "ab");
  input.emit("keypress", "", { name: "left" });
  assert.equal(rl.cursor, 1);
  let submitted;
  rl.on("line", (l) => (submitted = l));
  input.emit("keypress", "\r", { name: "return" });
  assert.equal(submitted, "ab");
  assert.equal(rl.line, "");
});

test("getCursorPos/getPrompt report the caret position (Inquirer's ScreenManager)", () => {
  // create-hono's prompts construct `new ScreenManager(rl)`, which calls
  // rl.getCursorPos() on every render — a missing method threw "not a function".
  const input = mockTty();
  const rl = readline.createInterface({ input, terminal: true, prompt: "? name " });
  assert.equal(rl.getPrompt(), "? name ");
  rl.write("abc");
  // prompt is 7 cols + 3 typed = column 10, still row 0 on an 80-col line
  assert.deepEqual(rl.getCursorPos(), { cols: 10, rows: 0 });
  input.emit("keypress", "", { name: "left" }); // caret back one → column 9
  assert.deepEqual(rl.getCursorPos(), { cols: 9, rows: 0 });
});

test("getCursorPos wraps to a new row past the terminal width", () => {
  const input = mockTty();
  const output = { columns: 10, isTTY: true, write() {} };
  const rl = readline.createInterface({ input, output, terminal: true, prompt: "" });
  rl.write("0123456789abc"); // 13 cols on a 10-col terminal → row 1, col 3
  assert.deepEqual(rl.getCursorPos(), { cols: 3, rows: 1 });
});

test("rl.write drives the editor: insert text, Ctrl-H backspace, Ctrl-U kill line", () => {
  const input = mockTty();
  const rl = readline.createInterface({ input, terminal: true });
  rl.write("hello");
  assert.equal(rl.line, "hello");
  rl.write(null, { ctrl: true, name: "h" });
  assert.equal(rl.line, "hell");
  rl.write(null, { ctrl: true, name: "u" });
  assert.equal(rl.line, "");
  rl.write("hi");
  assert.equal(rl.line, "hi");
});

test("terminal Interface detaches and pauses input on close (so the process can exit)", () => {
  const input = mockTty();
  let paused = false;
  input.pause = () => { paused = true; };
  const rl = readline.createInterface({ input, terminal: true });
  rl.write("x");
  rl.close();
  assert.equal(paused, true);
  input.emit("keypress", "y", { name: "y", sequence: "y" });
  assert.equal(rl.line, "x", "keypresses after close are ignored");
});

test("cursor helpers delegate to the output stream methods", () => {
  const calls = [];
  const out = {
    cursorTo: (...args) => calls.push(["cursorTo", ...args]),
    moveCursor: (...args) => calls.push(["moveCursor", ...args]),
    clearLine: (...args) => calls.push(["clearLine", ...args]),
    clearScreenDown: (...args) => calls.push(["clearScreenDown", ...args]),
  };
  readline.cursorTo(out, 2, 3);
  readline.moveCursor(out, 1, -1);
  readline.clearLine(out, 0);
  readline.clearScreenDown(out);
  assert.deepEqual(calls, [
    ["cursorTo", 2, 3, undefined],
    ["moveCursor", 1, -1, undefined],
    ["clearLine", 0, undefined],
    ["clearScreenDown", undefined],
  ]);
});

test("promises facade exposes createInterface", () => {
  assert.equal(readline.promises.createInterface, readline.createInterface);
  assert.equal(readline.promises.Interface, readline.Interface);
});

test("guest require resolves readline and question reads cooked stdin", async () => {
  const sys = fakeSys("hello from stdin\n");
  const main = [
    "const readline = require('readline');",
    "const fs = require('fs');",
    "(async () => {",
    "  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "  const line = await rl.question('prompt> ');",
    "  rl.close();",
    "  fs.writeFileSync('/readline-ok', line);",
    "})();",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(createFs(sys.syncFs).readFileSync("/readline-ok", "utf8"), "hello from stdin");
});
