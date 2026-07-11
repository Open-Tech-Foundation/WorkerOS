// Unit tests for readline.emitKeypressEvents — the raw-byte → `keypress` decoder
// that lets arrow-key prompt libraries drive `process.stdin` in raw mode. Pure
// over a fake stream (feed 'data', collect emitted keypress events).

import { test } from "node:test";
import assert from "node:assert/strict";
import { emitKeypressEvents } from "../src/node/readline.js";

function fakeStream() {
  const ls = {};
  return {
    on(ev, fn) { (ls[ev] ||= []).push(fn); return this; },
    emit(ev, ...a) { (ls[ev] || []).forEach((f) => f(...a)); return true; },
    resume() {},
  };
}

// Feed `input` to a keypress-decoded stream, return the collected events.
function decode(...chunks) {
  const s = fakeStream();
  const events = [];
  emitKeypressEvents(s);
  s.on("keypress", (str, key) => events.push({ str, key }));
  for (const c of chunks) s.emit("data", c);
  return events;
}

test("printable characters, shift, and space", () => {
  assert.deepEqual(decode("a"), [{ str: "a", key: { sequence: "a", name: "a", ctrl: false, meta: false, shift: false } }]);
  assert.deepEqual(decode("A")[0].key, { sequence: "A", name: "a", ctrl: false, meta: false, shift: true });
  const sp = decode(" ")[0];
  assert.equal(sp.str, " ");
  assert.equal(sp.key.name, "space");
});

test("Enter, Tab, Backspace", () => {
  assert.equal(decode("\r")[0].key.name, "return");
  assert.equal(decode("\n")[0].key.name, "enter");
  assert.equal(decode("\t")[0].key.name, "tab");
  assert.equal(decode("\x7f")[0].key.name, "backspace");
  assert.equal(decode("\r")[0].str, undefined, "control keys carry no printable str");
});

test("Ctrl-<letter>", () => {
  const c = decode("\x03")[0].key; // Ctrl-C
  assert.equal(c.name, "c");
  assert.equal(c.ctrl, true);
});

test("arrow keys (CSI and SS3)", () => {
  assert.equal(decode("\x1b[A")[0].key.name, "up");
  assert.equal(decode("\x1b[B")[0].key.name, "down");
  assert.equal(decode("\x1b[C")[0].key.name, "right");
  assert.equal(decode("\x1b[D")[0].key.name, "left");
  assert.equal(decode("\x1bOA")[0].key.name, "up", "SS3 application-cursor form");
});

test("navigation + editing keys via tilde form", () => {
  assert.equal(decode("\x1b[3~")[0].key.name, "delete");
  assert.equal(decode("\x1b[2~")[0].key.name, "insert");
  assert.equal(decode("\x1b[5~")[0].key.name, "pageup");
  assert.equal(decode("\x1b[H")[0].key.name, "home");
  assert.equal(decode("\x1b[1~")[0].key.name, "home");
});

test("xterm modifiers and shift-tab", () => {
  const ctrlUp = decode("\x1b[1;5A")[0].key; // Ctrl-Up
  assert.equal(ctrlUp.name, "up");
  assert.equal(ctrlUp.ctrl, true);
  const shiftTab = decode("\x1b[Z")[0].key;
  assert.equal(shiftTab.name, "tab");
  assert.equal(shiftTab.shift, true);
});

test("Alt/meta + character", () => {
  const alt = decode("\x1ba")[0].key; // Alt-a
  assert.equal(alt.name, "a");
  assert.equal(alt.meta, true);
});

test("a sequence split across two data chunks decodes as one key", () => {
  const events = decode("\x1b[", "B"); // ESC[ then B → one Down
  assert.equal(events.length, 1);
  assert.equal(events[0].key.name, "down");
});

test("multiple keys in one chunk decode in order", () => {
  const names = decode("ab\x1b[Ac").map((e) => e.key.name);
  assert.deepEqual(names, ["a", "b", "up", "c"]);
});

test("lone Escape flushes as the escape key", async () => {
  const s = fakeStream();
  const events = [];
  emitKeypressEvents(s);
  s.on("keypress", (str, key) => events.push(key));
  s.emit("data", "\x1b");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "escape");
});
