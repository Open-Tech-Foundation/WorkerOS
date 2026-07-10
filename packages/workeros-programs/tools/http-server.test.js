// Realistic http.Server integration tests (ADR-021): a multi-route app driven
// over the fake kernel, exercising the paths a real framework/static server hits
// that the basic net-http tests don't — content types, 404, HEAD, concurrent
// connections, and (the untested one) keep-alive: multiple requests on a single
// connection. Pure node --test; no browser.
import test from "node:test";
import assert from "node:assert";
import EventEmitter from "../src/node/events.js";
import { Buffer } from "../src/node/buffer.js";
import { createNet } from "../src/node/net.js";
import { createHttp } from "../src/node/http.js";

globalThis.Buffer = Buffer;
globalThis.__workerosLoop = { ref() {}, unref() {} };

// ---- fake kernel: channels/fds/ports (mirrors net.rs semantics) -------------
class Channel {
  constructor() { this.buf = []; this.closed = false; this.waiters = []; }
  push(b) { this.buf.push(b); this._wake(); }
  close() { this.closed = true; this._wake(); }
  _wake() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  async read() {
    while (this.buf.length === 0 && !this.closed) await new Promise((r) => this.waiters.push(r));
    return this.buf.length ? this.buf.shift() : new Uint8Array(0);
  }
}
let nextFd = 3;
const fds = new Map();
const ports = new Map();
const bind = (ch, dir) => { const fd = nextFd++; fds.set(fd, { ch, dir }); return fd; };
const sys = {
  async netListen(port) {
    if (ports.has(port)) { const e = new Error("EADDRINUSE"); e.code = "EADDRINUSE"; throw e; }
    ports.set(port, { backlog: [], waiters: [] });
    return port;
  },
  async netConnect(port) {
    const l = ports.get(port);
    if (!l) { const e = new Error("ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; }
    const c2s = new Channel(), s2c = new Channel();
    l.backlog.push({ rfd: bind(c2s, "r"), wfd: bind(s2c, "w") });
    const w = l.waiters.shift(); if (w) w();
    return { rfd: bind(s2c, "r"), wfd: bind(c2s, "w") };
  },
  async netAccept(listener) {
    const l = ports.get(listener);
    while (l.backlog.length === 0) await new Promise((r) => l.waiters.push(r));
    return l.backlog.shift();
  },
  async read(fd) { return fds.get(fd).ch.read(); },
  write(fd, bytes) { fds.get(fd).ch.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); return true; },
  close(fd) { const e = fds.get(fd); if (e && e.dir === "w") e.ch.close(); },
};

const net = createNet(sys, EventEmitter);
const http = createHttp(sys, EventEmitter, net);
const enc = new TextEncoder();
const dec = new TextDecoder();
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

// A persistent client connection: send bytes, receive one full HTTP response at a
// time (content-length- or chunked-framed), so keep-alive can be tested.
async function connect(port) {
  const c = await sys.netConnect(port);
  let buf = new Uint8Array(0);
  const boundary = (b) => {
    for (let i = 3; i < b.length; i++) if (b[i] === 10 && b[i - 1] === 13 && b[i - 2] === 10 && b[i - 3] === 13) return i + 1;
    return -1;
  };
  return {
    send: (text) => sys.write(c.wfd, enc.encode(text)),
    close: () => sys.close(c.wfd),
    async recv() {
      for (;;) {
        const end = boundary(buf);
        if (end >= 0) {
          const head = dec.decode(buf.subarray(0, end));
          if (/transfer-encoding:\s*chunked/i.test(head)) {
            const rest = dec.decode(buf.subarray(end));
            if (/\r\n0\r\n\r\n$/.test(rest) || rest.endsWith("0\r\n\r\n")) {
              const out = dec.decode(buf); buf = new Uint8Array(0); return out;
            }
          } else {
            const m = /content-length:\s*(\d+)/i.exec(head);
            const need = m ? parseInt(m[1], 10) : 0;
            if (buf.length - end >= need) {
              const out = dec.decode(buf.subarray(0, end + need));
              buf = buf.subarray(end + need);
              return out;
            }
          }
        }
        const chunk = await sys.read(c.rfd);
        if (chunk.length === 0) { const out = dec.decode(buf); buf = new Uint8Array(0); return out; }
        buf = concat(buf, chunk);
      }
    },
  };
}

// A small multi-route app, like a static server + a JSON API.
function makeApp() {
  return http.createServer((req, res) => {
    if (req.url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>home</h1>");
    } else if (req.url === "/style.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end("body{color:red}");
    } else if (req.url === "/api" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 5 });
      res.end("hello");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
}

const status = (r) => r.split("\r\n")[0];
const body = (r) => r.slice(r.indexOf("\r\n\r\n") + 4);

test("keep-alive: three sequential requests on one connection", async () => {
  const server = makeApp();
  await new Promise((r) => server.listen(16000, r));
  const c = await connect(16000);

  c.send("GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  let r = await c.recv();
  assert.match(status(r), /200 OK/);
  assert.equal(body(r), "<h1>home</h1>");

  c.send("GET /style.css HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  r = await c.recv();
  assert.match(r, /Content-Type: text\/css/);
  assert.equal(body(r), "body{color:red}");

  c.send("GET /api HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  r = await c.recv();
  assert.match(r, /application\/json/);
  assert.deepEqual(JSON.parse(body(r)), { ok: true });

  c.close();
  server.close();
});

test("404 for an unknown route", async () => {
  const server = makeApp();
  await new Promise((r) => server.listen(16001, r));
  const c = await connect(16001);
  c.send("GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  const r = await c.recv();
  assert.match(status(r), /404 Not Found/);
  assert.equal(body(r), "not found");
  server.close();
});

test("HEAD sends headers (incl. Content-Length) but no body", async () => {
  const server = makeApp();
  await new Promise((r) => server.listen(16002, r));
  const c = await connect(16002);
  c.send("HEAD /whatever HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  const r = await c.recv();
  assert.match(r, /Content-Length: 5/);
  assert.equal(body(r), "", "HEAD response has no body");
  server.close();
});

test("concurrent connections are served independently", async () => {
  const server = makeApp();
  await new Promise((r) => server.listen(16003, r));
  const a = await connect(16003);
  const b = await connect(16003);
  // Interleave: send on both before reading either.
  a.send("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  b.send("GET /api HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  const [ra, rb] = await Promise.all([a.recv(), b.recv()]);
  assert.equal(body(ra), "<h1>home</h1>");
  assert.deepEqual(JSON.parse(body(rb)), { ok: true });
  server.close();
});
