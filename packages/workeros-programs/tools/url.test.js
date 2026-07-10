// Unit tests for the `node:url` builtin (src/node/url.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createUrl } from "../src/node/url.js";

const url = createUrl();

test("re-exports the WHATWG URL / URLSearchParams", () => {
  assert.equal(url.URL, URL);
  assert.equal(url.URLSearchParams, URLSearchParams);
});

test("fileURLToPath / pathToFileURL round-trip (posix)", () => {
  assert.equal(url.fileURLToPath("file:///a/b/c.js"), "/a/b/c.js");
  assert.equal(url.fileURLToPath("file:///a/b%20c.txt"), "/a/b c.txt"); // percent-decoded
  assert.equal(url.pathToFileURL("/a/b/c.js").href, "file:///a/b/c.js");
  assert.equal(url.pathToFileURL("/a/b c.txt").href, "file:///a/b%20c.txt"); // encoded
  assert.equal(url.fileURLToPath(url.pathToFileURL("/x/y/z.mjs")), "/x/y/z.mjs");
});

test("fileURLToPath rejects non-file and non-local hosts", () => {
  assert.throws(() => url.fileURLToPath("http://x/y"), /scheme file/);
  assert.throws(() => url.fileURLToPath("file://remote/y"), /host/);
});

test("legacy parse of a full URL", () => {
  const u = url.parse("https://u:p@host.example:8080/a/b?x=1&y=2#frag");
  assert.equal(u.protocol, "https:");
  assert.equal(u.hostname, "host.example");
  assert.equal(u.port, "8080");
  assert.equal(u.auth, "u:p");
  assert.equal(u.pathname, "/a/b");
  assert.equal(u.search, "?x=1&y=2");
  assert.equal(u.hash, "#frag");
  assert.equal(u.slashes, true);
});

test("parse with parseQueryString, and a relative/path-only input", () => {
  const q = url.parse("/a/b?x=1&y=2", true);
  assert.deepEqual(q.query, { x: "1", y: "2" });
  assert.equal(q.pathname, "/a/b");
  assert.equal(q.protocol, null);
  assert.equal(q.host, null);
});

test("format is the inverse of parse for a normal URL", () => {
  const href = "https://host.example/a/b?x=1#f";
  assert.equal(url.format(url.parse(href)), href);
  assert.equal(url.format(new URL(href)), href);
});

test("resolve joins against an absolute base", () => {
  assert.equal(url.resolve("https://h/a/b", "../c"), "https://h/c");
  assert.equal(url.resolve("https://h/a/b", "/c"), "https://h/c");
});
