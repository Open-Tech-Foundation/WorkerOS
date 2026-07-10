// `nano` — a small, modeless full-screen text editor. A guest program (INV-1),
// installed at /bin/nano and run from wsh, in the spirit of GNU nano: you type
// to edit, arrows/Home/End/PgUp/PgDn move, and the on-screen bars show the key
// combos (^O write out, ^X exit, …). No modes to learn.
//
// It is a real TUI, so it drives the terminal directly: it flips the kernel TTY
// to *raw + no-echo* via tcsetattr (so every keystroke arrives immediately and
// nano — not the line discipline — owns what's on screen), switches to the
// alternate screen, and paints frames with ANSI. On exit (or crash) it restores
// the saved termios and the main screen. It also honors SIGWINCH, re-querying
// the window size and re-laying-out when the terminal is resized.
//
// Authored as a plain top-level-await script (no import/export) so it runs
// through the program worker's ESM path, which awaits top-level await.

const enc = new TextEncoder();
const dec = new TextDecoder();
const write = (s) => sys.write(1, enc.encode(s));

// Base64-encode a byte array (no atob/btoa dependency in the guest sandbox).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}
// OSC 52: hand `text` to the terminal's system clipboard (`c`). No-op for text
// too large for the common terminal cap; a select-drag copy still works there.
function osc52(text) {
  const b64 = base64(enc.encode(text));
  if (b64.length > 100000) return; // ~74 KB; most terminals reject larger
  write(`\x1b]52;c;${b64}\x1b\\`);
}

let tabWidth = 8; // display width of a literal \t (settable; also the tabs-mode indent size)

// ---- path helpers (same normalization the coreutils/curl use) --------------
function joinPath(...parts) {
  const segs = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}
const abs = (p) => (p.startsWith("/") ? joinPath(p) : joinPath(sys.cwd, p));

// ---- editor state ----------------------------------------------------------
let rows = [""]; // the document, one string per line (no trailing newline)
let filename = null; // path last read/written, or null for a new buffer
let cx = 0; // cursor column within rows[cy] (UTF-16 code units)
let cy = 0; // cursor line
let rowoff = 0; // first document line shown (vertical scroll)
let coloff = 0; // first render column shown (horizontal scroll)
let dirty = false; // unsaved changes?
let statusmsg = ""; // the message-bar text
let screenRows = 24;
let screenCols = 80;
let textRows = 20; // editable rows = screenRows - 4 chrome rows
let cutBuffer = ""; // text held by ^K / copy, re-inserted by ^U (may span lines)
let lastWasCut = false; // consecutive line ^K accumulate into cutBuffer
let mark = null; // selection anchor { cy, cx }, or null (^6 sets/clears)
let showLineNumbers = true; // left gutter with line numbers (toggle: M-N)
let autoIndent = true; // carry leading whitespace onto a new line (toggle: M-I)
let softWrap = false; // wrap long lines onto extra screen rows (toggle: M-$)
let expandTab = true; // Tab inserts spaces (VSCode insertSpaces); false = a real \t
let indentSize = 4; // spaces per indent level in spaces mode (M-t sets it)
let syntax = true; // syntax highlighting on (toggle: M-y); real work needs a lang
let lang = null; // detected language key (by file extension), or null for plain
let hl = []; // per-row highlight cache: { text, start, colors, end } (see refresh)
let hlGood = 0; // rows [0, hlGood) of `hl` are known-valid; edits lower this
let lineEnding = "\n"; // detected on load ("\n" unix, "\r\n" dos, "\r" mac)
let lastSearch = ""; // last search needle (empty ^W query repeats it)
let searchOpts = { caseSens: false, regex: false, backward: false };

// Undo/redo: whole-document snapshots. `coalesceKey` groups a run of like edits
// (a burst of typing, a run of backspaces) into one undo step; any other action
// or a cursor move resets it so the next edit starts a fresh step.
const undoStack = [];
const redoStack = [];
let coalesceKey = null;
const UNDO_LIMIT = 500;

const snap = () => ({ rows: rows.slice(), cx, cy, dirty });
function pushUndo(key = null) {
  if (key !== null && key === coalesceKey) return; // fold into the current step
  undoStack.push(snap());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  coalesceKey = key;
}
function restore(s) { rows = s.rows.slice(); cy = s.cy; cx = s.cx; dirty = s.dirty; mark = null; clampToDoc(); }
function clampToDoc() {
  if (cy > rows.length - 1) cy = rows.length - 1;
  if (cy < 0) cy = 0;
  clampCx();
}
function undo() {
  if (!undoStack.length) { setMsg("Nothing to undo"); return; }
  redoStack.push(snap());
  restore(undoStack.pop());
  coalesceKey = null;
  setMsg("Undid change");
}
function redo() {
  if (!redoStack.length) { setMsg("Nothing to redo"); return; }
  undoStack.push(snap());
  restore(redoStack.pop());
  coalesceKey = null;
  setMsg("Redid change");
}

const setMsg = (m) => { statusmsg = m; };
const markDirty = () => { dirty = true; hlGood = Math.min(hlGood, cy); };

async function updateSize() {
  const ws = await sys.winsize();
  screenRows = Math.max(ws.rows | 0, 4);
  screenCols = Math.max(ws.cols | 0, 8);
  textRows = Math.max(screenRows - 4, 1);
}

// ---- width + rendering helpers ---------------------------------------------
// Display width of a code point: East Asian wide / fullwidth glyphs and emoji
// occupy two terminal columns, everything else one. (A pragmatic wcwidth — no
// zero-width combining handling, which xterm composes onto the base cell anyway.)
export function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana … CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext-A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat / small forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext-B and beyond
  );
}
export const charWidth = (cp) => (isWide(cp) ? 2 : 1);

// Code-unit length of the character starting at / ending at index i, so cursor
// motion and deletion never split an astral code point (a surrogate pair).
export function nextLen(line, i) {
  const c = line.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < line.length ? 2 : 1;
}
export function prevLen(line, i) {
  const c = line.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i - 2 >= 0 ? 2 : 1;
}

// Map a cursor column (in UTF-16 code units) to its render column (tabs expand
// to the next stop; wide glyphs count as two).
export function cxToRx(line, col) {
  let rx = 0, i = 0;
  while (i < col && i < line.length) {
    if (line[i] === "\t") { rx += tabWidth - (rx % tabWidth); i += 1; continue; }
    const cp = line.codePointAt(i);
    rx += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return rx;
}

// Is `cp` a control character we must not emit raw (it would move the cursor or
// clear the line)? C0 controls (except tab, handled separately) and DEL.
const isCtrl = (cp) => (cp < 0x20 && cp !== 0x09) || cp === 0x7f;
// Caret notation for a control char: ^@ ^A … ^? (DEL). Two columns wide.
const caret = (cp) => "^" + String.fromCharCode(cp === 0x7f ? 0x3f : cp ^ 0x40);

// The visible slice of a line for a horizontal window [startCol, startCol+width):
// tabs expand to spaces, control chars show as inverse caret notation (^X), and a
// wide glyph clipped by either edge renders as a space for its visible half, so
// columns line up exactly. When `colors` (a per-code-unit color-id array from the
// tokenizer) is given, an SGR is emitted wherever the color changes.
export function visibleSlice(line, startCol, width, colors) {
  let col = 0, out = "", i = 0, cur = 0;
  const end = startCol + width;
  while (i < line.length) {
    const isTab = line[i] === "\t";
    let cp = 0, adv = 1, w, ctrl = false;
    if (isTab) w = tabWidth - (col % tabWidth);
    else {
      cp = line.codePointAt(i);
      adv = cp > 0xffff ? 2 : 1;
      if (isCtrl(cp)) { ctrl = true; w = 2; } // caret notation ^X is two columns
      else w = charWidth(cp);
    }
    const cellStart = col, cellEnd = col + w;
    if (cellEnd <= startCol) { col = cellEnd; i += adv; continue; }
    if (cellStart >= end) break;
    if (isTab || cellStart < startCol || cellEnd > end) {
      out += " ".repeat(Math.min(cellEnd, end) - Math.max(cellStart, startCol));
    } else if (ctrl) {
      out += "\x1b[7m" + caret(cp) + "\x1b[0m";
      cur = 0; // the ^X reset (\x1b[0m) cleared any active color
    } else {
      if (colors && colors[i] !== cur) { cur = colors[i] || 0; out += hlSgr(cur); }
      out += String.fromCodePoint(cp);
    }
    col = cellEnd;
    i += adv;
  }
  if (cur !== 0) out += "\x1b[39m"; // restore default fg so color can't bleed
  return out;
}

// Display width of a plain string (no tabs assumed): wide glyphs count as two,
// control chars as their two-column caret form. Used to lay out the chrome bars.
export function dispWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += isCtrl(cp) ? 2 : charWidth(cp);
  }
  return w;
}
// Pad/truncate a string to exactly `n` display columns (column-accurate `fit`).
export function fitCols(s, n) {
  let out = "", w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const cw = isCtrl(cp) ? 2 : charWidth(cp);
    if (w + cw > n) break;
    out += isCtrl(cp) ? caret(cp) : ch;
    w += cw;
  }
  return out + " ".repeat(Math.max(0, n - w));
}

// Inverse of cxToRx: the code-unit index whose cell contains render column `rx`
// (used to place the cursor from a mouse click).
export function rxToCx(line, rx) {
  let col = 0, i = 0;
  while (i < line.length) {
    let w, adv;
    if (line[i] === "\t") { w = tabWidth - (col % tabWidth); adv = 1; }
    else { const cp = line.codePointAt(i); w = charWidth(cp); adv = cp > 0xffff ? 2 : 1; }
    if (col + w > rx) break; // rx lands inside this cell → cursor sits before it
    col += w;
    i += adv;
  }
  return i;
}

// Width of the line-number gutter for a document of `n` lines: the widest number
// (min 2 digits) plus a one-column separator. 0 when line numbers are off.
export function gutterWidthFor(n) {
  return Math.max(String(n).length, 2) + 1;
}

// Word boundaries (readline-style): left skips spaces then the word before the
// cursor; right skips the word then trailing spaces. Used by Ctrl-←/→ and the
// word-delete chords. Surrogate pairs are all non-space, so they never split.
const isSpace = (ch) => ch === " " || ch === "\t";
export function wordLeftIndex(line, cx) {
  let i = cx;
  while (i > 0 && isSpace(line[i - 1])) i--;
  while (i > 0 && !isSpace(line[i - 1])) i--;
  return i;
}
export function wordRightIndex(line, cx) {
  let i = cx;
  while (i < line.length && !isSpace(line[i])) i++;
  while (i < line.length && isSpace(line[i])) i++;
  return i;
}

// First match of `q` in `line` at or after `from`, honoring case/regex options.
// Returns { index, len } or null. A regex that fails to compile yields null.
export function findInLine(line, from, q, opts) {
  if (opts.regex) {
    let re;
    try { re = new RegExp(q, opts.caseSens ? "g" : "gi"); } catch { return null; }
    re.lastIndex = Math.max(0, from);
    const m = re.exec(line);
    return m ? { index: m.index, len: m[0].length || 1 } : null;
  }
  const hay = opts.caseSens ? line : line.toLowerCase();
  const needle = opts.caseSens ? q : q.toLowerCase();
  const i = hay.indexOf(needle, Math.max(0, from));
  return i < 0 ? null : { index: i, len: q.length };
}

// Find the next occurrence of `q` from (cy, cx), scanning the whole document once
// (wrapping), forward or backward. Returns { cy, cx, len } or null. Pure over the
// passed `rows` so it unit-tests without editor state.
export function findNext(rows, cy, cx, q, opts) {
  if (!q) return null;
  const n = rows.length;
  if (!opts.backward) {
    for (let step = 0; step <= n; step++) {
      const r = (cy + step) % n;
      const from = step === 0 ? cx + 1 : 0;
      const m = findInLine(rows[r], from, q, opts);
      if (m) return { cy: r, cx: m.index, len: m.len };
      if (step === n) break;
    }
  } else {
    for (let step = 0; step <= n; step++) {
      const r = ((cy - step) % n + n) % n;
      const limit = step === 0 ? cx : rows[r].length + 1; // matches strictly before
      let best = null, at = 0;
      for (;;) {
        const m = findInLine(rows[r], at, q, opts);
        if (!m || m.index >= limit) break;
        best = m; at = m.index + Math.max(1, m.len);
      }
      if (best) return { cy: r, cx: best.index, len: best.len };
      if (step === n) break;
    }
  }
  return null;
}

// Render-column start of each wrapped segment of a line `lineWidth` columns wide,
// broken every `tw` columns. Always at least `[0]`.
export function wrapSegments(lineWidth, tw) {
  const starts = [0];
  for (let s = tw; s < lineWidth; s += tw) starts.push(s);
  return starts;
}

// Decode an SGR mouse report (`ESC [ < b ; x ; y M|m`) into a mouse event, or
// null if it isn't one. `press` is true for a button-press (`M`), false for
// release (`m`); x/y are 1-based cell coordinates.
export function parseMouse(params, final) {
  if (params[0] !== "<") return null;
  const parts = params.slice(1).split(";");
  if (parts.length !== 3) return null;
  const b = Number(parts[0]), x = Number(parts[1]), y = Number(parts[2]);
  if (!Number.isFinite(b) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { b, x, y, press: final === "M" };
}

const gutterWidth = () => (showLineNumbers ? gutterWidthFor(rows.length) : 0);
const textWidth = () => Math.max(screenCols - gutterWidth(), 1);

// screen-row → { r, start } map for the last painted frame; drives cursor
// placement and mouse hit-testing in both plain and soft-wrap modes.
let visualMap = [];

// How many screen rows a document line occupies (1 unless soft-wrapping).
function visualHeight(r) {
  if (!softWrap) return 1;
  return wrapSegments(cxToRx(rows[r], rows[r].length), textWidth()).length;
}

function scroll() {
  const rx = cxToRx(rows[cy], cx);
  const tw = textWidth();
  if (cy < rowoff) rowoff = cy;
  if (softWrap) {
    coloff = 0; // soft-wrap never scrolls horizontally
    const curSeg = Math.floor(rx / tw); // cursor's wrapped segment within its line
    // Advance rowoff until the cursor's segment fits in the visible screen rows.
    for (;;) {
      let used = 0;
      for (let r = rowoff; r < cy; r++) used += visualHeight(r);
      if (rowoff >= cy || used + curSeg + 1 <= textRows) break;
      rowoff++;
    }
  } else {
    if (cy >= rowoff + textRows) rowoff = cy - textRows + 1;
    if (rx < coloff) coloff = rx;
    if (rx >= coloff + tw) coloff = rx - tw + 1;
  }
}

// ---- syntax highlighting ---------------------------------------------------
// Heuristic, nano-style: a per-language *data* table + one generic tokenizer.
// This is deliberately NOT a real parser (adding a language is ~10 lines of data,
// not code); pathological cases — a `/` that's divide-vs-regex, nested template
// literals — can mis-color, the accepted trade real nano makes too.
//
// Color ids (0 = default text); mapped to SGR by `hlSgr`.
const HL = { COMMENT: 1, STRING: 2, KEYWORD: 3, NUMBER: 4, CONST: 5, TYPE: 6, ACCENT: 7 };
const KW = (s) => new Set(s.split(/\s+/).filter(Boolean));
const LANGS = {
  js: {
    ext: "js mjs cjs jsx ts tsx mts cts",
    line: "//", block: ["/*", "*/"],
    strings: [{ q: '"' }, { q: "'" }, { q: "`", multi: true }],
    keywords: KW("await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield async as enum type namespace declare readonly public private protected implements interface"),
    constants: KW("true false null undefined NaN Infinity this"),
    types: KW("string number boolean object symbol bigint any unknown never void"),
  },
  json: { ext: "json", strings: [{ q: '"' }], constants: KW("true false null") },
  sh: {
    ext: "sh bash zsh", line: "#",
    strings: [{ q: '"' }, { q: "'" }],
    keywords: KW("if then else elif fi for while until do done case esac in function return export local readonly declare set unset shift source"),
  },
  py: {
    ext: "py pyi", line: "#",
    strings: [{ q: '"""', multi: true }, { q: "'''", multi: true }, { q: '"' }, { q: "'" }],
    keywords: KW("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    constants: KW("True False None self cls __name__"),
  },
  go: {
    ext: "go", line: "//", block: ["/*", "*/"],
    strings: [{ q: '"' }, { q: "'" }, { q: "`", multi: true }],
    keywords: KW("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    constants: KW("true false nil iota"),
    types: KW("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
  },
  rust: {
    ext: "rs", line: "//", block: ["/*", "*/"],
    strings: [{ q: '"' }],
    keywords: KW("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while"),
    constants: KW("true false None Some Ok Err self Self"),
    types: KW("bool char str String i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 Vec Option Result Box"),
  },
  c: {
    ext: "c h cpp cc cxx hpp hh", line: "//", block: ["/*", "*/"],
    strings: [{ q: '"' }, { q: "'" }],
    keywords: KW("auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template public private protected virtual new delete using nullptr bool"),
    constants: KW("true false NULL"),
  },
  css: {
    ext: "css scss less", block: ["/*", "*/"],
    strings: [{ q: '"' }, { q: "'" }],
  },
  yaml: { ext: "yaml yml", line: "#", strings: [{ q: '"' }, { q: "'" }], keyish: ":" },
  toml: { ext: "toml", line: "#", strings: [{ q: '"' }, { q: "'" }], keyish: "=" },
  md: { ext: "md markdown mkd", md: true },
};

// filename → language key (by extension), or null for plain text.
export function detectLang(name) {
  if (!name) return null;
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (!ext) return null;
  for (const [k, spec] of Object.entries(LANGS))
    if (spec.ext && spec.ext.split(" ").includes(ext)) return k;
  return null;
}

// Guess a file's indentation (VSCode's "detect indentation"): tabs vs spaces, and
// for spaces the step (2/4/8). Returns { expandTab, size } or null when there's no
// evidence (caller keeps its default). `size` is null for tab-indented files.
export function detectIndent(rows) {
  let tabs = 0, spaces = 0;
  const votes = { 2: 0, 4: 0, 8: 0 };
  for (const line of rows) {
    const m = line.match(/^(\t+| +)(?=[^\s])/); // leading indent before real content
    if (!m) continue;
    if (m[1][0] === "\t") { tabs++; continue; }
    spaces++;
    for (const s of [2, 4, 8]) if (m[1].length % s === 0) votes[s]++;
  }
  if (tabs > spaces) return { expandTab: false, size: null };
  if (spaces === 0) return null;
  const size = [8, 4, 2].find((s) => votes[s] >= spaces * 0.7) ?? 4; // largest that fits, bias 4
  return { expandTab: true, size };
}

const isWordCh = (ch) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
const isDigitCh = (ch) => ch >= "0" && ch <= "9";

// Scan a string literal body from `from` up to `close`; honor `\` escapes unless
// disabled. Returns { closed, end } — `end` is just past the close (or line end).
function scanString(text, from, close, esc) {
  let i = from;
  while (i < text.length) {
    if (esc && text[i] === "\\") { i += 2; continue; }
    if (text.startsWith(close, i)) return { closed: true, end: i + close.length };
    i++;
  }
  return { closed: false, end: text.length };
}

// Tokenize one line into a per-code-unit color-id array. `startState` carries a
// multiline construct in from the line above: "" | "block" | "str:<close>".
// Returns { colors, endState } — endState feeds the next line.
export function tokenizeLine(text, langKey, startState = "") {
  const spec = LANGS[langKey];
  const n = text.length;
  const colors = new Array(n).fill(0);
  if (!spec) return { colors, endState: "" };
  if (spec.md) return { colors: mdColors(text), endState: "" };
  const paint = (a, b, c) => { for (let k = a; k < b; k++) colors[k] = c; };
  let i = 0;
  let state = startState;

  // Resume a multiline block comment / string carried from the previous line.
  if (state === "block" && spec.block) {
    const end = text.indexOf(spec.block[1]);
    if (end < 0) { paint(0, n, HL.COMMENT); return { colors, endState: "block" }; }
    paint(0, end + spec.block[1].length, HL.COMMENT);
    i = end + spec.block[1].length;
    state = "";
  } else if (state.startsWith("str:")) {
    const close = state.slice(4);
    const r = scanString(text, 0, close, true);
    if (!r.closed) { paint(0, n, HL.STRING); return { colors, endState: state }; }
    paint(0, r.end, HL.STRING);
    i = r.end;
    state = "";
  }

  // keyish (yaml/toml): color a leading `key:` / `key =` as a type/accent. The
  // main loop leaves plain identifiers uncolored, so this survives it.
  if (spec.keyish) {
    const m = text.match(new RegExp("^(\\s*)([\\w.-]+)\\s*" + spec.keyish));
    if (m) paint(m[1].length, m[1].length + m[2].length, HL.TYPE);
  }

  const lineTokens = spec.line ? [].concat(spec.line) : [];
  while (i < n) {
    if (lineTokens.some((t) => text.startsWith(t, i))) { paint(i, n, HL.COMMENT); break; }
    if (spec.block && text.startsWith(spec.block[0], i)) {
      const end = text.indexOf(spec.block[1], i + spec.block[0].length);
      if (end < 0) { paint(i, n, HL.COMMENT); state = "block"; break; }
      paint(i, end + spec.block[1].length, HL.COMMENT);
      i = end + spec.block[1].length;
      continue;
    }
    const s = spec.strings && spec.strings.find((x) => text.startsWith(x.q, i));
    if (s) {
      const r = scanString(text, i + s.q.length, s.q, s.esc !== false);
      if (!r.closed && s.multi) { paint(i, n, HL.STRING); state = "str:" + s.q; break; }
      paint(i, r.end, HL.STRING);
      i = r.end;
      continue;
    }
    const ch = text[i];
    if (isDigitCh(ch) || (ch === "." && isDigitCh(text[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(text[j])) j++;
      paint(i, j, HL.NUMBER);
      i = j;
      continue;
    }
    if (isWordCh(ch) && !isDigitCh(ch)) {
      let j = i;
      while (j < n && isWordCh(text[j])) j++;
      const w = text.slice(i, j);
      const c = spec.constants && spec.constants.has(w) ? HL.CONST
        : spec.types && spec.types.has(w) ? HL.TYPE
        : spec.keywords && spec.keywords.has(w) ? HL.KEYWORD : 0;
      if (c) paint(i, j, c);
      i = j;
      continue;
    }
    i++;
  }
  return { colors, endState: state };
}

// Markdown is line-shaped, not token-shaped: headings, list markers, inline code
// and emphasis. (Fenced ``` blocks aren't tracked across lines in v1.)
function mdColors(text) {
  const n = text.length;
  const colors = new Array(n).fill(0);
  const paint = (a, b, c) => { for (let k = a; k < b; k++) colors[k] = c; };
  if (/^\s{0,3}#{1,6}\s/.test(text)) { paint(0, n, HL.ACCENT); return colors; }
  const bullet = text.match(/^(\s*)([-*+]|\d+\.)(\s)/);
  if (bullet) paint(bullet[1].length, bullet[1].length + bullet[2].length, HL.KEYWORD);
  for (const re of [/`[^`]+`/g, /\*\*[^*]+\*\*/g, /(?<![*_])[*_][^*_]+[*_](?![*_])/g]) {
    let m;
    const col = re.source[0] === "`" ? HL.STRING : HL.TYPE;
    while ((m = re.exec(text))) paint(m.index, m.index + m[0].length, col);
  }
  return colors;
}

// Color id → SGR. 256-color (widely supported); id 0 resets to default fg.
const HL_SGR = {
  1: "\x1b[38;5;245m", // comment  — grey
  2: "\x1b[38;5;114m", // string   — green
  3: "\x1b[38;5;111m", // keyword  — blue
  4: "\x1b[38;5;179m", // number   — amber
  5: "\x1b[38;5;176m", // constant — purple
  6: "\x1b[38;5;80m", //  type     — cyan
  7: "\x1b[38;5;211m", // accent   — pink (md heading, etc.)
};
const hlSgr = (c) => (c ? HL_SGR[c] : "\x1b[39m");

const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";
// 24-bit (true-color) SGR helpers. The playground terminal (xterm.js) renders
// these directly; a real xterm does too. Used for the line-number gutter.
const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const GUTTER_DIM = fg(105, 112, 128); // inactive line numbers
const GUTTER_CUR = fg(255, 150, 80); // the current line's number (accent)

// Pad/truncate to exactly `n` display columns (column-accurate, wide/ctrl aware).
const fit = fitCols;

function shortcut(key, label) {
  return `${INVERSE}${key}${RESET} ${label}`;
}

// The selected render-column span [lo, hi) on document row `r`, or null. Built
// from the mark→cursor range; whole spanned lines highlight to their end.
function selColsFor(r) {
  const sel = selRange();
  if (!sel || r < sel.a.cy || r > sel.b.cy) return null;
  const line = rows[r];
  const lo = r === sel.a.cy ? cxToRx(line, Math.min(sel.a.cx, line.length)) : 0;
  const hi = r === sel.b.cy ? cxToRx(line, Math.min(sel.b.cx, line.length)) : cxToRx(line, line.length);
  return lo < hi ? [lo, hi] : null;
}
// Render one line's visible window, inverting the selected columns. Reuses the
// (tested) `visibleSlice` by splitting the window into pre / selected / post.
function renderRowVisible(line, off, tw, sel, colors) {
  if (!sel) return visibleSlice(line, off, tw, colors);
  const winHi = off + tw;
  const sLo = Math.max(sel[0], off), sHi = Math.min(sel[1], winHi);
  if (sLo >= sHi) return visibleSlice(line, off, tw, colors);
  // Selection inverts; syntax color applies only outside it (inverse wins).
  return (
    visibleSlice(line, off, sLo - off, colors) +
    "\x1b[7m" + visibleSlice(line, sLo, sHi - sLo) + "\x1b[0m" +
    visibleSlice(line, sHi, winHi - sHi, colors)
  );
}

// Ensure `hl[0..upto]` is valid, tokenizing only what changed. Each row's colors
// depend on the previous row's end-state (multiline comments/strings), so we walk
// forward from the first stale row, reusing a cached entry whenever its source
// text and carried-in state both still match.
function ensureHighlight(upto) {
  let start = hlGood > 0 ? hl[hlGood - 1].end : "";
  for (let r = hlGood; r <= upto && r < rows.length; r++) {
    const c = hl[r];
    if (c && c.text === rows[r] && c.start === start) { start = c.end; continue; }
    const { colors, endState } = tokenizeLine(rows[r], lang, start);
    hl[r] = { text: rows[r], start, colors, end: endState };
    start = endState;
  }
  hlGood = Math.max(hlGood, Math.min(rows.length, upto + 1));
}

// Build one full frame and emit it in a single write (no flicker).
function refresh() {
  let out = "\x1b[?25l\x1b[H"; // hide cursor, home

  // Title bar (inverse): program, file, and a modified marker.
  const name = filename || "New Buffer";
  const title = `  nano  ${name}${dirty ? "  *" : ""}`;
  out += INVERSE + fit(title, screenCols) + RESET + "\r\n";

  // Text area, with an optional 24-bit-colored line-number gutter. Each screen
  // row records its document position in `visualMap` (for the cursor + mouse).
  // In soft-wrap mode a long line spans several screen rows; otherwise one row
  // per line and the window scrolls horizontally by `coloff`.
  const gw = gutterWidth();
  const tw = textWidth();
  const hlOn = syntax && lang;
  if (hlOn) ensureHighlight(rowoff + textRows);
  visualMap = new Array(textRows).fill(null);
  let sl = 0; // screen line index within the text area
  for (let r = rowoff; r < rows.length && sl < textRows; r++) {
    const segs = softWrap ? wrapSegments(cxToRx(rows[r], rows[r].length), tw) : [coloff];
    const selCols = selColsFor(r);
    const cols = hlOn && hl[r] ? hl[r].colors : null;
    for (let si = 0; si < segs.length && sl < textRows; si++) {
      const start = segs[si];
      visualMap[sl] = { r, start };
      if (gw > 0) {
        if (si === 0) out += (r === cy ? GUTTER_CUR : GUTTER_DIM) + String(r + 1).padStart(gw - 1) + " " + RESET;
        else out += " ".repeat(gw); // continuation rows: blank gutter
      }
      out += renderRowVisible(rows[r], start, tw, selCols, cols);
      out += "\x1b[K\r\n";
      sl++;
    }
  }
  for (; sl < textRows; sl++) out += "\x1b[K\r\n"; // blank rows past the buffer

  // Message bar: status text on the left, a VSCode-style indent indicator on the
  // right (`Spaces: 4` / `Tab Size: 8`). Keep a one-column right margin so the
  // indicator never lands in the last cell — where a web terminal's scrollbar /
  // magic-margin wrap would clip it. It also yields to the message when the screen
  // is too narrow to show both, so a status line is never truncated.
  const indicator = expandTab ? `Spaces: ${indentSize}` : `Tab Size: ${tabWidth}`;
  const iw = dispWidth(indicator);
  const room = screenCols - iw - 2; // 1 gap before the indicator + 1 margin after
  if (room >= 0 && dispWidth(statusmsg) <= room)
    out += fit(statusmsg, room) + " " + indicator + " " + "\r\n";
  else out += fit(statusmsg, screenCols) + "\r\n";

  // Two shortcut bars.
  const bar1 = [
    shortcut("^G", "Help"),
    shortcut("^O", "Write Out"),
    shortcut("^W", "Where Is"),
    shortcut("^\\", "Replace"),
    shortcut("^K", "Cut"),
    shortcut("^C", "Cur Pos"),
  ].join("  ");
  const bar2 = [
    shortcut("^X", "Exit"),
    shortcut("^U", "Paste"),
    shortcut("M-U", "Undo"),
    shortcut("M-E", "Redo"),
    shortcut("^E", "End"),
    shortcut("^_", "Go To Line"),
  ].join("  ");
  // fit() can't count the invisible ANSI, so just clear-to-EOL after each.
  out += bar1 + "\x1b[K\r\n";
  out += bar2 + "\x1b[K";

  // Place the cursor: find the screen row in visualMap whose segment holds it.
  const rx = cxToRx(rows[cy], cx);
  let screenRow = 2, screenCol = gw + 1;
  for (let i = 0; i < textRows; i++) {
    const v = visualMap[i];
    if (!v || v.r !== cy) continue;
    const last = i + 1 >= textRows || !visualMap[i + 1] || visualMap[i + 1].r !== cy;
    if ((rx >= v.start && rx < v.start + tw) || (last && rx >= v.start)) {
      screenRow = i + 2; // +1 title bar, +1 to 1-based
      screenCol = gw + Math.min(rx - v.start, tw) + 1;
      break;
    }
  }
  out += `\x1b[${screenRow};${screenCol}H\x1b[?25h`;
  write(out);
}

// While a message-bar prompt is active this holds its redraw closure, so a
// SIGWINCH repaints the prompt instead of the main frame (which it would clobber).
let promptRedraw = null;

// ---- input: decode raw bytes into keys -------------------------------------
let inbuf = []; // pending input bytes not yet consumed into a key

async function readMore() {
  const b = await sys.read(0);
  for (const x of b) inbuf.push(x);
  return b.length > 0;
}
async function nextByte() {
  while (inbuf.length === 0) if (!(await readMore())) return -1;
  return inbuf.shift();
}

// Returns a key object: {char}, {ctrl}, or {key: '<name>'}.
async function nextKey() {
  const b = await nextByte();
  if (b === -1) return { key: "eof" };
  if (b === 0x1b) {
    const k = await parseEsc();
    // Bracketed paste: gather the whole block so its newlines don't each trigger
    // auto-indent (which would stair-step the text). Inserted literally instead.
    if (k.key === "pastestart") return { paste: await readPasteBody() };
    return k;
  }
  if (b === 0x0d || b === 0x0a) return { key: "enter" };
  if (b === 0x09) return { char: "\t" }; // Tab inserts a tab
  if (b === 0x7f || b === 0x08) return { key: "backspace" };
  if (b < 0x20) return { ctrl: String.fromCharCode(b === 0 ? 0x40 : b + 0x40) }; // ^@.. → letters
  if (b < 0x80) return { char: String.fromCharCode(b) };
  // A UTF-8 lead byte: gather its continuation bytes and decode.
  const need = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
  const seq = [b];
  for (let i = 0; i < need; i++) {
    const c = await nextByte();
    if (c === -1) break;
    seq.push(c);
  }
  return { char: dec.decode(new Uint8Array(seq)) };
}

// After ESC: recognize CSI (ESC [ …) and SS3 (ESC O …) navigation sequences,
// and Meta/Alt chords (ESC <char>, e.g. M-U undo / M-E redo).
async function parseEsc() {
  const c = await nextByte();
  if (c === -1) return { key: "esc" };
  if (c === 0x7f || c === 0x08) return { key: "wdelback" }; // M-Backspace: del word
  // A printable byte right after ESC is Alt-<char> (nano's M- bindings).
  if (c !== 0x5b && c !== 0x4f) {
    if (c >= 0x20 && c < 0x7f) return { alt: String.fromCharCode(c).toLowerCase() };
    return { key: "esc" }; // lone ESC / unhandled chord
  }
  let params = "";
  for (;;) {
    const d = await nextByte();
    if (d === -1) return { key: "esc" };
    if (d >= 0x40 && d <= 0x7e) return decodeCsi(String.fromCharCode(d), params);
    params += String.fromCharCode(d);
  }
}
// Read a bracketed-paste body: raw bytes up to the paste-end marker ESC [ 201 ~.
// Returns the enclosed text with CR/CRLF normalized to LF.
async function readPasteBody() {
  const END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // ESC [ 2 0 1 ~
  const bytes = [];
  for (;;) {
    const b = await nextByte();
    if (b === -1) break;
    bytes.push(b);
    const n = bytes.length;
    if (n >= END.length && END.every((e, i) => bytes[n - END.length + i] === e)) {
      bytes.length = n - END.length; // drop the terminator
      break;
    }
  }
  return dec.decode(new Uint8Array(bytes)).replace(/\r\n?/g, "\n");
}
function decodeCsi(final, params) {
  // SGR mouse report: ESC [ < b ; x ; y  (M press / m release).
  if (params[0] === "<") {
    const m = parseMouse(params, final);
    return m ? { mouse: m } : { key: "esc" };
  }
  // A modifier param (`1;5C` = Ctrl-Right) turns arrow motion into word motion.
  const mod = params.includes(";") ? params.split(";")[1] : "";
  const ctrl = mod === "5" || mod === "3"; // Ctrl or Alt → word-wise
  switch (final) {
    case "A": return { key: "up" };
    case "B": return { key: "down" };
    case "C": return { key: ctrl ? "wordright" : "right" };
    case "D": return { key: ctrl ? "wordleft" : "left" };
    case "H": return { key: "home" };
    case "F": return { key: "end" };
    case "~":
      if (params === "1" || params === "7") return { key: "home" };
      if (params === "4" || params === "8") return { key: "end" };
      if (params === "3") return { key: "del" };
      if (params === "5") return { key: "pgup" };
      if (params === "6") return { key: "pgdn" };
      if (params === "200") return { key: "pastestart" }; // bracketed paste begin
      if (params === "201") return { key: "esc" }; // stray paste end: ignore
      return { key: "esc" };
    default: return { key: "esc" };
  }
}

// ---- editing operations ----------------------------------------------------
function insertChar(ch) {
  pushUndo("insert"); // fold a burst of typing into one undo step
  rows[cy] = rows[cy].slice(0, cx) + ch + rows[cy].slice(cx);
  cx += ch.length;
  markDirty();
}
// Tab key: a real \t (tabs mode) or spaces out to the next indent stop (spaces
// mode, VSCode insertSpaces). Aligns to the stop so it works mid-line too.
function insertIndent() {
  if (!expandTab) { insertChar("\t"); return; }
  const rx = cxToRx(rows[cy], cx);
  insertChar(" ".repeat(indentSize - (rx % indentSize)));
}
function insertNewline() {
  pushUndo(null);
  const line = rows[cy];
  const after = line.slice(cx);
  // Auto-indent: carry the current line's leading whitespace (up to the cursor).
  let indent = "";
  if (autoIndent) {
    const lead = (line.match(/^[ \t]*/) || [""])[0];
    indent = lead.slice(0, Math.min(lead.length, cx));
  }
  rows[cy] = line.slice(0, cx);
  rows.splice(cy + 1, 0, indent + after);
  cy++;
  cx = indent.length;
  markDirty();
}
function backspace() {
  if (cx > 0 || cy > 0) pushUndo("delete");
  // Unindent: in spaces mode, when the cursor sits in leading spaces, one
  // Backspace removes a whole soft-tab back to the previous indent stop.
  const before = rows[cy].slice(0, cx);
  if (expandTab && cx > 0 && before.endsWith(" ") && /^ +$/.test(before)) {
    const del = ((cx - 1) % indentSize) + 1;
    rows[cy] = rows[cy].slice(del);
    cx -= del;
    markDirty();
    return;
  }
  if (cx > 0) {
    const l = prevLen(rows[cy], cx); // whole char (2 units for a surrogate pair)
    rows[cy] = rows[cy].slice(0, cx - l) + rows[cy].slice(cx);
    cx -= l;
    markDirty();
  } else if (cy > 0) {
    const prevEnd = rows[cy - 1].length;
    rows[cy - 1] += rows[cy];
    rows.splice(cy, 1);
    cy--;
    cx = prevEnd;
    markDirty();
  }
}
function deleteForward() {
  if (cx < rows[cy].length || cy < rows.length - 1) pushUndo("delete");
  if (cx < rows[cy].length) {
    const l = nextLen(rows[cy], cx);
    rows[cy] = rows[cy].slice(0, cx) + rows[cy].slice(cx + l);
    markDirty();
  } else if (cy < rows.length - 1) {
    rows[cy] += rows[cy + 1];
    rows.splice(cy + 1, 1);
    markDirty();
  }
}
// Insert a possibly multi-line string at the cursor (paste / insert-file).
function insertText(text) {
  pushUndo(null);
  const parts = text.split("\n");
  if (parts.length === 1) {
    rows[cy] = rows[cy].slice(0, cx) + parts[0] + rows[cy].slice(cx);
    cx += parts[0].length;
  } else {
    const tail = rows[cy].slice(cx);
    rows[cy] = rows[cy].slice(0, cx) + parts[0];
    const last = parts[parts.length - 1];
    rows.splice(cy + 1, 0, ...parts.slice(1, -1), last + tail);
    cy += parts.length - 1;
    cx = last.length;
  }
  markDirty();
}

// ---- selection (mark) ------------------------------------------------------
function toggleMark() {
  if (mark) { mark = null; setMsg("Mark unset"); }
  else { mark = { cy, cx }; setMsg("Mark set"); }
}
// The selection as normalized endpoints { a, b } (a before b), or null.
function selRange() {
  if (!mark) return null;
  const a = { cy: mark.cy, cx: Math.min(mark.cx, rows[mark.cy] ? rows[mark.cy].length : 0) };
  const b = { cy, cx };
  return a.cy > b.cy || (a.cy === b.cy && a.cx > b.cx) ? { a: b, b: a } : { a, b };
}
function selText(a, b) {
  if (a.cy === b.cy) return rows[a.cy].slice(a.cx, b.cx);
  let s = rows[a.cy].slice(a.cx);
  for (let r = a.cy + 1; r < b.cy; r++) s += "\n" + rows[r];
  return s + "\n" + rows[b.cy].slice(0, b.cx);
}
function deleteRange(a, b) {
  if (a.cy === b.cy) {
    rows[a.cy] = rows[a.cy].slice(0, a.cx) + rows[a.cy].slice(b.cx);
  } else {
    rows[a.cy] = rows[a.cy].slice(0, a.cx) + rows[b.cy].slice(b.cx);
    rows.splice(a.cy + 1, b.cy - a.cy);
  }
  cy = a.cy; cx = a.cx;
}

// ^K: with a mark, cut the selection; otherwise cut whole lines (a run of ^K
// accumulates). Returns true for a line-cut so consecutive cuts can accumulate.
function cutLine() {
  const sel = selRange();
  if (sel) {
    pushUndo(null);
    cutBuffer = selText(sel.a, sel.b);
    deleteRange(sel.a, sel.b);
    mark = null;
    osc52(cutBuffer);
    markDirty();
    return false;
  }
  pushUndo(lastWasCut ? "cut" : null);
  if (!lastWasCut) cutBuffer = "";
  cutBuffer += rows[cy] + "\n";
  rows.splice(cy, 1);
  if (rows.length === 0) rows = [""];
  if (cy >= rows.length) cy = rows.length - 1;
  cx = 0;
  osc52(cutBuffer); // accumulated cut (successive ^K) mirrors to the clipboard
  markDirty();
  return true;
}
// M-6: copy the selection (or the current line if there's no mark).
function copySelection() {
  const sel = selRange();
  if (sel) { cutBuffer = selText(sel.a, sel.b); mark = null; setMsg("Copied selection"); }
  else { cutBuffer = rows[cy] + "\n"; setMsg("Copied line"); }
  osc52(cutBuffer);
}
function pasteCut() {
  if (!cutBuffer) { setMsg("Cut buffer is empty"); return; }
  insertText(cutBuffer);
}

// ---- cursor movement -------------------------------------------------------
// Keep the cursor on a character boundary: clamp to the line end and never let
// it rest inside a surrogate pair (which a plain vertical move could do).
function clampCx() {
  const line = rows[cy];
  if (cx > line.length) cx = line.length;
  const c = line.charCodeAt(cx);
  if (cx > 0 && c >= 0xdc00 && c <= 0xdfff) cx--;
}
// Any deliberate cursor move ends the current undo-coalescing run.
function moveLeft() {
  coalesceKey = null;
  if (cx > 0) cx -= prevLen(rows[cy], cx);
  else if (cy > 0) { cy--; cx = rows[cy].length; }
}
function moveRight() {
  coalesceKey = null;
  if (cx < rows[cy].length) cx += nextLen(rows[cy], cx);
  else if (cy < rows.length - 1) { cy++; cx = 0; }
}
function moveUp() { coalesceKey = null; if (cy > 0) { cy--; clampCx(); } }
function moveDown() { coalesceKey = null; if (cy < rows.length - 1) { cy++; clampCx(); } }
function pageUp() { coalesceKey = null; cy = Math.max(0, cy - textRows); clampCx(); }
function pageDown() { coalesceKey = null; cy = Math.min(rows.length - 1, cy + textRows); clampCx(); }
const gotoHome = () => { coalesceKey = null; cx = 0; };
const gotoEnd = () => { coalesceKey = null; cx = rows[cy].length; };
// Word-wise motion (Ctrl-←/→) and word deletion (M-Backspace / M-Del).
function wordLeft() {
  coalesceKey = null;
  if (cx > 0) cx = wordLeftIndex(rows[cy], cx);
  else if (cy > 0) { cy--; cx = rows[cy].length; }
}
function wordRight() {
  coalesceKey = null;
  if (cx < rows[cy].length) cx = wordRightIndex(rows[cy], cx);
  else if (cy < rows.length - 1) { cy++; cx = 0; }
}
function deleteWordLeft() {
  if (cx === 0) { backspace(); return; }
  pushUndo(null);
  const to = wordLeftIndex(rows[cy], cx);
  rows[cy] = rows[cy].slice(0, to) + rows[cy].slice(cx);
  cx = to;
  markDirty();
}
function deleteWordRight() {
  if (cx >= rows[cy].length) { deleteForward(); return; }
  pushUndo(null);
  const to = wordRightIndex(rows[cy], cx);
  rows[cy] = rows[cy].slice(0, cx) + rows[cy].slice(to);
  markDirty();
}

// A mouse report: left-click positions the cursor; the wheel scrolls the view.
function handleMouse(m) {
  coalesceKey = null;
  if (m.b & 64) { // wheel: bit 0 = down, else up (3 lines, like a real terminal)
    if (m.b & 1) cy = Math.min(rows.length - 1, cy + 3);
    else cy = Math.max(0, cy - 3);
    clampCx();
    return;
  }
  if (!m.press || (m.b & 3) !== 0) return; // only act on a left-button press
  const rel = m.y - 2; // screen row 1 is the title bar; text starts at row 2
  if (rel < 0 || rel >= textRows) return; // a click on the chrome
  const v = visualMap[rel];
  if (!v) { cy = rows.length - 1; cx = rows[cy].length; return; } // below the buffer
  cy = v.r;
  const rx = v.start + Math.max(0, m.x - 1 - gutterWidth());
  cx = rxToCx(rows[cy], rx);
}

// ---- message-bar prompts ---------------------------------------------------
// A one-line prompt on the message bar with in-line editing (←/→, Home/End,
// Backspace/Del). Returns the entered string, or null if cancelled (^C / ESC).
// `complete` (optional) is an async `(text) => text|null` run on Tab.
async function promptLine(label, initial = "", complete = null) {
  let s = initial, p = s.length; // text and cursor index (code units)
  const draw = () => {
    write(`\x1b[${screenRows - 2};1H${INVERSE}${fit(label + s, screenCols)}${RESET}` +
      `\x1b[${screenRows - 2};${Math.min(dispWidth(label + s.slice(0, p)) + 1, screenCols)}H\x1b[?25h`);
  };
  promptRedraw = draw;
  try {
    for (;;) {
      draw();
      const k = await nextKey();
      if (k.key === "enter") return s;
      if (k.key === "esc" || k.ctrl === "C") return null;
      else if (k.char === "\t" && complete) {
        const c = await complete(s);
        if (c != null) { s = c; p = s.length; }
      } else if (k.char && k.char !== "\t") { s = s.slice(0, p) + k.char + s.slice(p); p += k.char.length; }
      else if (k.key === "backspace") { if (p > 0) { const l = prevLen(s, p); s = s.slice(0, p - l) + s.slice(p); p -= l; } }
      else if (k.key === "del") { if (p < s.length) s = s.slice(0, p) + s.slice(p + nextLen(s, p)); }
      else if (k.key === "left") { if (p > 0) p -= prevLen(s, p); }
      else if (k.key === "right") { if (p < s.length) p += nextLen(s, p); }
      else if (k.key === "home" || k.ctrl === "A") p = 0;
      else if (k.key === "end" || k.ctrl === "E") p = s.length;
    }
  } finally {
    promptRedraw = null;
  }
}

// Tab-completion for a filename prompt: complete to the longest common prefix of
// the matching directory entries, adding "/" when it resolves to a lone dir.
async function completeFilename(s) {
  const slash = s.lastIndexOf("/");
  const dirPart = slash >= 0 ? s.slice(0, slash + 1) : "";
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  let entries;
  try { entries = await sys.readdir(abs(dirPart || ".")); } catch { return null; }
  const names = entries.map((e) => e.name).filter((n) => n.startsWith(base));
  if (names.length === 0) { setMsg("No match"); return null; }
  let lcp = names[0];
  for (const n of names) while (!n.startsWith(lcp)) lcp = lcp.slice(0, -1);
  let out = dirPart + lcp;
  if (names.length === 1) {
    try { const st = await sys.stat(abs(out)); if (st && st.kind === "dir") out += "/"; } catch {}
  } else {
    setMsg(names.slice(0, 8).join("  "));
  }
  return out;
}
// A yes/no/cancel prompt. Returns true (yes), false (no), or null (cancel).
async function promptYesNo(label) {
  const draw = () => write(`\x1b[${screenRows - 2};1H${INVERSE}${fit(label + " [Y/N]", screenCols)}${RESET}`);
  promptRedraw = draw;
  try {
    for (;;) {
      draw();
      const k = await nextKey();
      if (k.char === "y" || k.char === "Y") return true;
      if (k.char === "n" || k.char === "N") return false;
      if (k.key === "esc" || k.ctrl === "C") return null;
    }
  } finally {
    promptRedraw = null;
  }
}

// M-t: change indentation (VSCode's status-bar menu). Ask tabs/spaces, then a
// size; blank keeps the current value. Updates the tabs-mode display width too.
async function setIndent() {
  const t = await promptLine("Indent [t]abs / [s]paces: ", expandTab ? "s" : "t");
  if (t === null) { setMsg("Cancelled"); return; }
  const toTabs = /^t/i.test(t.trim());
  const cur = toTabs ? tabWidth : indentSize;
  const sz = await promptLine("Indent size (2/4/8): ", String(cur));
  if (sz === null) { setMsg("Cancelled"); return; }
  const n = parseInt(sz.trim(), 10);
  const size = Number.isFinite(n) && n >= 1 && n <= 16 ? n : cur;
  expandTab = !toTabs;
  if (toTabs) tabWidth = size;
  else { indentSize = size; tabWidth = size; } // keep a stray \t aligned to the unit
  setMsg(expandTab ? `Spaces: ${indentSize}` : `Tab Size: ${tabWidth}`);
}

// ---- file I/O --------------------------------------------------------------
// Read a whole VFS file into a Uint8Array (throws if it can't be opened/read).
async function readFileBytes(path) {
  const fd = await sys.open(abs(path), {});
  const chunks = [];
  try {
    for (;;) {
      const b = await sys.read(fd, 1 << 16);
      if (!b || b.length === 0) break;
      chunks.push(b);
    }
  } finally {
    await sys.close(fd);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

async function loadFile(path) {
  filename = path;
  lang = detectLang(path); // pick syntax rules by extension (null → plain text)
  hl = []; hlGood = 0;
  try {
    const text = dec.decode(await readFileBytes(path));
    // Detect the line ending so we round-trip DOS/Mac files unchanged, and strip
    // it from the buffer so a stray CR can't corrupt the on-screen rendering.
    lineEnding = /\r\n/.test(text) ? "\r\n" : /\r/.test(text) ? "\r" : "\n";
    const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // A trailing newline yields a phantom empty final element; drop it.
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    rows = parts.length ? parts : [""];
    const det = detectIndent(rows); // adopt the file's own indentation, if any
    if (det) { expandTab = det.expandTab; if (det.size) indentSize = det.size; }
    const fmt = lineEnding === "\r\n" ? " [DOS]" : lineEnding === "\r" ? " [Mac]" : "";
    setMsg(`Read ${rows.length} line${rows.length === 1 ? "" : "s"}${fmt}`);
  } catch {
    rows = [""];
    setMsg("New File");
  }
}

async function saveFile(path) {
  if (!path) {
    path = await promptLine("File Name to Write: ", filename || "");
    if (path === null || path === "") { setMsg("Cancelled"); return false; }
  }
  // Join with the buffer's detected line ending (DOS/Mac files round-trip); a
  // non-empty buffer gets a trailing terminator (POSIX text).
  const body = rows.length === 1 && rows[0] === "" ? "" : rows.join(lineEnding) + lineEnding;
  try {
    const fd = await sys.open(abs(path), { create: true, truncate: true });
    try {
      if (body.length) await sys.write(fd, enc.encode(body));
    } finally {
      await sys.close(fd);
    }
    filename = path;
    dirty = false;
    setMsg(`Wrote ${rows.length} line${rows.length === 1 ? "" : "s"}`);
    return true;
  } catch (e) {
    setMsg(`Error writing ${path}: ${e && e.message ? e.message : e}`);
    return false;
  }
}

// ^O: always confirm the name (pre-filled with the current one) before writing,
// like real nano — this is also how you "Save As" to a different path.
async function writeOut() {
  const name = await promptLine("File Name to Write: ", filename || "", completeFilename);
  if (name === null || name === "") { setMsg("Cancelled"); return; }
  await saveFile(name);
}

// ^R: read another file and insert its contents at the cursor.
async function insertFile() {
  const name = await promptLine("File to insert: ", "", completeFilename);
  if (name === null || name === "") { setMsg("Cancelled"); return; }
  try {
    const text = dec.decode(await readFileBytes(name)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    insertText(text.endsWith("\n") ? text.slice(0, -1) : text);
    setMsg(`Inserted ${name}`);
  } catch (e) {
    setMsg(`Error reading ${name}: ${e && e.message ? e.message : e}`);
  }
}

// ---- commands --------------------------------------------------------------
// A search prompt: like promptLine, plus M-C case, M-R regex, M-B backward
// toggles (shown as [Case][Regex][Back]). Returns { query, opts } or null.
async function promptSearch(label, opts) {
  let s = "", p = 0;
  const draw = () => {
    const flags =
      (opts.caseSens ? " [Case]" : "") + (opts.regex ? " [Regex]" : "") + (opts.backward ? " [Back]" : "");
    write(`\x1b[${screenRows - 2};1H${INVERSE}${fit(label + s + flags, screenCols)}${RESET}` +
      `\x1b[${screenRows - 2};${Math.min(dispWidth(label + s.slice(0, p)) + 1, screenCols)}H\x1b[?25h`);
  };
  promptRedraw = draw;
  try {
    for (;;) {
      draw();
      const k = await nextKey();
      if (k.key === "enter") return { query: s, opts };
      if (k.key === "esc" || k.ctrl === "C") return null;
      else if (k.alt === "c") opts.caseSens = !opts.caseSens;
      else if (k.alt === "r") opts.regex = !opts.regex;
      else if (k.alt === "b") opts.backward = !opts.backward;
      else if (k.char && k.char !== "\t") { s = s.slice(0, p) + k.char + s.slice(p); p += k.char.length; }
      else if (k.key === "backspace") { if (p > 0) { const l = prevLen(s, p); s = s.slice(0, p - l) + s.slice(p); p -= l; } }
      else if (k.key === "left") { if (p > 0) p -= prevLen(s, p); }
      else if (k.key === "right") { if (p < s.length) p += nextLen(s, p); }
      else if (k.key === "home") p = 0;
      else if (k.key === "end") p = s.length;
    }
  } finally {
    promptRedraw = null;
  }
}

async function search() {
  const res = await promptSearch(`Search${lastSearch ? ` [${lastSearch}]` : ""}: `, { ...searchOpts });
  if (res === null) { setMsg("Cancelled"); return; }
  searchOpts = res.opts;
  const q = res.query || lastSearch; // empty query repeats the last search
  if (!q) { setMsg("Cancelled"); return; }
  lastSearch = q;
  const hit = findNext(rows, cy, cx, q, searchOpts);
  if (hit) { cy = hit.cy; cx = hit.cx; setMsg(`Found: ${q}`); }
  else setMsg(`"${q}" not found`);
}
// A yes/no/all/cancel prompt for the replace loop.
async function promptReplace() {
  const draw = () => write(`\x1b[${screenRows - 2};1H${INVERSE}${fit("Replace this instance? [Y/N/A]", screenCols)}${RESET}`);
  promptRedraw = draw;
  try {
    for (;;) {
      draw();
      const k = await nextKey();
      if (k.char === "y" || k.char === "Y" || k.key === "enter") return "y";
      if (k.char === "n" || k.char === "N") return "n";
      if (k.char === "a" || k.char === "A") return "a";
      if (k.key === "esc" || k.ctrl === "C") return "cancel";
    }
  } finally {
    promptRedraw = null;
  }
}

// ^\ — search & replace. Prompts for the needle and replacement, then walks
// matches from the cursor (wrapping), asking per instance unless "All" is chosen.
// The whole operation is a single undo step.
async function replace() {
  const sres = await promptSearch("Search (to replace): ", { ...searchOpts, backward: false });
  if (sres === null || !sres.query) { setMsg("Cancelled"); return; }
  const opts = { ...sres.opts, backward: false };
  searchOpts = { ...opts };
  const q = sres.query;
  lastSearch = q;
  const rep = await promptLine(`Replace with: `);
  if (rep === null) { setMsg("Cancelled"); return; }

  const pre = snap(); // capture once; commit to the undo stack only if we change
  let count = 0, all = false, cancelled = false;
  const n = rows.length;
  for (let step = 0; step < n && !cancelled; step++) {
    const r = (cy + step) % n;
    let c = step === 0 ? cx : 0;
    for (;;) {
      const m = findInLine(rows[r], c, q, opts);
      if (!m) break;
      const hit = m.index;
      cy = r; cx = hit; scroll(); refresh();
      let doIt = all;
      if (!all) {
        const ans = await promptReplace();
        if (ans === "cancel") { cancelled = true; break; }
        if (ans === "a") { all = doIt = true; }
        else doIt = ans === "y";
      }
      if (doIt) {
        rows[r] = rows[r].slice(0, hit) + rep + rows[r].slice(hit + m.len);
        c = hit + rep.length; // resume past the replacement (no re-match loop)
        count++;
      } else {
        c = hit + m.len;
      }
    }
  }
  if (count > 0) {
    undoStack.push(pre);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    coalesceKey = null;
    markDirty();
  }
  clampToDoc();
  setMsg(count ? `Replaced ${count} instance${count === 1 ? "" : "s"}` : `"${q}" not found`);
}

async function gotoLine() {
  const s = await promptLine("Enter line number: ");
  if (!s) { setMsg("Cancelled"); return; }
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) { setMsg("Invalid line number"); return; }
  cy = Math.min(n - 1, rows.length - 1);
  cx = 0;
}
function cursorPosition() {
  const chars = rows.reduce((a, l) => a + l.length + 1, 0) - 1;
  setMsg(`line ${cy + 1}/${rows.length}, col ${cx + 1}, char ${chars < 0 ? 0 : chars}`);
}
async function tryExit() {
  if (dirty) {
    const ans = await promptYesNo("Save modified buffer?");
    if (ans === null) { setMsg("Cancelled"); return false; }
    if (ans === true && !(await saveFile(filename))) return false;
  }
  return true;
}

// ---- main ------------------------------------------------------------------
async function main() {
  // Args: flags then a filename. `-l`/`--linenumbers`, `-L`/`--nolinenumbers`.
  let arg = null;
  for (let i = 1; i < sys.argv.length; i++) {
    const a = sys.argv[i];
    if (a === "-l" || a === "--linenumbers") showLineNumbers = true;
    else if (a === "-L" || a === "--nolinenumbers") showLineNumbers = false;
    else if (!a.startsWith("-")) { arg = a; break; }
  }
  await updateSize();

  // Enter raw + no-echo and the alternate screen. Save termios so we can restore
  // it — register SIGWINCH so a resize re-lays-out — and enable SGR mouse
  // reporting so clicks/scroll arrive as input we decode ourselves.
  const savedAttr = await sys.tcgetattr();
  await sys.tcsetattr({ canonical: false, echo: false, isig: false });
  write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h");
  sys.sighandle("SIGWINCH", true);
  sys.onSignal(async (sig) => {
    if (sig !== "SIGWINCH") return;
    await updateSize();
    // If a message-bar prompt is up, repaint it; otherwise repaint the buffer.
    if (promptRedraw) promptRedraw();
    else { scroll(); refresh(); }
  });

  try {
    if (arg) await loadFile(arg);
    else setMsg("New Buffer");

    for (;;) {
      scroll();
      refresh();
      const k = await nextKey();
      let isCut = false;

      if (k.key === "eof") break; // terminal closed
      else if (k.mouse) handleMouse(k.mouse);
      else if (k.alt) {
        // Meta/Alt chords.
        if (k.alt === "u") undo();
        else if (k.alt === "e") redo();
        else if (k.alt === "6" || k.alt === "^") copySelection();
        else if (k.alt === "d") deleteWordRight();
        else if (k.alt === "n") {
          showLineNumbers = !showLineNumbers;
          setMsg(showLineNumbers ? "Line numbers on" : "Line numbers off");
        } else if (k.alt === "i") {
          autoIndent = !autoIndent;
          setMsg(autoIndent ? "Auto-indent on" : "Auto-indent off");
        } else if (k.alt === "$") {
          softWrap = !softWrap;
          coloff = 0;
          setMsg(softWrap ? "Soft wrap on" : "Soft wrap off");
        } else if (k.alt === "y") {
          syntax = !syntax;
          setMsg(!syntax ? "Syntax highlighting off"
            : lang ? `Syntax highlighting on (${lang})` : "Syntax highlighting on (plain)");
        } else if (k.alt === "t") await setIndent();
      } else if (k.ctrl) {
        switch (k.ctrl) {
          case "X": if (await tryExit()) return; break; // finally restores the TTY
          case "O": await writeOut(); break;
          case "R": await insertFile(); break; // read a file into the buffer
          case "W": await search(); break;
          case "\\": await replace(); break; // ^\ : search & replace
          case "^": toggleMark(); break; // ^6 : set/clear the selection mark
          case "K": isCut = cutLine(); break;
          case "U": pasteCut(); break;
          case "G": setMsg("^O save ^R insert ^W find ^\\ replace ^6 mark M-6 copy M-U/M-E undo/redo M-y syntax M-t indent ^X exit"); break;
          case "C": cursorPosition(); break;
          case "A": gotoHome(); break;
          case "E": gotoEnd(); break;
          case "Y": pageUp(); break;
          case "V": pageDown(); break;
          case "D": deleteForward(); break;
          case "_": await gotoLine(); break;
          case "L": setMsg(""); break; // refresh happens at loop top
          default: break;
        }
      } else if (k.paste !== undefined) insertText(k.paste); // literal block, no auto-indent
      else if (k.char === "\t") insertIndent(); // tabs-vs-spaces per current setting
      else if (k.char) insertChar(k.char);
      else {
        switch (k.key) {
          case "enter": insertNewline(); break;
          case "backspace": backspace(); break;
          case "del": deleteForward(); break;
          case "wdelback": deleteWordLeft(); break;
          case "up": moveUp(); break;
          case "down": moveDown(); break;
          case "left": moveLeft(); break;
          case "right": moveRight(); break;
          case "wordleft": wordLeft(); break;
          case "wordright": wordRight(); break;
          case "home": gotoHome(); break;
          case "end": gotoEnd(); break;
          case "pgup": pageUp(); break;
          case "pgdn": pageDown(); break;
          default: break; // bare ESC and unknowns: ignore
        }
      }
      lastWasCut = isCut;
    }
  } finally {
    // Always restore the terminal, even on error: disable mouse reporting, leave
    // the alternate screen, and put the saved termios back.
    sys.sighandle("SIGWINCH", false);
    write("\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?1049l");
    await sys.tcsetattr(savedAttr);
  }
}

// Run only as a guest program (the worker installs the WorkerOS `sys` ABI).
// Importing this file in plain Node — to unit-test the exported pure helpers — is
// a no-op. (Guard on the ABI shape: Node has an unrelated legacy global `sys`.)
if (typeof sys !== "undefined" && sys && typeof sys.write === "function") await main();
