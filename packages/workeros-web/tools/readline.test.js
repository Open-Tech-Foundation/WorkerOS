// Unit tests for the raw-mode shell line editor — pure JS, no browser.
//
// The editor is fed raw keystroke bytes and produces terminal output through an
// injected `write`; a line is delivered via `done`. We assert the submitted line
// (the semantic result) and, where it matters, the rendered output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineEditor } from "../src/shell/readline.js";

const enc = (s) => new TextEncoder().encode(s);
const ESC = "\x1b";

// Drive the editor with a script of strings/byte-arrays; return { result, out }.
function run(script, history = []) {
  let out = "";
  let result = null;
  const ed = createLineEditor({
    prompt: "$ ",
    history,
    write: (s) => (out += s),
    done: (r) => (result = r),
  });
  ed.start();
  for (const chunk of script) ed.feed(typeof chunk === "string" ? enc(chunk) : chunk);
  return { result, out };
}

test("types a line and submits it on Enter", () => {
  const { result } = run(["echo hi", "\r"]);
  assert.deepEqual(result, { line: "echo hi" });
});

test("Backspace deletes the character before the cursor", () => {
  const { result } = run(["echX", "\x7f", "o ok", "\r"]);
  assert.deepEqual(result, { line: "echo ok" });
});

test("left-arrow + insert edits mid-line", () => {
  // "abc", Left, Left, insert "X" → "aXbc"
  const { result } = run(["abc", `${ESC}[D`, `${ESC}[D`, "X", "\r"]);
  assert.deepEqual(result, { line: "aXbc" });
});

test("Home/End (Ctrl-A/Ctrl-E) move the cursor to the ends", () => {
  // "bcd", Ctrl-A (home), insert "a" → "abcd"; Ctrl-E (end), insert "e" → "abcde"
  const { result } = run(["bcd", "\x01", "a", "\x05", "e", "\r"]);
  assert.deepEqual(result, { line: "abcde" });
});

test("Delete (ESC [ 3 ~) removes the character at the cursor", () => {
  // "abc", Left, Left → cursor before "b"; Del removes "b" → "ac"
  const { result } = run(["abc", `${ESC}[D`, `${ESC}[D`, `${ESC}[3~`, "\r"]);
  assert.deepEqual(result, { line: "ac" });
});

test("Ctrl-U kills to start, Ctrl-K kills to end", () => {
  assert.deepEqual(run(["throwaway", "\x15", "keep", "\r"]).result, { line: "keep" });
  // "keepDROP", move home, right x4, Ctrl-K → "keep"
  assert.deepEqual(
    run(["keepDROP", "\x01", `${ESC}[C`, `${ESC}[C`, `${ESC}[C`, `${ESC}[C`, "\x0b", "\r"]).result,
    { line: "keep" },
  );
});

test("Ctrl-W kills the previous word", () => {
  assert.deepEqual(run(["foo bar", "\x17", "\r"]).result, { line: "foo " });
});

test("up/down arrows recall history and restore the working line", () => {
  const history = ["first", "second"];
  // Up → "second", Up → "first", Down → "second", submit.
  assert.deepEqual(
    run([`${ESC}[A`, `${ESC}[A`, `${ESC}[B`, "\r"], history).result,
    { line: "second" },
  );
});

test("up-arrow then editing submits the edited recalled line", () => {
  const history = ["deploy"];
  // Up recalls "deploy"; append "-prod".
  assert.deepEqual(run([`${ESC}[A`, "-prod", "\r"], history).result, { line: "deploy-prod" });
});

test("down at the newest entry restores the half-typed line", () => {
  const history = ["old"];
  // Type "new", Up (→ "old"), Down (→ back to "new"), submit.
  assert.deepEqual(run(["new", `${ESC}[A`, `${ESC}[B`, "\r"], history).result, { line: "new" });
});

test("Ctrl-C aborts the line and echoes ^C", () => {
  const { result, out } = run(["half-typed", "\x03"]);
  assert.deepEqual(result, { aborted: true });
  assert.match(out, /\^C/);
});

test("Ctrl-D on an empty line signals EOF; mid-line it forward-deletes", () => {
  assert.deepEqual(run(["\x04"]).result, { eof: true });
  // "ab", Left, Ctrl-D deletes "b" → "a"
  assert.deepEqual(run(["ab", `${ESC}[D`, "\x04", "\r"]).result, { line: "a" });
});

test("unknown escape sequences and stray control bytes are ignored", () => {
  // An unrecognized CSI (ESC [ 5 ~ = PageUp) and a ^V (0x16) must not corrupt.
  const { result } = run(["ab", `${ESC}[5~`, new Uint8Array([0x16]), "c", "\r"]);
  assert.deepEqual(result, { line: "abc" });
});
