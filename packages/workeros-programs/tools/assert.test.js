import test from "node:test";
import assert from "node:assert/strict";
import realAssert from "node:assert";
import realStrict from "node:assert/strict";
import { assert as ours, strict as ourStrict } from "../src/node/assert.js";
import { createNodeRuntime } from "../src/node/require-runtime.js";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

function fakeSys() {
  const syncFs = createFakeSyncFs();
  return {
    syncFs,
    open: async (p, o = {}) => syncFs.open(p, o),
    read: async (fd, max) => syncFs.read(fd, max),
    close: async (fd) => syncFs.close(fd),
    stat: async (p) => syncFs.stat(p),
  };
}

test("module shape exposes assert and strict variants", () => {
  assert.equal(typeof ours, "function");
  assert.equal(typeof ourStrict, "function");
  assert.equal(ours.strict, ourStrict);
  assert.equal(ourStrict.strict, ourStrict);
  assert.equal(typeof ours.AssertionError, "function");
});

test("ok/equal/deepStrictEqual and strictEqual behave like host assert in common cases", () => {
  assert.doesNotThrow(() => ours.ok(true));
  assert.throws(() => ours.ok(false), { name: "AssertionError", code: "ERR_ASSERTION" });
  assert.doesNotThrow(() => ours.equal(1, "1"));
  assert.throws(() => ourStrict.equal(1, "1"), { name: "AssertionError", code: "ERR_ASSERTION" });
  assert.doesNotThrow(() => ours.deepStrictEqual({ a: [1, 2] }, { a: [1, 2] }));
  assert.throws(() => ours.deepStrictEqual({ a: 1 }, { a: "1" }), { operator: "deepStrictEqual" });
  assert.doesNotThrow(() => ours.match("abc", /b/));
  assert.throws(() => ours.doesNotMatch("abc", /b/), { operator: "doesNotMatch" });
});

test("throws/rejects and partialDeepStrictEqual work", async () => {
  const err = ours.throws(() => {
    throw new TypeError("boom");
  }, TypeError);
  assert.equal(err instanceof TypeError, true);

  await assert.doesNotReject(() => ours.rejects(async () => {
    throw Object.assign(new Error("bad"), { code: "E_BAD" });
  }, { code: "E_BAD" }));

  assert.doesNotThrow(() => ours.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 }));
  assert.throws(() => ours.partialDeepStrictEqual({ a: 1 }, { a: 2 }), { operator: "partialDeepStrictEqual" });
});

test("host module parity on exported keys we implement", () => {
  for (const key of ["ok", "equal", "strictEqual", "deepStrictEqual", "throws", "rejects", "match"]) {
    assert.equal(typeof ours[key], typeof realAssert[key], key);
  }
  assert.equal(typeof ourStrict.strictEqual, typeof realStrict.strictEqual);
});

test("guest require resolves assert and assert/strict as builtins", async () => {
  const sys = fakeSys();
  const main = [
    "const assert = require('assert');",
    "const strict = require('assert/strict');",
    "const fs = require('fs');",
    "assert.equal(1, '1');",
    "strict.deepStrictEqual({ a: [1, 2] }, { a: [1, 2] });",
    "fs.writeFileSync('/assert-ok', String(assert.strict === strict));",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  assert.equal(createFs(sys.syncFs).readFileSync("/assert-ok", "utf8"), "true");
});
