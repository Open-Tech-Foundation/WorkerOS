// `node:zlib` — DEFLATE/gzip for the WorkerOS Node runtime.
//
// GUEST code (INV-1). Node's zlib API is *synchronous* (`gzipSync`, `inflateSync`
// — Vite's build reporter calls `gzipSync` inline), but the browser's only
// compressor, `CompressionStream`, is async-only and can't back a sync call. So
// the actual DEFLATE + checksums run through the WorkerOS codec wasm
// (`crates/workeros-codec`, miniz_oxide), instantiated synchronously and reached
// via `wasm-codec.js` — the single implementation, no JS fallback. This file owns
// only the userland framing (gzip/zlib headers), the sync/async API surface, and
// the stream classes. (de)compression is userland, not a kernel primitive.
//
// Honest surface (INV-5): Brotli has no host/wasm backing here, so it is *absent*
// (not faked). The stream classes below are buffered transforms: they accept
// chunked writes and expose the standard constructors, but emit their payload on
// flush/end rather than implementing byte-perfect incremental zlib flush semantics.

import { Buffer } from "./buffer.js";
import { getCodec } from "./wasm-codec.js";
import { stream as streamModule } from "./stream.js";

// ---- input coercion -------------------------------------------------------
function toBytes(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("Input must be a string, Buffer, TypedArray, DataView, or ArrayBuffer");
}

// ---- codec (crates/workeros-codec) ---------------------------------------
// Raw DEFLATE + the checksums run through the wasm codec — the single, real
// implementation. `getCodec()` throws if it can't be loaded, so there is no
// silent fallback and no second, lower-ratio encoder to diverge from. Only the
// tiny framing below (gzip/zlib headers) stays in JS.
const deflateRaw = (data) => getCodec().deflateRaw(data);
const inflateRaw = (data) => getCodec().inflateRaw(data);
const crc32 = (data) => getCodec().crc32(data);
const adler32 = (data) => getCodec().adler32(data);

// ---- format wrappers ------------------------------------------------------
function u32le(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

function gzipWrap(data) {
  const body = deflateRaw(data);
  const out = new Uint8Array(10 + body.length + 8);
  out.set([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff], 0); // magic, DEFLATE, no flags, mtime 0, xfl 0, OS unknown
  out.set(body, 10);
  out.set(u32le(crc32(data)), 10 + body.length);
  out.set(u32le(data.length >>> 0), 14 + body.length);
  return out;
}
function gunzipUnwrap(buf) {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error("incorrect gzip header magic");
  if (buf[2] !== 0x08) throw new Error("unknown gzip compression method");
  const flg = buf[3];
  let p = 10;
  if (flg & 0x04) { const xlen = buf[p] | (buf[p + 1] << 8); p += 2 + xlen; } // FEXTRA
  if (flg & 0x08) { while (buf[p++] !== 0); }                                 // FNAME
  if (flg & 0x10) { while (buf[p++] !== 0); }                                 // FCOMMENT
  if (flg & 0x02) p += 2;                                                     // FHCRC
  const out = inflateRaw(buf.subarray(p));
  const wantCrc = (buf[buf.length - 8] | (buf[buf.length - 7] << 8) | (buf[buf.length - 6] << 16) | (buf[buf.length - 5] << 24)) >>> 0;
  if (crc32(out) !== wantCrc) throw new Error("gzip checksum mismatch");
  return out;
}
function zlibWrap(data) {
  const body = deflateRaw(data);
  const out = new Uint8Array(2 + body.length + 4);
  out.set([0x78, 0x9c], 0); // CMF/FLG (deflate, 32K window, default level)
  out.set(body, 2);
  const a = adler32(data);
  out.set([(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff], 2 + body.length); // Adler-32 big-endian
  return out;
}
function zlibUnwrap(buf) {
  if ((buf[0] & 0x0f) !== 8) throw new Error("unknown zlib compression method");
  return inflateRaw(buf.subarray(2));
}

// ---- one-shot codecs ------------------------------------------------------
const asBuf = (u8) => Buffer.from(u8);
const gzipSync = (data) => asBuf(gzipWrap(toBytes(data)));
const gunzipSync = (data) => asBuf(gunzipUnwrap(toBytes(data)));
const deflateSync = (data) => asBuf(zlibWrap(toBytes(data)));
const inflateSync = (data) => asBuf(zlibUnwrap(toBytes(data)));
const deflateRawSync = (data) => asBuf(deflateRaw(toBytes(data)));
const inflateRawSync = (data) => asBuf(inflateRaw(toBytes(data)));
function unzipSync(data) {
  const b = toBytes(data);
  if (b[0] === 0x1f && b[1] === 0x8b) return asBuf(gunzipUnwrap(b));
  if ((b[0] & 0x0f) === 8) return asBuf(zlibUnwrap(b));
  return asBuf(inflateRaw(b)); // headerless raw deflate
}

// Async callback form: `fn(buf[, opts], cb)`. Options (level, …) are accepted and
// ignored — the codec emits a valid DEFLATE stream regardless.
const asyncify = (syncFn) => (data, opts, cb) => {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  queueMicrotask(() => {
    try { cb(null, syncFn(data)); } catch (e) { cb(e); }
  });
};

class ZlibBase extends streamModule.Transform {
  constructor(syncFn, options = {}) {
    super(options);
    this._syncFn = syncFn;
    this._chunks = [];
    this.bytesWritten = 0;
    // `minizlib` (used by npm's `tar`) bypasses the stream interface and drives the
    // engine through Node's private zlib internals: it reads `engine._handle` and
    // temporarily neutralizes its `.close`, then calls `engine._processChunk(chunk,
    // flushFlag)` synchronously. We provide a stand-in `_handle` and a
    // `_processChunk` so that path works. `_handle` just needs a `close` to save and
    // restore; our codec is one-shot, so it isn't a real native binding.
    this._handle = { close() {} };
  }

  _transform(chunk, _encoding, cb) {
    const buf = toBytes(chunk);
    this._chunks.push(buf);
    this.bytesWritten += buf.length;
    cb();
  }

  // Synchronous chunk processor for `minizlib`. Our codec is one-shot (a whole
  // gzip/zlib member at a time), so accumulate input and (de)compress on the final
  // `Z_FINISH` flush, returning the full result then — sufficient for tar unpacking
  // package tarballs, which are complete members.
  _processChunk(chunk, flushFlag) {
    const buf = toBytes(chunk);
    if (buf.length) { this._chunks.push(buf); this.bytesWritten += buf.length; }
    if (flushFlag === constants.Z_FINISH) {
      const chunks = this._chunks;
      this._chunks = [];
      // minizlib monkeypatches `Buffer.concat` to a no-op for the duration of this
      // call (Node's native handler concatenates itself), so join manually — a
      // `Buffer.concat` here would return undefined and blow up the codec.
      let total;
      if (chunks.length === 1) {
        total = chunks[0];
      } else {
        let len = 0;
        for (const c of chunks) len += c.length;
        total = Buffer.alloc(len);
        let o = 0;
        for (const c of chunks) { total.set(c, o); o += c.length; }
      }
      return this._syncFn(total);
    }
    return Buffer.alloc(0);
  }

  close(cb) { if (typeof cb === "function") queueMicrotask(cb); return this; }

  _flush(cb) {
    try {
      const total = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks.map((c) => Buffer.from(c)));
      this._chunks = [];
      cb(null, this._syncFn(total));
    } catch (e) {
      cb(e);
    }
  }

  flush(kind, cb) {
    if (typeof kind === "function") {
      cb = kind;
      kind = constants.Z_FULL_FLUSH;
    }
    queueMicrotask(() => {
      if (cb) cb();
    });
    return this;
  }

  params(level, strategy, cb) {
    if (typeof cb === "function") queueMicrotask(cb);
    return this;
  }

  reset() {
    this._chunks = [];
    this.bytesWritten = 0;
  }
}

class Gzip extends ZlibBase {
  constructor(options = {}) { super(gzipSync, options); }
}
class Gunzip extends ZlibBase {
  constructor(options = {}) { super(gunzipSync, options); }
}
class Deflate extends ZlibBase {
  constructor(options = {}) { super(deflateSync, options); }
}
class Inflate extends ZlibBase {
  constructor(options = {}) { super(inflateSync, options); }
}
class DeflateRaw extends ZlibBase {
  constructor(options = {}) { super(deflateRawSync, options); }
}
class InflateRaw extends ZlibBase {
  constructor(options = {}) { super(inflateRawSync, options); }
}
class Unzip extends ZlibBase {
  constructor(options = {}) { super(unzipSync, options); }
}

const createGzip = (options) => new Gzip(options);
const createGunzip = (options) => new Gunzip(options);
const createDeflate = (options) => new Deflate(options);
const createInflate = (options) => new Inflate(options);
const createDeflateRaw = (options) => new DeflateRaw(options);
const createInflateRaw = (options) => new InflateRaw(options);
const createUnzip = (options) => new Unzip(options);

// ---- constants (a pragmatic subset of Node's zlib.constants) --------------
const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
  Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
  Z_DEFLATED: 8, ZLIB_VERNUM: 0x12b0,
};

// The `node:zlib` module object registered as a builtin (import + require).
export const zlib = {
  createGzip,
  createGunzip,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createUnzip,
  Gzip,
  Gunzip,
  Deflate,
  Inflate,
  DeflateRaw,
  InflateRaw,
  Unzip,
  gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, unzipSync,
  gzip: asyncify(gzipSync),
  gunzip: asyncify(gunzipSync),
  deflate: asyncify(deflateSync),
  inflate: asyncify(inflateSync),
  deflateRaw: asyncify(deflateRawSync),
  inflateRaw: asyncify(inflateRawSync),
  unzip: asyncify(unzipSync),
  crc32: (data, value = 0) => {
    // Node 20.15+ exposes zlib.crc32(data, value). We support the common value=0 case.
    if (value !== 0) throw new Error("zlib.crc32 with a nonzero seed is not supported");
    return crc32(toBytes(data));
  },
  constants,
};

export default zlib;
