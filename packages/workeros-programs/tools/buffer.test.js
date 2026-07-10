// Unit tests for the userland `node:buffer` (src/node/buffer.js). Cross-checked
// against Node's own global Buffer where the surfaces should agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer as B, buffer as bufferModule, constants } from "../src/node/buffer.js";
const NodeBuffer = globalThis.Buffer; // the runtime's real Buffer, for oracle checks

test("is a Uint8Array subclass and reports as a Buffer", () => {
  const b = B.from([1, 2, 3]);
  assert.ok(b instanceof Uint8Array);
  assert.ok(B.isBuffer(b));
  assert.equal(B.isBuffer(new Uint8Array(3)), false);
});

test("from(string) round-trips through every encoding like Node", () => {
  for (const enc of ["utf8", "utf16le", "latin1", "ascii", "hex", "base64", "base64url"]) {
    const src = enc === "hex" ? "deadbeef" : enc === "ascii" ? "hello world" : "hi ☃";
    const mine = B.from(src, enc).toString(enc);
    const node = NodeBuffer.from(src, enc === "base64url" ? "base64url" : enc).toString(enc);
    assert.equal(mine, node, `encoding ${enc}`);
  }
});

test("utf8 <-> bytes matches Node", () => {
  const s = "café ☕ #node";
  assert.deepEqual([...B.from(s, "utf8")], [...NodeBuffer.from(s, "utf8")]);
  assert.equal(B.from(s).toString(), s);
  assert.equal(B.byteLength(s), NodeBuffer.byteLength(s));
});

test("hex and base64/base64url match Node", () => {
  const bytes = [0, 1, 2, 250, 251, 255];
  assert.equal(B.from(bytes).toString("hex"), NodeBuffer.from(bytes).toString("hex"));
  assert.equal(B.from(bytes).toString("base64"), NodeBuffer.from(bytes).toString("base64"));
  assert.equal(B.from(bytes).toString("base64url"), NodeBuffer.from(bytes).toString("base64url"));
  // decode is lenient about url-safe + missing padding
  assert.deepEqual([...B.from("_-8", "base64")], [...NodeBuffer.from("_-8", "base64")]);
});

test("alloc / allocUnsafe / fill", () => {
  assert.deepEqual([...B.alloc(4)], [0, 0, 0, 0]);
  assert.deepEqual([...B.alloc(3, 7)], [7, 7, 7]);
  assert.deepEqual([...B.alloc(4, "ab")], [...NodeBuffer.alloc(4, "ab")]);
  assert.equal(B.allocUnsafe(5).length, 5);
  assert.deepEqual([...B.from([1, 1, 1, 1]).fill(9, 1, 3)], [1, 9, 9, 1]);
});

test("slice shares memory (Node semantics, not Uint8Array copy)", () => {
  const b = B.from([1, 2, 3, 4]);
  const s = b.slice(1, 3);
  assert.ok(s instanceof B);
  s[0] = 99;
  assert.equal(b[1], 99, "mutation is visible through the parent buffer");
});

test("concat, compare, equals, copy, indexOf/includes", () => {
  assert.deepEqual([...B.concat([B.from([1, 2]), B.from([3])])], [1, 2, 3]);
  assert.deepEqual([...B.concat([B.from([1, 2]), B.from([3, 4])], 3)], [1, 2, 3]);
  assert.equal(B.from("abc").equals(B.from("abc")), true);
  assert.equal(B.from("abc").equals(B.from("abd")), false);
  assert.equal(B.compare(B.from("abc"), B.from("abd")), -1);
  const dst = B.alloc(4);
  assert.equal(B.from([5, 6, 7]).copy(dst, 1), 3);
  assert.deepEqual([...dst], [0, 5, 6, 7]);
  assert.equal(B.from("hello world").indexOf("world"), 6);
  assert.equal(B.from("hello").includes("ell"), true);
  assert.equal(B.from("hello").indexOf("z"), -1);
});

test("numeric accessors agree with Node across widths/endianness", () => {
  const mine = B.alloc(8);
  const node = NodeBuffer.alloc(8);
  for (const w of ["UInt16LE", "UInt16BE", "Int32LE", "Int32BE", "FloatLE", "DoubleBE"]) {
    const v = w.startsWith("Float") || w.startsWith("Double") ? 3.5 : 0x1234;
    mine[`write${w}`](v, 0);
    node[`write${w}`](v, 0);
    assert.deepEqual([...mine], [...node], `write${w}`);
    assert.equal(mine[`read${w}`](0), node[`read${w}`](0), `read${w}`);
  }
});

test("BigInt64 + lowercase Uint aliases work", () => {
  const b = B.alloc(8);
  b.writeBigUInt64LE(0x0102030405060708n, 0);
  assert.equal(b.readBigUInt64LE(0), 0x0102030405060708n);
  assert.equal(typeof b.writeBigUint64LE, "function"); // Node's lowercase alias
  assert.equal(b.readBigUint64LE(0), b.readBigUInt64LE(0));
});

test("variable-width readUIntLE/BE + signed", () => {
  const b = B.from([0x12, 0x34, 0x56]);
  assert.equal(b.readUIntBE(0, 3), 0x123456);
  assert.equal(b.readUIntLE(0, 3), 0x563412);
  assert.equal(B.from([0xff]).readIntLE(0, 1), -1);
});

test("toJSON round-trips through from()", () => {
  const b = B.from([1, 2, 3]);
  const json = b.toJSON();
  assert.deepEqual(json, { type: "Buffer", data: [1, 2, 3] });
  assert.deepEqual([...B.from(json)], [1, 2, 3]);
});

test("module surface: byteLength, isEncoding, constants", () => {
  assert.equal(B.isEncoding("utf8"), true);
  assert.equal(B.isEncoding("utf-99"), false);
  assert.equal(bufferModule.Buffer, B);
  assert.equal(constants.MAX_LENGTH, 0x7fffffff);
});
