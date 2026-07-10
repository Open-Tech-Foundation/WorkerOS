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

const TABSTOP = 8;

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
let cutBuffer = []; // lines held by ^K, pasted by ^U
let lastWasCut = false; // consecutive ^K accumulate into cutBuffer
let showLineNumbers = true; // left gutter with line numbers (toggle: M-N)
let lineEnding = "\n"; // detected on load ("\n" unix, "\r\n" dos, "\r" mac)

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
function restore(s) { rows = s.rows.slice(); cy = s.cy; cx = s.cx; dirty = s.dirty; clampToDoc(); }
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
const markDirty = () => { dirty = true; };

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
    if (line[i] === "\t") { rx += TABSTOP - (rx % TABSTOP); i += 1; continue; }
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
// columns line up exactly.
export function visibleSlice(line, startCol, width) {
  let col = 0, out = "", i = 0;
  const end = startCol + width;
  while (i < line.length) {
    const isTab = line[i] === "\t";
    let cp = 0, adv = 1, w, ctrl = false;
    if (isTab) w = TABSTOP - (col % TABSTOP);
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
    } else {
      out += String.fromCodePoint(cp);
    }
    col = cellEnd;
    i += adv;
  }
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
    if (line[i] === "\t") { w = TABSTOP - (col % TABSTOP); adv = 1; }
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

function scroll() {
  const rx = cxToRx(rows[cy], cx);
  const tw = textWidth();
  if (cy < rowoff) rowoff = cy;
  if (cy >= rowoff + textRows) rowoff = cy - textRows + 1;
  if (rx < coloff) coloff = rx;
  if (rx >= coloff + tw) coloff = rx - tw + 1;
}

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

// Build one full frame and emit it in a single write (no flicker).
function refresh() {
  let out = "\x1b[?25l\x1b[H"; // hide cursor, home

  // Title bar (inverse): program, file, and a modified marker.
  const name = filename || "New Buffer";
  const title = `  nano  ${name}${dirty ? "  *" : ""}`;
  out += INVERSE + fit(title, screenCols) + RESET + "\r\n";

  // Text area, with an optional 24-bit-colored line-number gutter.
  const gw = gutterWidth();
  const tw = textWidth();
  for (let i = 0; i < textRows; i++) {
    const docRow = rowoff + i;
    if (docRow < rows.length) {
      if (gw > 0) {
        const num = String(docRow + 1).padStart(gw - 1);
        out += (docRow === cy ? GUTTER_CUR : GUTTER_DIM) + num + " " + RESET;
      }
      out += visibleSlice(rows[docRow], coloff, tw);
    }
    out += "\x1b[K\r\n";
  }

  // Message bar.
  out += fit(statusmsg, screenCols) + "\r\n";

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

  // Place the cursor and show it (offset past the gutter).
  const screenRow = cy - rowoff + 2; // +1 title, +1 to 1-based
  const screenCol = gw + cxToRx(rows[cy], cx) - coloff + 1;
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
  if (b === 0x1b) return parseEsc();
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
function decodeCsi(final, params) {
  // SGR mouse report: ESC [ < b ; x ; y  (M press / m release).
  if (params[0] === "<") {
    const m = parseMouse(params, final);
    return m ? { mouse: m } : { key: "esc" };
  }
  switch (final) {
    case "A": return { key: "up" };
    case "B": return { key: "down" };
    case "C": return { key: "right" };
    case "D": return { key: "left" };
    case "H": return { key: "home" };
    case "F": return { key: "end" };
    case "~":
      if (params === "1" || params === "7") return { key: "home" };
      if (params === "4" || params === "8") return { key: "end" };
      if (params === "3") return { key: "del" };
      if (params === "5") return { key: "pgup" };
      if (params === "6") return { key: "pgdn" };
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
function insertNewline() {
  pushUndo(null);
  const after = rows[cy].slice(cx);
  rows[cy] = rows[cy].slice(0, cx);
  rows.splice(cy + 1, 0, after);
  cy++;
  cx = 0;
  markDirty();
}
function backspace() {
  if (cx > 0 || cy > 0) pushUndo("delete");
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
function cutLine() {
  pushUndo(lastWasCut ? "cut" : null); // a run of ^K is one undo step
  if (!lastWasCut) cutBuffer = [];
  cutBuffer.push(rows[cy]);
  rows.splice(cy, 1);
  if (rows.length === 0) rows = [""];
  if (cy >= rows.length) cy = rows.length - 1;
  cx = 0;
  markDirty();
}
function pasteCut() {
  if (cutBuffer.length === 0) { setMsg("Cut buffer is empty"); return; }
  pushUndo(null);
  rows.splice(cy, 0, ...cutBuffer);
  cy += cutBuffer.length;
  cx = 0;
  markDirty();
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
  const docRow = rowoff + rel;
  if (docRow >= rows.length) { cy = rows.length - 1; cx = rows[cy].length; return; }
  cy = docRow;
  const rx = coloff + Math.max(0, m.x - 1 - gutterWidth());
  cx = rxToCx(rows[cy], rx);
}

// ---- message-bar prompts ---------------------------------------------------
// A one-line prompt on the message bar. Returns the entered string, or null if
// cancelled (^C / ESC). Handles printable input, backspace, and Enter.
async function promptLine(label, initial = "") {
  let s = initial;
  const draw = () => {
    const shown = label + s;
    write(`\x1b[${screenRows - 2};1H${INVERSE}${fit(shown, screenCols)}${RESET}` +
      `\x1b[${screenRows - 2};${Math.min(dispWidth(shown) + 1, screenCols)}H\x1b[?25h`);
  };
  promptRedraw = draw;
  try {
    for (;;) {
      draw();
      const k = await nextKey();
      if (k.key === "enter") return s;
      if (k.key === "esc" || (k.ctrl === "C")) return null;
      if (k.key === "backspace") s = s.slice(0, -1);
      else if (k.char) s += k.char;
    }
  } finally {
    promptRedraw = null;
  }
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

// ---- file I/O --------------------------------------------------------------
async function loadFile(path) {
  filename = path;
  try {
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
    const text = dec.decode(buf);
    // Detect the line ending so we round-trip DOS/Mac files unchanged, and strip
    // it from the buffer so a stray CR can't corrupt the on-screen rendering.
    lineEnding = /\r\n/.test(text) ? "\r\n" : /\r/.test(text) ? "\r" : "\n";
    const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // A trailing newline yields a phantom empty final element; drop it.
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    rows = parts.length ? parts : [""];
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
  const name = await promptLine("File Name to Write: ", filename || "");
  if (name === null || name === "") { setMsg("Cancelled"); return; }
  await saveFile(name);
}

// ---- commands --------------------------------------------------------------
async function search() {
  const q = await promptLine("Search: ");
  if (!q) { setMsg("Cancelled"); return; }
  // Scan forward from just after the cursor, wrapping around the document.
  const total = rows.length;
  for (let step = 0; step < total; step++) {
    const r = (cy + step) % total;
    const from = step === 0 ? cx + 1 : 0;
    const hit = rows[r].indexOf(q, from);
    if (hit !== -1) { cy = r; cx = hit; setMsg(`Found: ${q}`); return; }
  }
  setMsg(`"${q}" not found`);
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
  const q = await promptLine("Search (to replace): ");
  if (!q) { setMsg("Cancelled"); return; }
  const rep = await promptLine(`Replace "${q}" with: `);
  if (rep === null) { setMsg("Cancelled"); return; }

  const pre = snap(); // capture once; commit to the undo stack only if we change
  let count = 0, all = false, cancelled = false;
  const n = rows.length;
  for (let step = 0; step < n && !cancelled; step++) {
    const r = (cy + step) % n;
    let c = step === 0 ? cx : 0;
    for (;;) {
      const hit = rows[r].indexOf(q, c);
      if (hit === -1) break;
      cy = r; cx = hit; scroll(); refresh();
      let doIt = all;
      if (!all) {
        const ans = await promptReplace();
        if (ans === "cancel") { cancelled = true; break; }
        if (ans === "a") { all = doIt = true; }
        else doIt = ans === "y";
      }
      if (doIt) {
        rows[r] = rows[r].slice(0, hit) + rep + rows[r].slice(hit + q.length);
        c = hit + rep.length; // resume past the replacement (no re-match loop)
        count++;
      } else {
        c = hit + q.length;
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
  write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
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
        // Meta/Alt chords: M-U undo, M-E redo, M-N toggle line numbers.
        if (k.alt === "u") undo();
        else if (k.alt === "e") redo();
        else if (k.alt === "n") {
          showLineNumbers = !showLineNumbers;
          setMsg(showLineNumbers ? "Line numbers on" : "Line numbers off");
        }
      } else if (k.ctrl) {
        switch (k.ctrl) {
          case "X": if (await tryExit()) return; break; // finally restores the TTY
          case "O": await writeOut(); break;
          case "W": await search(); break;
          case "\\": await replace(); break; // ^\ : search & replace
          case "K": cutLine(); isCut = true; break;
          case "U": pasteCut(); break;
          case "G": setMsg("^O save  ^W find  ^\\ replace  M-U/M-E undo/redo  M-N line#s  mouse: click/scroll  ^X exit"); break;
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
      } else if (k.char) insertChar(k.char);
      else {
        switch (k.key) {
          case "enter": insertNewline(); break;
          case "backspace": backspace(); break;
          case "del": deleteForward(); break;
          case "up": moveUp(); break;
          case "down": moveDown(); break;
          case "left": moveLeft(); break;
          case "right": moveRight(); break;
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
    write("\x1b[?1006l\x1b[?1000l\x1b[?1049l");
    await sys.tcsetattr(savedAttr);
  }
}

// Run only as a guest program (the worker installs `sys`). Importing this file
// in plain Node — e.g. to unit-test the exported pure text helpers — is a no-op.
if (typeof sys !== "undefined") await main();
