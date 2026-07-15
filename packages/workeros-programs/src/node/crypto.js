// `node:crypto` — a Node-compatible crypto surface for the WorkerOS Node runtime.
//
// GUEST code (INV-1): the kernel knows nothing about crypto. Two honest sources,
// split by what the browser can do *synchronously* (Node's crypto API is sync):
//
//   • Randomness → the host Web Crypto (`crypto.getRandomValues`), which IS
//     synchronous and CSPRNG-backed. `randomBytes`/`randomUUID`/`randomFillSync`/
//     `randomInt` are genuinely host-backed, not reimplemented.
//   • Hashing → the WorkerOS codec wasm (`crates/workeros-codec`, RustCrypto),
//     reached synchronously via `wasm-codec.js`. The host's only hash
//     (`crypto.subtle.digest`) is async and can't back Node's sync `.digest()`, so
//     the codec is the single implementation (no JS fallback). `createHash`/
//     `createHmac` build on it; HMAC framing stays here.
//
// Covered: MD5, SHA-1/224/256/384/512 (`createHash`), HMAC over any of them
// (`createHmac`), CSPRNG helpers, `timingSafeEqual`, `getHashes`, and `webcrypto`
// (the host WebCrypto passthrough).

import { Buffer } from "./buffer.js";
import { getCodec } from "./wasm-codec.js";

// ---- byte helpers ---------------------------------------------------------
function toBytes(data, enc) {
  if (data == null) throw new TypeError("The data argument must not be null");
  if (typeof data === "string") return Buffer.from(data, enc || "utf8");
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("The data argument must be of type string or an instance of Buffer/TypedArray/ArrayBuffer");
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// A raw digest (Uint8Array) → Buffer, or a string in the requested encoding.
const encodeOut = (bytes, enc) => (enc ? Buffer.from(bytes).toString(enc) : Buffer.from(bytes));

// ---- hashing (crates/workeros-codec) --------------------------------------
// Digests run through the wasm codec — the single, real implementation.
// `getCodec()` throws if it can't be loaded, so there is no JS fallback.
const BLOCK = { md5: 64, sha1: 64, sha224: 64, sha256: 64, sha384: 128, sha512: 128 };
const digestWith = (algo, data) => getCodec()[algo](data);
// Node/OpenSSL accept case- and separator-insensitive names ("SHA-256", "sha256").
const normAlgo = (algo) => String(algo).toLowerCase().replace(/[-_]/g, "");
function lookup(algo) {
  const key = normAlgo(algo);
  if (!(key in BLOCK)) throw new Error(`Digest method not supported: ${algo}`);
  return key;
}

// ---- createHash -----------------------------------------------------------
class Hash {
  constructor(algo) {
    this._algo = lookup(algo);
    this._chunks = [];
    this._done = false;
  }
  update(data, inputEncoding) {
    if (this._done) throw new Error("Digest already called");
    this._chunks.push(toBytes(data, inputEncoding));
    return this;
  }
  digest(encoding) {
    if (this._done) throw new Error("Digest already called");
    this._done = true;
    return encodeOut(digestWith(this._algo, concat(this._chunks)), encoding);
  }
}

// `crypto.hash(algorithm, data[, outputEncoding])` — the one-shot digest helper
// (Node 20.12+), i.e. `createHash(algorithm).update(data).digest(outputEncoding)`
// without the object churn. `outputEncoding` defaults to `'hex'`; `'buffer'` yields
// a Buffer. Vite 8 calls this to fingerprint modules, so its absence stopped the
// dev server from even starting.
const hash = (algorithm, data, outputEncoding = "hex") =>
  encodeOut(digestWith(lookup(algorithm), toBytes(data)), outputEncoding === "buffer" ? undefined : outputEncoding);

// ---- createHmac (generic HMAC, FIPS 198-1) --------------------------------
class Hmac {
  constructor(algo, key) {
    this._algo = lookup(algo);
    const block = BLOCK[this._algo];
    let k = toBytes(key);
    if (k.length > block) k = digestWith(this._algo, k);
    const ipad = new Uint8Array(block);
    this._opad = new Uint8Array(block);
    for (let i = 0; i < block; i++) {
      const b = i < k.length ? k[i] : 0;
      ipad[i] = b ^ 0x36;
      this._opad[i] = b ^ 0x5c;
    }
    this._chunks = [ipad];
    this._done = false;
  }
  update(data, inputEncoding) {
    if (this._done) throw new Error("Digest already called");
    this._chunks.push(toBytes(data, inputEncoding));
    return this;
  }
  digest(encoding) {
    if (this._done) throw new Error("Digest already called");
    this._done = true;
    const inner = digestWith(this._algo, concat(this._chunks));
    return encodeOut(digestWith(this._algo, concat([this._opad, inner])), encoding);
  }
}

// ---- randomness (host Web Crypto — synchronous CSPRNG) --------------------
function fillRandom(view) {
  const host = globalThis.crypto;
  if (!host || typeof host.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is not available in this environment");
  }
  // getRandomValues rejects requests over 65536 bytes — chunk large fills.
  for (let o = 0; o < view.length; o += 65536) {
    host.getRandomValues(view.subarray(o, Math.min(o + 65536, view.length)));
  }
  return view;
}

function randomBytes(size, cb) {
  const buf = Buffer.allocUnsafe(size);
  if (cb) {
    try { fillRandom(buf); } catch (e) { queueMicrotask(() => cb(e)); return; }
    queueMicrotask(() => cb(null, buf));
    return;
  }
  return fillRandom(buf);
}

function randomFillSync(buf, offset = 0, size) {
  const len = size === undefined ? buf.length - offset : size;
  fillRandom(new Uint8Array(buf.buffer, buf.byteOffset + offset, len));
  return buf;
}

function randomFill(buf, offset, size, cb) {
  if (typeof offset === "function") { cb = offset; offset = 0; size = buf.length; }
  else if (typeof size === "function") { cb = size; size = buf.length - offset; }
  try { randomFillSync(buf, offset, size); } catch (e) { queueMicrotask(() => cb(e)); return; }
  queueMicrotask(() => cb(null, buf));
}

function randomUUID() {
  const host = globalThis.crypto;
  if (host && typeof host.randomUUID === "function") return host.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Uniform integer in [min, max) via rejection sampling (unbiased), matching
// Node's `randomInt` overloads: (max), (min, max), each with an optional cb.
function randomInt(min, max, cb) {
  if (typeof max === "undefined" || typeof max === "function") { cb = typeof max === "function" ? max : undefined; max = min; min = 0; }
  min = Math.floor(min); max = Math.floor(max);
  if (!(max > min)) throw new RangeError("The value of max must be greater than the value of min");
  const range = max - min;
  const bytesNeeded = Math.max(1, Math.ceil(Math.log2(range) / 8));
  const maxVal = 2 ** (bytesNeeded * 8);
  const limit = maxVal - (maxVal % range);
  const gen = () => {
    for (;;) {
      const rb = randomBytes(bytesNeeded);
      let v = 0;
      for (let i = 0; i < bytesNeeded; i++) v = v * 256 + rb[i];
      if (v < limit) return min + (v % range);
    }
  };
  if (cb) {
    let r;
    try { r = gen(); } catch (e) { queueMicrotask(() => cb(e)); return; }
    queueMicrotask(() => cb(null, r));
    return;
  }
  return gen();
}

const getRandomValues = (typedArray) => globalThis.crypto.getRandomValues(typedArray);

// ---- misc -----------------------------------------------------------------
function timingSafeEqual(a, b) {
  a = toBytes(a); b = toBytes(b);
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const getHashes = () => Object.keys(BLOCK);

// A small, honest subset of Node's `crypto.constants` (no OpenSSL engine here).
const constants = {
  SSL_OP_ALL: 0,
  RSA_PKCS1_PADDING: 1,
  RSA_PKCS1_OAEP_PADDING: 4,
};

// The `node:crypto` module object registered as a builtin (import + require).
export const crypto = {
  createHash: (algo) => new Hash(algo),
  createHmac: (algo, key) => new Hmac(algo, key),
  hash,
  Hash,
  Hmac,
  randomBytes,
  randomFillSync,
  randomFill,
  randomUUID,
  randomInt,
  getRandomValues,
  timingSafeEqual,
  getHashes,
  constants,
  // Node exposes the host WebCrypto here (`crypto.webcrypto.subtle`, …); pass the
  // browser's straight through (INV-5: the real thing, not a shim).
  webcrypto: globalThis.crypto,
};

export default crypto;
