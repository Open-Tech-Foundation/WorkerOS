// `node:zlib` — DEFLATE/gzip for the WorkerOS Node runtime.
//
// GUEST code (INV-1). Node's zlib API is *synchronous* (`gzipSync`, `inflateSync`
// — Vite's build reporter calls `gzipSync` inline), but the browser's only
// compressor, `CompressionStream`, is async-only and can't back a sync call. So,
// as with `node:crypto`, the sync core is self-contained here: a full RFC-1951
// INFLATE and a fixed-Huffman + LZ77 DEFLATE, wrapped for gzip (RFC 1952) and
// zlib (RFC 1950). This mirrors the kernel's own dependency-free `hash.rs` and
// keeps the ABI generic — (de)compression is userland, not a kernel primitive.
//
// Honest surface (INV-5): the DEFLATE encoder emits valid fixed-Huffman blocks
// (decodable by real zlib/Node), trading a little ratio for a small, verifiable
// codec — good enough for size reporting and interop. Brotli has no host backing
// and no small JS codec, so it is *absent* (not faked). The stream classes below
// are buffered transforms: they accept chunked writes and expose the standard
// constructors, but emit their payload on flush/end rather than implementing
// byte-perfect incremental zlib flush semantics.

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

// ---- checksums (RFC 1950 / 1952) ------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Js(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32Js(data) {
  let a = 1, b = 0;
  const MOD = 65521;
  // Process in blocks to defer the modulo (a/b can't overflow a double here).
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 3800, data.length);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- RFC 1951 length/distance tables --------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Canonical Huffman codes from a code-length vector (RFC 1951 §3.2.2).
function canonicalCodes(lengths) {
  let maxBits = 0;
  for (const l of lengths) if (l > maxBits) maxBits = l;
  const blCount = new Array(maxBits + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) { code = (code + blCount[bits - 1]) << 1; nextCode[bits] = code; }
  const codes = new Array(lengths.length).fill(0);
  for (let n = 0; n < lengths.length; n++) if (lengths[n]) codes[n] = nextCode[lengths[n]]++;
  return codes;
}

// Fixed Huffman code lengths (RFC 1951 §3.2.6).
const FIXED_LITLEN_LEN = (() => {
  const l = new Array(288);
  for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  return l;
})();
const FIXED_DIST_LEN = new Array(30).fill(5);
const FIXED_LITLEN_CODE = canonicalCodes(FIXED_LITLEN_LEN);
const FIXED_DIST_CODE = canonicalCodes(FIXED_DIST_LEN);

// ---- INFLATE (RFC 1951) ---------------------------------------------------
function inflateRawJs(input) {
  let bitPos = 0;
  const getBit = () => { const b = (input[bitPos >> 3] >> (bitPos & 7)) & 1; bitPos++; return b; };
  const getBits = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= getBit() << i; return v; };

  let out = new Uint8Array(1 << 16);
  let outLen = 0;
  const ensure = (n) => {
    if (outLen + n <= out.length) return;
    let cap = out.length;
    while (cap < outLen + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(out.subarray(0, outLen));
    out = nb;
  };
  const put = (b) => { ensure(1); out[outLen++] = b; };

  // Huffman decode table (puff.c canonical method).
  const buildHuff = (lengths, num) => {
    const count = new Array(16).fill(0);
    for (let i = 0; i < num; i++) count[lengths[i]]++;
    count[0] = 0;
    const offs = new Array(16).fill(0);
    for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
    const symbols = new Array(num);
    for (let i = 0; i < num; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { count, symbols };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= getBit();
      const cnt = h.count[len];
      if (code - first < cnt) return h.symbols[index + (code - first)];
      index += cnt;
      first += cnt; first <<= 1;
      code <<= 1;
    }
    throw new Error("invalid Huffman code (corrupt deflate stream)");
  };

  const fixedLit = buildHuff(FIXED_LITLEN_LEN, 288);
  const fixedDist = buildHuff(new Array(30).fill(5), 30);

  let final = 0;
  do {
    final = getBit();
    const type = getBits(2);
    if (type === 0) {
      // Stored: align to byte, read LEN, skip NLEN, copy LEN bytes.
      bitPos = (bitPos + 7) & ~7;
      const p = bitPos >> 3;
      const len = input[p] | (input[p + 1] << 8);
      ensure(len);
      for (let i = 0; i < len; i++) out[outLen++] = input[p + 4 + i];
      bitPos = (p + 4 + len) << 3;
    } else {
      let litHuff, distHuff;
      if (type === 1) { litHuff = fixedLit; distHuff = fixedDist; }
      else if (type === 2) {
        const hlit = getBits(5) + 257;
        const hdist = getBits(5) + 1;
        const hclen = getBits(4) + 4;
        const clLen = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLen[CL_ORDER[i]] = getBits(3);
        const clHuff = buildHuff(clLen, 19);
        const lengths = new Array(hlit + hdist).fill(0);
        let n = 0;
        while (n < hlit + hdist) {
          const sym = decode(clHuff);
          if (sym < 16) lengths[n++] = sym;
          else if (sym === 16) { const r = getBits(2) + 3; const prev = lengths[n - 1]; for (let i = 0; i < r; i++) lengths[n++] = prev; }
          else if (sym === 17) { const r = getBits(3) + 3; for (let i = 0; i < r; i++) lengths[n++] = 0; }
          else { const r = getBits(7) + 11; for (let i = 0; i < r; i++) lengths[n++] = 0; }
        }
        litHuff = buildHuff(lengths.slice(0, hlit), hlit);
        distHuff = buildHuff(lengths.slice(hlit), hdist);
      } else {
        throw new Error("invalid deflate block type");
      }
      for (;;) {
        const sym = decode(litHuff);
        if (sym === 256) break;
        if (sym < 256) { put(sym); continue; }
        const li = sym - 257;
        const length = LEN_BASE[li] + getBits(LEN_EXTRA[li]);
        const ds = decode(distHuff);
        const dist = DIST_BASE[ds] + getBits(DIST_EXTRA[ds]);
        ensure(length);
        for (let i = 0; i < length; i++) { out[outLen] = out[outLen - dist]; outLen++; }
      }
    }
  } while (!final);

  return out.subarray(0, outLen);
}

// ---- DEFLATE (fixed Huffman + LZ77) ---------------------------------------
const MIN_MATCH = 3, MAX_MATCH = 258, WINDOW = 32768, MAX_CHAIN = 128, HASH_BITS = 15, HASH_SIZE = 1 << HASH_BITS;

function lengthCode(len) {
  for (let i = 28; i >= 0; i--) if (len >= LEN_BASE[i]) return [257 + i, LEN_EXTRA[i], len - LEN_BASE[i]];
  return [257, 0, 0];
}
function distCodeOf(dist) {
  for (let i = 29; i >= 0; i--) if (dist >= DIST_BASE[i]) return [i, DIST_EXTRA[i], dist - DIST_BASE[i]];
  return [0, 0, 0];
}

function deflateRawJs(input) {
  const data = input;
  const n = data.length;
  const bytes = [];
  let bitBuf = 0, bitCnt = 0;
  const writeBit = (bit) => {
    bitBuf |= (bit & 1) << bitCnt;
    if (++bitCnt === 8) { bytes.push(bitBuf); bitBuf = 0; bitCnt = 0; }
  };
  const writeBits = (val, len) => { for (let i = 0; i < len; i++) writeBit((val >> i) & 1); }; // LSB-first (extra bits)
  const writeHuff = (code, len) => { for (let i = len - 1; i >= 0; i--) writeBit((code >> i) & 1); }; // MSB-first (codes)

  // One fixed-Huffman final block.
  writeBit(1);        // BFINAL = 1
  writeBits(1, 2);    // BTYPE = 01 (fixed)

  const emitLiteral = (b) => writeHuff(FIXED_LITLEN_CODE[b], FIXED_LITLEN_LEN[b]);
  const emitMatch = (len, dist) => {
    const [ls, lextra, lval] = lengthCode(len);
    writeHuff(FIXED_LITLEN_CODE[ls], FIXED_LITLEN_LEN[ls]);
    writeBits(lval, lextra);
    const [ds, dextra, dval] = distCodeOf(dist);
    writeHuff(FIXED_DIST_CODE[ds], FIXED_DIST_LEN[ds]);
    writeBits(dval, dextra);
  };

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n < 1 ? 1 : n).fill(-1);
  const hashAt = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
  const insert = (i) => { if (i + MIN_MATCH <= n) { const h = hashAt(i); prev[i] = head[h]; head[h] = i; } };

  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const h = hashAt(i);
      let p = head[h], chain = MAX_CHAIN;
      while (p >= 0 && i - p <= WINDOW && chain-- > 0) {
        let l = 0;
        const max = Math.min(MAX_MATCH, n - i);
        while (l < max && data[p + l] === data[i + l]) l++;
        if (l > bestLen) { bestLen = l; bestDist = i - p; if (l >= max) break; }
        p = prev[p];
      }
    }
    if (bestLen >= MIN_MATCH) {
      emitMatch(bestLen, bestDist);
      const end = i + bestLen;
      for (let j = i; j < end; j++) insert(j);
      i = end;
    } else {
      emitLiteral(data[i]);
      insert(i);
      i++;
    }
  }
  writeHuff(FIXED_LITLEN_CODE[256], FIXED_LITLEN_LEN[256]); // end of block
  if (bitCnt > 0) bytes.push(bitBuf);
  return Uint8Array.from(bytes);
}

// ---- codec dispatch -------------------------------------------------------
// Prefer the wasm codec (crates/workeros-codec) for the CPU-bound raw DEFLATE +
// checksums when it's installed and instantiable; fall back to the pure-JS impls
// above (plain Node unit tests, or an environment that didn't build the wasm). The
// framing below (gzip/zlib headers) stays in JS either way — it's negligible.
const deflateRaw = (data) => { const c = getCodec(); return c ? c.deflateRaw(data) : deflateRawJs(data); };
const inflateRaw = (data) => { const c = getCodec(); return c ? c.inflateRaw(data) : inflateRawJs(data); };
const crc32 = (data) => { const c = getCodec(); return c ? c.crc32(data) : crc32Js(data); };
const adler32 = (data) => { const c = getCodec(); return c ? c.adler32(data) : adler32Js(data); };

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
// ignored — the encoder always emits a valid fixed-Huffman stream.
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
  }

  _transform(chunk, _encoding, cb) {
    const buf = toBytes(chunk);
    this._chunks.push(buf);
    this.bytesWritten += buf.length;
    cb();
  }

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
