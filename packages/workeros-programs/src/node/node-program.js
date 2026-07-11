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

import { createNodeRuntime, usesCommonjs, makeBuiltins } from "/lib/workeros-node/require-runtime.js";
import { ArgError, tokenizeArgv } from "/lib/workeros-cli/args.js";
import { buildEsmGraph } from "/lib/workeros-node/esm-graph.js";
import { createTty } from "/lib/workeros-node/tty.js";
import { createEventLoop } from "/lib/workeros-node/event-loop.js";
import { createWorkerThreads } from "/lib/workeros-node/worker-threads.js";

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

// A minimal Node EventEmitter — enough for `process` and its streams
// (on/once/off/emit/listenerCount). `_onadd`/`_onremove` hooks let `process`
// tell the kernel when it starts/stops catching a signal.
const emitter = (obj = {}) => {
  const map = new Map();
  const list = (ev) => map.get(ev) || (map.set(ev, []), map.get(ev));
  obj.on = (ev, fn) => { list(ev).push(fn); obj._onadd?.(ev); return obj; };
  obj.addListener = obj.on;
  obj.once = (ev, fn) => { const g = (...a) => { obj.off(ev, g); fn(...a); }; return obj.on(ev, g); };
  obj.off = (ev, fn) => { map.set(ev, list(ev).filter((f) => f !== fn)); obj._onremove?.(ev); return obj; };
  obj.removeListener = obj.off;
  obj.listenerCount = (ev) => list(ev).length;
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
  emitter,
});

const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGWINCH", "SIGTSTP", "SIGHUP", "SIGUSR1", "SIGUSR2"]);

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

const process = emitter({
  // Node convention: argv[0] is the runtime, argv[1] the script.
  argv: ["node", ...sys.argv.slice(1)],
  argv0: "node",
  execPath: "/bin/node",
  env: { ...sys.env },
  platform: "workeros",
  arch: "wasm32",
  // A truthful, non-Node-fidelity version tag (INV-5): we are not Node.
  version: "workeros-node/0.0.0",
  // `versions.node` is what packages feature-detect on; we report a recent value
  // so they take modern code paths (which our builtins target) rather than throw
  // "unsupported Node". We are still not Node — see `version`/`release` (INV-5).
  versions: { node: "20.0.0", workeros: "0.0.0", v8: "0.0" },
  cwd: () => cwd,
  chdir: (d) => { cwd = resolveCwd(String(d)); },
  hrtime,
  nextTick: (cb, ...args) => queueMicrotask(() => cb(...args)),
  // A terminal fd gets a real tty stream (setRawMode / cursorTo / …); a redirected
  // one gets a plain reader/writer — the isTTY split Node makes. Both pump the fd
  // so `process.stdin` actually delivers input (flowing / paused / async-iter).
  stdin: new tty.ReadStream(0, { isTTY: in0 }),
  stdout: out1 ? new tty.WriteStream(1) : pipeStream(1),
  stderr: err2 ? new tty.WriteStream(2) : pipeStream(2),
  // sys.exit reports the code to the kernel and throws to unwind the current tick,
  // exactly like Node's non-returning process.exit.
  exit: (code = 0) => sys.exit(code | 0),
});
// Register/deregister signal interest with the kernel: a caught SIGINT is then
// delivered cooperatively (via sys.onSignal) instead of hard-killing the process.
process._onadd = (ev) => { if (SIGNALS.has(ev) && process.listenerCount(ev) === 1) sys.sighandle(ev, true); };
process._onremove = (ev) => { if (SIGNALS.has(ev) && process.listenerCount(ev) === 0) sys.sighandle(ev, false); };
globalThis.process = process;

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
const builtins = makeBuiltins(sys, nodeBuiltins);
const fs = builtins.get("fs");
const path = builtins.get("path");

// Node globals a browser worker doesn't provide, installed before the script
// loads: `global` (Node's alias for the global object) and `Buffer` (which a huge
// amount of npm expects ambient — `Buffer.from(...)` at module top level).
globalThis.global = globalThis;
globalThis.Buffer = builtins.get("buffer").Buffer;

// For `-e`/`-p`, the entry is synthetic (rooted at cwd so relative requires and
// imports resolve there); otherwise read the script file from the VFS.
const entryAbs =
  evalSource != null
    ? path.join(sys.cwd, "[eval]")
    : path.isAbsolute(script)
      ? path.normalize(script)
      : path.join(sys.cwd, script);
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

// CommonJS entry (`require`/`module.exports`): run it through the CJS runtime,
// which resolves the `require` graph out of the VFS and provides the `node:`
// builtins (fs/path). A plain ESM script falls through to the stitch path below.
if (usesCommonjs(entrySource, entryAbs)) {
  const run = createNodeRuntime(sys, nodeBuiltins);
  await run(entryAbs, entrySource);
} else {

const graph = buildEsmGraph({ fs, path }, entryAbs, entrySource);

// Stitch the resolved graph into blob URLs, dependencies first, rewriting each
// import specifier to its dependency's blob URL. Mechanical assembly only — the
// resolver already decided every target.
const pathToBlob = new Map();

// `node:` builtin edges (Phase 5·C-ESM): resolved as `builtin`, so there is no
// VFS file. Synthesize a tiny ES module per distinct builtin that re-exports the
// live runtime object (stashed on the global for the blob realm to read) —
// `export default m` plus a named export per own key, so both
// `import fs from 'node:fs'` and `import { readFileSync } from 'fs'` work.
globalThis.__workerosBuiltins = builtins;
// Load a CommonJS module (and, on demand, its `require` subtree) via the
// synchronous CJS loader — backed by the sync `fs`, so a CJS dep reached from
// ESM resolves its own `require`s at load time. Cached, so a stitch-time probe
// and the runtime import share one instance.
globalThis.__workerosLoadCjs = (p) => builtins.get("module")._load(p);

const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
// A synthetic ES module that re-exports a live runtime object `m`: `export
// default m` plus a named export per own key (interop for `import { x } from …`).
const reexportSource = (getter, keys) => {
  let src = `const m = ${getter};\nexport default m;\n`;
  for (const n of keys) src += `export const ${n} = m[${JSON.stringify(n)}];\n`;
  return src;
};
const ownKeys = (m) =>
  m && typeof m === "object" && !Array.isArray(m)
    ? Object.keys(m).filter((k) => k !== "default" && isIdent(k))
    : [];

// `node:` builtin edges (Phase 5·C-ESM): the kernel marked these `builtin`, so
// there is no VFS file — synthesize a re-export module wired to the guest runtime
// (`import fs from 'node:fs'` and `import { readFileSync } from 'fs'` both work).
for (const mod of graph.modules) {
  for (const imp of mod.imports) {
    if (imp.builtin && !pathToBlob.has(imp.resolved)) {
      const getter = `globalThis.__workerosBuiltins.get(${JSON.stringify(imp.resolved)})`;
      const src = reexportSource(getter, ownKeys(builtins.get(imp.resolved)));
      pathToBlob.set(imp.resolved, URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    }
  }
}

// CommonJS modules the kernel resolved into an ESM graph (Phase 5·D follow-up):
// they use `module.exports`/`require`, so they can't be evaluated as ES modules.
// Stand each one up with a synthetic ES module that hands off to the synchronous
// CJS loader, and skip stitching the CJS source as ESM. (The entry itself is ESM
// here — a CJS entry goes through the runtime branch above.)
const cjsPaths = new Set(
  graph.modules.filter((m) => m.path !== graph.entry && usesCommonjs(m.source, m.path)).map((m) => m.path),
);
for (const p of cjsPaths) {
  let keys = [];
  try {
    keys = ownKeys(globalThis.__workerosLoadCjs(p)); // cached; probes named exports
  } catch {
    // A load failure surfaces at runtime (the real import below), not here.
  }
  const src = reexportSource(`globalThis.__workerosLoadCjs(${JSON.stringify(p)})`, keys);
  pathToBlob.set(p, URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
}

let remaining = graph.modules.filter((m) => !cjsPaths.has(m.path));
while (remaining.length) {
  const built = [];
  for (const mod of remaining) {
    if (!mod.imports.every((imp) => pathToBlob.has(imp.resolved))) continue;
    let src = mod.source;
    for (const imp of mod.imports) {
      const url = pathToBlob.get(imp.resolved);
      src = src.split(`"${imp.specifier}"`).join(`"${url}"`);
      src = src.split(`'${imp.specifier}'`).join(`"${url}"`);
    }
    pathToBlob.set(mod.path, URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    built.push(mod.path);
  }
  if (built.length === 0) { err("node: unresolvable or cyclic module graph\n"); sys.exit(1); }
  remaining = remaining.filter((m) => !pathToBlob.has(m.path));
}

// Evaluate the script. A ProcessExit thrown by process.exit (via sys.exit) unwinds
// past here and is caught by the program worker, which reports the code; a genuine
// error likewise propagates to the worker's handler (stack + exit 1).
await import(pathToBlob.get(graph.entry));

} // end ESM branch

// Node stays alive past top level while the event loop has ref'd work; do the
// same, so timer-driven scripts (spinners, polling, deferred writes) actually run
// to completion instead of the process being reported exited the instant the
// entry's synchronous body returns.
await whenIdle();
