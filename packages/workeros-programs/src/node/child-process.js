// `node:child_process` — running sub-processes from a WorkerOS Node program.
//
// GUEST code (INV-1): the kernel has no `child_process` concept. A child is just
// another process the kernel spawns; this module drives it over syscalls the
// runtime adds:
//
//   • `sys.spawnChild({ argv, env, cwd, input })` → Promise<{ pid }>
//   • `sys.onChildEvent(cb)`   cb(pid, "stdout"|"stderr", bytes) / (pid, "exit", {code})
//   • `sys.childKill(pid, signal)`
//   • `sys.execCaptureSync(line, input)` → { code, stdout, stderr }  (blocking)
//
// The async APIs (`spawn`/`exec`/`execFile`/`fork`) launch a *real, live* child:
// its stdout/stderr stream back **incrementally** (`child.stdout` emits `data` as
// output arrives, not once at the end), `kill()` really signals it, and the exit
// code/signal are real. cwd/env are passed to the kernel natively, and the no-shell
// APIs pass argv verbatim (no shell interpretation). The synchronous forms
// (`execSync`/`execFileSync`/`spawnSync`) block the guest thread on the SAB channel
// while the kernel runs the child, then return its buffered output.
//
// Honest limits (INV-5): stdin is delivered from a temp file collected up to the
// child's launch (synchronous `stdin.write(...)` + `stdin.end()`), so a slow async
// drip of stdin *after* launch isn't seen; `fork()` runs `node <module>` but has no
// IPC channel; synchronous output is capped at the sync channel's 1 MiB (Node's
// default `maxBuffer`). These grow with the underlying primitives.

import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";

const enc = new TextEncoder();

const toBytes = (v) =>
  v == null ? new Uint8Array(0) : typeof v === "string" ? enc.encode(v) : new Uint8Array(v.buffer || v);

// Signal name → number, for kill(). A delivered signal hard-exits the child in
// the kernel (128 + signal), matching the terminal's own kill path.
const SIGNUM = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10,
  SIGUSR2: 12, SIGTERM: 15, SIGCONT: 18, SIGSTOP: 19,
};

// POSIX single-quote escaping — used only by the synchronous forms, which run
// through the shell driver (`execCaptureSync`) and so must quote each argv word to
// keep it literal (no glob/expansion). The async forms pass argv to the kernel
// directly and need none of this.
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const quoteArgv = (file, args) => [file, ...(args || [])].map(q).join(" ");

// Wrap a synchronous command so it honors `cwd`/`env` without leaking into the
// shared shell session: a subshell `( … )` snapshots and restores cwd + variables.
// `env` is *merged* onto the inherited environment (not a hard replacement).
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

// Decode captured bytes per the `encoding` option. The string APIs (`exec`/
// `execFile`) default to utf8 text; the buffer APIs (`execSync`/`spawnSync`)
// default to a Buffer. `'buffer'` always means a Buffer.
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

// Normalize Node's `stdio` option into a 3-entry [stdin, stdout, stderr] plan of
// the modes the sandbox honors: 'pipe' (stream to/from the parent), 'inherit'
// (share the parent's controlling terminal — an interactive child can prompt),
// or 'ignore' (empty stdin / discarded output). A shorthand string applies to
// all three; anything else we can't wire (a stream, an fd number, 'ipc') degrades
// to 'pipe'. This is what `stdio: 'inherit'` — npm's own `foregroundChild` path —
// needs so a scaffolder like `create-vite` reads and draws to the real terminal.
function normalizeStdio(stdio) {
  const one = (v) => (v === "inherit" || v === "ignore" ? v : "pipe");
  if (typeof stdio === "string") return [one(stdio), one(stdio), one(stdio)];
  if (Array.isArray(stdio)) return [one(stdio[0]), one(stdio[1]), one(stdio[2])];
  return ["pipe", "pipe", "pipe"];
}

export function createChildProcess(sys = globalThis.sys) {
  let nextFakePid = 90000; // for the synchronous forms (no real pid surfaced)
  const children = new Map(); // real pid → live ChildProcess

  // While a live child runs, hold /bin/node's event loop open (as net/http do for
  // sockets) so the process doesn't exit before the child's output/exit arrive.
  const refLoop = () => globalThis.__workerosLoop?.ref();
  const unrefLoop = () => globalThis.__workerosLoop?.unref();

  // One dispatcher for every live child: the kernel worker posts a child's stdout/
  // stderr/exit tagged with its pid; route each to the owning ChildProcess.
  sys.onChildEvent?.((pid, kind, payload) => {
    const child = children.get(pid);
    if (!child) return;
    if (kind === "stdout") child.stdout._push(payload);
    else if (kind === "stderr") child.stderr._push(payload);
    else if (kind === "message") child.emit("message", payload);
    else if (kind === "exit") {
      children.delete(pid);
      child._finish(payload && typeof payload.code === "number" ? payload.code : 0);
    }
  });

  // The readable side of a child stream: push-driven, so `data` fires as chunks
  // arrive (real streaming) and `end`/`close` on the child's exit.
  class ChildStream extends EventEmitter {
    constructor() {
      super();
      this.readable = true;
      this._encoding = null;
      this._ended = false;
    }
    setEncoding(e) { this._encoding = e; return this; }
    pause() { return this; }
    resume() { return this; }
    pipe(dest) {
      this.on("data", (d) => dest.write(d));
      this.on("end", () => dest.end && dest.end());
      return dest;
    }
    _push(bytes) {
      if (this._ended) return; // an inherited/closed stream never surfaces data
      if (!bytes || bytes.length === 0) return;
      this.emit("data", this._encoding ? Buffer.from(bytes).toString(this._encoding) : Buffer.from(bytes));
    }
    _end() {
      if (this._ended) return;
      this._ended = true;
      this.emit("end");
      this.emit("close");
    }
  }

  // The writable stdin of a child. Writes buffer until stdin is `end()`ed (or, if
  // the caller never touches stdin, until the microtask after `spawn()` returns);
  // that buffer is the child's stdin (a temp file, EOF-correct). A drip of stdin
  // *after* the child launches is the honest limit (INV-5).
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
      if (typeof encoding === "function") cb = encoding;
      this._touched = true;
      if (chunk != null) this._chunks.push(toBytes(chunk));
      if (cb) queueMicrotask(cb);
      return true;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
      else if (typeof encoding === "function") cb = encoding;
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
    constructor(stdio) {
      super();
      this.pid = null;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this._ipc = false;
      this.connected = false;
      this.channel = null;
      this._stdio = stdio || ["pipe", "pipe", "pipe"];
      this.stdout = new ChildStream();
      this.stderr = new ChildStream();
      let launch;
      this.stdin = new ChildStdin(() => launch && launch());
      this._setLaunch = (fn) => { launch = fn; };
    }
    kill(signal) {
      this.killed = true;
      this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
      const num = typeof signal === "number" ? signal : SIGNUM[this.signalCode] || SIGNUM.SIGTERM;
      if (this.pid != null) sys.childKill(this.pid, num);
      return true;
    }
    ref() { return this; }
    unref() { return this; }
    // fork IPC (or `spawn` with `stdio:'ipc'`): a real parent→child channel.
    _enableIpc() {
      this._ipc = true;
      this.connected = true;
      // Node exposes a `channel` object with ref/unref; a truthy value is what
      // libraries check to detect an IPC channel is present.
      this.channel = { ref: () => {}, unref: () => {} };
    }
    // send(message[, sendHandle][, options][, callback]) — sendHandle (passing a
    // socket/server across the channel) is unsupported; everything else works.
    send(message, sendHandle, options, callback) {
      if (typeof sendHandle === "function") { callback = sendHandle; sendHandle = undefined; }
      else if (typeof options === "function") { callback = options; options = undefined; }
      if (!this._ipc || !this.connected || this.pid == null) {
        const err = new Error("Channel closed");
        if (typeof callback === "function") queueMicrotask(() => callback(err));
        else queueMicrotask(() => this.emit("error", err));
        return false;
      }
      sys.ipcSend(this.pid, message);
      if (typeof callback === "function") queueMicrotask(() => callback(null));
      return true;
    }
    disconnect() {
      if (!this._ipc || !this.connected) return;
      this.connected = false;
      this.channel = null;
      queueMicrotask(() => this.emit("disconnect"));
    }
    // Called by the dispatcher on the child's exit: close the streams, then report
    // exit/close. A killed child reports code null + the signal name, as in Node.
    _finish(code) {
      this.stdout._end();
      this.stderr._end();
      if (this._ipc && this.connected) { this.connected = false; this.channel = null; this.emit("disconnect"); }
      const sig = this.killed ? this.signalCode : null;
      this.exitCode = sig ? null : code;
      this.emit("exit", this.exitCode, sig);
      this.emit("close", this.exitCode, sig);
      unrefLoop();
    }
  }

  // Turn (command, args, options) into the argv the kernel spawns. With `shell`,
  // run the whole thing through a shell (`sh -c "<line>"`, honoring a custom shell
  // path); otherwise pass argv verbatim — no interpretation (Node's no-shell rule).
  function buildArgv(command, args, options) {
    if (options.shell) {
      const shell = typeof options.shell === "string" ? options.shell : "/bin/sh";
      const line = [command, ...(args || [])].join(" ");
      return [shell, "-c", line];
    }
    return [command, ...(args || [])];
  }

  // Launch a ChildProcess: gather its buffered stdin, ask the kernel to spawn it,
  // and register it so the dispatcher can route its streamed output + exit.
  async function launchChild(child, argv, options) {
    const stdio = child._stdio;
    // Only a piped stdin is fed from the buffered writes; 'inherit' reads the
    // terminal and 'ignore' is an empty EOF (both handled kernel-side).
    const input = stdio[0] === "pipe" ? child.stdin._input() : null;
    const env = options.env || globalThis.process?.env || {};
    const cwd = options.cwd != null ? String(options.cwd) : globalThis.process?.cwd?.() ?? sys.cwd;
    try {
      const { pid } = await sys.spawnChild({ argv, env, cwd, input, stdio, ipc: !!options._ipc });
      child.pid = pid;
      children.set(pid, child);
      // A non-piped output fd never streams back as `data` (it went to the
      // terminal, or was discarded), so close those readable sides now — Node
      // reports them as `null`; ending them keeps any `end`/`close` listener honest.
      if (stdio[1] !== "pipe") child.stdout._end();
      if (stdio[2] !== "pipe") child.stderr._end();
      child.emit("spawn");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      child.stdout._end();
      child.stderr._end();
      child.emit("error", err);
      child.emit("close", null, null);
      unrefLoop();
    }
  }

  // spawn(command[, args][, options]) — the live, streaming API.
  function spawn(command, args, options) {
    const n = normalizeArgs(args, options, undefined);
    const argv = buildArgv(command, n.args, n.options);
    const stdio = normalizeStdio(n.options.stdio);
    // An IPC channel is opened by `fork`, or by `spawn` with `'ipc'` among stdio.
    const ipc = !!n.options._ipc || (Array.isArray(stdio) && stdio.includes("ipc"));
    const child = new ChildProcess(stdio);
    if (ipc) child._enableIpc();
    // Hold /bin/node's event loop open from the moment spawn() is called — *before*
    // the deferred launch below — so a `spawn()` right after an awaited child (whose
    // exit dropped the ref count to 0) doesn't let the process go idle and exit in
    // the gap. Released once in _finish (or the launch error path).
    refLoop();
    let launched = false;
    const launch = () => { if (launched) return; launched = true; launchChild(child, argv, { ...n.options, _ipc: ipc }); };
    child._setLaunch(launch);
    // Launch once stdin closes; if the caller never writes stdin, launch on the
    // next microtask (after synchronous setup), with empty stdin.
    queueMicrotask(() => { if (!child.stdin._touched || child.stdin._ended) launch(); });
    return child;
  }

  // Buffer a live child's streamed output, then hand it to a Node-style callback.
  // Shared by exec/execFile — the difference is only how argv is built.
  function bufferedExec(child, command, opts, cb) {
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (d) => outChunks.push(toBytes(d)));
    child.stderr.on("data", (d) => errChunks.push(toBytes(d)));
    let done = false;
    const finish = (err, code) => {
      if (done) return;
      done = true;
      const so = decodeOutput(concat(outChunks), opts.encoding, true);
      const se = decodeOutput(concat(errChunks), opts.encoding, true);
      if (err) { if (cb) cb(err, so, se); return; }
      if (code !== 0) {
        const e = new Error("Command failed: " + command + (se ? "\n" + se : ""));
        e.code = code;
        e.cmd = command;
        if (cb) cb(e, so, se);
      } else if (cb) cb(null, so, se);
    };
    child.on("error", (err) => finish(err, null));
    child.on("close", (code) => finish(null, code));
    // exec/execFile launch immediately: end stdin now (feeding `input` if given).
    child.stdin.end(opts.input != null ? toBytes(opts.input) : undefined);
    return child;
  }

  // exec(command[, options][, callback]) — run a shell command, buffer output.
  function exec(command, options, callback) {
    const { options: opts, callback: cb } = normalizeOpts(options, callback);
    const child = spawn(command, [], { ...opts, shell: opts.shell ?? true });
    return bufferedExec(child, command, opts, cb);
  }

  // execFile(file[, args][, options][, callback]) — no shell; args passed literally.
  function execFile(file, args, options, callback) {
    const n = normalizeArgs(args, options, callback);
    const child = spawn(file, n.args, { ...n.options, shell: n.options.shell || false });
    return bufferedExec(child, file, n.options, n.callback);
  }

  // fork(modulePath[, args][, options]) — run `node <module>` as a child. No IPC.
  function fork(modulePath, args, options) {
    const n = normalizeArgs(args, options, undefined);
    // fork always opens an IPC channel (Node): the child gets `process.send` and
    // the returned ChildProcess a `.send()` + `'message'` events. `execPath`/
    // `execArgv` are honored only nominally — we always run our `node`.
    return spawn("node", [modulePath, ...(n.args || [])], { ...n.options, shell: false, _ipc: true });
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
      return { pid: nextFakePid++, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error: err };
    }
    const stdout = decodeOutput(result.stdout, opts.encoding, false);
    const stderr = decodeOutput(result.stderr, opts.encoding, false);
    return {
      pid: nextFakePid++,
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

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
