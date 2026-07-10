// Unit tests for nano's pure text/width helpers (no terminal, no `sys`).
//
// nano-program.js is a guest script, but it guards `main()` behind a `sys`
// check and exports its pure helpers, so we can import and test the tricky
// bits in plain Node: display width (wide glyphs, tabs), surrogate-pair-safe
// lengths, cursor→render-column mapping, and the horizontal visible slice.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWide,
  charWidth,
  nextLen,
  prevLen,
  cxToRx,
  visibleSlice,
} from "../src/nano/nano-program.js";

const cp = (s) => s.codePointAt(0);

test("isWide / charWidth: ASCII is 1 column, CJK and emoji are 2", () => {
  assert.equal(charWidth(cp("a")), 1);
  assert.equal(charWidth(cp(" ")), 1);
  assert.equal(charWidth(cp("日")), 2); // CJK unified
  assert.equal(charWidth(cp("한")), 2); // Hangul syllable
  assert.equal(charWidth(cp("Ａ")), 2); // fullwidth Latin
  assert.equal(charWidth(cp("😀")), 2); // emoji (astral)
  assert.equal(isWide(cp("x")), false);
});

test("nextLen / prevLen keep surrogate pairs whole", () => {
  const line = "a😀b"; // "😀" is one astral code point = 2 UTF-16 units (idx 1,2)
  assert.equal(nextLen(line, 0), 1); // 'a'
  assert.equal(nextLen(line, 1), 2); // '😀' — do not split
  assert.equal(nextLen(line, 3), 1); // 'b'
  assert.equal(prevLen(line, 1), 1); // before 'a' boundary → 'a'
  assert.equal(prevLen(line, 3), 2); // char ending at idx 3 is '😀'
  assert.equal(prevLen(line, 4), 1); // 'b'
});

test("cxToRx maps code-unit columns to render columns (tabs + wide)", () => {
  assert.equal(cxToRx("abc", 2), 2);
  assert.equal(cxToRx("\tab", 1), 8); // a tab jumps to the next 8-stop
  assert.equal(cxToRx("\tab", 2), 9); // then 'a'
  assert.equal(cxToRx("日x", 1), 2); // one wide glyph = 2 columns
  assert.equal(cxToRx("日x", 2), 3); // + 'x'
  assert.equal(cxToRx("a😀b", 3), 3); // 'a'(1) + '😀'(2), cursor after the pair
});

test("visibleSlice: plain, tab expansion, and wide-glyph clipping", () => {
  assert.equal(visibleSlice("hello", 0, 3), "hel");
  assert.equal(visibleSlice("hello", 2, 3), "llo");
  assert.equal(visibleSlice("\tab", 0, 10), "        ab"); // 8 spaces + ab
  assert.equal(visibleSlice("日本", 0, 4), "日本"); // both fully visible
  // A wide glyph clipped on the right renders as a space for its shown half.
  assert.equal(visibleSlice("日本", 0, 3), "日 ");
  // Clipped on both edges → the middle window shows only spaces.
  assert.equal(visibleSlice("日本", 1, 2), "  ");
});
