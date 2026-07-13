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
 *   readFd(fd, max)    — async read from a fd; resolves bytes, empty = EOF
 *   emitter(obj)       — augment obj with the Node EventEmitter surface
 */
export function createTty({ write, isattyFor, getWinsize, getEnv, setRawMode, readFd, emitter }) {
  const isatty = (fd) => isattyFor(fd);
  const fire = (cb) => { if (typeof cb === "function") queueMicrotask(cb); };
  // Buffer / event loop are installed on the global by /bin/node at runtime, after
  // this module is built; resolve them lazily so a ReadStream pump (which only runs
  // once a program starts reading) always sees the live values.
  const asBuf = (bytes) => (globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
  const loop = () => globalThis.__workerosLoop;

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

  // A real readable stdin: a pump loop drains the fd (`readFd`, which blocks in the
  // kernel until keystrokes arrive or EOF) and drives Node's stream surface —
  // flowing (`'data'`/`resume`/`pause`), paused (`'readable'`/`read`), async
  // iteration, `pipe`, and `setEncoding`. This is what makes interactive programs
  // (readline, prompt libraries, scaffolders) actually receive input; before it,
  // `process.stdin` never read the fd so every `on('data')` was silent (INV-5).
  class ReadStream {
    constructor(fd, { isTTY = true } = {}) {
      emitter(this);
      this.fd = fd;
      this.isTTY = isTTY;
      this.isRaw = false;
      this.readable = true;
      this._flowing = false;   // Node flowing mode (emitting 'data')
      this._reading = false;   // a pump loop is in flight
      this._ended = false;     // EOF seen; 'end' emitted
      this._refd = false;      // holding an event-loop ref
      this._encoding = null;   // setEncoding → emit strings
      this._buf = [];          // paused-mode backlog of chunks
      this._decoder = null;
      // Start flowing the instant someone listens for data (Node's semantics); a
      // 'readable' listener arms paused mode. `_onadd` is the light emitter's hook.
      this._onadd = (ev) => {
        if (ev === "data") this.resume();
        else if (ev === "readable" && !this._reading && !this._ended) this._pump();
      };
      // TTY-only control surface (Node's non-tty stdin has no setRawMode).
      if (isTTY) {
        this.setRawMode = (mode) => {
          this.isRaw = !!mode;
          setRawMode(this.fd, !!mode);
          return this;
        };
      }
    }

    _ref() { if (!this._refd) { this._refd = true; loop()?.ref(); } }
    _unref() { if (this._refd) { this._refd = false; loop()?.unref(); } }

    _wrap(bytes) {
      if (!this._encoding) return asBuf(bytes);
      const dec = this._decoder || (this._decoder = new TextDecoder(this._encoding === "utf-8" ? "utf-8" : this._encoding));
      try { return dec.decode(bytes, { stream: true }); } catch { return new TextDecoder().decode(bytes); }
    }

    // The single reader of the fd. In flowing mode it emits each chunk as 'data';
    // if paused mid-read it stashes the chunk and emits 'readable' instead.
    async _pump() {
      if (this._reading || this._ended || this.fd == null) return;
      this._reading = true;
      this._ref();
      try {
        for (;;) {
          // Drain any paused backlog first (a resume after pause).
          while (this._flowing && this._buf.length) this.emit("data", this._buf.shift());
          const bytes = await readFd(this.fd, 1 << 16);
          if (this._ended) break;
          if (!bytes || bytes.length === 0) {
            this._ended = true;
            this.readable = false;
            this.emit("end");
            break;
          }
          const chunk = this._wrap(bytes);
          if (this._flowing) {
            this.emit("data", chunk);
          } else {
            this._buf.push(chunk);
            this.emit("readable");
            break; // paused: stop reading until read()/resume()
          }
        }
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      } finally {
        this._reading = false;
        if (this._ended || !this._flowing) this._unref();
      }
    }

    resume() {
      if (this._ended) return this;
      this._flowing = true;
      this._ref();
      if (!this._reading) this._pump();
      return this;
    }

    pause() { this._flowing = false; return this; }

    setEncoding(enc) { this._encoding = enc; this._decoder = null; return this; }

    // Minimal paused-mode read(): hand back buffered data, else prime one read.
    read() {
      if (this._buf.length) {
        const chunk = this._buf.shift();
        if (!this._buf.length && !this._reading && !this._ended) this._pump();
        return chunk;
      }
      if (!this._reading && !this._ended) this._pump();
      return null;
    }

    pipe(dest) {
      const onData = (chunk) => dest.write(chunk);
      const onEnd = () => { if (typeof dest.end === "function") dest.end(); };
      (this._pipes || (this._pipes = [])).push({ dest, onData, onEnd });
      this.on("data", onData);
      this.once("end", onEnd);
      this.resume();
      return dest;
    }

    // Node's `unpipe([dest])`: detach one piped destination, or all when omitted.
    // Prompt libraries (@clack/prompts, inquirer) call `stdin.unpipe()` during
    // teardown — without it their cleanup throws and the prompt never resolves.
    unpipe(dest) {
      const pipes = this._pipes || [];
      this._pipes = [];
      for (const p of pipes) {
        if (dest && p.dest !== dest) { this._pipes.push(p); continue; }
        this.off("data", p.onData);
        this.off("end", p.onEnd);
      }
      return this;
    }

    ref() { this._ref(); return this; }
    unref() { this._unref(); return this; }
    destroy() { this._ended = true; this.readable = false; this._unref(); this.emit("close"); return this; }
    // `setRawMode` is attached per-instance only when isTTY (constructor), matching
    // Node: a redirected/piped stdin has no setRawMode, which libraries feature-test.

    // `for await (const chunk of process.stdin)` — consume flowing 'data'.
    [Symbol.asyncIterator]() {
      const self = this;
      const queue = [];
      let pending = null;
      let done = false;
      const onData = (c) => { if (pending) { pending({ value: c, done: false }); pending = null; } else queue.push(c); };
      const onEnd = () => { done = true; if (pending) { pending({ value: undefined, done: true }); pending = null; } };
      self.on("data", onData);
      self.once("end", onEnd);
      self.resume();
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => (pending = r));
        },
        return() { self.off("data", onData); self.pause(); return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }

  return { isatty, ReadStream, WriteStream };
}
