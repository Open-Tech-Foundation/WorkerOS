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
  rxToCx,
  gutterWidthFor,
  parseMouse,
  dispWidth,
  fitCols,
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

test("rxToCx is the inverse of cxToRx on cell boundaries (for mouse clicks)", () => {
  assert.equal(rxToCx("hello", 3), 3);
  assert.equal(rxToCx("\tab", 8), 1); // render col 8 is just past the tab
  assert.equal(rxToCx("日x", 2), 1); // past the wide glyph
  assert.equal(rxToCx("日x", 1), 0); // clicking the right half lands before it
  for (const line of ["hello", "\tab", "日x", "a😀b"]) {
    for (let cx = 0; cx <= line.length; cx++) {
      // A boundary column round-trips; a mid-surrogate index isn't a boundary.
      if (cx > 0 && cx < line.length) {
        const c = line.charCodeAt(cx);
        if (c >= 0xdc00 && c <= 0xdfff) continue;
      }
      assert.equal(rxToCx(line, cxToRx(line, cx)), cx, `${JSON.stringify(line)} @ ${cx}`);
    }
  }
});

test("gutterWidthFor sizes the line-number column (min 2 digits + separator)", () => {
  assert.equal(gutterWidthFor(1), 3); // "·1 " → 2 digits + space
  assert.equal(gutterWidthFor(9), 3);
  assert.equal(gutterWidthFor(42), 3);
  assert.equal(gutterWidthFor(100), 4);
  assert.equal(gutterWidthFor(1000), 5);
});

test("parseMouse decodes SGR mouse reports and rejects non-mouse CSI", () => {
  assert.deepEqual(parseMouse("<0;12;3", "M"), { b: 0, x: 12, y: 3, press: true });
  assert.deepEqual(parseMouse("<65;1;1", "m"), { b: 65, x: 1, y: 1, press: false });
  assert.equal(parseMouse("3", "~"), null); // an ordinary CSI (Delete)
  assert.equal(parseMouse("<0;12", "M"), null); // malformed (missing y)
});

test("control characters render as inverse caret notation, not raw bytes", () => {
  // A stray CR (from a CRLF line) or ^A must never be emitted raw — it would move
  // the cursor / clear the row. It shows as a 2-column inverse "^M" / "^A".
  assert.equal(visibleSlice("a\rb", 0, 10), "a\x1b[7m^M\x1b[0mb");
  assert.equal(visibleSlice("\x01x", 0, 10), "\x1b[7m^A\x1b[0mx");
  assert.equal(visibleSlice("a\x7fb", 0, 10), "a\x1b[7m^?\x1b[0mb"); // DEL → ^?
  // The caret glyph is two columns, so it clips like a wide glyph.
  assert.equal(visibleSlice("\x01", 1, 5), " "); // right half only
});

test("dispWidth / fitCols measure and pad by display columns (wide + ctrl)", () => {
  assert.equal(dispWidth("abc"), 3);
  assert.equal(dispWidth("日本"), 4); // two wide glyphs
  assert.equal(dispWidth("a\x01"), 3); // ^A counts as two
  assert.equal(fitCols("abc", 5), "abc  "); // pad to 5
  assert.equal(fitCols("日本", 3), "日 "); // truncate: the second wide glyph won't fit
  assert.equal(fitCols("日本", 4), "日本"); // exact fit
});
