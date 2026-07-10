// `node:tty` — the terminal streams and `isatty`, for the WorkerOS Node runtime.
//
// GUEST code (INV-1): a real `tty` module, not a chalk-shaped stub. It covers the
// module's public surface — `isatty`, plus `WriteStream` (the cursor/erase control
// methods, `getWindowSize`, `getColorDepth`, `hasColors`) and `ReadStream`
// (`setRawMode`, wired to the kernel line discipline). The control methods emit the
// exact CSI sequences Node's own `readline` writes, so a TUI driving `process.stdout`
// paints identically. Pure over injected primitives (write / isatty / winsize / env
// / raw-mode / an EventEmitter factory), so the module owns no I/O and stays
// swappable; `/bin/node` supplies the primitives from the syscall surface.

const enc = new TextEncoder();
const asBytes = (s) => (typeof s === "string" ? enc.encode(s) : new Uint8Array(s));

// Node's `WriteStream.getColorDepth` heuristic (a documented subset): FORCE_COLOR
// wins, then COLORTERM/TERM. Returns color *bit depth* — 1 (mono, 2 colors),
// 4 (16), 8 (256), 24 (16m) — the same integers Node returns.
export function colorDepth(env = {}) {
  const fc = env.FORCE_COLOR;
  if (fc != null && fc !== "") {
    if (fc === "0" || fc === "false") return 1;
    if (fc === "1" || fc === "true") return 4;
    if (fc === "2") return 8;
    if (fc === "3") return 24;
  }
  const term = String(env.TERM || "").toLowerCase();
  if (term === "dumb") return 1;
  const colorterm = String(env.COLORTERM || "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (/-256(color)?$/.test(term)) return 8;
  if (env.COLORTERM != null || /^(screen|xterm|vt100|vt220|rxvt|ansi|cygwin|linux)/.test(term) || /color/.test(term))
    return 4;
  return 1;
}

/**
 * Build the `node:tty` module over the runtime primitives:
 *   write(fd, bytes)   — emit to a terminal fd
 *   isattyFor(fd)      — synchronous "is fd a terminal" (probed at startup)
 *   getWinsize()       — current { cols, rows }
 *   getEnv()           — the live process.env (for color detection)
 *   setRawMode(fd, on) — flip the kernel line discipline (tcsetattr)
 *   emitter(obj)       — augment obj with the Node EventEmitter surface
 */
export function createTty({ write, isattyFor, getWinsize, getEnv, setRawMode, emitter }) {
  const isatty = (fd) => isattyFor(fd);
  const fire = (cb) => { if (typeof cb === "function") queueMicrotask(cb); };

  class WriteStream {
    constructor(fd) {
      emitter(this);
      this.fd = fd;
      this.isTTY = true;
      this.writable = true;
      const { cols, rows } = getWinsize();
      this.columns = cols;
      this.rows = rows;
    }
    write(chunk, encoding, cb) {
      write(this.fd, asBytes(chunk));
      fire(typeof encoding === "function" ? encoding : cb);
      return true;
    }
    _csi(seq) { write(this.fd, enc.encode(seq)); }
    // cursorTo(x[, y][, cb]): absolute column (…G) or row;col (…H) — Node's escapes.
    cursorTo(x, y, cb) {
      if (typeof y === "function") { cb = y; y = undefined; }
      this._csi(y == null ? `\x1b[${(x | 0) + 1}G` : `\x1b[${(y | 0) + 1};${(x | 0) + 1}H`);
      fire(cb);
      return true;
    }
    // moveCursor(dx, dy[, cb]): relative move (C/D columns, B/A rows).
    moveCursor(dx, dy, cb) {
      let seq = "";
      if (dx > 0) seq += `\x1b[${dx}C`; else if (dx < 0) seq += `\x1b[${-dx}D`;
      if (dy > 0) seq += `\x1b[${dy}B`; else if (dy < 0) seq += `\x1b[${-dy}A`;
      if (seq) this._csi(seq);
      fire(cb);
      return true;
    }
    // clearLine(dir[, cb]): -1 to start (1K), 1 to end (0K), 0 whole line (2K).
    clearLine(dir, cb) {
      this._csi(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K");
      fire(cb);
      return true;
    }
    clearScreenDown(cb) { this._csi("\x1b[0J"); fire(cb); return true; }
    getWindowSize() { const { cols, rows } = getWinsize(); return [cols, rows]; }
    getColorDepth(env) { return colorDepth(env || getEnv()); }
    hasColors(count, env) {
      if (count != null && typeof count === "object") { env = count; count = undefined; }
      return 2 ** colorDepth(env || getEnv()) >= (count || 16);
    }
    end(chunk, encoding, cb) {
      if (chunk != null && typeof chunk !== "function") this.write(chunk, encoding);
      this.writable = false;
      fire(typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : cb);
      return this;
    }
  }

  class ReadStream {
    constructor(fd) {
      emitter(this);
      this.fd = fd;
      this.isTTY = true;
      this.isRaw = false;
      this.readable = true;
    }
    // Node returns `this` synchronously; the kernel line-discipline switch is
    // applied asynchronously (honest limit, INV-5) — raw = no canon/echo/isig.
    setRawMode(mode) {
      this.isRaw = !!mode;
      setRawMode(this.fd, !!mode);
      return this;
    }
  }

  return { isatty, ReadStream, WriteStream };
}
