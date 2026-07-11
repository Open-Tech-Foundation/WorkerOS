// `node:assert` / `node:assert/strict` — assertion helpers for the guest runtime.
//
// GUEST code (INV-1): this is a pragmatic Node-compatible surface over the
// existing deep-equality helper in `util.js`. It covers the assertion methods
// packages and tests commonly import directly, plus the `strict` variant.

import { isDeepStrictEqual } from "./util.js";

function stringify(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class AssertionError extends Error {
  constructor({ message, actual, expected, operator, generatedMessage } = {}) {
    super(message || `Expected values to be strictly ${operator || "equal"}`);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    this.generatedMessage = !!generatedMessage;
  }
}

function failAssertion({ actual, expected, message, operator, generatedMessage }) {
  throw new AssertionError({ actual, expected, message, operator, generatedMessage });
}

const isRegExp = (v) => v instanceof RegExp;

function equalLoose(a, b) {
  // eslint-disable-next-line eqeqeq
  return a == b;
}

function partialDeepStrictEqual(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (typeof expected !== "object" || expected === null) return isDeepStrictEqual(actual, expected);
  if (typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    for (let i = 0; i < expected.length; i++) if (!partialDeepStrictEqual(actual[i], expected[i])) return false;
    return true;
  }
  for (const key of Reflect.ownKeys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return false;
    if (!partialDeepStrictEqual(actual[key], expected[key])) return false;
  }
  return true;
}

function validateThrown(err, expected, message) {
  if (expected == null) return true;
  if (typeof expected === "function" && expected.prototype instanceof Error) return err instanceof expected;
  if (typeof expected === "function") return expected(err) === true;
  if (isRegExp(expected)) return expected.test(String(err && err.message));
  if (expected && typeof expected === "object") {
    // An object validator: every own property must match the thrown error. Node's
    // one wrinkle — a RegExp *property value* is `.test()`ed against the actual
    // (stringified) property, not deep-compared (e.g. `{ message: /"buffer"/ }`).
    return Object.keys(expected).every((k) =>
      isRegExp(expected[k]) ? expected[k].test(String(err?.[k])) : isDeepStrictEqual(err?.[k], expected[k]));
  }
  failAssertion({ actual: err, expected, message, operator: "throws", generatedMessage: !message });
}

async function getRejection(block) {
  try {
    const p = typeof block === "function" ? block() : block;
    await p;
    return { rejected: false };
  } catch (err) {
    return { rejected: true, err };
  }
}

function makeAssert(strictMode) {
  function assert(value, message) {
    if (!value) failAssertion({ actual: value, expected: true, message, operator: "==", generatedMessage: !message });
  }

  assert.ok = assert;
  assert.fail = (actual, expected, message, operator) => {
    if (expected === undefined && message === undefined && operator === undefined) {
      failAssertion({ actual, expected: undefined, message: actual, operator: "fail", generatedMessage: false });
    }
    failAssertion({ actual, expected, message, operator: operator || "fail", generatedMessage: !message });
  };
  assert.equal = (actual, expected, message) => {
    const pass = strictMode ? Object.is(actual, expected) : equalLoose(actual, expected);
    if (!pass) failAssertion({
      actual,
      expected,
      message,
      operator: strictMode ? "strictEqual" : "==",
      generatedMessage: !message,
    });
  };
  assert.notEqual = (actual, expected, message) => {
    const pass = strictMode ? !Object.is(actual, expected) : !equalLoose(actual, expected);
    if (!pass) failAssertion({
      actual,
      expected,
      message,
      operator: strictMode ? "notStrictEqual" : "!=",
      generatedMessage: !message,
    });
  };
  assert.strictEqual = (actual, expected, message) => {
    if (!Object.is(actual, expected)) {
      failAssertion({ actual, expected, message, operator: "strictEqual", generatedMessage: !message });
    }
  };
  assert.notStrictEqual = (actual, expected, message) => {
    if (Object.is(actual, expected)) {
      failAssertion({ actual, expected, message, operator: "notStrictEqual", generatedMessage: !message });
    }
  };
  assert.deepEqual = (actual, expected, message) => {
    const pass = strictMode ? isDeepStrictEqual(actual, expected) : stringify(actual) === stringify(expected);
    if (!pass) failAssertion({
      actual,
      expected,
      message,
      operator: strictMode ? "deepStrictEqual" : "deepEqual",
      generatedMessage: !message,
    });
  };
  assert.notDeepEqual = (actual, expected, message) => {
    const pass = strictMode ? !isDeepStrictEqual(actual, expected) : stringify(actual) !== stringify(expected);
    if (!pass) failAssertion({
      actual,
      expected,
      message,
      operator: strictMode ? "notDeepStrictEqual" : "notDeepEqual",
      generatedMessage: !message,
    });
  };
  assert.deepStrictEqual = (actual, expected, message) => {
    if (!isDeepStrictEqual(actual, expected)) {
      failAssertion({ actual, expected, message, operator: "deepStrictEqual", generatedMessage: !message });
    }
  };
  assert.notDeepStrictEqual = (actual, expected, message) => {
    if (isDeepStrictEqual(actual, expected)) {
      failAssertion({ actual, expected, message, operator: "notDeepStrictEqual", generatedMessage: !message });
    }
  };
  assert.partialDeepStrictEqual = (actual, expected, message) => {
    if (!partialDeepStrictEqual(actual, expected)) {
      failAssertion({ actual, expected, message, operator: "partialDeepStrictEqual", generatedMessage: !message });
    }
  };
  assert.match = (string, regexp, message) => {
    if (!isRegExp(regexp) || !regexp.test(String(string))) {
      failAssertion({ actual: string, expected: regexp, message, operator: "match", generatedMessage: !message });
    }
  };
  assert.doesNotMatch = (string, regexp, message) => {
    if (!isRegExp(regexp) || regexp.test(String(string))) {
      failAssertion({ actual: string, expected: regexp, message, operator: "doesNotMatch", generatedMessage: !message });
    }
  };
  assert.throws = (block, expected, message) => {
    try {
      block();
    } catch (err) {
      if (!validateThrown(err, expected, message)) {
        failAssertion({ actual: err, expected, message, operator: "throws", generatedMessage: !message });
      }
      return err;
    }
    failAssertion({ actual: undefined, expected, message, operator: "throws", generatedMessage: !message });
  };
  assert.doesNotThrow = (block, expected, message) => {
    try {
      block();
    } catch (err) {
      failAssertion({ actual: err, expected, message, operator: "doesNotThrow", generatedMessage: !message });
    }
  };
  assert.rejects = async (block, expected, message) => {
    const res = await getRejection(block);
    if (!res.rejected) {
      failAssertion({ actual: undefined, expected, message, operator: "rejects", generatedMessage: !message });
    }
    if (!validateThrown(res.err, expected, message)) {
      failAssertion({ actual: res.err, expected, message, operator: "rejects", generatedMessage: !message });
    }
    return res.err;
  };
  assert.doesNotReject = async (block, expected, message) => {
    const res = await getRejection(block);
    if (res.rejected) {
      failAssertion({ actual: res.err, expected, message, operator: "doesNotReject", generatedMessage: !message });
    }
  };
  assert.ifError = (err) => {
    if (err) failAssertion({ actual: err, expected: null, message: err.message, operator: "ifError", generatedMessage: false });
  };
  assert.AssertionError = AssertionError;
  assert.CallTracker = class CallTracker {};
  return assert;
}

const strict = makeAssert(true);
const assertModule = makeAssert(false);
assertModule.strict = strict;
assertModule.default = assertModule;
strict.strict = strict;
strict.default = strict;

export { assertModule as assert, strict };
export default assertModule;
