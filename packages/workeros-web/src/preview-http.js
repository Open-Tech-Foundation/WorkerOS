// Pure HTTP/1.1 wire (de)serialization for the preview transport (ADR-021).
//
// The Service Worker turns a browser `fetch` to the preview URL into raw request
// bytes, hands them to the kernel injector, and turns the raw response bytes back
// into a `Response`. Those two byte transforms are the only non-trivial logic in
// the SW, and a SW can't be unit-tested in Node — so they live here as a pure,
// node-tested module, and `public/preview-sw.js` inlines them verbatim (the same
// tested-reference/mirror discipline as the ringbuffer, ADR-015). Keep the two in
// sync; `tools/preview-http.test.js` guards this copy.

const enc = new TextEncoder();
const dec = new TextDecoder();
const CRLF = "\r\n";

/** Concatenate Uint8Arrays into one. */
export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Serialize a request to HTTP/1.1 bytes. `headers` is an array of `[name,value]`.
 * Always sends `Connection: close` (the injector reads until EOF) and a `Host`
 * header. `body` is an optional Uint8Array.
 */
export function serializeRequest({ method, path, host, headers = [], body = null }) {
  let head = `${method} ${path} HTTP/1.1${CRLF}`;
  let sawHost = false;
  for (const [name, value] of headers) {
    const lc = name.toLowerCase();
    // The browser owns hop-by-hop framing; drop what we set or recompute.
    if (lc === "connection" || lc === "transfer-encoding") continue;
    if (lc === "host") sawHost = true;
    head += `${name}: ${value}${CRLF}`;
  }
  if (!sawHost) head += `Host: ${host}${CRLF}`;
  head += `Connection: close${CRLF}${CRLF}`;
  const headBytes = enc.encode(head);
  return body && body.length ? concatBytes([headBytes, body]) : headBytes;
}

/** Index just past the CRLFCRLF header/body boundary, or -1 if not present. */
function headerBoundary(buf) {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i] === 10 && buf[i - 1] === 13 && buf[i - 2] === 10 && buf[i - 3] === 13) return i + 1;
  }
  return -1;
}

/**
 * Decode a `Transfer-Encoding: chunked` body to its raw bytes. Tolerant of chunk
 * extensions (`;name=val` after the size) and a missing final CRLF.
 */
export function dechunk(buf) {
  const out = [];
  let pos = 0;
  const readLine = () => {
    let i = pos;
    while (i < buf.length && !(buf[i] === 13 && buf[i + 1] === 10)) i++;
    const line = dec.decode(buf.subarray(pos, i));
    pos = i + 2; // skip CRLF
    return line;
  };
  for (;;) {
    if (pos >= buf.length) break;
    const sizeLine = readLine();
    const size = parseInt(sizeLine.split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break; // 0 = last chunk (or malformed)
    out.push(buf.subarray(pos, pos + size));
    pos += size + 2; // data + trailing CRLF
  }
  return concatBytes(out);
}

/**
 * Parse HTTP/1.1 response bytes into `{ status, statusText, headers, body }`,
 * de-chunking a chunked body and dropping framing headers the browser recomputes
 * (`transfer-encoding`, `content-length`, `connection`). `headers` is an array of
 * `[name,value]` suitable for a `Headers` / `Response`.
 */
export function parseResponse(buf) {
  const end = headerBoundary(buf);
  if (end < 0) return { status: 502, statusText: "Bad Gateway", headers: [], body: new Uint8Array(0) };
  const headText = dec.decode(buf.subarray(0, end));
  const lines = headText.split(CRLF).filter((l) => l.length);
  const statusLine = lines.shift() || "HTTP/1.1 502 Bad Gateway";
  const parts = statusLine.split(" ");
  const status = parseInt(parts[1], 10) || 502;
  const statusText = parts.slice(2).join(" ");

  let chunked = false;
  const headers = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    const lc = name.toLowerCase();
    if (lc === "transfer-encoding") { if (/chunked/i.test(value)) chunked = true; continue; }
    if (lc === "content-length" || lc === "connection") continue;
    headers.push([name, value]);
  }

  let body = buf.subarray(end);
  if (chunked) body = dechunk(body);
  return { status, statusText, headers, body };
}
