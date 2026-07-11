// The bridge to the WorkerOS codec wasm (crates/workeros-codec) — a synchronous
// accelerator for node:zlib / node:crypto's hot paths (DEFLATE + hashing).
//
// GUEST code (INV-1). The module is a freestanding .wasm with a manual
// pointer/length ABI, so it can be instantiated *synchronously* and called from
// inside Node's sync APIs. `getCodec()` lazily reads /lib/workeros-codec/codec.wasm
// through the process's sync-fs channel (`globalThis.sys.syncFs`) and instantiates
// it once per process. Everything degrades cleanly: no `sys` (plain Node unit
// tests), no WebAssembly, or no installed wasm (an environment that didn't build
// it) → `getCodec()` returns `null` and the callers use their pure-JS path.

const CODEC_PATH = "/lib/workeros-codec/codec.wasm";

// Wrap a raw instance's exports in an ergonomic byte-in/byte-out facade. Pure —
// takes the exports object — so it is unit-testable against a directly-instantiated
// module (no `sys`).
export function codecFromExports(ex) {
  // A fresh view each time: `cdc_alloc`/the codec calls can grow memory, which
  // detaches any previously-created view over the old ArrayBuffer.
  const mem = () => new Uint8Array(ex.memory.buffer);

  // Copy `data` into freshly-allocated linear memory; returns its pointer.
  const put = (data) => {
    const ptr = ex.cdc_alloc(data.length) >>> 0;
    mem().set(data, ptr);
    return ptr;
  };
  // Read a packed (ptr<<32)|len result out, free it, and return the bytes (or null
  // when the module signalled failure with a null pointer).
  const take = (packed) => {
    const ptr = Number(packed >> 32n) >>> 0;
    const len = Number(packed & 0xffffffffn) >>> 0;
    if (ptr === 0) return null;
    const out = mem().slice(ptr, ptr + len);
    ex.cdc_dealloc(ptr, len);
    return out;
  };
  // Call `fn(inptr, len[, extra])` over a copied-in input buffer, freeing the input.
  const call = (fn, data, extra) => {
    const p = put(data);
    try {
      return extra === undefined ? fn(p, data.length) : fn(p, data.length, extra);
    } finally {
      ex.cdc_dealloc(p, data.length);
    }
  };

  const hash = (fn) => (data) => take(call(fn, data));
  return {
    deflateRaw: (data) => take(call(ex.cdc_deflate, data, 6)),
    inflateRaw: (data) => {
      const out = take(call(ex.cdc_inflate, data));
      if (out === null) throw new Error("invalid or corrupt deflate data");
      return out;
    },
    crc32: (data) => call(ex.cdc_crc32, data) >>> 0,
    adler32: (data) => call(ex.cdc_adler32, data) >>> 0,
    md5: hash(ex.cdc_md5),
    sha1: hash(ex.cdc_sha1),
    sha224: hash(ex.cdc_sha224),
    sha256: hash(ex.cdc_sha256),
    sha384: hash(ex.cdc_sha384),
    sha512: hash(ex.cdc_sha512),
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

let cached; // undefined = not yet tried, null = unavailable, object = facade
export function getCodec() {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const sys = globalThis.sys;
    if (!sys || !sys.syncFs || typeof WebAssembly === "undefined") return cached;
    const bytes = readWasmBytes(sys.syncFs, CODEC_PATH);
    if (!bytes || bytes.length === 0) return cached;
    // Sync compile + instantiate — permitted at any size off the main thread (the
    // program worker), unlike the 4 KB main-thread limit.
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    cached = codecFromExports(instance.exports);
  } catch {
    cached = null; // any failure → pure-JS fallback
  }
  return cached;
}
