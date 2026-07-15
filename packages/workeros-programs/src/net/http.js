// HTTP/1.1 over a real kernel socket — the client half of the OS's own network.
//
// `localhost` inside WorkerOS means WorkerOS. A process that listens on port 3000
// (node's `http.createServer(...).listen(3000)` → `sys.netListen`) is reachable from
// any other process in this OS through the kernel's loopback (`sys.netConnect`), and
// this module is what speaks HTTP over that socket pair: serialize a request, write
// it, read until EOF, parse the response.
//
// Why this exists: guest HTTP clients used to hand every URL to the worker's `fetch`
// (ADR-008), which is the *host browser's* network. So `curl http://localhost:3000`
// left the OS entirely and fetched the page the developer's own machine happened to
// serve on 3000 — not the in-OS server, which was sitting right there listening. An
// OS whose loopback escapes to the host isn't one. Outbound (real, remote) URLs still
// ride `fetch`; that's ADR-008 and stays.
//
// The kernel only moves bytes (INV-1), so all framing is here in userland. The wire
// format matches `workeros-web/src/preview-http.js`, which does the same job for the
// Service Worker's injected connections (ADR-021) — same protocol, other direction.

const enc = new TextEncoder();
const dec = new TextDecoder();
const CRLF = "\r\n";

/** Hosts that mean "this OS", not the outside world. */
const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** Is `hostname` this OS's own loopback? */
export function isLoopbackHost(hostname) {
  return LOCAL.has(String(hostname || "").toLowerCase());
}

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
 * Serialize a request to HTTP/1.1 bytes. `headers` is an array of `[name, value]`.
 * Sends `Connection: close` so the server ends the body at EOF, and a `Host` header.
 * Adds `Content-Length` for a body unless the caller already set one.
 */
export function serializeRequest({ method = "GET", path = "/", host, headers = [], body = null }) {
  const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
  const lines = [`${method.toUpperCase()} ${path} HTTP/1.1`];
  if (!has("host")) lines.push(`Host: ${host}`);
  for (const [k, v] of headers) {
    if (k.toLowerCase() === "connection") continue; // we dictate close
    lines.push(`${k}: ${v}`);
  }
  if (body && body.length && !has("content-length")) lines.push(`Content-Length: ${body.length}`);
  lines.push("Connection: close");
  const head = enc.encode(lines.join(CRLF) + CRLF + CRLF);
  return body && body.length ? concatBytes([head, body]) : head;
}

/** Index just past the blank line ending the headers, or -1. */
function headerBoundary(buf) {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) return i + 1;
  }
  return -1;
}

/** Undo `Transfer-Encoding: chunked` framing. */
export function dechunk(buf) {
  const parts = [];
  let i = 0;
  for (;;) {
    let j = i;
    while (j < buf.length && !(buf[j] === 13 && buf[j + 1] === 10)) j++;
    if (j >= buf.length) break;
    const size = parseInt(dec.decode(buf.subarray(i, j)).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = j + 2;
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2; // skip the chunk's trailing CRLF
  }
  return concatBytes(parts);
}

/**
 * Parse raw response bytes into `{ status, statusText, headers, body }`.
 * `headers` is an array of `[name, value]`; `body` is a Uint8Array.
 */
export function parseResponse(buf) {
  const end = headerBoundary(buf);
  if (end < 0) throw new Error("malformed HTTP response (no header terminator)");
  const head = dec.decode(buf.subarray(0, end));
  const [statusLine, ...headerLines] = head.split(CRLF).filter(Boolean);
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine || "");
  if (!m) throw new Error("malformed HTTP status line: " + JSON.stringify(statusLine || ""));
  const headers = [];
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  let body = buf.subarray(end);
  const te = headers.find(([k]) => k.toLowerCase() === "transfer-encoding");
  if (te && /chunked/i.test(te[1])) body = dechunk(body);
  return { status: parseInt(m[1], 10), statusText: m[2] || "", headers, body };
}

/** Coerce a fetch-ish body (string / Uint8Array / ArrayBuffer) to bytes. */
function toBytes(body) {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return enc.encode(String(body));
}

/**
 * `fetch`, but over this OS's loopback instead of the host browser's network.
 * Same call shape and a real `Response` back, so callers written against `fetch`
 * work unchanged.
 *
 * Deliberately unlike `fetch`: no CORS (there is no origin here — it's a socket to
 * a process on this machine), no forbidden-header list (the kernel moves whatever
 * bytes we hand it, so `Host`/`User-Agent`/`Cookie` really are sent), and redirects
 * are NOT followed — the caller sees the 3xx.
 */
export async function fetchLoopback(url, init = {}) {
  const u = new URL(url);
  const port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
  const headers = [];
  if (init.headers) {
    if (typeof init.headers.forEach === "function" && !Array.isArray(init.headers)) {
      init.headers.forEach((v, k) => headers.push([k, v])); // Headers
    } else {
      for (const [k, v] of Array.isArray(init.headers) ? init.headers : Object.entries(init.headers)) {
        headers.push([k, v]);
      }
    }
  }
  const method = (init.method || "GET").toUpperCase();
  const r = await requestLoopback({
    port,
    method,
    path: (u.pathname || "/") + (u.search || ""),
    host: u.host,
    headers,
    body: toBytes(init.body),
  });
  // A Response may not carry a body for these; the bytes are still parsed above.
  const bodyless = method === "HEAD" || r.status === 204 || r.status === 304 || r.status < 200;
  const h = new Headers();
  for (const [k, v] of r.headers) {
    try { h.append(k, v); } catch { /* skip a header name the browser won't model */ }
  }
  return new Response(bodyless || !r.body.length ? null : r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: h,
  });
}

/**
 * Make one HTTP request to a port in THIS OS over the kernel loopback and resolve
 * the parsed response. Throws `ECONNREFUSED` (from the kernel) when nothing is
 * listening — the same thing a real client gets.
 */
export async function requestLoopback({ port, method = "GET", path = "/", host, headers = [], body = null }) {
  const conn = await sys.netConnect(port | 0);
  try {
    await sys.write(conn.wfd, serializeRequest({ method, path, host: host || `localhost:${port}`, headers, body }));
    // Half-close so the server sees EOF on its read side and stops waiting for more
    // request bytes; we still hold rfd to read the response.
    try { sys.close(conn.wfd); conn.wfd = -1; } catch { /* server may have closed first */ }
    const chunks = [];
    for (;;) {
      const bytes = await sys.read(conn.rfd, 1 << 16);
      if (!bytes || bytes.length === 0) break; // EOF: Connection: close
      chunks.push(bytes);
    }
    return parseResponse(concatBytes(chunks));
  } finally {
    for (const fd of [conn.rfd, conn.wfd]) {
      if (fd >= 0) { try { sys.close(fd); } catch { /* already gone */ } }
    }
  }
}
