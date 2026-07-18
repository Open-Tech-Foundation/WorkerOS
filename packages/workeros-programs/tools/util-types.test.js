import { test } from "node:test";
import assert from "node:assert/strict";
import nodeTypes from "node:util/types";
import { types } from "../src/node/util.js";
import { makeBuiltins } from "../src/node/require-runtime.js";

test("exports the Node 22 util/types module shape", () => {
  // Pinned from the official Node v22.23.1 binary. Bun exposes the newer
  // `isEventTarget`, so its Object.keys() is not the target-version authority.
  const node22 = [
    "isAnyArrayBuffer", "isArgumentsObject", "isArrayBuffer", "isArrayBufferView",
    "isAsyncFunction", "isBigInt64Array", "isBigIntObject", "isBigUint64Array",
    "isBooleanObject", "isBoxedPrimitive", "isCryptoKey", "isDataView", "isDate",
    "isExternal", "isFloat16Array", "isFloat32Array", "isFloat64Array",
    "isGeneratorFunction", "isGeneratorObject", "isInt16Array", "isInt32Array",
    "isInt8Array", "isKeyObject", "isMap", "isMapIterator", "isModuleNamespaceObject",
    "isNativeError", "isNumberObject", "isPromise", "isProxy", "isRegExp", "isSet",
    "isSetIterator", "isSharedArrayBuffer", "isStringObject", "isSymbolObject",
    "isTypedArray", "isUint16Array", "isUint32Array", "isUint8Array",
    "isUint8ClampedArray", "isWeakMap", "isWeakSet",
  ];
  assert.deepEqual(Object.keys(types).sort(), node22.sort());
});

test("typed arrays and array-buffer views match Node", () => {
  const values = [
    new ArrayBuffer(4), new DataView(new ArrayBuffer(4)),
    new Uint8Array(2), new Uint8ClampedArray(2), new Uint16Array(2),
    new Uint32Array(2), new Int8Array(2), new Int16Array(2), new Int32Array(2),
    new Float32Array(2), new Float64Array(2), new BigInt64Array(2), new BigUint64Array(2),
  ];
  const predicates = Object.keys(nodeTypes).filter((name) => /Array|DataView/.test(name));
  for (const predicate of predicates) {
    for (const value of values) {
      assert.equal(types[predicate](value), nodeTypes[predicate](value), `${predicate}: ${value.constructor.name}`);
    }
  }
});

test("objects, iterators, functions, and boxed primitives match Node", async () => {
  function* generator() { yield 1; }
  async function asyncFn() {}
  const values = [
    new Date(), /x/, new Error("x"), Promise.resolve(1), new Map(), new Set(),
    new WeakMap(), new WeakSet(), new Map().keys(), new Set().values(),
    Object(1), Object("x"), Object(true), Object(1n), Object(Symbol("x")),
    generator, generator(), asyncFn,
  ];
  const predicates = [
    "isDate", "isRegExp", "isNativeError", "isPromise", "isMap", "isSet",
    "isWeakMap", "isWeakSet", "isMapIterator", "isSetIterator", "isNumberObject",
    "isStringObject", "isBooleanObject", "isBigIntObject", "isSymbolObject",
    "isBoxedPrimitive", "isGeneratorFunction", "isGeneratorObject", "isAsyncFunction",
  ];
  for (const predicate of predicates) {
    for (const value of values) {
      assert.equal(types[predicate](value), nodeTypes[predicate](value), predicate);
    }
  }
});

test("arguments and honest V8-only predicates", () => {
  const args = (function () { return arguments; })(1, 2);
  assert.equal(types.isArgumentsObject(args), true);
  assert.equal(types.isArgumentsObject([]), false);
  assert.equal(types.isExternal({}), false);
  assert.equal(types.isKeyObject({}), false);
  assert.equal(types.isProxy(new Proxy({}, {})), false);
});

test("builtin registry shares util.types with util/types", () => {
  const builtins = makeBuiltins({ syncFs: {} });
  assert.equal(builtins.get("util").types, types);
  assert.equal(builtins.get("util/types"), types);
});
