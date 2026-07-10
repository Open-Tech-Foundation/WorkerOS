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

const enc = new TextEncoder();
const err = (s) => sys.write(2, enc.encode(s));

const script = sys.argv[1];
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
const [in0, out1, err2, ws] = await Promise.all([
  sys.isatty(0), sys.isatty(1), sys.isatty(2), sys.winsize(),
]);

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

const stream = (fd, isTTY) => {
  const s = emitter({ write(chunk) { sys.write(fd, toBytes(chunk)); return true; }, isTTY });
  if (isTTY) { s.columns = ws.cols; s.rows = ws.rows; }
  return s;
};

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
  stdin: emitter({ isTTY: in0 }),
  stdout: stream(1, out1),
  stderr: stream(2, err2),
  // sys.exit reports the code to the kernel and throws to unwind the current tick,
  // exactly like Node's non-returning process.exit.
  exit: (code = 0) => sys.exit(code | 0),
});
// Register/deregister signal interest with the kernel: a caught SIGINT is then
// delivered cooperatively (via sys.onSignal) instead of hard-killing the process.
process._onadd = (ev) => { if (SIGNALS.has(ev) && process.listenerCount(ev) === 1) sys.sighandle(ev, true); };
process._onremove = (ev) => { if (SIGNALS.has(ev) && process.listenerCount(ev) === 0) sys.sighandle(ev, false); };
globalThis.process = process;

// Deliver kernel signals to process listeners. SIGWINCH refreshes the cached
// terminal size first, so a handler (and later reads of stdout.columns) see the
// new geometry; its default disposition is otherwise a harmless no-op.
sys.onSignal(async (sig) => {
  if (sig === "SIGWINCH") {
    const size = await sys.winsize();
    if (process.stdout.isTTY) { process.stdout.columns = size.cols; process.stdout.rows = size.rows; }
    process.stdout.emit("resize");
  }
  process.emit(sig);
});

// The kernel resolves the whole import graph against the VFS (every specifier→path
// decision is the kernel's — INV-2); we only evaluate what it hands back.
const graph = await sys.resolveGraph(script);
if (graph.kind === "wasm") {
  err("node: " + script + " is a wasm module, not JS (run it directly)\n");
  sys.exit(1);
}

// CommonJS entry (`require`/`module.exports`): run it through the CJS runtime,
// which resolves the `require` graph out of the VFS and provides the `node:`
// builtins (fs/path). A plain ESM script falls through to the stitch path below.
const entryMod = graph.modules.find((m) => m.path === graph.entry);
if (entryMod && usesCommonjs(entryMod.source, graph.entry)) {
  const run = createNodeRuntime(sys);
  await run(graph.entry, entryMod.source);
} else {

// Stitch the resolved graph into blob URLs, dependencies first, rewriting each
// import specifier to its dependency's blob URL. Mechanical assembly only — the
// kernel already decided every target (mirrors the worker's own stitch step).
const pathToBlob = new Map();

// `node:` builtin edges (Phase 5·C-ESM): the kernel marked these `builtin`, so
// there is no VFS file. Synthesize a tiny ES module per distinct builtin that
// re-exports the live runtime object (stashed on the global for the blob realm
// to read) — `export default m` plus a named export per own key, so both
// `import fs from 'node:fs'` and `import { readFileSync } from 'fs'` work.
const builtins = makeBuiltins(sys);
globalThis.__workerosBuiltins = builtins;
const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
const builtinModuleSource = (key) => {
  const b = builtins.get(key);
  const names = b && typeof b === "object" ? Object.keys(b).filter((k) => k !== "default" && isIdent(k)) : [];
  let src = `const m = globalThis.__workerosBuiltins.get(${JSON.stringify(key)});\nexport default m;\n`;
  for (const n of names) src += `export const ${n} = m[${JSON.stringify(n)}];\n`;
  return src;
};
for (const mod of graph.modules) {
  for (const imp of mod.imports) {
    if (imp.builtin && !pathToBlob.has(imp.resolved)) {
      const blob = new Blob([builtinModuleSource(imp.resolved)], { type: "text/javascript" });
      pathToBlob.set(imp.resolved, URL.createObjectURL(blob));
    }
  }
}

let remaining = [...graph.modules];
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
