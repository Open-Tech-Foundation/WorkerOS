// `node` — the Node.js-compatibility runtime, as an ordinary user program
// installed at /bin/node (INV-1). The kernel has no `node` concept: it owns only
// native JS resolution + execution. `node foo.js` therefore does exactly what the
// name implies and nothing more — it asks the kernel to resolve `foo.js` into a
// module graph (`sys.resolveGraph`, INV-2), installs the Node surface (`process`)
// on the guest global, and evaluates the graph *in this same worker*, so the
// script is one process: killable as a unit, sharing stdio directly.
//
// Because it's a plain program, it's swappable — replace /bin/node with a richer
// runtime (CommonJS `require`, more of `process`, a REPL) without touching the
// kernel. Today it is "just enough Node for ordinary ESM scripts" (INV-5): we do
// not claim to be Node, and unsupported bits fail honestly rather than pretending.
//
// It imports its CommonJS runtime + `node:` builtins (`fs`/`path`) from the VFS
// (`/lib/workeros-node`, installed at boot), so a `require`-using script runs;
// a plain ESM script keeps the kernel-graph stitch path. Both are guest code —
// the kernel still owns only native resolution + execution (INV-1/INV-2).

import { createNodeRuntime, detectFormat, makeBuiltins } from "/lib/workeros-node/require-runtime.js";
import { ArgError, tokenizeArgv } from "/lib/workeros-cli/args.js";
import { buildEsmGraph, transformModule, isTsPath } from "/lib/workeros-node/esm-graph.js";
import { createResolver, isBuiltinSpec, builtinKey } from "/lib/workeros-node/resolve.js";
import { createEsmRunner } from "/lib/workeros-node/esm-runner.js";
import { getBundler } from "/lib/workeros-node/node-bundler.js";
import { createTty } from "/lib/workeros-node/tty.js";
import { createEventLoop } from "/lib/workeros-node/event-loop.js";
import { createWorkerThreads } from "/lib/workeros-node/worker-threads.js";
import { Buffer as NodeBuffer } from "/lib/workeros-node/buffer.js";

const enc = new TextEncoder();
const err = (s) => sys.write(2, enc.encode(s));

// `-e "code"` / `--eval` runs the argument as source (no file); `-p`/`--print`
// evaluates an expression and prints it (wrapped in console.log). Otherwise the
// first operand is the script path. This makes one-liners like
// `node -e "require('http').createServer(...).listen(5173)"` work.
let script = null;
let evalSource = null;
try {
  const tokens = tokenizeArgv(sys.argv.slice(1), {
    shortAlias: { e: "eval", p: "print" },
    shortValue: new Set(["e", "p"]),
    longValue: new Set(["eval", "print"]),
    stopAtFirstOperand: true,
  });
  const first = tokens.find((tok) => tok.kind === "option" || tok.kind === "operand");
  if (first?.kind === "option" && (first.name === "eval" || first.name === "print")) {
    const code = first.value;
    evalSource = first.name === "print" ? "console.log(" + code + ")" : code;
    script = "[eval]";
  } else if (first?.kind === "operand") {
    script = first.value;
  }
} catch (e) {
  if (e instanceof ArgError) {
    err("node: " + e.message + "\n");
    sys.exit(1);
  }
  throw e;
}
if (!script) {
  // Real Node drops into a REPL here; we have no TTY, so say so plainly.
  err("node: no script given (usage: node <file.js> [args…]); REPL is not supported\n");
  sys.exit(1);
}

// The Node `process` global, mapped onto the kernel's `sys` primitives. Installed
// before the script loads so its top-level code sees it.
const toBytes = (chunk) =>
  typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk);
// Query the controlling terminal once at startup: is each stdio fd a TTY, and its
// size. process.std*.isTTY must be a plain boolean (Node code reads it
// synchronously), so we resolve it here rather than on each access. (This is what
// makes chalk/ora/readline detect a terminal — reversing the old isTTY=false stub.)
// `workerInit` is resolved here too: node:worker_threads needs `isMainThread`/
// `workerData`/`threadId` as synchronous values at module load, so we ask the
// kernel once (is this /bin/node a spawned Worker?) before the script runs.
const [in0, out1, err2, ws, workerInit] = await Promise.all([
  sys.isatty(0), sys.isatty(1), sys.isatty(2), sys.winsize(), sys.workerInit(),
]);
// Live terminal geometry: seeded from the startup probe, kept current by the
// SIGWINCH handler below so tty.WriteStream.getWindowSize()/columns stay accurate.
const winsize = { cols: ws.cols, rows: ws.rows };

// A minimal Node EventEmitter — enough for `process` and its streams. Covers the
// EventEmitter surface npm's signal-handling exercises on `process`
// (getMaxListeners/setMaxListeners/listeners in addition to on/once/off/emit).
// `_onadd`/`_onremove` hooks let `process` tell the kernel when it starts/stops
// catching a signal.
const emitter = (obj = {}) => {
  const map = new Map();
  let maxListeners = 10; // Node's EventEmitter.defaultMaxListeners
  const list = (ev) => map.get(ev) || (map.set(ev, []), map.get(ev));
  obj.on = (ev, fn) => { list(ev).push(fn); obj._onadd?.(ev); return obj; };
  obj.addListener = obj.on;
  obj.prependListener = (ev, fn) => { list(ev).unshift(fn); obj._onadd?.(ev); return obj; };
  obj.once = (ev, fn) => { const g = (...a) => { obj.off(ev, g); fn(...a); }; return obj.on(ev, g); };
  obj.prependOnceListener = (ev, fn) => { const g = (...a) => { obj.off(ev, g); fn(...a); }; return obj.prependListener(ev, g); };
  obj.off = (ev, fn) => { map.set(ev, list(ev).filter((f) => f !== fn)); obj._onremove?.(ev); return obj; };
  obj.removeListener = obj.off;
  obj.removeAllListeners = (ev) => {
    if (ev === undefined) { for (const k of [...map.keys()]) obj.removeAllListeners(k); return obj; }
    map.set(ev, []); obj._onremove?.(ev); return obj;
  };
  obj.listeners = (ev) => list(ev).slice();
  obj.rawListeners = (ev) => list(ev).slice();
  obj.listenerCount = (ev) => list(ev).length;
  obj.eventNames = () => [...map.keys()].filter((ev) => list(ev).length > 0);
  obj.setMaxListeners = (n) => { maxListeners = n; return obj; };
  obj.getMaxListeners = () => maxListeners;
  obj.emit = (ev, ...a) => { const l = list(ev).slice(); for (const f of l) f(...a); return l.length > 0; };
  return obj;
};

// A non-TTY stdio fd (pipe/file redirect): a plain writable, no terminal methods —
// exactly what Node hands you when a stream isn't a terminal.
const pipeStream = (fd) =>
  emitter({ write(chunk) { sys.write(fd, toBytes(chunk)); return true; }, isTTY: false });

// The `node:tty` module. Its WriteStream/ReadStream back the stdio below when the
// fd is a terminal, so `process.stdout` is a real tty.WriteStream (cursorTo,
// clearLine, getColorDepth…) and `process.stdin.setRawMode()` works — same as Node.
const tty = createTty({
  write: (fd, bytes) => sys.write(fd, bytes),
  isattyFor: (fd) => (fd === 0 ? in0 : fd === 1 ? out1 : fd === 2 ? err2 : false),
  getWinsize: () => winsize,
  getEnv: () => process.env,
  setRawMode: (fd, on) => sys.tcsetattr({ canonical: !on, echo: !on, isig: !on }),
  readFd: (fd, max) => sys.read(fd, max),
  cancelRead: (fd) => { if (typeof sys.readCancel === "function") sys.readCancel(fd); },
  emitter,
});

// SIGPIPE: the kernel worker applies the POSIX default (kill, 128+13) to a
// writer on a broken pipe unless it registers a handler here (ADR-023) — then
// the write raises EPIPE instead and the handler is delivered cooperatively.
const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGWINCH", "SIGTSTP", "SIGHUP", "SIGPIPE", "SIGUSR1", "SIGUSR2"]);
// Signal name ↔ number, for `process.kill`. A caller may pass either form.
const SIGNUM = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15,
  SIGUSR1: 10, SIGUSR2: 12, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGWINCH: 28,
};
const SIGNAME = Object.fromEntries(Object.entries(SIGNUM).map(([k, v]) => [v, k]));

// `process.cwd()`/`chdir()`. The kernel owns the real cwd (set at spawn); we have
// no chdir syscall yet, so this is a process-local view: it moves what the script
// *sees* and how it resolves relative paths it builds, but absolute VFS ops are
// unaffected. Honest limit (INV-5) until a kernel `chdir` lands.
let cwd = sys.cwd;
const resolveCwd = (d) => {
  const segs = [];
  for (const part of ((d.startsWith("/") ? "" : cwd) + "/" + d).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
};

// Monotonic high-res time from the worker clock (ms, sub-ms where the browser
// allows it). `hrtime([prev])` → [seconds, nanoseconds]; `hrtime.bigint()` → ns.
const nowNs = () => Math.round((globalThis.performance ? performance.now() : Date.now()) * 1e6);
const hrtime = (prev) => {
  const ns = nowNs();
  let s = Math.floor(ns / 1e9);
  let n = ns % 1e9;
  if (prev) { s -= prev[0]; n -= prev[1]; if (n < 0) { s -= 1; n += 1e9; } }
  return [s, n];
};
hrtime.bigint = () => BigInt(nowNs());

// Build/runtime feature metadata used by Node packages and Node's own test/common
// harness. These are truthful gates for the WorkerOS host: browser Intl is
// available, while native shared libraries, OpenSSL, sanitizers, inspector, and
// single-executable support are not.
const processConfig = Object.freeze({
  target_defaults: Object.freeze({}),
  variables: Object.freeze({
    asan: 0,
    icu_gyp_path: "tools/icu/icu-system.gyp",
    icu_small: false,
    is_debug: 0,
    node_shared: false,
    node_shared_openssl: false,
    node_use_openssl: false,
    openssl_quic: false,
    shlib_suffix: "",
    single_executable_application: false,
    ubsan: 0,
    v8_enable_i18n_support: typeof Intl !== "undefined" ? 1 : 0,
    want_separate_host_toolset: 0,
  }),
});
let processUmask = 0o022;
const umask = (mask) => {
  const previous = processUmask;
  if (mask === undefined) return previous;
  const next = typeof mask === "string" && /^[0-7]+$/.test(mask) ? parseInt(mask, 8) : mask;
  if (!Number.isInteger(next) || next < 0 || next > 0o777) {
    throw new TypeError("mask must be an integer or octal string between 0 and 0o777");
  }
  processUmask = next;
  return previous;
};

const process = emitter({
  // Node convention: argv[0] is the runtime, argv[1] the script.
  argv: ["node", ...sys.argv.slice(1)],
  argv0: "node",
  execPath: "/bin/node",
  // The node-specific CLI flags the runtime was launched with (`--inspect`, …).
  // We accept none, so it's empty — but it MUST be an array: tools spread it
  // (`[...process.execArgv]`), e.g. Next's getParsedNodeOptions.
  execArgv: [],
  env: { ...sys.env },
  platform: "workeros",
  arch: "wasm32",
  config: processConfig,
  features: Object.freeze({ debug: false, inspector: false }),
  // `process.version` MUST be a Node-compatible semver: real tools (npm, and
  // anything using `semver.satisfies(process.version, engines.node)`) parse it to
  // gate the engine, and a non-semver value makes them bail (npm exits silently).
  // We match `versions.node`. Our true identity — that we are NOT Node — lives in
  // `process.release.name` below (Node reports "node"; we say "workeros"), the same
  // way Bun/Deno report a Node semver here while identifying themselves elsewhere.
  version: "v22.23.1",
  // `versions.node` is what packages feature-detect on; a recent value makes them
  // take modern code paths (which our builtins target) rather than throw
  // "unsupported Node".
  //
  // `versions.webcontainer` is the seam napi-rs/rolldown (Vite's bundler) use to
  // choose their **wasm** binding over a native `.node` addon — a browser OS can't
  // load native machine code, but a wasm binding it can. WorkerOS is a webcontainer-
  // class environment (in-browser, wasm-backed), so we truthfully advertise the
  // capability here; it's what makes `@rolldown/binding-wasm32-wasi` load instead of
  // rolldown throwing "Cannot find native binding". (npm already installs that wasm
  // binding for us, since we report `arch: "wasm32"`.)
  versions: { node: "22.23.1", workeros: "0.0.0", v8: "0.0", webcontainer: "1.6.0" },
  // Truthful runtime identity (INV-5): a real Node reports `release.name === "node"`.
  release: { name: "workeros", lts: false, sourceUrl: "", headersUrl: "" },
  cwd: () => cwd,
  chdir: (d) => { cwd = resolveCwd(String(d)); },
  hrtime,
  nextTick: (cb, ...args) => queueMicrotask(() => cb(...args)),
  umask,
  // A terminal fd gets a real tty stream (setRawMode / cursorTo / …); a redirected
  // one gets a plain reader/writer — the isTTY split Node makes. Both pump the fd
  // so `process.stdin` actually delivers input (flowing / paused / async-iter).
  stdin: new tty.ReadStream(0, { isTTY: in0 }),
  stdout: out1 ? new tty.WriteStream(1) : pipeStream(1),
  stderr: err2 ? new tty.WriteStream(2) : pipeStream(2),
  // sys.exit reports the code to the kernel and throws to unwind the current tick,
  // exactly like Node's non-returning process.exit.
  exit: (code = 0) => { emitExit(code | 0); sys.exit(code | 0); },
});
// Node emits `'exit'` exactly once as the process finishes — natural completion or
// an explicit process.exit. Handlers run synchronously; a throw here (e.g. a test
// harness' deferred `mustCall` assertion) propagates to the program worker and
// becomes a non-zero exit, exactly as an uncaught error would.
let exitEmitted = false;
const emitExit = (code) => { if (exitEmitted) return; exitEmitted = true; process.emit("exit", code | 0); };
// Register/deregister signal interest with the kernel: a caught SIGINT is then
// delivered cooperatively (via sys.onSignal) instead of hard-killing the process.
process._onadd = (ev) => { if (SIGNALS.has(ev) && process.listenerCount(ev) === 1) sys.sighandle(ev, true); };
process._onremove = (ev) => { if (SIGNALS.has(ev) && process.listenerCount(ev) === 0) sys.sighandle(ev, false); };

// `process.pid` / `process.kill(pid, sig)`. The kernel assigns the real pid at
// spawn. Killing another pid routes to the kernel (same path child_process uses).
// Killing *self* (own pid, or the conventional 0, or an omitted pid) applies Node's
// disposition: signal 0 is a liveness probe (a no-op that reports the process
// exists); a signal the guest handles fires that listener; an unhandled terminating
// signal exits 128+signum. npm's signal-exit re-raises `process.kill(process.pid,
// sig)` after running its cleanup, so this must actually terminate rather than throw
// "process.kill is not a function" (the error seen on Ctrl-C during `npm run dev`).
process.pid = sys.pid;
process.ppid = sys.ppid ?? 0;
process.kill = (pid, sig = "SIGTERM") => {
  const signum = typeof sig === "number" ? sig : (SIGNUM[sig] ?? SIGNUM.SIGTERM);
  if (pid == null || pid === 0 || pid === process.pid) {
    if (signum === 0) return true; // probe only: we're alive
    const name = typeof sig === "string" ? sig : SIGNAME[signum];
    if (name && SIGNALS.has(name) && process.listenerCount(name) > 0) { process.emit(name); return true; }
    emitExit(128 + signum);
    sys.exit(128 + signum);
    return true;
  }
  sys.childKill(pid, signum);
  return true;
};
globalThis.process = process;

// Node's fatal-error semantics for the guest. An exception that escapes an async
// callback — a timer, a socket 'data' handler, a resolved-promise continuation —
// has nowhere to go in a browser worker: it neither rejects the tail `whenIdle()`
// nor exits the process, so the run would just hang until the harness times out.
// Mirror Node instead: hand it to a `process.on('uncaughtException')` listener if
// one is registered (and let the process continue); with no listener, print the
// stack and exit 1. This is what turns a test's *asynchronous* assertion failure
// into a real non-zero exit — the difference between a reported FAIL and a
// timeout. (Synchronous throws at module top level already reject up to the
// program worker; this covers only what escapes the loop.)
let inFatal = false;
// Set once we've committed to the terminal fatal path (printed + reported exit 1).
// The idle-exit tail reads it to avoid overwriting that with a success code when a
// rejection/error surfaced right as the loop drained (they fire as a *task* after
// the microtask checkpoint, i.e. potentially after whenIdle() has resolved).
let fatalReported = false;
const onFatal = (error, kind) => {
  // process.exit()'s unwinding throw isn't an error — the code is already reported.
  if (error && error.name === "ProcessExit") return;
  const event = kind === "unhandledRejection" ? "unhandledRejection" : "uncaughtException";
  if (process.listenerCount(event) > 0) {
    // A handler exists: Node emits and keeps running (unless the handler itself
    // throws, which is then genuinely fatal). unhandledRejection also passes the
    // promise as the 2nd arg; we don't retain it, so pass undefined.
    try { process.emit(event, error, undefined); return; }
    catch (e) { if (e && e.name === "ProcessExit") return; error = e; }
  }
  if (inFatal) return; // a throw from within stderr write / emit('exit') — give up cleanly
  inFatal = true;
  fatalReported = true;
  if (event === "unhandledRejection") {
    // Node ≥15 default: an unhandled rejection is fatal, reported as such.
    err("node: Unhandled promise rejection. " +
      ((error && (error.stack || error.message)) || String(error)) + "\n");
  } else {
    err(((error && (error.stack || error.message)) || String(error)) + "\n");
  }
  emitExit(1);
  try { sys.exit(1); } catch (e) { if (!e || e.name !== "ProcessExit") throw e; }
};
// A browser worker surfaces every async-callback throw as a global 'error' event
// and every dropped rejection as 'unhandledrejection' — the single choke point
// through which the event loop's rethrows (event-loop.js) and stray rejections
// pass. preventDefault() suppresses the worker's own console spew; onFatal owns it.
if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("error", (ev) => {
    ev.preventDefault();
    onFatal(ev.error != null ? ev.error : new Error(ev.message || "uncaught exception"), "uncaughtException");
  });
  self.addEventListener("unhandledrejection", (ev) => {
    ev.preventDefault();
    onFatal(ev.reason, "unhandledRejection");
  });
}

// Node event-loop keep-alive (INV-1): without it, /bin/node reports the process
// exited the instant the script's synchronous top level returns, so a top-level
// setInterval/setTimeout would never fire. `install` publishes wrapped timer
// globals that ref-count outstanding work; the tail `await whenIdle()` waits for
// them to drain. (Bind the natives first — install overwrites the globals.)
const loop = createEventLoop({
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
});
loop.install(globalThis);
const whenIdle = loop.whenIdle;
// Published for the network layer (node:net/http, ADR-021): an open listener or
// live connection holds the process alive via loop.ref()/unref(), exactly as a
// pending socket does in Node. Read at listen/close time, so ordering vs. the
// builtin construction below doesn't matter.
globalThis.__workerosLoop = loop;

// Deliver kernel signals to process listeners. SIGWINCH refreshes the cached
// terminal size first, so a handler (and later reads of stdout.columns) see the
// new geometry; its default disposition is otherwise a harmless no-op. A handler
// that calls process.exit throws ProcessExit (exit already reported) — swallow it.
sys.onSignal(async (sig) => {
  if (sig === "SIGWINCH") {
    const size = await sys.winsize();
    winsize.cols = size.cols; // keep the tty streams' getWindowSize() current
    winsize.rows = size.rows;
    if (process.stdout.isTTY) { process.stdout.columns = size.cols; process.stdout.rows = size.rows; }
    process.stdout.emit("resize");
  }
  try { process.emit(sig); }
  catch (e) { if (!e || e.name !== "ProcessExit") throw e; }
});

// Node module resolution is *userland* (INV-1): the kernel is just the
// filesystem here. We read the entry ourselves (sync `fs`), decide CJS vs ESM,
// and — for ESM — build the whole import graph in-process (`buildEsmGraph`),
// resolving relative + `node_modules`/`exports` + `node:` builtins. The kernel
// knows nothing of any of that.
// The `node:` builtins that only this running program can supply — `process` and
// `tty` carry per-process state (argv/env/stdio, the fds' TTY-ness) that the pure
// `makeBuiltins` factory can't; `worker_threads` carries this process's own thread
// identity (isMainThread/threadId/workerData from the startup `workerInit` probe).
// Threaded into both the ESM registry here and the CJS runtime below, so
// `import process from 'node:process'` / `require('tty')` alike resolve to these
// exact objects. (chalk's supports-color needs both.)
const nodeBuiltins = { process, tty, worker_threads: createWorkerThreads(sys, workerInit) };

// Node globals a browser worker doesn't provide: `global` (Node's alias for the
// global object) and `Buffer` (which a huge amount of npm expects ambient). Set
// these BEFORE makeBuiltins: builtins that capture `globalThis.Buffer` at
// construction (net/http do, for socket-data chunks) would otherwise capture
// `undefined` and later throw `Cannot read properties of undefined (reading
// 'from')` — the bug that stopped `http.Server` (hence a Vite dev server) from
// delivering a request to its handler.
globalThis.global = globalThis;
globalThis.Buffer = NodeBuffer;

// Node ≥18 ships a global WHATWG `fetch`. The program worker sealed the browser's
// own `fetch` (sealGuestNetwork) so a guest can't reach the network behind the
// kernel's back — but the *capability* still exists, through `sys.netFetch` (routed,
// audited egress). So /bin/node re-provides `fetch` on top of that primitive, the
// same userland-over-kernel layering as `process` (INV-1): a guest gets the standard
// API Node exposes while every byte still leaves through the kernel. This is what
// modern CLIs need — create-astro (and undici-based tools) call global `fetch`
// directly with no `node:http` fallback, so without it they die with "fetch is not a
// function". The WHATWG data classes (`Headers`/`Request`/`Response`/`URL`) are not
// sealed, so we reuse them to normalize the request and shape the response. A process
// denied egress (netEgress=false) still can't reach out: `sys.netFetch` is refused
// kernel-side, so this fetch rejects — enforcement stays in the kernel, not here.
if (typeof globalThis.fetch !== "function" && typeof sys.netFetch === "function") {
  const H = globalThis.Headers;
  globalThis.fetch = async (input, init = {}) => {
    init = init || {};
    const url =
      typeof input === "string" ? input
        : input instanceof URL ? input.href
        : (input && input.url) || String(input);
    const method = String(init.method || (input && input.method) || "GET").toUpperCase();
    const headers = H ? [...new H(init.headers || (input && input.headers) || undefined)] : [];
    let body;
    const raw = init.body != null ? init.body : (input && typeof input === "object" ? input.body : null);
    if (raw != null && method !== "GET" && method !== "HEAD") {
      if (typeof raw === "string") body = enc.encode(raw);
      else if (raw instanceof Uint8Array) body = raw;
      else if (raw instanceof ArrayBuffer) body = new Uint8Array(raw);
      else body = new Uint8Array(await new Response(raw).arrayBuffer());
    }
    const res = await sys.netFetch({ url, method, headers, body });
    // A null-body status (204/205/304) forbids a body in the Response constructor.
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    const out = new Response(nullBody ? null : res.body, {
      status: res.status,
      statusText: res.statusText || "",
      headers: H ? new H(res.headers) : res.headers,
    });
    // `Response.url` is read-only/empty by default; real fetch reports the final URL.
    try { Object.defineProperty(out, "url", { value: res.url || url, configurable: true }); } catch { /* frozen */ }
    return out;
  };
}

const builtins = makeBuiltins(sys, nodeBuiltins);
const fs = builtins.get("fs");
const path = builtins.get("path");
// A browser WorkerGlobalScope exposes `self` as a getter-only accessor; Node's
// worker global lets you assign it. napi-rs's wasm threadpool worker
// (`wasi-worker.mjs`, spun up by Vite's rolldown bundler) does
// `Object.assign(globalThis, { self: globalThis, … })`, which throws on the
// read-only accessor. Redefine `self` as a writable data property (=== globalThis,
// its value anyway) so that assignment succeeds, matching Node.
try { Object.defineProperty(globalThis, "self", { value: globalThis, writable: true, configurable: true }); } catch { /* already writable */ }

// Node publishes `MessageChannel`/`MessagePort` as globals that are the *same*
// constructors as `require('worker_threads')`'s — so we shadow the browser
// worker's DOM ones with ours. emnapi's async-work keep-alive depends on this: it
// counts outstanding napi work by holding `new MessageChannel().port1` and
// `ref()`ing it while any is in flight (its NodejsWaitingRequestCounter — the
// userland spelling of a libuv request handle, since Node exposes no other way to
// say "a request is pending"). It prefers the *global* MessageChannel and guards
// with `if (port.ref)`; the DOM port has no `ref`, so the guard silently skips and
// the loop drains mid-flight — /bin/node exits 0 while rolldown is still bundling.
// Ours carry the real ref/unref, so the outstanding work holds the loop as in Node.
globalThis.MessageChannel = nodeBuiltins.worker_threads.MessageChannel;
globalThis.MessagePort = nodeBuiltins.worker_threads.MessagePort;

// For `-e`/`-p`, the entry is synthetic (rooted at cwd so relative requires and
// imports resolve there); otherwise read the script file from the VFS.
let entryAbs =
  evalSource != null
    ? path.join(sys.cwd, "[eval]")
    : path.isAbsolute(script)
      ? path.normalize(script)
      : path.join(sys.cwd, script);
// Node resolves a symlinked main script to its real path (unless
// `--preserve-symlinks-main`), so `import.meta.url`, `__dirname`, and every
// relative `import`/`require` resolve against the *real* directory. This is what
// lets a `node_modules/.bin/<tool>` symlink — how the real npm's bin-links installs
// a package's bin — find the package's own `./dist/...` rather than `.bin/dist/...`.
if (evalSource == null) {
  try { entryAbs = fs.realpathSync(entryAbs); } catch { /* missing → readFileSync below reports it */ }
}
let entrySource;
if (evalSource != null) {
  entrySource = evalSource;
} else {
  let entryBytes;
  try {
    entryBytes = fs.readFileSync(entryAbs);
  } catch {
    err("node: cannot find module '" + script + "'\n");
    sys.exit(1);
  }
  // A wasm file (`\0asm`) isn't JS — run it directly, not through node.
  if (entryBytes.length >= 4 && entryBytes[0] === 0x00 && entryBytes[1] === 0x61 && entryBytes[2] === 0x73 && entryBytes[3] === 0x6d) {
    err("node: " + script + " is a wasm module, not JS (run it directly)\n");
    sys.exit(1);
  }
  entrySource = new TextDecoder().decode(entryBytes);
}

// The ESM loader is set up *unconditionally* (before the entry runs, whatever its
// format), so a CommonJS program can also `import()` an ESM module — the hooks live
// on globalThis, ready for either entry path (Node interop).
//
// Node module resolution is *userland* (INV-1). We build a script's ESM graph and
// stitch it for evaluation. The browser's native ESM loader (in this worker) can
// only fetch blob:/data: URLs — never a VFS path — so a blob per module is the
// unavoidable eval primitive. But nothing user-observable is blob-shaped: the
// resolver, `import.meta.url`, and dynamic `import()` are all backed by the sync
// `fs`, so `import.meta.url` is a real `file://` path and `import(expr)` resolves
// lazily out of `node_modules` exactly as in Node.
const urlMod = builtins.get("url");
const toFileUrl = (abs) => urlMod.pathToFileURL(abs).href;
const resolver = createResolver({ fs, path, conditions: ["node", "import"] });

// resolved path | builtin key -> blob URL. Also the module cache: a path stitched
// once (statically or via a later dynamic import) keeps one blob, so the browser
// gives it a single module instance — Node's singleton semantics.
const pathToBlob = new Map();

globalThis.__workerosBuiltins = builtins;
// Load a CommonJS module (and, on demand, its `require` subtree) via the
// synchronous CJS loader — backed by the sync `fs`, so a CJS dep reached from
// ESM resolves its own `require`s at load time. Cached, so a stitch-time probe
// and the runtime import share one instance.
globalThis.__workerosLoadCjs = (p) => builtins.get("module")._loadByPath(p);

const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
// A synthetic ES module that re-exports a live runtime object `m`: `export
// default m` plus a named export per own key (interop for `import { x } from …`).
const reexportSource = (getter, keys) => {
  let src = `const m = ${getter};\nexport default m;\n`;
  for (const n of keys) src += `export const ${n} = m[${JSON.stringify(n)}];\n`;
  return src;
};
// A module value can be a function carrying named properties, not just a plain
// object — the classic CJS `module.exports = fn; fn.Named = …` shape (node:stream
// is exactly this: `Stream` is a function with `Stream.Readable` etc.). Enumerate
// named exports for both so `import { Readable } from 'node:stream'` resolves.
const ownKeys = (m) =>
  m && (typeof m === "object" || typeof m === "function") && !Array.isArray(m)
    ? Object.keys(m).filter((k) => k !== "default" && isIdent(k))
    : [];
const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));

// A `node:` builtin has no VFS file — synthesize a re-export module wired to the
// guest runtime object (`import fs from 'node:fs'` / `import { readFileSync } from
// 'fs'` both work). Keyed by the builtin key, created once.
const builtinBlob = (key) => {
  if (!pathToBlob.has(key)) {
    const getter = `globalThis.__workerosBuiltins.get(${JSON.stringify(key)})`;
    pathToBlob.set(key, blobUrl(reexportSource(getter, ownKeys(builtins.get(key)))));
  }
  return pathToBlob.get(key);
};

// A CommonJS module (`module.exports`/`require`) reached from ESM can't evaluate
// as an ES module — stand it up with a synthetic ESM that hands off to the sync
// CJS loader (its `require` subtree resolves out of the VFS at load time).
const cjsBlob = (abs) => {
  if (!pathToBlob.has(abs)) {
    // Load once to read the named exports (cached & shared with the blob's own
    // `__workerosLoadCjs(abs)`, so both see the same instance). A failure here
    // must PROPAGATE, not be swallowed: ESM named exports are static, baked into
    // the blob at build time, so a caught failure would freeze a `default`-only
    // blob — and then, since a throwing module is no longer cached, a retry that
    // happens to succeed would resolve with every named export silently missing
    // (`mod.nextDev is not a function`). Letting it throw surfaces the real load
    // error and rejects the import, which is the honest outcome.
    const keys = ownKeys(globalThis.__workerosLoadCjs(abs));
    pathToBlob.set(abs, blobUrl(reexportSource(`globalThis.__workerosLoadCjs(${JSON.stringify(abs)})`, keys)));
  }
  return pathToBlob.get(abs);
};

// Stitch a resolved graph into blob modules (dependencies first) and return the
// entry's blob URL. `transformModule` rewrites each module's static specifiers to
// their dependency blobs and makes `import.meta` / dynamic `import()` fs-backed.
// Reused for the entry graph and for every lazily import()'d subgraph, sharing the
// `pathToBlob` cache. Cyclic ESM can't be blob-stitched (a blob URL must exist
// before it's referenced) — a true cycle is reported rather than silently wrong.
// Thrown by stitchGraph when the graph has a true import cycle (no blob URL can be
// created before it is referenced). Caught by `evalEsm`, which retries via the oxc
// runner — the loader that *can* link cycles.
const CYCLE = Symbol("cycle");

const stitchGraph = (graph) => {
  for (const mod of graph.modules) {
    for (const imp of mod.imports) if (imp.builtin) builtinBlob(imp.resolved);
  }
  const cjsPaths = new Set(
    graph.modules
      .filter((m) => m.path !== graph.entry && detectFormat(m.source, m.path, { fs, path }) === "cjs")
      .map((m) => m.path),
  );
  for (const p of cjsPaths) cjsBlob(p);
  let remaining = graph.modules.filter((m) => !cjsPaths.has(m.path) && !pathToBlob.has(m.path));
  while (remaining.length) {
    const built = [];
    for (const mod of remaining) {
      if (!mod.imports.every((imp) => pathToBlob.has(imp.resolved))) continue;
      const resolvedOf = new Map(mod.imports.map((i) => [i.specifier, i.resolved]));
      const src = transformModule(mod.source, mod.path, {
        staticUrl: (spec) => pathToBlob.get(resolvedOf.get(spec)),
      });
      pathToBlob.set(mod.path, blobUrl(src));
      built.push(mod.path);
    }
    if (built.length === 0) throw CYCLE;
    remaining = remaining.filter((m) => !pathToBlob.has(m.path));
  }
  return pathToBlob.get(graph.entry);
};

// The oxc-backed ESM runner (built lazily, only if a cycle actually needs it): it
// transforms each module (import/export → live-binding runner calls) and runs it as
// an async function, seeding exports before the body — so it links import cycles the
// blob stitch can't. Reuses this process's resolver, `import.meta`, CJS loader, and
// builtins, so a module loaded either way behaves identically.
let esmRunner = null;
const getRunner = () =>
  esmRunner ||
  (esmRunner = createEsmRunner({
    fs,
    path,
    resolver,
    transform: (src, abs) =>
      isTsPath(abs)
        ? getBundler().transformTs(src, abs.endsWith(".tsx"))
        : getBundler().transform(src),
    detectFormat,
    makeMeta: (abs) => globalThis.__workerosMeta(abs),
    loadCjs: (abs) => globalThis.__workerosLoadCjs(abs),
    getBuiltin: (key) => builtins.get(key),
  }));

// Evaluate an ES module and return its namespace: the native blob stitch by default
// (V8's own loader — the fast, spec-exact path); on a true cycle it retries through
// the runner. `isFile` is false only for the synthetic `-e`/`-p` entry, which has no
// VFS file for the runner to read (and no cycle to speak of).
const evalEsm = async (abs, source, isFile = true) => {
  const graph = buildEsmGraph({ fs, path, resolver }, abs, source);
  // TypeScript anywhere in the graph → the oxc runner, which type-strips with a real
  // parser and links the rest (the native blob stitch can't run TS, and the JS import
  // scanner can't read it). buildEsmGraph marks such modules `ts` without scanning them.
  if (graph.modules.some((m) => m.ts)) return await getRunner().load(abs);
  try {
    return await import(stitchGraph(graph));
  } catch (e) {
    if (e !== CYCLE) throw e;
    if (!isFile) { err("node: unresolvable or cyclic module graph\n"); sys.exit(1); }
    return await getRunner().load(abs);
  }
};

// `require(esm)` — a CommonJS module synchronously requiring an ES module (Node
// allows this for modules without top-level await). The CJS loader (`module.js`)
// calls this with a resolved ESM file; the runner loads it synchronously and
// returns its namespace. A module with real top-level await surfaces as a require
// failure, as in Node.
globalThis.__workerosRequireEsm = (abs) => getRunner().loadSync(abs);

// Strip TypeScript from a CommonJS module's source before the CJS evaluator runs it
// (module.js). Strip-only: types (and `import type`) go, `enum`/`namespace`/parameter
// properties are lowered, `require`/`module.exports` are untouched. `tsx` picks JSX.
globalThis.__workerosStripTs = (src, tsx) => getBundler().stripTs(src, tsx);

// `import.meta` for a module: a real `file://` URL plus fs-derived
// filename/dirname and a `resolve()` that runs the same resolver (as Node's
// `import.meta.resolve`). This is what `createRequire(import.meta.url)`,
// `fileURLToPath(import.meta.url)`, and `new URL('./x', import.meta.url)` see.
globalThis.__workerosMeta = (abs) => ({
  url: toFileUrl(abs),
  filename: abs,
  dirname: path.dirname(abs),
  resolve: (spec) => {
    const r = resolver.resolveFrom(path.dirname(abs), String(spec));
    return r ? toFileUrl(r) : undefined;
  },
});

// Lazy, fs-resolved dynamic `import()`: resolve the specifier against the importing
// module's real directory, materialize it on demand, and import the result. A
// missing target rejects the returned promise (as in Node) instead of aborting the
// process at graph-build time — so `import('optional').catch(...)` degrades.
globalThis.__workerosImport = async (base, spec) => {
  // Hold the event loop open while the import is in flight (Node keeps the process
  // alive during a pending dynamic import) — otherwise a CJS entry whose only
  // remaining work is `import('…').then(…)` would exit before the module loads.
  loop.ref();
  try {
    spec = String(spec);
    if (isBuiltinSpec(spec)) return await import(builtinBlob(builtinKey(spec)));
    const target = spec.startsWith("file://") ? urlMod.fileURLToPath(spec) : spec;
    const abs = resolver.resolveFrom(path.dirname(base), target);
    if (!abs) throw new Error(`Cannot find module '${spec}' imported from ${base}`);
    const source = fs.readFileSync(abs, "utf8");
    if (detectFormat(source, abs, { fs, path }) === "cjs") return await import(cjsBlob(abs));
    return await evalEsm(abs, source);
  } finally {
    loop.unref();
  }
};

// Evaluate the entry on the path its format selects: a CommonJS entry runs through
// the sync CJS runtime; an ESM entry is stitched and imported. (`-e`/`-p` has no
// file scope, so its format is syntax-only; a real entry uses the nearest
// package.json `"type"` — Node's rule — not a source sniff.) A ProcessExit thrown by
// process.exit (via sys.exit) unwinds past here and is caught by the program worker,
// which reports the code; a genuine error likewise propagates (stack + exit 1).
if (detectFormat(entrySource, entryAbs, evalSource != null ? undefined : { fs, path }) === "cjs") {
  const run = createNodeRuntime(sys, nodeBuiltins);
  await run(entryAbs, entrySource);
} else {
  await evalEsm(entryAbs, entrySource, evalSource == null);
}

// Node stays alive past top level while the event loop has ref'd work; do the
// same, so timer-driven scripts (spinners, polling, deferred writes) actually run
// to completion instead of the process being reported exited the instant the
// entry's synchronous body returns.
await whenIdle();

// The loop drained, but a promise rejected without a handler (or an async callback
// threw) right as it did would only surface on the *next* task: the browser fires
// 'unhandledrejection'/'error' during the microtask checkpoint that follows the
// current task, so onFatal hasn't run yet. Returning now would report exit 0 before
// that event lands (the program worker's success reportExit wins the race), which is
// exactly how a create-* CLI whose entry is `void import('./cli').then(m=>m.main())`
// vanished silently. Yield a few macrotasks so any pending rejection/error dispatches
// and onFatal reports it (exit 1) first. Node likewise reports a still-unhandled
// rejection at loop end rather than exiting 0.
for (let i = 0; i < 3 && !fatalReported; i++) await new Promise((r) => setTimeout(r, 0));

// The loop has drained: the process is about to exit. If a fatal error surfaced in
// those macrotasks, onFatal already printed it and reported exit 1 (its sys.exit
// throw was swallowed at the event-listener boundary; the program worker's exit
// report is idempotent, so success can no longer overwrite it) — leave that as the
// outcome. Otherwise fire Node's `'exit'` event (0) so end-of-run hooks — notably
// the compat harness' `mustCall` bookkeeping — get their synchronous chance to assert.
if (!fatalReported) emitExit(0);
