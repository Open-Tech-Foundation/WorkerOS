// `node:buffer` — a Node-compatible Buffer for the WorkerOS Node runtime.
//
// GUEST code (INV-1): a real Buffer, not a stub — a huge share of npm expects it
// ambient. `Buffer` is a `Uint8Array` subclass (as in Node), so it interops with
// typed-array APIs for free; `slice`/`subarray` share memory (Node semantics, not
// `Uint8Array.slice`'s copy). Covers the widely-used surface: the from/alloc
// factories, encoding-aware `toString`/`write` (utf8, utf16le/ucs2, latin1/binary,
// ascii, hex, base64, base64url), fixed- and variable-width numeric accessors
// (8/16/32-bit LE+BE, BigInt64, float/double), and copy/fill/compare/indexOf.
// Pure JS over TextEncoder/Decoder + atob/btoa — no kernel involvement.

const te = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");
const utf16Decoder = new TextDecoder("utf-16le");

function normEnc(enc) {
  if (!enc) return "utf8";
  switch (String(enc).toLowerCase()) {
    case "utf8": case "utf-8": return "utf8";
    case "utf16le": case "utf-16le": case "ucs2": case "ucs-2": return "utf16le";
    case "latin1": case "binary": return "latin1";
    case "ascii": return "ascii";
    case "base64": return "base64";
    case "base64url": return "base64url";
    case "hex": return "hex";
    default: throw new TypeError(`Unknown encoding: ${enc}`);
  }
}

const HEX = "0123456789abcdef";
const hexVal = (c) => HEX.indexOf(c.toLowerCase());

function fromHex(str) {
  const bytes = [];
  for (let i = 0; i + 2 <= str.length; i += 2) {
    const hi = hexVal(str[i]);
    const lo = hexVal(str[i + 1]);
    if (hi < 0 || lo < 0) break; // Node stops at the first non-hex pair
    bytes.push(hi * 16 + lo);
  }
  return Uint8Array.from(bytes);
}
const toHex = (bytes) => {
  let s = "";
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 0xf];
  return s;
};

function fromBase64(str) {
  // Node is lenient: accept url-safe alphabet and missing padding, drop the rest.
  let s = String(str).replace(/[^A-Za-z0-9+/_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  let bin = "";
  try { bin = atob(s); } catch { bin = ""; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toBase64(bytes, url) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return url ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
}

function fromString(str, enc) {
  str = String(str);
  switch (normEnc(enc)) {
    case "utf8": return te.encode(str);
    case "utf16le": {
      const out = new Uint8Array(str.length * 2);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true);
      return out;
    }
    case "latin1": {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case "ascii": {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
      return out;
    }
    case "hex": return fromHex(str);
    case "base64": case "base64url": return fromBase64(str);
  }
}

function toStringEnc(bytes, enc, start, end) {
  const sub = bytes.subarray(start ?? 0, end ?? bytes.length);
  switch (normEnc(enc)) {
    case "utf8": return utf8Decoder.decode(sub);
    case "utf16le": return utf16Decoder.decode(sub.subarray(0, sub.length - (sub.length % 2)));
    case "latin1": { let s = ""; for (const b of sub) s += String.fromCharCode(b); return s; }
    case "ascii": { let s = ""; for (const b of sub) s += String.fromCharCode(b & 0x7f); return s; }
    case "hex": return toHex(sub);
    case "base64": return toBase64(sub, false);
    case "base64url": return toBase64(sub, true);
  }
}

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const toBufferView = (u8) => new Buffer(u8.buffer, u8.byteOffset, u8.byteLength);

export class Buffer extends Uint8Array {
  // ---- factories ----------------------------------------------------------
  static from(value, encodingOrOffset, length) {
    if (typeof value === "string") return toBufferView(fromString(value, encodingOrOffset));
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const offset = encodingOrOffset || 0;
      const len = length === undefined ? value.byteLength - offset : length;
      return new Buffer(value, offset, len); // shares memory
    }
    if (ArrayBuffer.isView(value)) {
      const src = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const b = new Buffer(src.length);
      b.set(src); // Buffer.from(typedArray) copies
      return b;
    }
    if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
      return Buffer.from(value.data); // round-trips toJSON()
    }
    if (Array.isArray(value) || (value && typeof value.length === "number")) {
      const b = new Buffer(value.length);
      for (let i = 0; i < value.length; i++) b[i] = value[i] & 0xff;
      return b;
    }
    throw new TypeError(
      "The first argument must be of type string, Buffer, ArrayBuffer, Array, or Array-like Object.",
    );
  }
  static alloc(size, fill, encoding) {
    const b = new Buffer(size); // Uint8Array is zero-initialized
    if (fill !== undefined && !(typeof fill === "number" && fill === 0)) b.fill(fill, encoding);
    return b;
  }
  static allocUnsafe(size) { return new Buffer(size); }
  static allocUnsafeSlow(size) { return new Buffer(size); }
  static isBuffer(b) { return b instanceof Buffer; }
  static isEncoding(enc) { try { normEnc(enc); return true; } catch { return false; } }
  static byteLength(value, encoding) {
    if (typeof value !== "string") return value.byteLength ?? value.length ?? 0;
    return fromString(value, encoding).length;
  }
  static concat(list, totalLength) {
    if (totalLength === undefined) { totalLength = 0; for (const b of list) totalLength += b.length; }
    const out = new Buffer(totalLength);
    let o = 0;
    for (const b of list) {
      if (o >= totalLength) break;
      const n = Math.min(b.length, totalLength - o);
      out.set(b.subarray(0, n), o);
      o += n;
    }
    return out;
  }
  static compare(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  // ---- strings & memory ---------------------------------------------------
  toString(encoding, start, end) { return toStringEnc(this, encoding, start, end); }
  write(string, offset, length, encoding) {
    if (offset === undefined) { offset = 0; length = this.length; }
    else if (typeof offset === "string") { encoding = offset; offset = 0; length = this.length; }
    else if (typeof length === "string") { encoding = length; length = this.length - offset; }
    const bytes = fromString(string, encoding);
    const n = Math.min(length ?? bytes.length, bytes.length, this.length - offset);
    this.set(bytes.subarray(0, n), offset);
    return n;
  }
  toJSON() { return { type: "Buffer", data: Array.prototype.slice.call(this) }; }
  slice(start, end) { return this.subarray(start, end); } // Node: shares memory
  equals(other) {
    if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
  compare(target) { return Buffer.compare(this, target); }
  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const sub = this.subarray(sourceStart, sourceEnd);
    const n = Math.min(sub.length, target.length - targetStart);
    target.set(sub.subarray(0, n), targetStart);
    return n;
  }
  fill(value, offset = 0, end = this.length, encoding) {
    if (typeof offset === "string") { encoding = offset; offset = 0; end = this.length; }
    else if (typeof end === "string") { encoding = end; end = this.length; }
    let pattern;
    if (typeof value === "number") pattern = Uint8Array.of(value & 0xff);
    else if (typeof value === "string") pattern = fromString(value, encoding);
    else pattern = Uint8Array.from(value);
    if (pattern.length === 0) pattern = Uint8Array.of(0);
    for (let i = offset; i < end; i++) this[i] = pattern[(i - offset) % pattern.length];
    return this;
  }
  indexOf(value, byteOffset, encoding) {
    let needle;
    if (typeof value === "number") needle = Uint8Array.of(value & 0xff);
    else if (typeof value === "string") {
      const enc = typeof byteOffset === "string" ? byteOffset : encoding;
      needle = fromString(value, enc);
    } else needle = value;
    let start = typeof byteOffset === "number" ? byteOffset : 0;
    if (start < 0) start = Math.max(0, this.length + start);
    if (needle.length === 0) return start <= this.length ? start : this.length;
    for (let i = start; i + needle.length <= this.length; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) { match = false; break; }
      if (match) return i;
    }
    return -1;
  }
  includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }
  swap16() { for (let i = 0; i < this.length; i += 2) { const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t; } return this; }
  swap32() {
    for (let i = 0; i < this.length; i += 4) {
      let a = this[i], b = this[i + 1];
      this[i] = this[i + 3]; this[i + 1] = this[i + 2]; this[i + 2] = b; this[i + 3] = a;
    }
    return this;
  }
  inspect() {
    const max = INSPECT_MAX_BYTES;
    let s = "";
    for (let i = 0; i < Math.min(this.length, max); i++) s += (i ? " " : "") + HEX[this[i] >> 4] + HEX[this[i] & 0xf];
    if (this.length > max) s += ` ... ${this.length - max} more byte${this.length - max > 1 ? "s" : ""}`;
    return `<Buffer ${s}>`;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() { return this.inspect(); }
}

// ---- fixed-width numeric accessors ---------------------------------------
const num = {
  readUInt8(o = 0) { return this[o]; },
  readInt8(o = 0) { return dv(this).getInt8(o); },
  readUInt16LE(o = 0) { return dv(this).getUint16(o, true); },
  readUInt16BE(o = 0) { return dv(this).getUint16(o, false); },
  readInt16LE(o = 0) { return dv(this).getInt16(o, true); },
  readInt16BE(o = 0) { return dv(this).getInt16(o, false); },
  readUInt32LE(o = 0) { return dv(this).getUint32(o, true); },
  readUInt32BE(o = 0) { return dv(this).getUint32(o, false); },
  readInt32LE(o = 0) { return dv(this).getInt32(o, true); },
  readInt32BE(o = 0) { return dv(this).getInt32(o, false); },
  readFloatLE(o = 0) { return dv(this).getFloat32(o, true); },
  readFloatBE(o = 0) { return dv(this).getFloat32(o, false); },
  readDoubleLE(o = 0) { return dv(this).getFloat64(o, true); },
  readDoubleBE(o = 0) { return dv(this).getFloat64(o, false); },
  readBigUInt64LE(o = 0) { return dv(this).getBigUint64(o, true); },
  readBigUInt64BE(o = 0) { return dv(this).getBigUint64(o, false); },
  readBigInt64LE(o = 0) { return dv(this).getBigInt64(o, true); },
  readBigInt64BE(o = 0) { return dv(this).getBigInt64(o, false); },
  writeUInt8(v, o = 0) { this[o] = v & 0xff; return o + 1; },
  writeInt8(v, o = 0) { dv(this).setInt8(o, v); return o + 1; },
  writeUInt16LE(v, o = 0) { dv(this).setUint16(o, v, true); return o + 2; },
  writeUInt16BE(v, o = 0) { dv(this).setUint16(o, v, false); return o + 2; },
  writeInt16LE(v, o = 0) { dv(this).setInt16(o, v, true); return o + 2; },
  writeInt16BE(v, o = 0) { dv(this).setInt16(o, v, false); return o + 2; },
  writeUInt32LE(v, o = 0) { dv(this).setUint32(o, v, true); return o + 4; },
  writeUInt32BE(v, o = 0) { dv(this).setUint32(o, v, false); return o + 4; },
  writeInt32LE(v, o = 0) { dv(this).setInt32(o, v, true); return o + 4; },
  writeInt32BE(v, o = 0) { dv(this).setInt32(o, v, false); return o + 4; },
  writeFloatLE(v, o = 0) { dv(this).setFloat32(o, v, true); return o + 4; },
  writeFloatBE(v, o = 0) { dv(this).setFloat32(o, v, false); return o + 4; },
  writeDoubleLE(v, o = 0) { dv(this).setFloat64(o, v, true); return o + 8; },
  writeDoubleBE(v, o = 0) { dv(this).setFloat64(o, v, false); return o + 8; },
  writeBigUInt64LE(v, o = 0) { dv(this).setBigUint64(o, BigInt(v), true); return o + 8; },
  writeBigUInt64BE(v, o = 0) { dv(this).setBigUint64(o, BigInt(v), false); return o + 8; },
  writeBigInt64LE(v, o = 0) { dv(this).setBigInt64(o, BigInt(v), true); return o + 8; },
  writeBigInt64BE(v, o = 0) { dv(this).setBigInt64(o, BigInt(v), false); return o + 8; },
  // Variable-width (1..6 bytes), matching Node's readUIntLE/BE + signed forms.
  readUIntLE(o, len) { let v = 0, m = 1; for (let i = 0; i < len; i++) { v += this[o + i] * m; m *= 256; } return v; },
  readUIntBE(o, len) { let v = 0; for (let i = 0; i < len; i++) v = v * 256 + this[o + i]; return v; },
  readIntLE(o, len) { let v = this.readUIntLE(o, len); const sub = 2 ** (8 * len); return v >= sub / 2 ? v - sub : v; },
  readIntBE(o, len) { let v = this.readUIntBE(o, len); const sub = 2 ** (8 * len); return v >= sub / 2 ? v - sub : v; },
  writeUIntLE(v, o, len) { let x = v; for (let i = 0; i < len; i++) { this[o + i] = x & 0xff; x = Math.floor(x / 256); } return o + len; },
  writeUIntBE(v, o, len) { let x = v; for (let i = len - 1; i >= 0; i--) { this[o + i] = x & 0xff; x = Math.floor(x / 256); } return o + len; },
};
num.writeIntLE = num.writeUIntLE; // two's complement wraps naturally under & 0xff
num.writeIntBE = num.writeUIntBE;
for (const [k, fn] of Object.entries(num)) {
  Buffer.prototype[k] = fn;
  // Node also exposes lowercase-`Uint` aliases (readUint8, writeBigUint64LE, …).
  if (/U[Ii]nt/.test(k)) Buffer.prototype[k.replace("UInt", "Uint")] = fn;
}

// ---- module surface -------------------------------------------------------
export const INSPECT_MAX_BYTES = 50;
export const kMaxLength = 0x7fffffff; // 2^31 - 1 (browser typed-array ceiling)
export const kStringMaxLength = 0x1fffffe8;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
export const SlowBuffer = (length) => Buffer.alloc(+length);

// The `node:buffer` module object registered as a builtin (import + require).
export const buffer = {
  Buffer,
  SlowBuffer,
  constants,
  kMaxLength,
  kStringMaxLength,
  INSPECT_MAX_BYTES,
  atob: (s) => atob(s),
  btoa: (s) => btoa(s),
};
