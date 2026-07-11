// `node:crypto` — a Node-compatible crypto surface for the WorkerOS Node runtime.
//
// GUEST code (INV-1): the kernel knows nothing about crypto. Two honest sources,
// split by what the browser can do *synchronously* (Node's crypto API is sync):
//
//   • Randomness → the host Web Crypto (`crypto.getRandomValues`), which IS
//     synchronous and CSPRNG-backed. `randomBytes`/`randomUUID`/`randomFillSync`/
//     `randomInt` are genuinely host-backed, not reimplemented.
//   • Hashing → self-contained sync digests here (`createHash`/`createHmac`). The
//     host's only hash (`crypto.subtle.digest`) is async, so it cannot back Node's
//     sync `.digest()`. Implementing the digests in-guest mirrors the kernel's own
//     choice (`hash.rs` ships SHA-256 in-crate to avoid a dependency) and keeps the
//     kernel ABI generic — a hash is not a primitive a multi-process OS must own.
//
// Covered: MD5, SHA-1/224/256/384/512 (`createHash`), HMAC over any of them
// (`createHmac`), CSPRNG helpers, `timingSafeEqual`, `getHashes`, and `webcrypto`
// (the host WebCrypto passthrough). Pure JS + host `crypto` — no kernel syscalls,
// so it is fully unit-testable on its own.

import { Buffer } from "./buffer.js";

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

// ---- padding (MD5/SHA-1/SHA-256 share a 64-byte block, big/little length) --
// Append 0x80, zero-pad so the length field lands at the block's end, then the
// 64-bit bit-length (big- or little-endian per algorithm).
function pad64(input, lengthBE) {
  const len = input.length;
  const bitLen = len * 8;
  const zeros = (56 - ((len + 1) % 64) + 64) % 64;
  const total = len + 1 + zeros + 8;
  const msg = new Uint8Array(total);
  msg.set(input);
  msg[len] = 0x80;
  const dv = new DataView(msg.buffer);
  const hi = Math.floor(bitLen / 0x100000000) >>> 0;
  const lo = bitLen >>> 0;
  if (lengthBE) { dv.setUint32(total - 8, hi, false); dv.setUint32(total - 4, lo, false); }
  else { dv.setUint32(total - 8, lo, true); dv.setUint32(total - 4, hi, true); }
  return msg;
}

const rotl32 = (x, c) => (x << c) | (x >>> (32 - c));
const rotr32 = (x, c) => (x >>> c) | (x << (32 - c));

// ---- MD5 (RFC 1321) -------------------------------------------------------
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = (() => {
  const k = new Int32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
  return k;
})();
function md5(input) {
  const msg = pad64(input, false); // MD5 length is little-endian
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const dv = new DataView(msg.buffer);
  const M = new Int32Array(16);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true) | 0;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl32(F, MD5_S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0 >>> 0, true); odv.setUint32(4, b0 >>> 0, true);
  odv.setUint32(8, c0 >>> 0, true); odv.setUint32(12, d0 >>> 0, true);
  return out;
}

// ---- SHA-1 (FIPS 180-4) ---------------------------------------------------
function sha1(input) {
  const msg = pad64(input, true);
  const dv = new DataView(msg.buffer);
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  const w = new Int32Array(80);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false) | 0;
    for (let i = 16; i < 80; i++) w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (rotl32(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h >>> 0, false));
  return out;
}

// ---- SHA-256 / SHA-224 (FIPS 180-4) ---------------------------------------
const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256core(input, H, outBytes) {
  const msg = pad64(input, true);
  const dv = new DataView(msg.buffer);
  const h = Int32Array.from(H);
  const w = new Int32Array(64);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false) | 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const full = new Uint8Array(32);
  const odv = new DataView(full.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i] >>> 0, false);
  return full.subarray(0, outBytes);
}
const SHA256_H = [0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0, 0x1f83d9ab, 0x5be0cd19];
const SHA224_H = [0xc1059ed8 | 0, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31 | 0, 0x68581511, 0x64f98fa7, 0xbefa4fa4 | 0];
const sha256 = (input) => sha256core(input, SHA256_H, 32);
const sha224 = (input) => sha256core(input, SHA224_H, 28);

// ---- SHA-512 / SHA-384 (FIPS 180-4, 64-bit via BigInt) --------------------
const MASK64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64;
const SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];
function sha512core(input, H, outBytes) {
  // Pad to a 128-byte block with a 128-bit big-endian length (high 64 bits 0 for
  // any realistic in-browser input).
  const len = input.length;
  const bitLen = BigInt(len) * 8n;
  const zeros = (112 - ((len + 1) % 128) + 128) % 128;
  const total = len + 1 + zeros + 16;
  const msg = new Uint8Array(total);
  msg.set(input);
  msg[len] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setBigUint64(total - 8, bitLen & MASK64, false);
  const h = H.slice();
  const w = new Array(80);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = dv.getBigUint64(off + i * 8, false);
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const t1 = (hh + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      hh = g; g = f; f = e; e = (d + t1) & MASK64; d = c; c = b; b = a; a = (t1 + t2) & MASK64;
    }
    const upd = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + upd[i]) & MASK64;
  }
  const full = new Uint8Array(64);
  const odv = new DataView(full.buffer);
  for (let i = 0; i < 8; i++) odv.setBigUint64(i * 8, h[i], false);
  return full.subarray(0, outBytes);
}
const SHA512_H = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SHA384_H = [
  0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n, 0x152fecd8f70e5939n,
  0x67332667ffc00b31n, 0x8eb44a8768581511n, 0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n,
];
const sha512 = (input) => sha512core(input, SHA512_H, 64);
const sha384 = (input) => sha512core(input, SHA384_H, 48);

// ---- algorithm registry ---------------------------------------------------
const HASHERS = { md5, sha1, sha224, sha256, sha384, sha512 };
const BLOCK = { md5: 64, sha1: 64, sha224: 64, sha256: 64, sha384: 128, sha512: 128 };
// Node/OpenSSL accept case- and separator-insensitive names ("SHA-256", "sha256").
const normAlgo = (algo) => String(algo).toLowerCase().replace(/[-_]/g, "");
function lookup(algo) {
  const key = normAlgo(algo);
  const fn = HASHERS[key];
  if (!fn) throw new Error(`Digest method not supported: ${algo}`);
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
    return encodeOut(HASHERS[this._algo](concat(this._chunks)), encoding);
  }
}

// ---- createHmac (generic HMAC, FIPS 198-1) --------------------------------
class Hmac {
  constructor(algo, key) {
    this._algo = lookup(algo);
    const fn = HASHERS[this._algo];
    const block = BLOCK[this._algo];
    let k = toBytes(key);
    if (k.length > block) k = fn(k);
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
    const fn = HASHERS[this._algo];
    const inner = fn(concat(this._chunks));
    return encodeOut(fn(concat([this._opad, inner])), encoding);
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

const getHashes = () => Object.keys(HASHERS);

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
