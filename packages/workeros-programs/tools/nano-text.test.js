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
  wordLeftIndex,
  wordRightIndex,
  findNext,
  findInLine,
  wrapSegments,
  detectLang,
  tokenizeLine,
  detectIndent,
  rankPaths,
  subseqScore,
} from "../src/nano/nano-program.js";

const cp = (s) => s.codePointAt(0);

// Render a tokenized line as a compact color-id map, one char per code unit:
// "." default, C comment, S string, K keyword, N number, L literal, T type, A accent.
const NAMES = { 0: ".", 1: "C", 2: "S", 3: "K", 4: "N", 5: "L", 6: "T", 7: "A" };
const hlMap = (text, lang, start = "") => {
  const { colors } = tokenizeLine(text, lang, start);
  return text.split("").map((_, i) => NAMES[colors[i] || 0]).join("");
};

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

test("word boundaries: left skips spaces+word, right skips word+spaces", () => {
  //           0123456789
  const line = "foo  bar baz";
  assert.equal(wordLeftIndex(line, 12), 9); // from end → start of "baz"
  assert.equal(wordLeftIndex(line, 9), 5); // → start of "bar"
  assert.equal(wordLeftIndex(line, 5), 0); // across the double space → "foo"
  assert.equal(wordLeftIndex(line, 0), 0); // clamp at start
  assert.equal(wordRightIndex(line, 0), 5); // over "foo" + spaces → start of "bar"
  assert.equal(wordRightIndex(line, 5), 9); // → start of "baz"
  assert.equal(wordRightIndex(line, 12), 12); // clamp at end
});

test("findNext: forward/backward, wrap, case-insensitive, and regex", () => {
  const rows = ["foo bar", "BAR baz", "qux foo"];
  const plain = { caseSens: true, regex: false, backward: false };
  // Forward from (0,0): next "foo" is the one on row 2 (skips the match at cursor).
  assert.deepEqual(findNext(rows, 0, 0, "foo", plain), { cy: 2, cx: 4, len: 3 });
  // Wrap: from the last line, "bar" (case-sensitive) is back on row 0.
  assert.deepEqual(findNext(rows, 2, 0, "bar", plain), { cy: 0, cx: 4, len: 3 });
  // Case-insensitive finds "BAR" on row 1 first.
  assert.deepEqual(
    findNext(rows, 0, 0, "bar", { caseSens: false, regex: false, backward: false }),
    { cy: 0, cx: 4, len: 3 },
  );
  // Backward from (2,4) — the "foo" at the cursor — the previous one is on row 0.
  assert.deepEqual(findNext(rows, 2, 4, "foo", { ...plain, backward: true }), { cy: 0, cx: 0, len: 3 });
  // Regex: \bba\w+ matches "bar" then "baz".
  assert.deepEqual(
    findNext(rows, 0, 0, "ba\\w+", { caseSens: false, regex: true, backward: false }),
    { cy: 0, cx: 4, len: 3 },
  );
  assert.equal(findNext(rows, 0, 0, "zzz", plain), null);
  assert.equal(findInLine("aXbXc", 2, "X", plain).index, 3); // resume search mid-line
});

test("wrapSegments breaks a line every `tw` render columns", () => {
  assert.deepEqual(wrapSegments(0, 10), [0]); // empty line → one segment
  assert.deepEqual(wrapSegments(8, 10), [0]); // fits
  assert.deepEqual(wrapSegments(10, 10), [0]); // exact width, still one row
  assert.deepEqual(wrapSegments(11, 10), [0, 10]);
  assert.deepEqual(wrapSegments(25, 10), [0, 10, 20]);
});

test("detectLang maps file extensions to language keys", () => {
  assert.equal(detectLang("app.js"), "js");
  assert.equal(detectLang("/src/x.tsx"), "js"); // TS/JSX share the JS ruleset
  assert.equal(detectLang("main.go"), "go");
  assert.equal(detectLang("lib.rs"), "rust");
  assert.equal(detectLang("s.py"), "py");
  assert.equal(detectLang("run.sh"), "sh");
  assert.equal(detectLang("data.json"), "json");
  assert.equal(detectLang("k8s.yaml"), "yaml");
  assert.equal(detectLang("Cargo.toml"), "toml");
  assert.equal(detectLang("README.md"), "md");
  assert.equal(detectLang("a.c"), "c");
  assert.equal(detectLang("style.css"), "css");
  assert.equal(detectLang("Makefile"), null); // no extension → plain
  assert.equal(detectLang("notes.xyz"), null); // unknown extension → plain
  assert.equal(detectLang(null), null);
});

test("tokenizeLine: JS keywords, strings, comments, numbers", () => {
  assert.equal(hlMap(`const x = "hi"; // note`, "js"), "KKKKK.....SSSS..CCCCCCC");
  assert.equal(hlMap("let n = 42", "js"), "KKK.....NN");
  assert.equal(hlMap("return true", "js"), "KKKKKK.LLLL"); // true = constant
});

test("tokenizeLine: a block comment carries across lines via endState", () => {
  const l1 = tokenizeLine("code /* open", "js");
  assert.equal(l1.endState, "block");
  assert.equal(hlMap("code /* open", "js"), ".....CCCCCCC");
  // The next line, fed l1's endState, stays a comment until `*/` then resumes.
  assert.equal(hlMap("still */ done", "js", l1.endState), "CCCCCCCC.....");
  assert.equal(tokenizeLine("still */ done", "js", l1.endState).endState, "");
});

test("tokenizeLine: a multiline template string carries and closes", () => {
  const l1 = tokenizeLine("s = `a", "js");
  assert.equal(l1.endState, "str:`");
  assert.equal(tokenizeLine("b` + 1", "js", l1.endState).endState, "");
  assert.equal(hlMap("b` + 1", "js", l1.endState), "SS...N");
});

test("tokenizeLine: language-specific rules (py, json, yaml, md)", () => {
  assert.equal(hlMap("def f(): return None  # x", "py"), "KKK......KKKKKK.LLLL..CCC");
  assert.equal(hlMap(`{"a": 12, "b": true}`, "json"), ".SSS..NN..SSS..LLLL.");
  assert.equal(hlMap("name: value  # c", "yaml"), "TTTT.........CCC"); // key + comment
  assert.equal(hlMap("## Heading", "md"), "AAAAAAAAAA"); // whole heading accented
});

test("tokenizeLine: unknown language leaves text uncolored", () => {
  assert.equal(hlMap("const x = 1", "nope"), "...........");
  assert.equal(hlMap("const x = 1", null), "...........");
});

test("detectIndent: spaces (size), tabs, and no-evidence", () => {
  assert.deepEqual(
    detectIndent(["function f() {", "    return 1;", "    if (x) {", "        y();", "    }", "}"]),
    { expandTab: true, size: 4 },
  );
  assert.deepEqual(detectIndent(["a:", "  b:", "    c: 1", "  d: 2"]), { expandTab: true, size: 2 });
  assert.deepEqual(detectIndent(["func f() {", "\treturn 1", "\tif x {", "\t\ty()"]), { expandTab: false, size: null });
  assert.equal(detectIndent(["no", "indent", "here"]), null); // no evidence → caller keeps default
  assert.equal(detectIndent([""]), null);
});

test("subseqScore: contiguous matches score lower; non-match is -1", () => {
  assert.equal(subseqScore("nano-program", "nano"), 3); // n..o span 0→3
  assert.equal(subseqScore("n-a-n-o", "nano"), 6); // same chars, more spread out
  assert.equal(subseqScore("readme", "xyz"), -1); // not a subsequence
});

test("rankPaths: basename hits beat path hits; contiguous & shorter first", () => {
  const files = [
    "src/nano/nano-program.js",
    "src/node/node-program.js",
    "tools/nano.test.js",
    "src/other/nano/x.js", // only the directory matches "nano"
    "README.md",
  ];
  // Both basename hits rank above the path-only hit; shorter path breaks the tie.
  assert.deepEqual(rankPaths(files, "nano"), [
    "tools/nano.test.js",
    "src/nano/nano-program.js",
    "src/other/nano/x.js",
  ]);
  assert.deepEqual(rankPaths(files, "nanoprog"), ["src/nano/nano-program.js"]);
  assert.deepEqual(rankPaths(files, "zzz"), []); // no matches
  assert.deepEqual(rankPaths(files, ""), files); // empty query keeps order
});
