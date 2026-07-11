// `node:querystring` - legacy query-string encoding and decoding.
//
// GUEST code (INV-1): pure JavaScript with Node's API shape. This intentionally
// does not use URLSearchParams; repeated keys, spaces, malformed escapes, and
// null-prototype parse results have different compatibility requirements.

import { Buffer } from "./buffer.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function stringifyPrimitive(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  return "";
}

export function escape(value) {
  return encodeURIComponent(stringifyPrimitive(value));
}

// decodeURIComponent rejects a whole input when one escape is malformed. Node's
// querystring decoder instead preserves malformed bytes and decodes valid runs.
export function unescapeBuffer(value, decodeSpaces = false) {
  let input = String(value);
  if (decodeSpaces) input = input.replace(/\+/g, " ");
  const bytes = [];
  for (let i = 0; i < input.length;) {
    if (input[i] === "%" && /^[0-9a-f]{2}$/i.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const cp = input.codePointAt(i);
      bytes.push(...enc.encode(String.fromCodePoint(cp)));
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return Buffer.from(bytes);
}

export function unescape(value, decodeSpaces = false) {
  let input = String(value);
  if (decodeSpaces) input = input.replace(/\+/g, " ");
  try {
    return decodeURIComponent(input);
  } catch {
    return dec.decode(unescapeBuffer(input));
  }
}

export function stringify(obj, sep = "&", eq = "=", options) {
  if (obj === null || typeof obj !== "object") return "";
  const encode = options && typeof options.encodeURIComponent === "function"
    ? options.encodeURIComponent
    : escape;
  const fields = [];
  for (const key of Object.keys(obj)) {
    const encodedKey = encode(stringifyPrimitive(key));
    const values = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
    if (values.length === 0) continue;
    for (const value of values) {
      fields.push(encodedKey + eq + encode(stringifyPrimitive(value)));
    }
  }
  return fields.join(sep);
}

export function parse(input, sep = "&", eq = "=", options) {
  const out = Object.create(null);
  if (typeof input !== "string" || input.length === 0) return out;
  const decode = options && typeof options.decodeURIComponent === "function"
    ? options.decodeURIComponent
    : unescape;
  let maxKeys = 1000;
  if (options && Number.isFinite(options.maxKeys)) maxKeys = options.maxKeys;
  const parts = input.split(sep);
  const limit = maxKeys > 0 ? Math.min(parts.length, maxKeys) : parts.length;
  for (let i = 0; i < limit; i++) {
    const part = parts[i];
    const at = part.indexOf(eq);
    const rawKey = at < 0 ? part : part.slice(0, at);
    const rawValue = at < 0 ? "" : part.slice(at + eq.length);
    const key = decode(rawKey.replace(/\+/g, "%20"));
    const value = decode(rawValue.replace(/\+/g, "%20"));
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const encode = stringify;
export const decode = parse;

export const querystring = {
  stringify,
  encode,
  parse,
  decode,
  unescapeBuffer,
  escape,
  unescape,
};

export default querystring;
