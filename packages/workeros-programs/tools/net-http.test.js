// Functional tests for the guest node:net + node:http shims (ADR-021), driven by
// an in-process fake `sys` that mimics the kernel's port/pipe/accept semantics —
// the same contract net.rs enforces natively. This proves the userland HTTP
// parse/serialize + socket-duplex logic (the half that can't run in `cargo test`)
// without a browser; the browser E2E (real wasm kernel + Service-Worker injector)
// is the Phase-6c follow-up.
import test from "node:test";
import assert from "node:assert";
import EventEmitter from "../src/node/events.js";
import { Buffer } from "../src/node/buffer.js";
import { createNet } from "../src/node/net.js";
import { createHttp } from "../src/node/http.js";

globalThis.Buffer = Buffer;
// A counting event-loop stub: a listening server must hold a ref so /bin/node
// doesn't exit the instant the script's top level returns (ADR-021).
let loopRefs = 0;
globalThis.__workerosLoop = { ref() { loopRefs++; }, unref() { loopRefs--; } };

// ---- fake kernel: channels (pipes), fds, ports, accept parking --------------
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

async function rawRoundtrip(port, requestText) {
  const conn = await sys.netConnect(port);
  sys.write(conn.wfd, enc.encode(requestText));
  let out = "";
  for (;;) {
    const b = await Promise.race([
      sys.read(conn.rfd),
      new Promise((r) => setTimeout(() => r(null), 50)),
    ]);
    if (b === null || b.length === 0) break;
    out += dec.decode(b);
  }
  return out;
}

test("GET → 200 with a Content-Length body (non-chunked)", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/hello");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hi there");
  });
  await new Promise((r) => server.listen(15173, r));
  const resp = await rawRoundtrip(15173, "GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.match(resp, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(resp, /Content-Type: text\/plain\r\n/);
  assert.match(resp, /Content-Length: 8\r\n/);
  assert.ok(resp.endsWith("\r\n\r\nhi there"));
  server.close();
});

test("streaming writes → chunked transfer-encoding", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("chunk-a");
    res.write("chunk-b");
    res.end();
  });
  await new Promise((r) => server.listen(15174, r));
  const resp = await rawRoundtrip(15174, "GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
  assert.match(resp, /Transfer-Encoding: chunked\r\n/);
  const body = resp.slice(resp.indexOf("\r\n\r\n") + 4);
  assert.match(body, /^7\r\nchunk-a\r\n7\r\nchunk-b\r\n0\r\n\r\n$/);
  server.close();
});

test("POST body streams to req 'data'/'end'", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d.toString(); });
    req.on("end", () => res.end("got:" + body));
  });
  await new Promise((r) => server.listen(15175, r));
  const resp = await rawRoundtrip(15175, "POST /x HTTP/1.1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHELLO");
  assert.ok(resp.endsWith("got:HELLO"));
  server.close();
});

test("second listen on a held port → EADDRINUSE", async () => {
  const a = http.createServer(() => {});
  await new Promise((r) => a.listen(15176, r));
  const b = http.createServer(() => {});
  const err = await new Promise((r) => { b.on("error", r); b.listen(15176); });
  assert.equal(err.code, "EADDRINUSE");
  a.close();
});

test("Connection: Upgrade → 'upgrade' event with the raw socket (ws/HMR path)", async () => {
  const server = http.createServer((req, res) => res.end("no"));
  let upgraded = null;
  server.on("upgrade", (req, socket) => { upgraded = { req, socket }; socket.end(); });
  await new Promise((r) => server.listen(15177, r));
  await rawRoundtrip(15177, "GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  assert.ok(upgraded);
  assert.equal(upgraded.req.headers.upgrade, "websocket");
  server.close();
});

test("server.listen refs the event loop synchronously (no immediate exit)", () => {
  // The regression: ref happened after the async netListen, so whenIdle() — checked
  // the moment the script's top level returns — saw 0 refs and the process exited
  // before the server registered. listen() must ref *before* it returns.
  const before = loopRefs;
  const server = http.createServer(() => {});
  server.listen(15179);
  assert.equal(loopRefs, before + 1, "listen must ref the loop synchronously");
  server.close();
  assert.equal(loopRefs, before, "close unrefs the loop");
});

test("net.connect ⇄ server full-duplex echo", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", (d) => socket.write(Buffer.from("echo:" + d.toString())));
  });
  await new Promise((r) => server.listen(15178, r));
  const client = net.connect(15178);
  const got = await new Promise((resolve) => {
    client.on("connect", () => client.write("ping"));
    client.on("data", (d) => resolve(d.toString()));
  });
  assert.equal(got, "echo:ping");
  server.close();
});
