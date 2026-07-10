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

const setMsg = (m) => { statusmsg = m; };
const markDirty = () => { dirty = true; };

async function updateSize() {
  const ws = await sys.winsize();
  screenRows = Math.max(ws.rows | 0, 4);
  screenCols = Math.max(ws.cols | 0, 8);
  textRows = Math.max(screenRows - 4, 1);
}

// ---- rendering helpers -----------------------------------------------------
// Expand tabs to the next tab stop; returns the on-screen form of a line.
function renderRow(line) {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\t") out += " ".repeat(TABSTOP - (out.length % TABSTOP));
    else out += line[i];
  }
  return out;
}
// Map a cursor column (in chars) to a render column (accounting for tabs).
function cxToRx(line, col) {
  let rx = 0;
  for (let i = 0; i < col && i < line.length; i++) {
    if (line[i] === "\t") rx += TABSTOP - (rx % TABSTOP);
    else rx++;
  }
  return rx;
}

function scroll() {
  const rx = cxToRx(rows[cy], cx);
  if (cy < rowoff) rowoff = cy;
  if (cy >= rowoff + textRows) rowoff = cy - textRows + 1;
  if (rx < coloff) coloff = rx;
  if (rx >= coloff + screenCols) coloff = rx - screenCols + 1;
}

const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

// Pad/truncate a plain string to exactly `n` columns.
const fit = (s, n) => (s.length > n ? s.slice(0, n) : s + " ".repeat(n - s.length));

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

  // Text area.
  for (let i = 0; i < textRows; i++) {
    const docRow = rowoff + i;
    if (docRow < rows.length) {
      const rendered = renderRow(rows[docRow]);
      out += rendered.slice(coloff, coloff + screenCols);
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
    shortcut("^K", "Cut"),
    shortcut("^C", "Cur Pos"),
  ].join("  ");
  const bar2 = [
    shortcut("^X", "Exit"),
    shortcut("^U", "Paste"),
    shortcut("^A", "Home"),
    shortcut("^E", "End"),
    shortcut("^_", "Go To Line"),
  ].join("  ");
  // fit() can't count the invisible ANSI, so just clear-to-EOL after each.
  out += bar1 + "\x1b[K\r\n";
  out += bar2 + "\x1b[K";

  // Place the cursor and show it.
  const screenRow = cy - rowoff + 2; // +1 title, +1 to 1-based
  const screenCol = cxToRx(rows[cy], cx) - coloff + 1;
  out += `\x1b[${screenRow};${screenCol}H\x1b[?25h`;
  write(out);
}

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

// After ESC: recognize CSI (ESC [ …) and SS3 (ESC O …) navigation sequences.
async function parseEsc() {
  const c = await nextByte();
  if (c !== 0x5b && c !== 0x4f) return { key: "esc" }; // lone ESC / Alt-key
  let params = "";
  for (;;) {
    const d = await nextByte();
    if (d === -1) return { key: "esc" };
    if (d >= 0x40 && d <= 0x7e) return decodeCsi(String.fromCharCode(d), params);
    params += String.fromCharCode(d);
  }
}
function decodeCsi(final, params) {
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
  rows[cy] = rows[cy].slice(0, cx) + ch + rows[cy].slice(cx);
  cx += ch.length;
  markDirty();
}
function insertNewline() {
  const after = rows[cy].slice(cx);
  rows[cy] = rows[cy].slice(0, cx);
  rows.splice(cy + 1, 0, after);
  cy++;
  cx = 0;
  markDirty();
}
function backspace() {
  if (cx > 0) {
    rows[cy] = rows[cy].slice(0, cx - 1) + rows[cy].slice(cx);
    cx--;
    markDirty();
  } else if (cy > 0) {
    const prevLen = rows[cy - 1].length;
    rows[cy - 1] += rows[cy];
    rows.splice(cy, 1);
    cy--;
    cx = prevLen;
    markDirty();
  }
}
function deleteForward() {
  if (cx < rows[cy].length) {
    rows[cy] = rows[cy].slice(0, cx) + rows[cy].slice(cx + 1);
    markDirty();
  } else if (cy < rows.length - 1) {
    rows[cy] += rows[cy + 1];
    rows.splice(cy + 1, 1);
    markDirty();
  }
}
function cutLine() {
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
  rows.splice(cy, 0, ...cutBuffer);
  cy += cutBuffer.length;
  cx = 0;
  markDirty();
}

// ---- cursor movement -------------------------------------------------------
function clampCx() { if (cx > rows[cy].length) cx = rows[cy].length; }
function moveLeft() {
  if (cx > 0) cx--;
  else if (cy > 0) { cy--; cx = rows[cy].length; }
}
function moveRight() {
  if (cx < rows[cy].length) cx++;
  else if (cy < rows.length - 1) { cy++; cx = 0; }
}
function moveUp() { if (cy > 0) { cy--; clampCx(); } }
function moveDown() { if (cy < rows.length - 1) { cy++; clampCx(); } }
function pageUp() { cy = Math.max(0, cy - textRows); clampCx(); }
function pageDown() { cy = Math.min(rows.length - 1, cy + textRows); clampCx(); }

// ---- message-bar prompts ---------------------------------------------------
// A one-line prompt on the message bar. Returns the entered string, or null if
// cancelled (^C / ESC). Handles printable input, backspace, and Enter.
async function promptLine(label, initial = "") {
  let s = initial;
  for (;;) {
    const shown = label + s;
    write(`\x1b[${screenRows - 2};1H${INVERSE}${fit(shown, screenCols)}${RESET}` +
      `\x1b[${screenRows - 2};${Math.min(shown.length + 1, screenCols)}H\x1b[?25h`);
    const k = await nextKey();
    if (k.key === "enter") return s;
    if (k.key === "esc" || (k.ctrl === "C")) return null;
    if (k.key === "backspace") s = s.slice(0, -1);
    else if (k.char) s += k.char;
  }
}
// A yes/no/cancel prompt. Returns true (yes), false (no), or null (cancel).
async function promptYesNo(label) {
  write(`\x1b[${screenRows - 2};1H${INVERSE}${fit(label + " [Y/N]", screenCols)}${RESET}`);
  for (;;) {
    const k = await nextKey();
    if (k.char === "y" || k.char === "Y") return true;
    if (k.char === "n" || k.char === "N") return false;
    if (k.key === "esc" || k.ctrl === "C") return null;
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
    const parts = dec.decode(buf).split("\n");
    // A trailing newline yields a phantom empty final element; drop it.
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    rows = parts.length ? parts : [""];
    setMsg(`Read ${rows.length} line${rows.length === 1 ? "" : "s"}`);
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
  // Join with newlines; a non-empty buffer gets a trailing newline (POSIX text).
  const body = rows.length === 1 && rows[0] === "" ? "" : rows.join("\n") + "\n";
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
  const arg = sys.argv[1];
  await updateSize();

  // Enter raw + no-echo and the alternate screen. Save termios so we can restore
  // it — and register SIGWINCH so a resize re-lays-out.
  const savedAttr = await sys.tcgetattr();
  await sys.tcsetattr({ canonical: false, echo: false, isig: false });
  write("\x1b[?1049h");
  sys.sighandle("SIGWINCH", true);
  sys.onSignal(async (sig) => {
    if (sig === "SIGWINCH") { await updateSize(); scroll(); refresh(); }
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
      else if (k.ctrl) {
        switch (k.ctrl) {
          case "X": if (await tryExit()) return; break; // finally restores the TTY
          case "O": await writeOut(); break;
          case "W": await search(); break;
          case "K": cutLine(); isCut = true; break;
          case "U": pasteCut(); break;
          case "G": setMsg("nano: type to edit; ^O write out, ^X exit"); break;
          case "C": cursorPosition(); break;
          case "A": cx = 0; break;
          case "E": cx = rows[cy].length; break;
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
          case "home": cx = 0; break;
          case "end": cx = rows[cy].length; break;
          case "pgup": pageUp(); break;
          case "pgdn": pageDown(); break;
          default: break; // bare ESC and unknowns: ignore
        }
      }
      lastWasCut = isCut;
    }
  } finally {
    // Always restore the terminal, even on error.
    sys.sighandle("SIGWINCH", false);
    write("\x1b[?1049l");
    await sys.tcsetattr(savedAttr);
  }
}

await main();
