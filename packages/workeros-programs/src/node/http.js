// `node:http` — an HTTP/1.1 server (and a fetch-backed client) for the WorkerOS
// Node runtime. GUEST code (INV-1): the wire protocol is parsed/serialized here,
// entirely in userland, over the opaque byte stream `node:net` provides (ADR-021).
// The kernel never sees an HTTP token. This is what a preview "server" (e.g. Vite)
// runs; the Service-Worker injector turns an intercepted browser `fetch` into a
// loopback connection this server accepts.
//
// Server: real HTTP/1.1 request parsing, keep-alive, chunked responses, and the
// `upgrade` event (so `ws` — hence Vite HMR — works over the raw socket).
//
// Client (`request`/`get`): every request goes through the kernel (`kernelFetch`),
// which routes it. `localhost`/`127.0.0.1` is THIS OS, so it becomes a loopback
// socket to the process listening on that port — every header sent, no CORS. Any
// other host is an egress decision the kernel records before performing it with the
// host's fetch (CORS-bound, ADR-008 — the browser cannot open raw TCP outward). This
// is the path npm's registry traffic takes, so it is routed and auditable like
// everything else.
//
// Honest limits (INV-5): no HTTP/2, no trailers, no continue/expect handling; the
// loopback client does not follow redirects (Node's client doesn't either) while the
// fetch path does.

import { kernelFetch, isLoopbackHost } from "/lib/workeros-net/http.js";

const CRLF = "\r\n";
const enc = new TextEncoder();
const dec = new TextDecoder();

export const STATUS_CODES = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
  301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
  426: "Upgrade Required", 429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout",
};

export const METHODS = [
  "GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH",
];

// Concatenate two Uint8Arrays.
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
// Index of the CRLFCRLF header/body boundary, or -1.
function headerEnd(buf) {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i] === 10 && buf[i - 1] === 13 && buf[i - 2] === 10 && buf[i - 3] === 13) return i + 1;
  }
  return -1;
}

export function createHttp(sys, EventEmitter, net) {
  const Buffer = globalThis.Buffer;

  // The parsed inbound request: method/url/headers + a readable body stream.
  class IncomingMessage extends EventEmitter {
    constructor(socket) {
      super();
      this.socket = socket;
      this.headers = {};
      this.rawHeaders = [];
      // We don't support trailers, but Node always exposes empty `trailers`/
      // `rawTrailers` — consumers read them unconditionally (minipass-fetch does
      // `createHeadersLenient(res.trailers)`, i.e. `Object.keys(res.trailers)`, on
      // every response; `undefined` there throws "Cannot convert … to object").
      this.trailers = {};
      this.rawTrailers = [];
      this.method = null;
      this.url = null;
      this.httpVersion = "1.1";
      this.complete = false;
      this.statusCode = null;
      this.statusMessage = "";
      this._encoding = null;
    }
    // Node's IncomingMessage is a Readable; consumers routinely call these. We emit
    // 'data'/'end' in flowing mode, so `setEncoding` decodes emitted chunks and
    // `pipe` forwards them — enough for http clients (`res.setEncoding('utf8')`,
    // `res.pipe(dest)`) without pulling the full stream machinery in.
    setEncoding(enc) { this._encoding = enc; return this; }
    pause() { this.socket && this.socket.pause && this.socket.pause(); return this; }
    resume() { this.socket && this.socket.resume && this.socket.resume(); return this; }
    isPaused() { return false; }
    read() { return null; }
    unpipe() { return this; }
    destroy(err) { this.socket && this.socket.destroy && this.socket.destroy(err); return this; }
    pipe(dest, opts) {
      this.on("data", (c) => dest.write(c));
      this.on("end", () => { if ((!opts || opts.end !== false) && dest.end) dest.end(); });
      this.on("error", (e) => dest.destroy && dest.destroy(e));
      dest.emit && dest.emit("pipe", this);
      return dest;
    }
    emit(ev, data) {
      if (ev === "data" && this._encoding && data && typeof data !== "string") {
        data = typeof data.toString === "function" && data.length !== undefined
          ? Buffer.from(data).toString(this._encoding)
          : data;
      }
      return super.emit(ev, data);
    }
  }

  // The outbound response the handler writes. Serializes status line + headers on
  // the first write, then the body (chunked when the length isn't known).
  class ServerResponse extends EventEmitter {
    constructor(socket, req) {
      super();
      this._socket = socket;
      this._req = req;
      this.statusCode = 200;
      this.statusMessage = undefined;
      this.headersSent = false;
      this.finished = false;
      this._headers = new Map(); // lowercase name → { name, value }
      this._chunked = false;
      this.sendDate = true;
      // A HEAD response carries headers (incl. Content-Length) but never a body.
      this._headOnly = req && req.method === "HEAD";
    }

    setHeader(name, value) {
      this._headers.set(String(name).toLowerCase(), { name, value });
      return this;
    }
    getHeader(name) {
      const h = this._headers.get(String(name).toLowerCase());
      return h ? h.value : undefined;
    }
    removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
    hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }

    writeHead(statusCode, statusMessage, headers) {
      this.statusCode = statusCode;
      if (typeof statusMessage === "string") this.statusMessage = statusMessage;
      else headers = statusMessage;
      if (headers) {
        if (Array.isArray(headers)) {
          for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
        } else {
          for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
        }
      }
      return this;
    }

    _flushHead() {
      if (this.headersSent) return;
      this.headersSent = true;
      const msg = this.statusMessage || STATUS_CODES[this.statusCode] || "";
      let head = `HTTP/1.1 ${this.statusCode} ${msg}${CRLF}`;
      if (this.sendDate && !this.hasHeader("date")) head += `Date: ${new Date().toUTCString()}${CRLF}`;
      const hasLen = this.hasHeader("content-length");
      const keepAlive = this._req && this._req._keepAlive;
      // No chunked framing for a HEAD response — it has no body at all.
      if (!hasLen && !this.hasHeader("transfer-encoding") && !this._headOnly) {
        this._chunked = true;
        head += `Transfer-Encoding: chunked${CRLF}`;
      }
      if (!this.hasHeader("connection")) head += `Connection: ${keepAlive ? "keep-alive" : "close"}${CRLF}`;
      for (const { name, value } of this._headers.values()) {
        const vals = Array.isArray(value) ? value : [value];
        for (const v of vals) head += `${name}: ${v}${CRLF}`;
      }
      head += CRLF;
      this._socket.write(enc.encode(head));
    }

    write(chunk, encoding, cb) {
      if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      this._flushHead();
      if (this._headOnly) { if (cb) queueMicrotask(cb); return true; } // no body on HEAD
      const bytes = chunk == null ? new Uint8Array(0)
        : typeof chunk === "string" ? enc.encode(chunk)
        : chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this._chunked) {
        if (bytes.length > 0) {
          this._socket.write(enc.encode(bytes.length.toString(16) + CRLF));
          this._socket.write(bytes);
          this._socket.write(enc.encode(CRLF));
        }
      } else {
        this._socket.write(bytes);
      }
      if (cb) queueMicrotask(cb);
      return true;
    }

    end(chunk, encoding, cb) {
      if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
      else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      // Known-length fast path: a lone end(body) with no prior write sets
      // Content-Length so the response is a clean, non-chunked message.
      if (!this.headersSent && chunk != null && !this.hasHeader("content-length") && !this.hasHeader("transfer-encoding")) {
        const bytes = typeof chunk === "string" ? enc.encode(chunk)
          : chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        this.setHeader("Content-Length", bytes.length);
        this._flushHead();
        if (this._req.method !== "HEAD") this._socket.write(bytes);
      } else {
        if (chunk != null) this.write(chunk, encoding);
        else this._flushHead();
        if (this._chunked) this._socket.write(enc.encode("0" + CRLF + CRLF));
      }
      this.finished = true;
      this.emit("finish");
      if (cb) queueMicrotask(cb);
      // Close the connection unless the client asked to keep it alive.
      if (!(this._req && this._req._keepAlive)) this._socket.end();
      this.emit("close");
      return this;
    }
  }

  // Parse HTTP/1.1 requests off a socket and drive request/upgrade events.
  class Server extends EventEmitter {
    constructor(opts, requestListener) {
      super();
      if (typeof opts === "function") { requestListener = opts; opts = {}; }
      // `allowHalfOpen`: a client that half-closes after sending its request (the
      // normal HTTP client pattern — write request, shutdown(WR), await response)
      // must NOT tear down the server's write side. Without this, the request-side
      // EOF auto-ends the socket before an ASYNC handler (Vite's middleware) writes
      // the response, so the client gets an empty reply. A sync `res.end()` happened
      // to beat the EOF; an async one didn't.
      this._net = net.createServer({ allowHalfOpen: true }, (socket) => this._onConnection(socket));
      // Forward the listener's lifecycle events.
      this._net.on("listening", () => this.emit("listening"));
      this._net.on("close", () => this.emit("close"));
      this._net.on("error", (e) => this.emit("error", e));
      if (requestListener) this.on("request", requestListener);
    }

    _onConnection(socket) {
      this.emit("connection", socket);
      let buf = new Uint8Array(0);
      let req = null;
      let res = null;
      let needBody = 0;
      let bodyGot = 0;

      const startRequest = () => {
        const end = headerEnd(buf);
        if (end < 0) return false; // headers incomplete
        const headText = dec.decode(buf.subarray(0, end));
        buf = buf.subarray(end);
        const lines = headText.split(CRLF).filter((l) => l.length);
        const [method, url, version] = (lines.shift() || "").split(" ");
        req = new IncomingMessage(socket);
        req.method = method;
        req.url = url;
        req.httpVersion = (version || "HTTP/1.1").replace("HTTP/", "");
        for (const line of lines) {
          const i = line.indexOf(":");
          if (i < 0) continue;
          const name = line.slice(0, i).trim();
          const value = line.slice(i + 1).trim();
          req.rawHeaders.push(name, value);
          const lc = name.toLowerCase();
          // Node joins duplicate headers with ", " (except set-cookie).
          req.headers[lc] = req.headers[lc] ? req.headers[lc] + ", " + value : value;
        }
        const conn = (req.headers.connection || "").toLowerCase();
        req._keepAlive = req.httpVersion === "1.1" ? conn !== "close" : conn === "keep-alive";

        // WebSocket / protocol upgrade: hand the raw socket to the listener (ws).
        if (conn.includes("upgrade") && req.headers.upgrade) {
          this.emit("upgrade", req, socket, buf);
          buf = new Uint8Array(0);
          req = null;
          return false; // the upgrade owns the socket now
        }

        needBody = parseInt(req.headers["content-length"] || "0", 10) || 0;
        bodyGot = 0;
        res = new ServerResponse(socket, req);
        res.on("close", () => {
          // Ready for the next pipelined/keep-alive request on this socket.
          req = null; res = null;
          if (req === null && buf.length) queueMicrotask(pump);
        });
        this.emit("request", req, res);
        return true;
      };

      const pump = () => {
        if (req === null && !startRequest()) return;
        if (req && needBody > 0) {
          const take = Math.min(needBody - bodyGot, buf.length);
          if (take > 0) {
            req.emit("data", Buffer.from(buf.subarray(0, take)));
            buf = buf.subarray(take);
            bodyGot += take;
          }
          if (bodyGot >= needBody) { req.complete = true; req.emit("end"); }
        } else if (req) {
          req.complete = true;
          req.emit("end");
        }
      };

      socket.on("data", (chunk) => {
        buf = concat(buf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        pump();
      });
      // The client's read-side EOF (it half-closed after sending the request) must
      // NOT end our write side — the response still has to go out. `res.end()` closes
      // the socket once the handler has replied; a keep-alive idle socket is closed
      // when the peer fully goes away (the pump reaches EOF and, since we then have
      // no writable work, the socket finishes closing).
      socket.on("error", () => {});
    }

    listen(...args) { this._net.listen(...args); return this; }
    address() { return this._net.address(); }
    close(cb) { this._net.close(cb); return this; }
    setTimeout(_ms, cb) { if (cb) this.once("timeout", cb); return this; }
  }

  const createServer = (opts, requestListener) => new Server(opts, requestListener);

  // ---- client: mapped onto `fetch` (outbound, CORS-bound — ADR-008) ----------
  // The browser cannot open raw TCP, so an outbound request rides the worker's
  // `fetch` (which does the DNS/TLS/HTTP). This is what makes `node:https` reach
  // registry.npmjs.org: `minipass-fetch` calls `https.request(options)` and reads
  // the response as a stream, so `ClientRequest` presents a streaming
  // `IncomingMessage`. Any `agent` option is accepted but ignored — fetch owns the
  // connection, so @npmcli/agent's tls/net.connect path is never exercised.
  //
  // A shared factory so `node:http` and `node:https` differ only in the default
  // protocol; `minipass-fetch` passes `protocol` explicitly, so both are identical
  // in practice.
  // Under cross-origin isolation the browser enforces CORS on every outbound
  // fetch: any non-safelisted request header triggers a preflight OPTIONS, which
  // the npm registry (and most hosts) don't answer — the request then fails with
  // "Failed to fetch". npm attaches telemetry headers (`npm-command`,
  // `npm-session`, `user-agent`, …) that aren't needed to fetch a public package,
  // so forward only the CORS-safelisted set plus `authorization` (essential when a
  // token is configured; an authenticated registry must support its own preflight).
  const SAFELISTED_HEADERS = new Set([
    "accept", "accept-language", "content-language", "content-type", "range", "authorization",
  ]);
  const corsSafeHeaders = (headers) => {
    const out = {};
    for (const k of Object.keys(headers || {})) {
      if (SAFELISTED_HEADERS.has(k.toLowerCase())) out[k] = headers[k];
    }
    return out;
  };

  /** Does this URL address a server inside this OS (kernel loopback)? */
  const isLocalUrl = (u) => {
    try { return isLoopbackHost(new URL(u).hostname); } catch { return false; }
  };

  // A pending request must hold the event loop open exactly as a live socket does
  // in Node (ADR-021) — a `fetch` is a host promise the guest loop can't see, so
  // without an explicit ref the loop drains mid-request and the process exits
  // early (npm's "Exit handler never called!"). Ref synchronously in `end()`,
  // release once the response fully settles or errors.
  const loop = () => globalThis.__workerosLoop; // undefined outside /bin/node

  const makeClient = (defaultProtocol) => {
    // http.request(url[, options][, cb]) and http.request(options[, cb]).
    const normalize = (a, b, c) => {
      let urlArg = null, opts = {}, cb;
      if (typeof a === "string" || a instanceof URL) {
        urlArg = String(a);
        if (typeof b === "function") cb = b;
        else { opts = b || {}; cb = c; }
      } else {
        opts = a || {};
        cb = typeof b === "function" ? b : undefined;
      }
      const headers = { ...(opts.headers || {}) };
      if (opts.auth && !headers.Authorization && !headers.authorization) {
        headers.Authorization = "Basic " + btoa(opts.auth);
      }
      let url;
      if (urlArg) {
        const u = new URL(urlArg);
        if (opts.path) { const p = new URL(opts.path, u); u.pathname = p.pathname; u.search = p.search; }
        url = u.toString();
      } else if (opts.url) {
        url = opts.url;
      } else {
        const protocol = opts.protocol || defaultProtocol;
        const host = opts.hostname || opts.host || "localhost";
        const port = opts.port ? ":" + opts.port : "";
        url = `${protocol}//${host}${port}${opts.path || "/"}`;
      }
      return { url, method: (opts.method || "GET").toUpperCase(), headers, signal: opts.signal };
    };

    class ClientRequest extends EventEmitter {
      constructor(a, b, c) {
        super();
        this._opts = normalize(a, b, c);
        this._chunks = [];
        this._ac = new AbortController();
        // Node fires 'socket' before 'response'; some clients wait on it.
        this._socket = new EventEmitter();
        this._socket.setTimeout = () => this._socket;
        this._socket.setKeepAlive = () => this._socket;
        this._socket.setNoDelay = () => this._socket;
        this._socket.ref = this._socket.unref = () => this._socket;
        for (const x of [a, b, c]) if (typeof x === "function") this.once("response", x);
      }
      setHeader(name, value) { this._opts.headers[name] = value; return this; }
      getHeader(name) { return this._opts.headers[name]; }
      removeHeader(name) { delete this._opts.headers[name]; }
      getHeaders() { return { ...this._opts.headers }; }
      hasHeader(name) { return name in this._opts.headers; }
      flushHeaders() {}
      setNoDelay() {}
      setSocketKeepAlive() {}
      write(chunk, enc2, cb) {
        this._chunks.push(typeof chunk === "string" ? enc.encode(chunk) : chunk);
        if (typeof enc2 === "function") enc2(); else if (typeof cb === "function") cb();
        return true;
      }
      end(chunk, enc2, cb) {
        if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
        else if (typeof enc2 === "function") { cb = enc2; }
        if (chunk != null) this.write(chunk);
        const o = this._opts;
        const body = o.method !== "GET" && o.method !== "HEAD" && this._chunks.length
          ? Buffer.concat(this._chunks.map((c) => Buffer.from(c))) : undefined;
        // Hold the loop open for the whole request/response, released exactly once.
        loop()?.ref();
        let released = false;
        const release = () => { if (!released) { released = true; loop()?.unref(); } };
        queueMicrotask(() => this.emit("socket", this._socket));
        // A local URL is a socket to a process in this OS: send every header the
        // caller set (nothing is CORS-checked on a socket). Only the outbound fetch
        // path needs the safelist.
        const local = isLocalUrl(o.url);
        kernelFetch(o.url, {
          method: o.method,
          headers: local ? { ...o.headers } : corsSafeHeaders(o.headers),
          body,
          signal: o.signal || this._ac.signal,
          redirect: "follow",
        })
          .then((r) => {
            const res = new IncomingMessage(this._socket);
            res.statusCode = r.status;
            res.statusMessage = r.statusText;
            res.url = r.url;
            // `fetch` has already decoded the transfer/content encoding and given
            // us the plaintext body, so DON'T forward `content-encoding` (the Node
            // layer, e.g. minipass-fetch, would try to gunzip already-plain data)
            // or `content-length` (it describes the compressed size — now wrong).
            // Over loopback nothing decoded anything for us: the bytes ARE what the
            // server wrote, so its own headers still describe them and must survive.
            r.headers.forEach((v, k) => {
              const lk = k.toLowerCase();
              if (!local && (lk === "content-encoding" || lk === "content-length")) return;
              res.headers[k] = v;
              res.rawHeaders.push(k, v);
            });
            res.pause = () => res;
            res.resume = () => res;
            res.destroy = (e) => { try { r.body?.cancel?.(); } catch { /* */ } release(); if (e) res.emit("error", e); return res; };
            this.emit("response", res);
            // Stream the body chunk-by-chunk so large tarballs never fully buffer.
            const reader = r.body && r.body.getReader ? r.body.getReader() : null;
            if (!reader) { res.complete = true; release(); res.emit("end"); return; }
            const pump = () => reader.read().then(({ done, value }) => {
              if (done) { res.complete = true; release(); res.emit("end"); return; }
              res.emit("data", Buffer.from(value));
              return pump();
            });
            pump().catch((e) => { release(); res.emit("error", e instanceof Error ? e : new Error(String(e))); });
          })
          .catch((e) => {
            release();
            if (this._aborted) return;
            this.emit("error", e instanceof Error ? e : new Error(String(e)));
          });
        if (typeof cb === "function") cb();
        return this;
      }
      abort() { this._aborted = true; try { this._ac.abort(); } catch { /* */ } this.emit("abort"); }
      destroy(e) { this._aborted = true; try { this._ac.abort(); } catch { /* */ } if (e) this.emit("error", e); return this; }
      setTimeout(_ms, cb) { if (cb) this.once("timeout", cb); return this; }
    }

    const request = (a, b, c) => new ClientRequest(a, b, c);
    const get = (a, b, c) => { const r = new ClientRequest(a, b, c); r.end(); return r; };
    return { ClientRequest, request, get };
  };

  const { ClientRequest, request, get } = makeClient("http:");

  const http = {
    Server, ServerResponse, IncomingMessage, ClientRequest,
    createServer, request, get, STATUS_CODES, METHODS,
    makeClient, // consumed by node:https
    globalAgent: {}, Agent: class Agent extends EventEmitter {},
  };
  http.default = http;
  return http;
}
