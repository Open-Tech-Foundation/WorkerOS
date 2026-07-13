// `node:readline` — a pragmatic line-reader over the current WorkerOS Node I/O.
//
// GUEST code (INV-1): this reuses what the runtime already has instead of
// inventing a second line discipline. `question()` reads a whole line from the
// input fd (or an input stream that emits `data`) and the cursor helpers delegate
// to the existing tty.WriteStream methods. `emitKeypressEvents` decodes the now-
// real evented `process.stdin` byte stream into Node-style `keypress` events, so
// arrow-key prompt libraries (prompts/enquirer/inquirer) work in raw mode.

import { EventEmitter } from "./events.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const toBytes = (chunk) => (typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk));

function writeOut(output, chunk) {
  if (!output) return;
  if (typeof output.write === "function") output.write(chunk);
}

function normalizeLine(bytes) {
  let text = dec.decode(bytes);
  text = text.replace(/\r?\n$/, "");
  return text.replace(/\r$/, "");
}

async function readLineFromFd(input, sys) {
  if (!sys || typeof sys.read !== "function") throw new Error("readline requires sys.read for fd-backed input");
  const fd = typeof input?.fd === "number" ? input.fd : 0;
  const chunks = [];
  for (;;) {
    const b = await sys.read(fd, 1 << 16);
    if (!b || b.length === 0) break;
    chunks.push(b);
    if (b.includes?.(10) || b.includes?.(13)) break;
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return normalizeLine(out);
}

function readLineFromStream(input) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const cleanup = () => {
      input.off?.("data", onData);
      input.off?.("end", onEnd);
      input.off?.("error", onError);
      input.off?.("close", onEnd);
    };
    const finish = () => {
      cleanup();
      resolve(normalizeLine(parts.length === 1 ? parts[0] : concat(parts)));
    };
    const onData = (chunk) => {
      const bytes = toBytes(chunk);
      parts.push(bytes);
      if (bytes.includes?.(10) || bytes.includes?.(13)) finish();
    };
    const onEnd = () => finish();
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    input.on?.("data", onData);
    input.on?.("end", onEnd);
    input.on?.("close", onEnd);
    input.on?.("error", onError);
    if (typeof input.resume === "function") input.resume();
  });
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function readLine(input, sys) {
  if (input && typeof input.fd === "number") return readLineFromFd(input, sys);
  if (input && typeof input.on === "function") return readLineFromStream(input);
  return readLineFromFd(input, sys);
}

class Interface extends EventEmitter {
  constructor({ input, output, terminal = !!output?.isTTY, prompt = "", sys = globalThis.sys } = {}) {
    super();
    this.input = input || globalThis.process?.stdin || { fd: 0 };
    this.output = output || globalThis.process?.stdout;
    this.terminal = terminal;
    this._prompt = String(prompt);
    this._sys = sys;
    this.closed = false;
    // Node's readline maintains an editable input buffer + cursor that prompt
    // libraries read back: @clack/prompts, inquirer, and prompts all drive the
    // prompt off `rl.line`/`rl.cursor` and feed it with `rl.write(...)`.
    this.line = "";
    this.cursor = 0;
    // A terminal interface consumes the tty as a Node `keypress` stream — what
    // those libraries listen for — and, like Node, holds the event loop open while
    // open. Start the decoder + flowing read now (so keypresses flow and the
    // process doesn't idle-exit before the first key) and run the line editor
    // ahead of the user's own keypress handler (registered later), so their
    // handler sees an up-to-date `rl.line`. `close()` tears both down.
    if (this.terminal && this.input && typeof this.input.on === "function") {
      emitKeypressEvents(this.input, this);
      this._onKeypress = (str, key) => this._editKeypress(str, key);
      this.input.on("keypress", this._onKeypress);
      if (typeof this.input.resume === "function") this.input.resume();
    }
  }

  // Apply one decoded keypress to the line buffer, mirroring Node's readline line
  // discipline (the subset prompt libraries rely on). Editing is silent — a
  // terminal interface created without an `output` (as @clack does) renders the
  // prompt itself; we only maintain `line`/`cursor` and emit `line` on Enter.
  _editKeypress(str, key) {
    if (this.closed) return;
    key = key || {};
    const name = key.name;
    if (key.ctrl && !key.meta) {
      switch (name) {
        case "c": this.emit("SIGINT"); if (this.listenerCount("SIGINT") === 0) this.close(); return;
        case "h": this._backspace(); return;               // Ctrl-H → backspace
        case "d": if (this.line === "") this.close(); return; // Ctrl-D on empty → EOF
        case "u": this.line = this.line.slice(this.cursor); this.cursor = 0; return; // kill to start
        case "k": this.line = this.line.slice(0, this.cursor); return;               // kill to end
        case "a": this.cursor = 0; return;
        case "e": this.cursor = this.line.length; return;
        case "b": if (this.cursor > 0) this.cursor--; return;
        case "f": if (this.cursor < this.line.length) this.cursor++; return;
        case "w": this._deleteWordLeft(); return;
        default: return; // other control combos: no line edit
      }
    }
    if (key.meta) return;
    switch (name) {
      case "return":
      case "enter": {
        const line = this.line;
        this.line = ""; this.cursor = 0;
        this.emit("line", line);
        return;
      }
      case "backspace": this._backspace(); return;
      case "delete": this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1); return;
      case "left": if (this.cursor > 0) this.cursor--; return;
      case "right": if (this.cursor < this.line.length) this.cursor++; return;
      case "home": this.cursor = 0; return;
      case "end": this.cursor = this.line.length; return;
      case "up": case "down": case "tab": case "escape":
      case "pageup": case "pagedown": case "insert":
        return; // navigation/history: not part of the buffer
      default:
        // A printable key (letter, digit, punctuation, or Space) — insert its text.
        if (str) {
          this.line = this.line.slice(0, this.cursor) + str + this.line.slice(this.cursor);
          this.cursor += str.length;
        }
    }
  }

  _backspace() {
    if (this.cursor > 0) {
      this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
      this.cursor--;
    }
  }

  _deleteWordLeft() {
    let i = this.cursor;
    while (i > 0 && this.line[i - 1] === " ") i--;
    while (i > 0 && this.line[i - 1] !== " ") i--;
    this.line = this.line.slice(0, i) + this.line.slice(this.cursor);
    this.cursor = i;
  }

  // `rl.write(data[, key])` — programmatically drive the editor: a string is
  // inserted as typed text; `write(null, key)` applies one key action (Ctrl-U to
  // clear, Ctrl-H to backspace, etc.). This is how @clack seeds/replaces a value.
  write(data, key) {
    if (this.closed) return;
    if (key) { this._editKeypress(typeof data === "string" ? data : "", key); return; }
    if (data == null) return;
    for (const ch of String(data)) this._editKeypress(ch, keyFromChar(ch));
  }

  setPrompt(prompt) {
    this._prompt = String(prompt);
  }

  getPrompt() {
    return this._prompt;
  }

  // The cursor's position (relative to the start of the prompt), accounting for
  // explicit newlines and terminal-width wrapping. Inquirer's ScreenManager reads
  // this on every render to place the caret; without it `new ScreenManager` throws
  // "rl.getCursorPos is not a function" (e.g. `npm create hono`'s prompts). One
  // column per code point (no East-Asian-width table) is close enough for the
  // ASCII prompts these libraries draw.
  getCursorPos() {
    const cols = this.output?.columns || 80;
    const str = this._prompt + this.line.slice(0, this.cursor);
    let rows = 0;
    let col = 0;
    for (const ch of str) {
      if (ch === "\n") {
        rows++;
        col = 0;
      } else {
        col++;
        if (col >= cols) { // wrap to the next display row at the right edge
          rows++;
          col = 0;
        }
      }
    }
    return { cols: col, rows };
  }

  prompt(preserveCursor) {
    writeOut(this.output, this._prompt);
    if (!preserveCursor) this.emit("prompt");
    return this;
  }

  async question(query, cb) {
    if (this.closed) throw new Error("readline was closed");
    if (query) writeOut(this.output, query);
    const line = await readLine(this.input, this._sys);
    this.emit("line", line);
    if (cb) cb(line);
    return line;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // Stop consuming the tty and release the event-loop hold (undo what the
    // constructor armed for a terminal interface) so the process can exit.
    const inp = this.input;
    if (inp && this._onKeypress) { inp.off?.("keypress", this._onKeypress); this._onKeypress = null; }
    if (inp && inp._keypressDecoder) {
      inp.off?.("data", inp._keypressDecoder);
      inp._keypressDecoder = null;
    }
    if (this.terminal && inp && typeof inp.pause === "function") inp.pause();
    this.emit("close");
  }

  pause() { return this; }
  resume() { return this; }
}

function createInterface(options) {
  return new Interface(options);
}

function cursorTo(stream, x, y, cb) {
  return stream.cursorTo(x, y, cb);
}
function moveCursor(stream, dx, dy, cb) {
  return stream.moveCursor(dx, dy, cb);
}
function clearLine(stream, dir, cb) {
  return stream.clearLine(dir, cb);
}
function clearScreenDown(stream, cb) {
  return stream.clearScreenDown(cb);
}
// ---- keypress decoding -----------------------------------------------------
// Turn a raw byte stream into Node's `keypress` (str, key) events. Enough of
// Node's readline decoder for the prompt libraries the ecosystem relies on:
// printable chars, Enter/Tab/Backspace/Escape/Space, Ctrl-<letter>, arrow keys,
// Home/End/Insert/Delete/PageUp/PageDown, F1–F12, xterm modifier params
// (`ESC[1;5A` = Ctrl-Up), SS3 (`ESC O A`), and Alt/meta (`ESC <char>`).

const CSI_LETTER = { A: "up", B: "down", C: "right", D: "left", E: "clear", F: "end", H: "home" };
const CSI_TILDE = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
};

function applyMods(key, modCode) {
  const m = (modCode | 0) - 1;
  if (m > 0) { if (m & 1) key.shift = true; if (m & 2) key.meta = true; if (m & 4) key.ctrl = true; }
  return key;
}

// A key from a single non-escape character.
function keyFromChar(ch) {
  const key = { sequence: ch, name: undefined, ctrl: false, meta: false, shift: false };
  const code = ch.charCodeAt(0);
  if (ch === "\r") key.name = "return";
  else if (ch === "\n") key.name = "enter";
  else if (ch === "\t") key.name = "tab";
  else if (ch === "\x7f" || ch === "\b") key.name = "backspace";
  else if (ch === "\x1b") key.name = "escape";
  else if (ch === " ") key.name = "space";
  else if (code >= 1 && code <= 26) { key.name = String.fromCharCode(code + 96); key.ctrl = true; } // Ctrl-a…z
  else if (/^[a-z]$/.test(ch)) key.name = ch;
  else if (/^[A-Z]$/.test(ch)) { key.name = ch.toLowerCase(); key.shift = true; }
  // other printables (digits/punctuation): name stays undefined; `sequence` carries it.
  return key;
}

// Decode the first key in `s`. Returns [consumed, key] (key may be null for an
// ignored sequence), or null if `s` is an incomplete escape sequence (need more).
function nextKey(s) {
  if (s.length === 0) return null;
  if (s[0] !== "\x1b") return [1, keyFromChar(s[0])];
  if (s.length === 1) return null; // lone ESC — caller flushes as Escape on idle
  const c1 = s[1];
  if (c1 !== "[" && c1 !== "O") {
    // Alt/meta + the following key (e.g. ESC a = Alt-a, ESC \x7f = Alt-Backspace).
    const inner = keyFromChar(c1);
    inner.meta = true;
    inner.sequence = s.slice(0, 2);
    return [2, inner];
  }
  let i = 2;
  let params = "";
  if (c1 === "[") while (i < s.length && /[0-9;]/.test(s[i])) params += s[i++];
  if (i >= s.length) return null; // no final byte yet
  const final = s[i++];
  const seq = s.slice(0, i);
  const parts = params.split(";");
  let key;
  if (final === "~") {
    key = { sequence: seq, name: CSI_TILDE[parseInt(parts[0], 10)], ctrl: false, meta: false, shift: false };
    applyMods(key, parts[1]);
  } else if (final === "Z") {
    key = { sequence: seq, name: "tab", ctrl: false, meta: false, shift: true };
  } else if (CSI_LETTER[final]) {
    key = { sequence: seq, name: CSI_LETTER[final], ctrl: false, meta: false, shift: false };
    applyMods(key, parts[1]); // xterm form ESC[1;<mod><letter>
  } else {
    return [i, null]; // unrecognized: consume, emit nothing
  }
  return [i, key];
}

// Install the keypress decoder on a stream. Idempotent. As raw bytes arrive it
// emits `stream.emit('keypress', str, key)` — `str` is the printable text (or
// undefined for a pure control key), `key` is `{ sequence, name, ctrl, meta, shift }`.
function emitKeypressEvents(stream, _iface) {
  if (!stream || stream._keypressDecoder) return;
  let buf = "";
  let escTimer = null;
  const flushLoneEsc = () => {
    escTimer = null;
    if (buf === "\x1b") { buf = ""; stream.emit("keypress", "\x1b", keyFromChar("\x1b")); }
  };
  const decoder = (chunk) => {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    buf += typeof chunk === "string" ? chunk : dec.decode(toBytes(chunk));
    for (;;) {
      const res = nextKey(buf);
      if (res === null) break; // incomplete — wait for more bytes
      const [consumed, key] = res;
      buf = buf.slice(consumed);
      if (!key) continue;
      // `str` is the printable text for a typed character (incl. space), else
      // undefined for control/navigation keys — matching Node's keypress arg.
      const seq = key.sequence;
      const str = seq.length === 1 && seq >= " " && seq <= "~" ? seq : undefined;
      stream.emit("keypress", str, key);
    }
    // A trailing lone ESC is the Escape key once no continuation follows; our TTY
    // delivers a sequence in one chunk, so a short timer disambiguates cleanly.
    if (buf === "\x1b") escTimer = setTimeout(flushLoneEsc, 3);
  };
  stream._keypressDecoder = decoder;
  stream.on("data", decoder);
  if (typeof stream.resume === "function") stream.resume();
}

const promises = {
  Interface,
  createInterface,
};

export function createReadline(sys = globalThis.sys) {
  const bindInterface = (options) => new Interface({ ...options, sys: options?.sys || sys });
  const promises = {
    Interface,
    createInterface: bindInterface,
  };
  const readline = {
    Interface,
    createInterface: bindInterface,
    cursorTo,
    moveCursor,
    clearLine,
    clearScreenDown,
    emitKeypressEvents,
    promises,
  };
  readline.default = readline;
  return readline;
}

const readline = createReadline();
const defaultPromises = readline.promises;

const exported = {
  Interface,
  createInterface: readline.createInterface,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  emitKeypressEvents,
  promises: defaultPromises,
};

export {
  Interface,
  createInterface,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  emitKeypressEvents,
  promises,
  readline,
};
export default readline;
