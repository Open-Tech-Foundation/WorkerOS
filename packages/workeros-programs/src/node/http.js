// `node:http` — an HTTP/1.1 server (and a fetch-backed client) for the WorkerOS
// Node runtime. GUEST code (INV-1): the wire protocol is parsed/serialized here,
// entirely in userland, over the opaque byte stream `node:net` provides (ADR-021).
// The kernel never sees an HTTP token. This is what a preview "server" (e.g. Vite)
// runs; the Service-Worker injector turns an intercepted browser `fetch` into a
// loopback connection this server accepts.
//
// Server: real HTTP/1.1 request parsing, keep-alive, chunked responses, and the
// `upgrade` event (so `ws` — hence Vite HMR — works over the raw socket). Honest
// limits (INV-5): no HTTP/2, no trailers, no continue/expect handling, and the
// client (`request`/`get`) is mapped onto the worker's `fetch` (CORS-bound, per
// ADR-008) rather than the loopback socket path.

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
      this.method = null;
      this.url = null;
      this.httpVersion = "1.1";
      this.complete = false;
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
      this._net = net.createServer((socket) => this._onConnection(socket));
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
      socket.on("end", () => { socket.end?.(); });
      socket.on("error", () => {});
    }

    listen(...args) { this._net.listen(...args); return this; }
    address() { return this._net.address(); }
    close(cb) { this._net.close(cb); return this; }
    setTimeout(_ms, cb) { if (cb) this.once("timeout", cb); return this; }
  }

  const createServer = (opts, requestListener) => new Server(opts, requestListener);

  // ---- client: mapped onto `fetch` (outbound, CORS-bound — ADR-008) ----------
  // A minimal ClientRequest whose `end()` fires a fetch and replays the response
  // as an IncomingMessage. Covers `http.get`/`http.request` for absolute URLs.
  class ClientRequest extends EventEmitter {
    constructor(options, cb) {
      super();
      this._opts = normalizeClientOptions(options);
      if (cb) this.once("response", cb);
      this._chunks = [];
    }
    setHeader(name, value) { (this._opts.headers ||= {})[name] = value; return this; }
    write(chunk) { this._chunks.push(typeof chunk === "string" ? enc.encode(chunk) : chunk); return true; }
    end(chunk) {
      if (chunk != null) this.write(chunk);
      const o = this._opts;
      const body = o.method !== "GET" && o.method !== "HEAD" && this._chunks.length
        ? Buffer.concat(this._chunks.map((c) => Buffer.from(c))) : undefined;
      fetch(o.url, { method: o.method, headers: o.headers, body })
        .then(async (r) => {
          const res = new IncomingMessage(null);
          res.statusCode = r.status;
          res.statusMessage = r.statusText;
          r.headers.forEach((v, k) => { res.headers[k] = v; });
          this.emit("response", res);
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length) res.emit("data", Buffer.from(bytes));
          res.complete = true;
          res.emit("end");
        })
        .catch((e) => this.emit("error", e instanceof Error ? e : new Error(String(e))));
      return this;
    }
    abort() { this.emit("abort"); }
    setTimeout(_ms, cb) { if (cb) this.once("timeout", cb); return this; }
  }

  function normalizeClientOptions(options) {
    if (typeof options === "string") return { url: options, method: "GET", headers: {} };
    const protocol = options.protocol || "http:";
    const host = options.hostname || options.host || "localhost";
    const port = options.port ? ":" + options.port : "";
    const path = options.path || "/";
    return {
      url: options.url || `${protocol}//${host}${port}${path}`,
      method: options.method || "GET",
      headers: options.headers || {},
    };
  }

  const request = (options, cb) => new ClientRequest(options, cb);
  const get = (options, cb) => { const r = new ClientRequest(options, cb); r.end(); return r; };

  const http = {
    Server, ServerResponse, IncomingMessage, ClientRequest,
    createServer, request, get, STATUS_CODES, METHODS,
    globalAgent: {}, Agent: class Agent {},
  };
  http.default = http;
  return http;
}
