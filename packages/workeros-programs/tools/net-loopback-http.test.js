// The guest HTTP client that speaks over the kernel loopback (`/lib/workeros-net/
// http.js`). This is what makes `curl http://localhost:3000` — and node's
// `http.get("http://localhost:3000")` — reach a server running in THIS OS instead of
// leaking out to whatever the host machine serves on that port.
//
// Driven by an in-process fake `sys` that mimics the kernel's netConnect/read/write/
// close contract (the same shape net.rs enforces natively), so the wire logic is
// proven without a browser or a wasm kernel.
import test from "node:test";
import assert from "node:assert";
import {
  isLoopbackHost,
  serializeRequest,
  parseResponse,
  dechunk,
  fetchLoopback,
  fetchEgress,
  kernelFetch,
} from "../src/net/http.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- fake kernel loopback ---------------------------------------------------
// `respond(requestBytes) -> responseBytes`, or null to refuse the connection.
function installFakeSys({ ports }) {
  const fds = new Map();
  let nextFd = 3;
  const open = (v) => { const fd = nextFd++; fds.set(fd, v); return fd; };
  globalThis.sys = {
    lastRequest: null,
    async netConnect(port) {
      const handler = ports[port];
      if (!handler) { const e = new Error("errno Connrefused (14)"); e.errno = 14; throw e; }
      const state = { req: [], resp: null, off: 0, handler };
      return { wfd: open({ kind: "w", state }), rfd: open({ kind: "r", state }) };
    },
    async write(fd, bytes) {
      const v = fds.get(fd);
      assert.equal(v.kind, "w", "wrote to a non-writable fd");
      v.state.req.push(bytes);
      return bytes.length;
    },
    async read(fd, max) {
      const v = fds.get(fd);
      assert.equal(v.kind, "r", "read from a non-readable fd");
      const s = v.state;
      if (s.resp === null) {
        // The server only answers once the client has finished its request — i.e.
        // after the write half is closed, exactly like `Connection: close`.
        const reqBytes = Buffer.concat(s.req.map((c) => Buffer.from(c)));
        globalThis.sys.lastRequest = dec.decode(reqBytes);
        s.resp = s.handler(reqBytes);
      }
      if (s.off >= s.resp.length) return new Uint8Array(0); // EOF
      const chunk = s.resp.subarray(s.off, s.off + max);
      s.off += chunk.length;
      return chunk;
    },
    close(fd) { fds.delete(fd); },
    _openFds: () => fds.size,
  };
  return () => { delete globalThis.sys; };
}

const httpResponse = (body, { status = 200, headers = ["Content-Type: text/plain"] } = {}) =>
  enc.encode(
    `HTTP/1.1 ${status} OK\r\n` +
      [...headers, `Content-Length: ${enc.encode(body).length}`].join("\r\n") +
      `\r\n\r\n${body}`,
  );

// ---- pure wire --------------------------------------------------------------

test("isLoopbackHost: localhost means THIS OS, a real host does not", () => {
  for (const h of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "LOCALHOST"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["example.com", "registry.npmjs.org", "192.168.1.5", ""]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("serializeRequest: request line, Host, Connection: close, Content-Length", () => {
  const bytes = serializeRequest({
    method: "post",
    path: "/api?x=1",
    host: "localhost:3000",
    headers: [["Content-Type", "application/json"], ["Connection", "keep-alive"]],
    body: enc.encode('{"a":1}'),
  });
  const text = dec.decode(bytes);
  assert.match(text, /^POST \/api\?x=1 HTTP\/1\.1\r\n/);
  assert.match(text, /\r\nHost: localhost:3000\r\n/);
  assert.match(text, /\r\nContent-Type: application\/json\r\n/);
  assert.match(text, /\r\nContent-Length: 7\r\n/);
  // We dictate close so the server EOFs the body; a caller's keep-alive is dropped.
  assert.match(text, /\r\nConnection: close\r\n/);
  assert.equal(/keep-alive/.test(text), false);
  assert.ok(text.endsWith('\r\n\r\n{"a":1}'));
});

test("parseResponse: status, headers, body", () => {
  const r = parseResponse(httpResponse("hello", { status: 404 }));
  assert.equal(r.status, 404);
  assert.equal(dec.decode(r.body), "hello");
  assert.deepEqual(
    r.headers.find(([k]) => k.toLowerCase() === "content-type"),
    ["Content-Type", "text/plain"],
  );
});

test("parseResponse: undoes chunked framing", () => {
  const raw = enc.encode(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
  );
  assert.equal(dec.decode(parseResponse(raw).body), "hello world");
});

test("dechunk: handles chunk extensions and a zero terminator", () => {
  assert.equal(dec.decode(dechunk(enc.encode("3;a=b\r\nabc\r\n0\r\n\r\n"))), "abc");
});

test("parseResponse: rejects garbage rather than inventing a response", () => {
  assert.throws(() => parseResponse(enc.encode("not http at all\r\n\r\n")), /malformed HTTP/);
});

// ---- the client over the fake kernel ---------------------------------------

test("fetchLoopback: reaches the in-OS server and returns a real Response", async () => {
  const restore = installFakeSys({ ports: { 3000: () => httpResponse("hello from in-OS server") } });
  try {
    const res = await fetchLoopback("http://localhost:3000/");
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello from in-OS server");
    assert.equal(res.headers.get("content-type"), "text/plain");
    assert.equal(globalThis.sys._openFds(), 0, "every socket fd must be closed");
  } finally { restore(); }
});

test("fetchLoopback: path, query and method reach the server verbatim", async () => {
  const restore = installFakeSys({ ports: { 8080: () => httpResponse("ok") } });
  try {
    await fetchLoopback("http://127.0.0.1:8080/a/b?q=1", { method: "DELETE" });
    assert.match(globalThis.sys.lastRequest, /^DELETE \/a\/b\?q=1 HTTP\/1\.1\r\n/);
  } finally { restore(); }
});

test("fetchLoopback: sends a body and every header — no CORS safelist on a socket", async () => {
  const restore = installFakeSys({ ports: { 3000: () => httpResponse("ok") } });
  try {
    await fetchLoopback("http://localhost:3000/submit", {
      method: "POST",
      // `User-Agent`/`Cookie` are forbidden for browser fetch; over a socket they go.
      headers: { "Content-Type": "application/json", "User-Agent": "curl/workeros", Cookie: "a=1" },
      body: '{"x":1}',
    });
    const req = globalThis.sys.lastRequest;
    assert.match(req, /\r\nUser-Agent: curl\/workeros\r\n/);
    assert.match(req, /\r\nCookie: a=1\r\n/);
    assert.ok(req.endsWith('{"x":1}'));
  } finally { restore(); }
});

test("fetchLoopback: default port 80 when the URL omits one", async () => {
  const restore = installFakeSys({ ports: { 80: () => httpResponse("root") } });
  try {
    assert.equal(await (await fetchLoopback("http://localhost/")).text(), "root");
  } finally { restore(); }
});

test("fetchLoopback: nothing listening surfaces ECONNREFUSED, not a fake 502", async () => {
  const restore = installFakeSys({ ports: {} });
  try {
    await assert.rejects(() => fetchLoopback("http://localhost:4999/"), /Connrefused/);
  } finally { restore(); }
});

test("fetchLoopback: a 204 yields a bodyless Response (Response would throw otherwise)", async () => {
  const restore = installFakeSys({
    ports: { 3000: () => enc.encode("HTTP/1.1 204 OK\r\nConnection: close\r\n\r\n") },
  });
  try {
    const res = await fetchLoopback("http://localhost:3000/");
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  } finally { restore(); }
});

test("fetchLoopback: HEAD keeps the status/headers but no body", async () => {
  const restore = installFakeSys({ ports: { 3000: () => httpResponse("ignored") } });
  try {
    const res = await fetchLoopback("http://localhost:3000/", { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
    assert.match(globalThis.sys.lastRequest, /^HEAD \//);
  } finally { restore(); }
});

test("fetchLoopback: reassembles a body split across many reads", async () => {
  const big = "x".repeat(200_000);
  const restore = installFakeSys({ ports: { 3000: () => httpResponse(big) } });
  try {
    assert.equal((await (await fetchLoopback("http://localhost:3000/")).text()).length, big.length);
  } finally { restore(); }
});

// ---- egress: out of the OS, but only through the kernel ---------------------

/** A fake `sys.netFetch` standing in for the kernel's egress syscall. */
function installFakeEgress(handler) {
  globalThis.sys = { calls: [], netFetch(req) { this.calls.push(req); return handler(req); } };
  return () => { delete globalThis.sys; };
}
const egressReply = (body, { status = 200, headers = [["content-type", "text/plain"]] } = {}) => ({
  status, statusText: "OK", headers, body: enc.encode(body), url: "http://example.com/",
});

test("fetchEgress: goes through the kernel syscall, not a host fetch", async () => {
  const restore = installFakeEgress(async () => egressReply("from the outside"));
  try {
    const res = await fetchEgress("https://example.com/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    assert.equal(await res.text(), "from the outside");
    assert.equal(res.status, 200);
    const [call] = globalThis.sys.calls;
    assert.equal(call.url, "https://example.com/thing");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.headers, [["Content-Type", "application/json"]]);
    assert.equal(dec.decode(call.body), '{"a":1}');
  } finally { restore(); }
});

test("fetchEgress: a kernel refusal surfaces to the caller", async () => {
  const restore = installFakeEgress(async () => { throw new Error("blocked by policy"); });
  try {
    await assert.rejects(() => fetchEgress("https://blocked.example/"), /blocked by policy/);
  } finally { restore(); }
});

test("kernelFetch: a remote URL takes the egress door", async () => {
  const restore = installFakeEgress(async () => egressReply("remote"));
  try {
    assert.equal(await (await kernelFetch("https://registry.npmjs.org/left-pad")).text(), "remote");
    assert.equal(globalThis.sys.calls.length, 1, "must have gone through net_fetch");
  } finally { restore(); }
});

test("kernelFetch: a loopback URL never reaches egress — it stays in the OS", async () => {
  const restore = installFakeSys({ ports: { 3000: () => httpResponse("in-os") } });
  // netFetch must never be called for localhost; blow up loudly if it is.
  globalThis.sys.netFetch = () => { throw new Error("localhost must not leave the OS"); };
  try {
    assert.equal(await (await kernelFetch("http://localhost:3000/")).text(), "in-os");
  } finally { restore(); }
});
