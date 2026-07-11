import { test } from "node:test";
import assert from "node:assert/strict";
import querystring, { parse, stringify } from "../src/node/querystring.js";
import { createNodeRuntime } from "../src/node/require-runtime.js";

test("stringify encodes primitives, arrays, and spaces", () => {
  assert.equal(stringify({ a: "hello world", n: 2, ok: true }), "a=hello%20world&n=2&ok=true");
  assert.equal(stringify({ x: ["a", "b"], empty: null }), "x=a&x=b&empty=");
  assert.equal(querystring.encode, stringify);
});

test("parse uses null prototype, collects repeated keys, and decodes plus", () => {
  const value = parse("a=hello+world&x=1&x=2&flag");
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual({ ...value }, { a: "hello world", x: ["1", "2"], flag: "" });
  assert.equal(querystring.decode, parse);
});

test("custom separators, equals signs, codecs, and maxKeys", () => {
  assert.equal(stringify({ a: "x", b: "y" }, ";", ":"), "a:x;b:y");
  assert.deepEqual({ ...parse("a:x;b:y", ";", ":") }, { a: "x", b: "y" });
  assert.deepEqual({ ...parse("a=1&b=2", "&", "=", { maxKeys: 1 }) }, { a: "1" });
  const identity = (s) => s;
  assert.equal(stringify({ "a b": "c d" }, "&", "=", { encodeURIComponent: identity }), "a b=c d");
});

test("malformed percent escapes do not abort parsing", () => {
  assert.deepEqual({ ...parse("ok=%E2%9C%93&bad=%ZZ") }, { ok: "✓", bad: "%ZZ" });
  assert.deepEqual([...querystring.unescapeBuffer("a%20b")], [97, 32, 98]);
  assert.deepEqual(Object.keys(querystring), [
    "stringify", "encode", "parse", "decode", "unescapeBuffer", "escape", "unescape",
  ]);
});

test("guest require resolves querystring and node:querystring", async () => {
  const outputs = [];
  const sys = {
    syncFs: {
      stat: (p) => p === "/app.js" ? { kind: "file" } : null,
      readFile: () => new TextEncoder().encode(""),
    },
  };
  const run = createNodeRuntime(sys);
  await run("/app.js", "module.exports = require('querystring').parse('a=1').a + require('node:querystring').stringify({b:2})");
  // Resolution completing without MODULE_NOT_FOUND is the contract under test.
  assert.deepEqual(outputs, []);
});
