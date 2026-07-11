// `node:readline` — a pragmatic line-reader over the current WorkerOS Node I/O.
//
// GUEST code (INV-1): this reuses what the runtime already has instead of
// inventing a second line discipline. Today stdin is a cooked fd for guest
// programs, not an evented raw-keypress stream, so `question()` reads a whole line
// from the input fd (or an input stream that emits `data`) and the cursor helpers
// delegate to the existing tty.WriteStream methods.

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
function emitKeypressEvents() {
  // Honest limit (INV-5): process.stdin is not an evented raw-byte stream yet, so
  // keypress synthesis is intentionally absent rather than faked.
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
