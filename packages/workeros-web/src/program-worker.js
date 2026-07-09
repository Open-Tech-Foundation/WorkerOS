// The program worker — one per process. A thin "dumb CPU" (INV-2): it evaluates
// exactly one program on the host JS engine and routes every syscall back to the
// kernel worker. It makes no resolution, filesystem, or capability decision —
// the kernel already resolved the whole module graph and handed it over.
//
// Every guest gets one native surface:
//   • `globalThis.sys` — the WorkerOS syscall ABI (argv/env/cwd + fd ops + a
//     `resolveGraph` call), plus a routing `console`. Coreutils and `/bin/node`
//     alike are written against it.
// Node.js compatibility (`process`, CommonJS `require`) is not a worker concern:
// it lives in the userland `/bin/node` program, which installs `process` and
// evaluates the target script itself. The kernel has no `node` interpreter.
//
// Isolation level: `Full` (bare dynamic import), ADR-009/§7.1.

import { MSG } from "./protocol.js";
import { ProcessExit } from "../../workeros-programs/src/node/process-shim.js";
import { createWasiImports } from "../../workeros-programs/src/wasi/host.js";
import { makeSyncCaller } from "./sync-syscall.js";

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

/** A fire-and-forget write. Ordering with later syscalls is preserved by the
 *  message queue, so a write followed by exit lands before the process closes. */
function writeBytes(fd, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  kernel.postMessage({ type: MSG.SYSCALL, call: "write", args: { fd, data: u8 } });
  return u8.length;
}

let exited = false;
function reportExit(code) {
  if (exited) return;
  exited = true;
  kernel.postMessage({ type: MSG.PROC_EXIT, code: code | 0 });
}

/** Build the WorkerOS-native `sys` ABI for a guest. */
function makeSys(start) {
  return {
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
    // Ask the kernel to resolve a JS module graph (INV-2: the kernel owns every
    // specifier→path decision). A userland runtime like /bin/node calls this to
    // get the graph and then evaluates it itself, in this same worker.
    resolveGraph: (path) => call("resolveGraph", { path, cwd: start.cwd }),
    exit: (code = 0) => {
      reportExit(code | 0);
      throw new ProcessExit(code | 0);
    },
  };
}

/** Stitch a kernel-resolved module graph into blob URLs; return the entry URL.
 *  Dependencies build first so specifiers can be rewritten to their blob URLs.
 *  Mechanical assembly only — the kernel decided every specifier→path (INV-2). */
function stitch(graph) {
  const pathToBlob = new Map();
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
    if (built.length === 0) throw new Error("unresolvable or cyclic module graph");
    remaining = remaining.filter((m) => !pathToBlob.has(m.path));
  }
  return pathToBlob.get(graph.entry);
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
async function runWasm(start, sys) {
  const bytes = await readAll(sys, start.graph.entry);
  let memory = null;
  // Blocking WASI calls (fd_read/path_open/…) go through the synchronous SAB
  // channel; the kernel worker services them while this thread parks.
  const syncCall = makeSyncCaller(start.syncSab, () => kernel.postMessage({ type: MSG.SYNC }));
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
  if (msg.type !== MSG.START) return;

  const sys = makeSys(msg);
  installGlobals(msg, sys);

  try {
    // A wasm32-wasip1 binary: run it through the WASI host bound to the kernel.
    if (msg.graph.kind === "wasm") {
      await runWasm(msg, sys);
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
    reportExit(1);
  }
};
