// Unit tests for the userland `node:util` (src/node/util.js), cross-checked
// against Node's real util where the surfaces should agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeUtil from "node:util";
import util, {
  inspect, format, promisify, callbackify, inherits, deprecate,
  isDeepStrictEqual, types, styleText,
} from "../src/node/util.js";

test("format handles the standard specifiers like Node", () => {
  const cases = [
    ["%s world", "hi"],
    ["%d + %d", 2, 3],
    ["%j", { a: 1 }],
    ["%s and %s", "a", "b", "c"], // extra arg appended
    ["100%% done"],
    ["no spec", 1, 2],
  ];
  for (const [fmt, ...args] of cases) {
    assert.equal(format(fmt, ...args), nodeUtil.format(fmt, ...args), JSON.stringify(fmt));
  }
});

test("inspect: primitives, quoting, and -0", () => {
  assert.equal(inspect("hi"), "'hi'");
  assert.equal(inspect(42), "42");
  assert.equal(inspect(-0), "-0");
  assert.equal(inspect(10n), "10n");
  assert.equal(inspect(null), "null");
  assert.equal(inspect(undefined), "undefined");
  assert.equal(inspect(Symbol("s")), "Symbol(s)");
});

test("inspect: arrays and plain objects", () => {
  assert.equal(inspect([1, 2, 3]), "[ 1, 2, 3 ]");
  assert.equal(inspect({ a: 1, b: "x" }), "{ a: 1, b: 'x' }");
  assert.equal(inspect({}), "{}");
  assert.equal(inspect([]), "[]");
});

test("inspect: Map, Set, Date, RegExp", () => {
  assert.equal(inspect(new Set([1, 2])), "Set(2) { 1, 2 }");
  assert.equal(inspect(new Map([["k", 1]])), "Map(1) { 'k' => 1 }");
  assert.equal(inspect(/ab+c/gi), "/ab+c/gi");
  const d = new Date("2020-01-01T00:00:00.000Z");
  assert.equal(inspect(d), "2020-01-01T00:00:00.000Z");
});

test("inspect: depth limit and circular references", () => {
  assert.equal(inspect({ a: { b: { c: { d: 1 } } } }), "{ a: { b: { c: [Object] } } }");
  const o = { name: "x" };
  o.self = o;
  assert.match(inspect(o), /\[Circular/);
});

test("inspect: honors a custom inspect symbol (as Buffer uses)", () => {
  const obj = { [inspect.custom]: () => "<custom>" };
  assert.equal(inspect(obj), "<custom>");
});

test("promisify turns a node-callback fn into a promise", async () => {
  const cb = (x, done) => done(null, x * 2);
  assert.equal(await promisify(cb)(21), 42);
  const failing = (done) => done(new Error("bad"));
  await assert.rejects(promisify(failing)(), /bad/);
});

test("promisify honors the custom symbol", async () => {
  function fn() {}
  fn[promisify.custom] = async () => "custom-result";
  assert.equal(await promisify(fn)(), "custom-result");
});

test("callbackify turns a promise-returning fn into a node-callback fn", async () => {
  const fn = callbackify(async (x) => x + 1);
  const result = await new Promise((resolve, reject) =>
    fn(41, (err, v) => (err ? reject(err) : resolve(v))),
  );
  assert.equal(result, 42);
});

test("inherits wires up the prototype chain and super_", () => {
  function Base() {}
  Base.prototype.hello = () => "hi";
  function Derived() {}
  inherits(Derived, Base);
  assert.equal(Derived.super_, Base);
  assert.equal(new Derived().hello(), "hi");
});

test("isDeepStrictEqual matches Node", () => {
  assert.equal(isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(isDeepStrictEqual({ a: 1 }, { a: "1" }), false);
  assert.equal(isDeepStrictEqual(new Map([["k", 1]]), new Map([["k", 1]])), true);
  assert.equal(nodeUtil.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), true);
});

test("types.* predicates", () => {
  assert.equal(types.isDate(new Date()), true);
  assert.equal(types.isRegExp(/x/), true);
  assert.equal(types.isPromise(Promise.resolve()), true);
  assert.equal(types.isTypedArray(new Uint8Array(1)), true);
  assert.equal(types.isTypedArray(new DataView(new ArrayBuffer(1))), false);
  assert.equal(types.isMap(new Map()), true);
});

test("deprecate warns once then delegates", () => {
  let calls = 0;
  const orig = globalThis.process?.emitWarning;
  if (globalThis.process) globalThis.process.emitWarning = () => { calls++; };
  const fn = deprecate((x) => x + 1, "old");
  assert.equal(fn(1), 2);
  assert.equal(fn(2), 3);
  assert.equal(calls <= 1, true);
  if (globalThis.process) globalThis.process.emitWarning = orig;
});

test("legacy is* predicates + module shape", () => {
  assert.equal(util.isString("x"), true);
  assert.equal(util.isNullOrUndefined(null), true);
  assert.equal(util.isFunction(() => {}), true);
  assert.equal(util.TextEncoder, globalThis.TextEncoder);
});

test("styleText wraps text in ANSI SGR codes (create-vite's colored prompts)", () => {
  // Cross-check the code table and the composed open/close ordering against Node's
  // real util.styleText, applying colors unconditionally (validateStream:false).
  assert.equal(styleText("red", "x"), nodeUtil.styleText("red", "x", { validateStream: false }));
  assert.equal(
    styleText(["bold", "cyan"], "hi"),
    nodeUtil.styleText(["bold", "cyan"], "hi", { validateStream: false }),
  );
  assert.equal(styleText("red", "x"), "\x1b[31mx\x1b[39m");
  assert.equal(styleText(["bold", "underline"], "hi"), "\x1b[1m\x1b[4mhi\x1b[24m\x1b[22m");
  // 'none' is the documented no-op; it's also exposed on the module surface.
  assert.equal(styleText("none", "plain"), "plain");
  assert.equal(util.styleText, styleText);
});

test("styleText validates its arguments like Node", () => {
  assert.throws(() => styleText("nosuchcolor", "x"), { code: "ERR_INVALID_ARG_VALUE" });
  assert.throws(() => styleText("red", 42), { code: "ERR_INVALID_ARG_TYPE" });
});
