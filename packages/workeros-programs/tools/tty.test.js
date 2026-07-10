// Unit tests for the userland `node:tty` module (src/node/tty.js): isatty, the
// WriteStream control methods (exact CSI escapes), color detection, and the
// ReadStream raw-mode wiring. Pure over injected primitives + a tiny emitter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTty, colorDepth } from "../src/node/tty.js";

const dec = new TextDecoder();

// A minimal EventEmitter shim matching what /bin/node injects.
function emitter(obj = {}) {
  const map = new Map();
  const list = (ev) => map.get(ev) || (map.set(ev, []), map.get(ev));
  obj.on = (ev, fn) => (list(ev).push(fn), obj);
  obj.emit = (ev, ...a) => { for (const f of list(ev).slice()) f(...a); return list(ev).length > 0; };
  return obj;
}

function harness({ isTTY = { 0: true, 1: true, 2: true }, env = {}, winsize = { cols: 80, rows: 24 } } = {}) {
  const writes = []; // { fd, text }
  const rawCalls = []; // { fd, on }
  const tty = createTty({
    write: (fd, bytes) => writes.push({ fd, text: dec.decode(bytes) }),
    isattyFor: (fd) => isTTY[fd] ?? false,
    getWinsize: () => winsize,
    getEnv: () => env,
    setRawMode: (fd, on) => rawCalls.push({ fd, on }),
    emitter,
  });
  return { tty, writes, rawCalls, winsize };
}

test("isatty reflects the injected fd truth", () => {
  const { tty } = harness({ isTTY: { 0: true, 1: true, 2: false } });
  assert.equal(tty.isatty(0), true);
  assert.equal(tty.isatty(2), false);
  assert.equal(tty.isatty(7), false); // unknown fd → not a terminal
});

test("WriteStream: isTTY, dimensions, and write", () => {
  const { tty, writes } = harness({ winsize: { cols: 120, rows: 40 } });
  const w = new tty.WriteStream(1);
  assert.equal(w.isTTY, true);
  assert.equal(w.columns, 120);
  assert.equal(w.rows, 40);
  assert.deepEqual(w.getWindowSize(), [120, 40]);
  assert.equal(w.write("hi"), true);
  assert.deepEqual(writes, [{ fd: 1, text: "hi" }]);
});

test("WriteStream: cursor + erase emit Node's exact CSI sequences", () => {
  const { tty, writes } = harness();
  const w = new tty.WriteStream(1);
  w.cursorTo(4);          // column only → CSI 5 G
  w.cursorTo(4, 2);       // row;col     → CSI 3;5 H
  w.moveCursor(3, -2);    // right 3, up 2
  w.moveCursor(-1, 1);    // left 1, down 1
  w.clearLine(-1);        // to line start
  w.clearLine(1);         // to line end
  w.clearLine(0);         // whole line
  w.clearScreenDown();
  assert.deepEqual(writes.map((x) => x.text), [
    "\x1b[5G",
    "\x1b[3;5H",
    "\x1b[3C\x1b[2A",
    "\x1b[1D\x1b[1B",
    "\x1b[1K",
    "\x1b[0K",
    "\x1b[2K",
    "\x1b[0J",
  ]);
});

test("WriteStream color detection reads the live env", () => {
  const env = { COLORTERM: "truecolor" };
  const { tty } = harness({ env });
  const w = new tty.WriteStream(1);
  assert.equal(w.getColorDepth(), 24);
  assert.equal(w.hasColors(), true);
  assert.equal(w.hasColors(1 << 24), true);
  assert.equal(w.hasColors((1 << 24) + 1), false);
  // Explicit env arg overrides the live one.
  assert.equal(w.getColorDepth({ TERM: "dumb" }), 1);
});

test("colorDepth heuristic: FORCE_COLOR / COLORTERM / TERM", () => {
  assert.equal(colorDepth({ FORCE_COLOR: "0" }), 1);
  assert.equal(colorDepth({ FORCE_COLOR: "3" }), 24);
  assert.equal(colorDepth({ COLORTERM: "truecolor" }), 24);
  assert.equal(colorDepth({ TERM: "xterm-256color" }), 8);
  assert.equal(colorDepth({ TERM: "xterm" }), 4);
  assert.equal(colorDepth({ TERM: "dumb" }), 1);
  assert.equal(colorDepth({}), 1); // nothing advertised → monochrome
});

test("ReadStream.setRawMode toggles isRaw and calls the kernel", () => {
  const { tty, rawCalls } = harness();
  const r = new tty.ReadStream(0);
  assert.equal(r.isTTY, true);
  assert.equal(r.isRaw, false);
  assert.equal(r.setRawMode(true), r); // returns this (Node contract)
  assert.equal(r.isRaw, true);
  r.setRawMode(false);
  assert.deepEqual(rawCalls, [{ fd: 0, on: true }, { fd: 0, on: false }]);
});
