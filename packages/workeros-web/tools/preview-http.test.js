// Tests for the preview transport's pure HTTP byte helpers (ADR-021). These are
// the transforms public/preview-sw.js inlines; guarding them here (a SW can't run
// under node --test) is what keeps the inlined copy honest.
import test from "node:test";
import assert from "node:assert";
import { serializeRequest, parseResponse, dechunk } from "../src/preview-http.js";

const dec = new TextDecoder();
const text = (u8) => dec.decode(u8);

test("serializeRequest: GET adds Host + Connection: close, keeps headers", () => {
  const bytes = serializeRequest({
    method: "GET",
    path: "/app?x=1",
    host: "localhost:5173",
    headers: [["Accept", "text/html"], ["Connection", "keep-alive"]],
  });
  const s = text(bytes);
  assert.equal(s.split("\r\n")[0], "GET /app?x=1 HTTP/1.1");
  assert.match(s, /\r\nAccept: text\/html\r\n/);
  assert.match(s, /\r\nHost: localhost:5173\r\n/);
  assert.match(s, /\r\nConnection: close\r\n\r\n$/);
  assert.doesNotMatch(s, /keep-alive/, "the client's Connection header is dropped");
});

test("serializeRequest: POST appends the body after the header block", () => {
  const body = new TextEncoder().encode("a=1&b=2");
  const bytes = serializeRequest({
    method: "POST",
    path: "/submit",
    host: "h",
    headers: [["Content-Type", "application/x-www-form-urlencoded"]],
    body,
  });
  const s = text(bytes);
  assert.ok(s.startsWith("POST /submit HTTP/1.1\r\n"));
  assert.ok(s.endsWith("\r\n\r\na=1&b=2"));
});

test("parseResponse: content-length response, framing headers stripped", () => {
  const raw = new TextEncoder().encode(
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
  );
  const { status, statusText, headers, body } = parseResponse(raw);
  assert.equal(status, 200);
  assert.equal(statusText, "OK");
  assert.equal(text(body), "hello");
  const names = headers.map(([k]) => k.toLowerCase());
  assert.ok(names.includes("content-type"));
  assert.ok(!names.includes("content-length"), "content-length dropped");
  assert.ok(!names.includes("connection"), "connection dropped");
});

test("parseResponse: chunked body is de-chunked (matches http.js output)", () => {
  // Exactly the framing node:http emits for res.write('chunk-a'); res.write('chunk-b'); res.end().
  const raw = new TextEncoder().encode(
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "7\r\nchunk-a\r\n7\r\nchunk-b\r\n0\r\n\r\n",
  );
  const { status, headers, body } = parseResponse(raw);
  assert.equal(status, 200);
  assert.equal(text(body), "chunk-achunk-b");
  assert.ok(!headers.map(([k]) => k.toLowerCase()).includes("transfer-encoding"));
});

test("dechunk: handles chunk extensions and multiple chunks", () => {
  const raw = new TextEncoder().encode("3;foo=bar\r\nabc\r\n2\r\nde\r\n0\r\n\r\n");
  assert.equal(text(dechunk(raw)), "abcde");
});

test("parseResponse: malformed input degrades to 502, not a throw", () => {
  const { status } = parseResponse(new TextEncoder().encode("not http"));
  assert.equal(status, 502);
});
