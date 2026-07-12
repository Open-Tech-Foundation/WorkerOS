// The bridge to the WorkerOS node-bundler wasm (crates/workeros-node-bundler) — a
// synchronous ESM→module-runner transform (oxc). GUEST code (INV-1).
//
// The module is a freestanding .wasm with a manual pointer/length ABI, so it is
// instantiated *synchronously* (`new WebAssembly.Instance`) and callable inside a
// synchronous `require(esm)`. `getBundler()` lazily reads the wasm from the VFS
// through the process's sync-fs channel and instantiates it once per process.
//
// The transform rewrites `import`/`export`/`import.meta`/`import()` into
// live-binding runner calls (`__workeros_import__`, `__workeros_exports__`, …) that
// the guest's module runner binds — so ESM (import cycles + `require(esm)` included)
// runs through the CJS runtime, which the browser's native ESM loader cannot do.

const BUNDLER_PATH = "/lib/workeros-node-bundler/bundler.wasm";

// Wrap a raw instance's exports in a `transform(source) -> code` facade. Pure —
// takes the exports object — so it is unit-testable against a directly-instantiated
// module (no `sys`).
export function bundlerFromExports(ex) {
  // A fresh view each time: `nb_alloc`/the transform can grow memory, detaching any
  // view over the old ArrayBuffer.
  const mem = () => new Uint8Array(ex.memory.buffer);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // Run one of the wasm transforms: copy `source` in, call `fn(ptr, len, ...extra)`,
  // copy the packed (ptr<<32)|len result out. All three transforms share this ABI.
  const call = (fn, source, ...extra) => {
    const data = enc.encode(source);
    const ptr = ex.nb_alloc(data.length) >>> 0;
    mem().set(data, ptr);
    let packed;
    try {
      packed = fn(ptr, data.length, ...extra);
    } finally {
      ex.nb_dealloc(ptr, data.length);
    }
    const outPtr = Number(packed >> 32n) >>> 0;
    const outLen = Number(packed & 0xffffffffn) >>> 0;
    const out = dec.decode(mem().slice(outPtr, outPtr + outLen));
    ex.nb_dealloc(outPtr, outLen);
    return out;
  };
  return {
    // JS ESM → module-runner JS.
    transform: (source) => call(ex.nb_transform, source),
    // TypeScript ESM → module-runner JS (strip types + import/export rewrite).
    transformTs: (source, tsx = false) => call(ex.nb_transform_ts, source, tsx ? 1 : 0),
    // TypeScript CJS → plain JS (strip types only; keep require/module.exports).
    stripTs: (source, tsx = false) => call(ex.nb_strip_ts, source, tsx ? 1 : 0),
  };
}

function readWasmBytes(syncFs, path) {
  let fd;
  try { fd = syncFs.open(path, {}); } catch { return null; }
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const b = syncFs.read(fd, 1 << 20);
      if (!b || b.length === 0) break;
      chunks.push(b);
      total += b.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } finally {
    try { syncFs.close(fd); } catch { /* ignore */ }
  }
}

let cached; // undefined = not yet loaded, or a facade

// Inject a bundler directly (used by `node --test`, which has no `sys` channel to
// read the wasm through — the test instantiates it and hands it here).
export function setBundler(facade) {
  cached = facade;
}

// Load the bundler from the VFS if not already set. Throws if it can't be loaded:
// the wasm is the sole implementation of the ESM transform.
export function getBundler() {
  if (cached !== undefined) return cached;
  const sys = globalThis.sys;
  if (!sys || !sys.syncFs || typeof WebAssembly === "undefined") {
    throw new Error("workeros node-bundler unavailable: no sync-fs channel to load " + BUNDLER_PATH);
  }
  const bytes = readWasmBytes(sys.syncFs, BUNDLER_PATH);
  if (!bytes || bytes.length === 0) {
    throw new Error("workeros node-bundler not installed at " + BUNDLER_PATH + " (build it: npm run build:bundler)");
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  cached = bundlerFromExports(instance.exports);
  return cached;
}
