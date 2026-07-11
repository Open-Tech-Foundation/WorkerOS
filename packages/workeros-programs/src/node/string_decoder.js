// `node:string_decoder` — incremental string decoding for chunked byte streams.
//
// GUEST code (INV-1): pure userland, no kernel help. This is the small Node
// utility stream parsers reach for when multibyte characters may be split across
// chunks. The common cases are covered directly: utf8, utf16le/ucs2, base64, and
// the byte-wise encodings (latin1/ascii/hex).

import { Buffer } from "./buffer.js";

function normalizeEncoding(enc) {
  switch (String(enc || "utf8").toLowerCase()) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "utf16le":
    case "utf-16le":
    case "ucs2":
    case "ucs-2":
      return "utf16le";
    case "base64":
    case "latin1":
    case "ascii":
    case "hex":
      return String(enc).toLowerCase() === "ucs2" || String(enc).toLowerCase() === "ucs-2" ? "utf16le" : String(enc).toLowerCase();
    default:
      throw new Error(`Unknown encoding: ${enc}`);
  }
}

function toBytes(chunk) {
  if (chunk == null) return Buffer.alloc(0);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return Buffer.from(chunk);
}

function concatParts(parts) {
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

export class StringDecoder {
  constructor(encoding = "utf8") {
    this.encoding = normalizeEncoding(encoding);
    this.lastNeed = 0;
    this.lastTotal = 0;
    this._leftover = Buffer.alloc(0);
    this._decoder =
      this.encoding === "utf8" ? new TextDecoder("utf-8") :
      this.encoding === "utf16le" ? new TextDecoder("utf-16le") :
      null;
  }

  write(chunk) {
    const input = toBytes(chunk);
    if (input.length === 0) return "";
    switch (this.encoding) {
      case "utf8":
      case "utf16le":
        return this._writeText(input);
      case "base64":
        return this._writeBase64(input);
      case "latin1":
      case "ascii":
      case "hex":
        return Buffer.from(input).toString(this.encoding);
    }
  }

  end(chunk) {
    const head = chunk == null ? "" : this.write(chunk);
    switch (this.encoding) {
      case "utf8":
      case "utf16le": {
        const tail = this._leftover.length ? this._decoder.decode(this._leftover) : "";
        this._leftover = Buffer.alloc(0);
        this.lastNeed = 0;
        this.lastTotal = 0;
        return head + tail;
      }
      case "base64": {
        const tail = this._leftover.length ? this._leftover.toString("base64") : "";
        this._leftover = Buffer.alloc(0);
        this.lastNeed = 0;
        this.lastTotal = 0;
        return head + tail;
      }
      default:
        return head;
    }
  }

  text(buf, offset = 0) {
    return this.write(buf.subarray ? buf.subarray(offset) : Buffer.from(buf).subarray(offset));
  }

  _writeText(input) {
    const bytes = this._leftover.length ? concatParts([this._leftover, input]) : input;
    let complete = bytes.length;
    if (this.encoding === "utf16le" && complete % 2 === 1) complete--;
    if (this.encoding === "utf8") complete = utf8CompletePrefix(bytes);
    this._leftover = complete < bytes.length ? Buffer.from(bytes.subarray(complete)) : Buffer.alloc(0);
    this.lastNeed = this._leftover.length;
    this.lastTotal = this._leftover.length;
    if (complete === 0) return "";
    return this._decoder.decode(bytes.subarray(0, complete));
  }

  _writeBase64(input) {
    const bytes = this._leftover.length ? concatParts([this._leftover, input]) : input;
    const complete = bytes.length - (bytes.length % 3);
    this._leftover = complete < bytes.length ? Buffer.from(bytes.subarray(complete)) : Buffer.alloc(0);
    this.lastNeed = this._leftover.length ? 3 - this._leftover.length : 0;
    this.lastTotal = this._leftover.length ? 3 : 0;
    if (complete === 0) return "";
    return bytes.subarray(0, complete).toString("base64");
  }
}

function utf8CompletePrefix(bytes) {
  const len = bytes.length;
  if (len === 0) return 0;
  let cont = 0;
  for (let i = len - 1; i >= 0 && cont < 3; i--) {
    const b = bytes[i];
    if ((b & 0xc0) === 0x80) {
      cont++;
      continue;
    }
    const need =
      (b & 0x80) === 0x00 ? 1 :
      (b & 0xe0) === 0xc0 ? 2 :
      (b & 0xf0) === 0xe0 ? 3 :
      (b & 0xf8) === 0xf0 ? 4 :
      1;
    return cont + 1 < need ? i : len;
  }
  return cont === 0 ? len : len - cont;
}

const stringDecoder = { StringDecoder };
stringDecoder.default = stringDecoder;

export { stringDecoder };
export default stringDecoder;
