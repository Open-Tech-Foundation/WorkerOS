// `node:child_process` — running sub-processes from a WorkerOS Node program.
//
// GUEST code (INV-1): the kernel has no `child_process` concept. A child here is
// just another command run through the same shell driver (`wsh`) that services a
// terminal command line — reached via two syscalls the runtime adds on top of the
// existing `exec` primitive:
//
//   • `sys.execCapture(line, input)`      → Promise<{ code, stdout, stderr }>
//   • `sys.execCaptureSync(line, input)`  → { code, stdout, stderr } (blocking)
//
// Both run `line` as a `wsh` command (PATH + `node_modules/.bin` resolution, glob,
// redirects — everything a shell does), feed `input` as its stdin, and hand back
// the exit code with stdout/stderr *captured* (not routed to this process's
// streams). Every API here is built on those two calls.
//
// Honest limits (INV-5): output is buffered and delivered when the child exits —
// there is no live streaming, so `spawn().stdout` emits its `data` once at close,
// not incrementally; and a child can't be signalled mid-run (`kill()` is a
// best-effort flag). `fork()` runs `node <module>` but has no IPC channel. These
// mirror what the shell driver can currently express, and grow with it.

import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";

const enc = new TextEncoder();

const toBytes = (v) =>
  v == null ? new Uint8Array(0) : typeof v === "string" ? enc.encode(v) : new Uint8Array(v.buffer || v);

// POSIX single-quote escaping: wrap in '…', and represent an embedded ' as '\''.
// Used to pass an argv element to the shell as a single literal word — this is
// what makes `execFile`/`spawn` (no-shell APIs) treat their args verbatim, with
// no glob/expansion, even when they contain shell metacharacters.
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Turn a (file, args) pair into a shell line with every word quoted literally.
const quoteArgv = (file, args) => [file, ...(args || [])].map(q).join(" ");

// Wrap `line` so it honors `cwd`/`env` without leaking into the shared shell
// session: a subshell `( … )` snapshots and restores cwd + variables, so a
// `cd`/`export` here is scoped to this one child. `env` is *merged* onto the
// inherited environment (not a hard replacement) — the common
// `{ ...process.env, EXTRA }` case works; a from-scratch env does not (INV-5).
function wrapLine(line, options) {
  const pre = [];
  if (options.cwd != null) pre.push("cd " + q(options.cwd));
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v != null) pre.push("export " + k + "=" + q(v));
    }
  }
  return pre.length ? "( " + pre.join("; ") + "; " + line + " )" : line;
}

// Decode captured bytes per the `encoding` option. `child_process` splits on
// default: the string APIs (`exec`/`execFile`) default to utf8 text, while the
// buffer APIs (`execSync`/`spawnSync`) default to a Buffer. `'buffer'` always
// means a Buffer; any other encoding name means a decoded string.
function decodeOutput(bytes, encoding, defaultString) {
  const buf = Buffer.from(bytes);
  if (encoding === "buffer") return buf;
  if (encoding) return buf.toString(encoding);
  return defaultString ? buf.toString("utf8") : buf;
}

// Normalize the (args, options, callback) tail shared by exec/execFile/spawn:
// `args` may be omitted, and either of the trailing two may be the callback.
function normalizeArgs(args, options, callback) {
  if (typeof args === "function") return { args: [], options: {}, callback: args };
  if (!Array.isArray(args)) return { args: [], ...normalizeOpts(args, options) };
  return { args, ...normalizeOpts(options, callback) };
}
function normalizeOpts(options, callback) {
  if (typeof options === "function") return { options: {}, callback: options };
  return { options: options || {}, callback: typeof callback === "function" ? callback : undefined };
}

export function createChildProcess(sys = globalThis.sys) {
  let nextPid = 90000; // synthetic pids — the shell driver doesn't surface a real one

  // While an async child is running, hold /bin/node's event loop open (as net/http
  // do for live sockets) so the process doesn't exit the instant the script's
  // synchronous top level returns — mirroring how a pending child keeps Node alive.
  // `undefined` outside /bin/node (e.g. a unit test), so guarded.
  const refLoop = () => globalThis.__workerosLoop?.ref();
  const unrefLoop = () => globalThis.__workerosLoop?.unref();

  // A one-shot readable side of a child stream: the whole captured output arrives
  // at once (INV-5 buffered limit), so we emit a single `data` then `end` on the
  // next tick, after the caller has had a turn to attach listeners.
  class ChildStream extends EventEmitter {
    constructor() {
      super();
      this.readable = true;
      this._encoding = null;
    }
    setEncoding(e) { this._encoding = e; return this; }
    pause() { return this; }
    resume() { return this; }
    pipe(dest) {
      this.on("data", (d) => dest.write(d));
      this.on("end", () => dest.end && dest.end());
      return dest;
    }
    _deliver(bytes) {
      if (bytes && bytes.length) {
        this.emit("data", this._encoding ? Buffer.from(bytes).toString(this._encoding) : Buffer.from(bytes));
      }
      this.emit("end");
      this.emit("close");
    }
  }

  // The writable stdin of a child. Writes are buffered; the child is actually
  // launched once stdin is `end()`ed (or, if the caller never touches stdin, on
  // the microtask after `spawn()` returns — see below). This matches the common
  // `child.stdin.write(x); child.stdin.end()` shape; a slow async drip of stdin
  // after other output has been awaited is the honest limit (INV-5).
  class ChildStdin extends EventEmitter {
    constructor(onEnd) {
      super();
      this.writable = true;
      this._chunks = [];
      this._touched = false;
      this._ended = false;
      this._onEnd = onEnd;
    }
    write(chunk, encoding, cb) {
      if (typeof encoding === "function") { cb = encoding; }
      this._touched = true;
      if (chunk != null) this._chunks.push(toBytes(chunk));
      if (cb) queueMicrotask(cb);
      return true;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
      else if (typeof encoding === "function") { cb = encoding; }
      if (chunk != null) this.write(chunk);
      if (!this._ended) {
        this._ended = true;
        this.emit("finish");
        this._onEnd();
      }
      if (cb) queueMicrotask(cb);
    }
    _input() {
      if (this._chunks.length === 0) return null;
      let n = 0;
      for (const c of this._chunks) n += c.length;
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of this._chunks) { out.set(c, o); o += c.length; }
      return out;
    }
  }

  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this.pid = nextPid++;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.stdout = new ChildStream();
      this.stderr = new ChildStream();
      let launch;
      this.stdin = new ChildStdin(() => launch && launch());
      this._setLaunch = (fn) => { launch = fn; };
    }
    // Honest limit (INV-5): a buffered child can't be signalled once running.
    // Flag it as Node does and report the request as delivered.
    kill(signal) {
      this.killed = true;
      this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
      return true;
    }
    ref() { return this; }
    unref() { return this; }
    // No IPC channel for `fork` (INV-5) — the message never sends.
    send() { return false; }
    disconnect() {}
  }

  // Launch a ChildProcess: run `line` (with any buffered stdin), then fan the
  // captured result out onto the child's streams and lifecycle events.
  function runChild(child, line) {
    const input = child.stdin._input();
    refLoop();
    sys
      .execCapture(line, input)
      .then(({ code, stdout, stderr }) => {
        child.exitCode = code;
        child.stdout._deliver(stdout);
        child.stderr._deliver(stderr);
        // A signalled child reports code null + the signal, as in Node.
        const sig = child.killed ? child.signalCode : null;
        child.emit("exit", sig ? null : code, sig);
        child.emit("close", sig ? null : code, sig);
      })
      .catch((e) => child.emit("error", e instanceof Error ? e : new Error(String(e))))
      .finally(unrefLoop);
    return child;
  }

  // spawn(command[, args][, options]) — the streaming-shaped API (buffered here).
  function spawn(command, args, options) {
    const n = normalizeArgs(args, options, undefined);
    const opts = n.options;
    const useShell = opts.shell;
    const base = useShell ? [command, ...(n.args || [])].join(" ") : quoteArgv(command, n.args);
    const line = wrapLine(base, opts);
    const child = new ChildProcess();
    let launched = false;
    const launch = () => { if (launched) return; launched = true; runChild(child, line); };
    child._setLaunch(launch);
    // Launch once stdin is closed; if the caller never writes stdin, launch on the
    // next microtask (after synchronous setup runs), with no stdin.
    queueMicrotask(() => { if (!child.stdin._touched || child.stdin._ended) launch(); });
    return child;
  }

  // exec(command[, options][, callback]) — run a shell command, buffer output.
  function exec(command, options, callback) {
    const { options: opts, callback: cb } = normalizeOpts(options, callback);
    const line = wrapLine(command, opts);
    const child = new ChildProcess();
    child._setLaunch(() => {});
    refLoop();
    sys
      .execCapture(line, toBytes(opts.input).length ? toBytes(opts.input) : null)
      .then(({ code, stdout, stderr }) => {
        const so = decodeOutput(stdout, opts.encoding, true);
        const se = decodeOutput(stderr, opts.encoding, true);
        child.exitCode = code;
        child.stdout._deliver(stdout);
        child.stderr._deliver(stderr);
        child.emit("exit", code, null);
        child.emit("close", code, null);
        if (code !== 0) {
          const err = new Error("Command failed: " + command + (se ? "\n" + se : ""));
          err.code = code;
          err.cmd = command;
          if (cb) cb(err, so, se);
        } else if (cb) cb(null, so, se);
      })
      .catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        child.emit("error", err);
        if (cb) cb(err, decodeOutput(new Uint8Array(0), opts.encoding, true), "");
      })
      .finally(unrefLoop);
    return child;
  }

  // execFile(file[, args][, options][, callback]) — no shell; args passed literally.
  function execFile(file, args, options, callback) {
    const n = normalizeArgs(args, options, callback);
    return exec(quoteArgv(file, n.args), n.options, n.callback);
  }

  // fork(modulePath[, args][, options]) — run `node <module>` as a child. No IPC.
  function fork(modulePath, args, options) {
    const n = normalizeArgs(args, options, undefined);
    return spawn("node", [modulePath, ...(n.args || [])], n.options);
  }

  // ---- synchronous forms (block on the sync-syscall channel) ----------------

  function runSync(line, options) {
    const input = toBytes(options.input);
    return sys.execCaptureSync(line, input.length ? input : null);
  }

  // execSync(command[, options]) — returns stdout (Buffer, or string w/ encoding);
  // throws on a non-zero exit, with `.status`/`.stdout`/`.stderr` attached.
  function execSync(command, options = {}) {
    const { code, stdout, stderr } = runSync(wrapLine(command, options), options);
    if (code !== 0) {
      const err = new Error("Command failed: " + command);
      err.status = code;
      err.stdout = decodeOutput(stdout, options.encoding, false);
      err.stderr = decodeOutput(stderr, options.encoding, false);
      throw err;
    }
    return decodeOutput(stdout, options.encoding, false);
  }

  function execFileSync(file, args, options) {
    const n = normalizeArgs(args, options, undefined);
    return execSync(quoteArgv(file, n.args), n.options);
  }

  // spawnSync(command[, args][, options]) — the object-returning synchronous form.
  function spawnSync(command, args, options) {
    const n = normalizeArgs(args, options, undefined);
    const opts = n.options;
    const base = opts.shell ? [command, ...(n.args || [])].join(" ") : quoteArgv(command, n.args);
    let result;
    try {
      result = runSync(wrapLine(base, opts), opts);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { pid: nextPid++, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error: err };
    }
    const stdout = decodeOutput(result.stdout, opts.encoding, false);
    const stderr = decodeOutput(result.stderr, opts.encoding, false);
    return {
      pid: nextPid++,
      output: [null, stdout, stderr],
      stdout,
      stderr,
      status: result.code,
      signal: null,
      error: undefined,
    };
  }

  const mod = {
    spawn,
    exec,
    execFile,
    fork,
    execSync,
    execFileSync,
    spawnSync,
    ChildProcess,
  };
  mod.default = mod;
  return mod;
}
