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
  }

  setPrompt(prompt) {
    this._prompt = String(prompt);
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
