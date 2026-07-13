// The program worker — one per process. A thin "dumb CPU" (INV-2): it evaluates
// exactly one program on the host JS engine and routes every syscall back to the
// kernel worker. It makes no resolution, filesystem, or capability decision —
// the kernel already resolved the whole module graph and handed it over.
//
// Every guest gets one native surface:
//   • `globalThis.sys` — the WorkerOS syscall ABI (argv/env/cwd + fd ops), plus
//     a routing `console`. Coreutils and `/bin/node` alike are written against it.
// Node.js compatibility (`process`, CommonJS `require`) is not a worker concern:
// it lives in the userland `/bin/node` program, which installs `process` and
// evaluates the target script itself. The kernel has no `node` interpreter.
//
// Isolation level: `Full` (bare dynamic import), ADR-009/§7.1.

import { MSG } from "./protocol.js";
import { ProcessExit } from "../../workeros-programs/src/node/process-shim.js";
import { createWasiImports } from "../../workeros-programs/src/wasi/host.js";
import { makeSyncCaller, MAX_SYNC_PAYLOAD } from "./sync-syscall.js";
import { unframeExecResult } from "./exec-frame.js";

const kernel = self; // the kernel worker created us; postMessage talks back to it.

let nextCallId = 1;
const pendingCalls = new Map(); // id → { resolve, reject }

/** A request/response syscall: posts to the kernel worker and awaits its reply. */
function call(callName, args) {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    kernel.postMessage({ type: MSG.SYSCALL, id, call: callName, args });
  });
}

// The blocking write primitive, installed once the sync channel exists (START).
// Routing writes through the SAB gives them real POSIX semantics (ADR-023): a
// write into a full pipe *blocks this thread* until the reader drains it, and a
// write to a broken pipe applies the SIGPIPE disposition (default: the kernel
// worker kills this process with 128+13; if caught, the call errors with EPIPE).
// Terminal/file writes return immediately — only a full pipe ever parks.
let syncWrite = null;
// A safe per-write chunk: the sync channel payload is 1 MiB (minus the JSON
// meta), and the kernel worker parks until a whole chunk is accepted — so
// chunking loses nothing and keeps every request under the channel's capacity.
const WRITE_CHUNK = 1 << 19; // 512 KiB

/** Write `bytes` to `fd`, blocking (sync channel) until every byte is accepted.
 *  Ordering with fire-and-forget syscalls is preserved: the SAB request is
 *  announced by the same postMessage queue the async path uses. Falls back to a
 *  fire-and-forget postMessage before START (no sync channel yet). */
function writeBytes(fd, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!syncWrite) {
    kernel.postMessage({ type: MSG.SYSCALL, call: "write", args: { fd, data: u8 } });
    return u8.length;
  }
  for (let off = 0; off < u8.length; off += WRITE_CHUNK) {
    syncWrite(fd, u8.subarray(off, Math.min(off + WRITE_CHUNK, u8.length)));
  }
  return u8.length;
}

// The guest's signal dispatcher (installed by a runtime like /bin/node). The
// kernel worker delivers SIGINT/SIGWINCH/SIGTSTP as async messages; a JS guest
// processes them at event-loop boundaries (cooperative — there is no preemption).
let signalDispatch = null;
// The guest's fs.watch event dispatcher (installed by node:fs). The kernel worker
// delivers FS_EVENT messages; node:fs routes each to the right FSWatcher.
let fsEventDispatch = null;
// The guest's child_process event dispatcher (installed by node:child_process).
// The kernel worker delivers CHILD_STDOUT/CHILD_STDERR/CHILD_EXIT for spawned
// children; node:child_process routes each to the right ChildProcess by pid.
let childDispatch = null;
// The guest's worker_threads event dispatcher (installed by node:worker_threads).
// The kernel worker delivers WORKER_MESSAGE/WORKER_EXIT for spawned workers;
// node:worker_threads routes each to the right Worker / parentPort by thread id.
// A worker receives its first parent message *before* its script has run (the
// spawner posts as soon as it's online), so events that arrive before the guest
// registers the dispatcher are buffered here and flushed when it does.
let workerEventDispatch = null;
let pendingWorkerEvents = [];

let exited = false;
function reportExit(code) {
  if (exited) return;
  exited = true;
  kernel.postMessage({ type: MSG.PROC_EXIT, code: code | 0 });
}

/** Build the synchronous-filesystem primitives from a process's SAB sync channel.
 *  Each call blocks this thread (`Atomics.wait`) while the kernel worker services
 *  it — the basis for Node's synchronous `fs` (`readFileSync`/`writeFileSync`/…).
 *  Every method throws a plain `Error` carrying the kernel's errno name on
 *  failure; the guest's `node:fs` maps that to a Node error code. */
function makeSyncFs(syncCall) {
  const fail = (r) => {
    let msg;
    if (r.value && r.value.error) msg = r.value.error;
    else if (r.bytes && r.bytes.length) {
      try { msg = JSON.parse(new TextDecoder().decode(r.bytes)).error; } catch {}
    }
    throw new Error(msg || "errno " + r.status);
  };
  const json = (name, args, bytes) => {
    const r = syncCall(name, args, false, bytes);
    if (r.status < 0) fail(r);
    return r.value || {};
  };
  return {
    open: (path, opts) => json("open", { path, opts }).fd,
    read: (fd, max) => {
      // The kernel advances the fd offset by the bytes it reads, but the sync
      // channel only carries MAX_SYNC_PAYLOAD back. Requesting more would advance
      // past — and drop — the remainder, so clamp here and let the caller loop
      // (fs.readSync does). This is why a single read of a >1 MiB cache entry used
      // to come back truncated, breaking npm's integrity check on large packuments.
      const r = syncCall("read", { fd, max: Math.min(max, MAX_SYNC_PAYLOAD) }, true);
      if (r.status < 0) fail(r);
      return r.bytes;
    },
    write: (fd, bytes) => json("write", { fd }, bytes).nwritten,
    close: (fd) => { json("close", { fd }); },
    seek: (fd, offset, whence) => json("seek", { fd, offset, whence }).offset,
    stat: (path) => json("stat", { path }),
    lstat: (path) => json("lstat", { path }),
    symlink: (target, path) => { json("symlink", { target, path }); },
    readlink: (path) => json("readlink", { path }).target,
    link: (existing, path) => { json("link", { existing, path }); },
    realpath: (path) => json("realpath", { path }).path,
    readdir: (path) => json("readdir", { path }).entries,
    mkdir: (path) => { json("mkdir", { path }); },
    unlink: (path) => { json("unlink", { path }); },
    rmdir: (path) => { json("rmdir", { path }); },
    rename: (from, to) => { json("rename", { from, to }); },
    utimes: (path, atime, mtime) => { json("utimes", { path, atime, mtime }); },
    // fs.watch: register/unregister synchronously (events arrive async via FS_EVENT).
    watchAdd: (path, recursive) => json("watchAdd", { path, recursive }).id,
    watchRemove: (id) => { json("watchRemove", { id }); },
  };
}

/** Build the WorkerOS-native `sys` ABI for a guest. */
function makeSys(start, syncCall) {
  return {
    // Synchronous filesystem primitives over the SAB channel (Node `fs` builds on
    // these). Async fd ops below are for streaming/pipes; `syncFs` is for files.
    syncFs: makeSyncFs(syncCall),
    argv: start.argv,
    env: start.env,
    cwd: start.cwd,
    pid: start.pid,
    write: (fd, bytes) => writeBytes(fd, bytes),
    // read resolves to a Uint8Array; empty means EOF (the kernel worker parks
    // "would block" internally, so a guest never sees it).
    read: async (fd, max = 65536) => {
      const r = await call("read", { fd, max });
      return r.status === "data" ? r.data : new Uint8Array(0);
    },
    open: (path, opts = {}) => call("open", { path, opts }),
    close: (fd) => call("close", { fd }),
    // Terminal introspection: is this fd the controlling terminal, and how big is
    // it. Guests query these once at startup (e.g. process.stdout.isTTY/columns).
    isatty: (fd) => call("isatty", { fd }),
    winsize: () => call("winsize", {}),
    // Line-discipline control (tcgetattr/tcsetattr). A full-screen TUI (editor,
    // pager) goes raw + no-echo so each keystroke arrives immediately and it
    // paints the screen itself, then restores the saved flags on exit. `tcsetattr`
    // merges the given keys onto the current termios: `{ canonical, echo, isig }`.
    tcgetattr: () => call("getattr", {}),
    tcsetattr: (attr) => call("setattr", { attr }),
    // Signals. `onSignal` registers the guest's dispatcher; `sighandle` tells the
    // kernel worker whether the guest catches a signal (so a caught SIGINT is
    // delivered cooperatively rather than the process being hard-killed).
    onSignal: (cb) => { signalDispatch = cb; },
    // fs.watch dispatcher: node:fs registers one callback; the kernel worker's
    // FS_EVENT messages are routed here as (watchId, eventType, filename).
    onFsEvent: (cb) => { fsEventDispatch = cb; },
    sighandle: (signal, on) =>
      kernel.postMessage({ type: MSG.SIGACTION, signal, on: !!on }),
    readdir: (path) => call("readdir", { path }),
    stat: (path) => call("stat", { path }),
    mkdir: (path) => call("mkdir", { path }),
    unlink: (path) => call("unlink", { path }),
    rmdir: (path) => call("rmdir", { path }),
    rename: (from, to) => call("rename", { from, to }),
    // Run a command line as a sub-process (like system(3)); its stdout/stderr are
    // routed to this process's streams. Resolves with the exit code. Used by `npm
    // run`. The kernel worker services it with the shell driver.
    exec: (line) => call("exec", { line }),
    // node:child_process — streaming spawn. `spawnChild` launches `argv` as a real
    // headless child (cwd/env/stdin from `opts`), resolving with its `{ pid }`; the
    // child's stdout/stderr then arrive *incrementally* as CHILD_STDOUT/CHILD_STDERR
    // messages and its exit as CHILD_EXIT, all routed to the dispatcher registered
    // via `onChildEvent`. `childKill` signals it. The synchronous forms instead use
    // `execCaptureSync`: a blocking capture over the SAB channel (the guest parks
    // while the kernel worker runs the child, then unpacks the framed result;
    // output is capped at the channel's 1 MiB — Node's default maxBuffer).
    spawnChild: (opts) => call("spawnChild", opts),
    childKill: (childPid, signal) => call("childKill", { pid: childPid, signal }),
    onChildEvent: (cb) => { childDispatch = cb; },
    // node:worker_threads. `spawnWorker` launches a `/bin/node` worker thread and
    // resolves its `{ threadId }`; `workerInit` (queried once at /bin/node startup)
    // reports whether *this* process is a worker and its `workerData`; `workerPost`
    // relays a structured-clone message (fire-and-forget) to the parent (`"parent"`)
    // or to a worker by threadId; messages/exits arrive via the dispatcher set with
    // `onWorkerEvent`. Termination reuses `childKill`.
    spawnWorker: (opts) => call("spawnWorker", opts),
    workerInit: () => call("workerInit", {}),
    workerPost: (to, data) =>
      kernel.postMessage({ type: MSG.SYSCALL, call: "workerPost", args: { to, data } }),
    onWorkerEvent: (cb) => {
      workerEventDispatch = cb;
      const queued = pendingWorkerEvents;
      pendingWorkerEvents = [];
      for (const ev of queued) cb(ev.threadId, ev.kind, ev.payload);
    },
    execCaptureSync: (line, input) => {
      const r = syncCall("execCapture", { line }, true, input || undefined);
      if (r.status < 0) {
        let msg = "execCapture failed";
        try { msg = JSON.parse(new TextDecoder().decode(r.bytes)).error; } catch {}
        throw new Error(msg);
      }
      return unframeExecResult(r.bytes);
    },
    // Port-keyed loopback sockets (`otf:net_*`, ADR-021). A connection is a pair
    // of pipe fds; read/write it with the ordinary `sys.read`/`sys.write` above.
    // `netListen` → `{ listener, port }` (port is the bound port, assigned when
    // the guest passes 0); `netConnect` → `{ rfd, wfd }`; `netAccept` resolves to
    // `{ rfd, wfd }` once a client connects (the kernel worker parks the accept
    // until then, so a guest never sees "would block"). All HTTP/WS framing is
    // guest userland — the kernel only moves bytes (INV-1).
    netListen: (port) => call("net_listen", { port }),
    netConnect: (port) => call("net_connect", { port }),
    netAccept: (listener) => call("net_accept", { listener }),
    exit: (code = 0) => {
      reportExit(code | 0);
      throw new ProcessExit(code | 0);
    },
  };
}

/** A guest program is a single self-contained module (its deps were inlined at
 *  build time — the esbuild bundle for /bin, the inline prelude for /sbin
 *  coreutils), so "stitching" is just wrapping the entry source in a blob URL to
 *  import. The kernel decided the entry (INV-2); the worker only assembles it. */
function stitch(graph) {
  const entry = graph.modules.find((m) => m.path === graph.entry) ?? graph.modules[0];
  return URL.createObjectURL(new Blob([entry.source], { type: "text/javascript" }));
}

/** Read a whole VFS file into a Uint8Array via the syscall channel. */
async function readAll(sys, path) {
  const fd = await sys.open(path, {});
  const chunks = [];
  try {
    for (;;) {
      const b = await sys.read(fd, 1 << 16);
      if (b.length === 0) break;
      chunks.push(b);
    }
  } finally {
    await sys.close(fd);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Run a `wasm32-wasip1` binary: read it from the VFS, bind the WASI host to the
 *  kernel syscalls, instantiate, and call its `_start`. */
async function runWasm(start, sys, syncCall) {
  const bytes = await readAll(sys, start.graph.entry);
  let memory = null;
  // Blocking WASI calls (fd_read/path_open/…) go through the synchronous SAB
  // channel; the kernel worker services them while this thread parks.
  const imports = createWasiImports({
    sys,
    syncCall,
    argv: start.argv,
    env: start.env,
    getMemory: () => memory,
  });
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  memory = instance.exports.memory;
  const startFn = instance.exports._start;
  if (typeof startFn !== "function") throw new Error("wasm: no _start export");
  startFn();
}

function stringify(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

/** Install the guest's ambient globals. */
function installGlobals(start, sys) {
  globalThis.sys = sys;

  const enc = new TextEncoder();
  const line = (fd, args) => sys.write(fd, enc.encode(args.map(stringify).join(" ") + "\n"));
  // A routing console — a terminal concern, given to every guest.
  globalThis.console = {
    log: (...a) => line(1, a),
    info: (...a) => line(1, a),
    debug: (...a) => line(1, a),
    warn: (...a) => line(2, a),
    error: (...a) => line(2, a),
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === MSG.SYSCALL_RESULT) {
    const p = pendingCalls.get(msg.id);
    if (p) {
      pendingCalls.delete(msg.id);
      msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
    }
    return;
  }
  if (msg.type === MSG.PING) {
    // Watchdog liveness probe (ADR-020): answering proves this worker's event
    // loop turns. A synchronous spin never reaches here — that's the signal.
    kernel.postMessage({ type: MSG.PONG });
    return;
  }
  if (msg.type === MSG.SIGNAL) {
    // Cooperative delivery: hand the signal to the guest's dispatcher (if any).
    try { signalDispatch?.(msg.signal); } catch (e) {
      writeBytes(2, new TextEncoder().encode("signal handler error: " + (e?.message ?? e) + "\n"));
    }
    return;
  }
  if (msg.type === MSG.FS_EVENT) {
    // A watched path changed — hand it to node:fs's watch dispatcher (if any).
    try { fsEventDispatch?.(msg.watchId, msg.eventType, msg.filename); } catch (e) {
      writeBytes(2, new TextEncoder().encode("fs.watch handler error: " + (e?.message ?? e) + "\n"));
    }
    return;
  }
  if (msg.type === MSG.CHILD_STDOUT || msg.type === MSG.CHILD_STDERR || msg.type === MSG.CHILD_EXIT) {
    // Live stdio/exit of a spawned child — hand it to node:child_process's
    // dispatcher (if any), which fans it out to the owning ChildProcess by pid.
    const kind =
      msg.type === MSG.CHILD_STDOUT ? "stdout" : msg.type === MSG.CHILD_STDERR ? "stderr" : "exit";
    const payload = kind === "exit" ? { code: msg.code, signal: msg.signal ?? null } : msg.data;
    try { childDispatch?.(msg.pid, kind, payload); } catch (e) {
      writeBytes(2, new TextEncoder().encode("child_process handler error: " + (e?.message ?? e) + "\n"));
    }
    return;
  }
  if (msg.type === MSG.WORKER_MESSAGE || msg.type === MSG.WORKER_EXIT || msg.type === MSG.WORKER_ERROR) {
    // node:worker_threads traffic — hand it to the worker dispatcher (if any),
    // keyed by the peer thread id (0 = the parent, for a worker's inbound).
    const kind =
      msg.type === MSG.WORKER_MESSAGE ? "message" : msg.type === MSG.WORKER_EXIT ? "exit" : "error";
    const payload =
      kind === "exit" ? { code: msg.code }
      : kind === "error" ? { message: msg.message, stack: msg.stack, name: msg.name }
      : msg.data;
    if (!workerEventDispatch) { pendingWorkerEvents.push({ threadId: msg.threadId, kind, payload }); return; }
    try { workerEventDispatch(msg.threadId, kind, payload); } catch (e) {
      writeBytes(2, new TextEncoder().encode("worker_threads handler error: " + (e?.message ?? e) + "\n"));
    }
    return;
  }
  if (msg.type !== MSG.START) return;

  // Capability enforcement at the worker boundary (ADR-024): a process the
  // kernel denied net egress gets its ambient network globals removed *before
  // any guest code runs* — nothing was evaluated yet, so no reference to them
  // can have been captured. Coarse, same-realm, pre-`Membrane` (honest, INV-5):
  // it stops ordinary code cold, not a hostile realm-surgeon. `Worker` is
  // stripped too (a fresh worker would mint fresh globals); guest concurrency
  // uses the sys ABI (worker_threads/child_process), which stays kernel-routed.
  if (msg.netEgress === false) {
    for (const name of [
      "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport",
      "Worker", "SharedWorker", "importScripts",
    ]) {
      // Remove from the whole prototype chain, then pin an undefined shadow.
      for (let o = globalThis; o; o = Object.getPrototypeOf(o)) {
        try { delete o[name]; } catch { /* non-configurable somewhere: shadow below */ }
      }
      try {
        Object.defineProperty(globalThis, name, {
          value: undefined, writable: false, configurable: false,
        });
      } catch { /* already shadowed */ }
    }
  }

  // One synchronous-syscall channel per process (SAB + Atomics). Both the WASI
  // host and a JS guest's `sys.syncFs` block on it; only one guest runs at a time.
  const syncCall = makeSyncCaller(msg.syncSab, () => kernel.postMessage({ type: MSG.SYNC }));
  // From here on, `sys.write` is a real blocking write (backpressure + EPIPE,
  // ADR-023). A broken-pipe error only comes back if this process catches
  // SIGPIPE — the default disposition already killed it otherwise.
  syncWrite = (fd, chunk) => {
    const r = syncCall("write", { fd }, false, chunk);
    if (r.status < 0) {
      const reason = (r.value && r.value.error) || "errno " + r.status;
      throw new Error(/errno Pipe\b/.test(reason) ? "EPIPE: broken pipe, write" : reason);
    }
    return r.value ? r.value.nwritten : chunk.length;
  };
  const sys = makeSys(msg, syncCall);
  installGlobals(msg, sys);

  // Memory self-sampling for the watchdog (ADR-020) where the browser exposes
  // it to workers (Chromium under cross-origin isolation). Soft/sampled by
  // design (INV-5): a synchronous allocation burst lands between samples. The
  // measurement is async and may take a while (it can wait for GC) — one in
  // flight at a time.
  if (typeof performance !== "undefined" && performance.measureUserAgentSpecificMemory) {
    let measuring = false;
    setInterval(async () => {
      if (measuring) return;
      measuring = true;
      try {
        const m = await performance.measureUserAgentSpecificMemory();
        kernel.postMessage({ type: MSG.MEM_SAMPLE, bytes: m.bytes });
      } catch { /* API refused (e.g. isolation lost); sampling just stops mattering */ }
      measuring = false;
    }, 3000);
  }

  try {
    // A wasm32-wasip1 binary: run it through the WASI host bound to the kernel.
    if (msg.graph.kind === "wasm") {
      await runWasm(msg, sys, syncCall);
      reportExit(0);
      return;
    }
    // Every JS program — coreutils, npm, and /bin/node itself — is the same to the
    // worker: stitch the kernel-resolved graph into blob URLs and import the entry
    // (that path permits top-level await). A program that wants Node semantics
    // (like /bin/node) installs them itself before loading its own target.
    const entryUrl = stitch(msg.graph);
    await import(entryUrl);
    reportExit(0); // top-level completed without an explicit exit → success.
  } catch (err) {
    if (err instanceof ProcessExit) {
      reportExit(err.code);
      return;
    }
    writeBytes(2, new TextEncoder().encode(String(err && err.stack ? err.stack : err) + "\n"));
    // If this process is a worker_threads Worker, hand the error to the kernel to
    // relay to the spawner (→ `worker.on('error')`); a no-op for a normal process.
    reportWorkerError(err);
    reportExit(1);
  }
};

/** Report an uncaught error to the kernel worker; it relays a WORKER_ERROR to the
 *  spawner iff this process was spawned as a worker_threads Worker (else ignored). */
function reportWorkerError(err) {
  kernel.postMessage({
    type: MSG.WORKER_ERROR_REPORT,
    message: err && err.message ? String(err.message) : String(err),
    stack: err && err.stack ? String(err.stack) : undefined,
    name: err && err.name ? String(err.name) : "Error",
  });
}
