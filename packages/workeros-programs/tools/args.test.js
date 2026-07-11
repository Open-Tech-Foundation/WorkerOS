import { test } from "node:test";
import assert from "node:assert/strict";

import { ArgError, collectSimpleFlags, hasFlag, tokenizeArgv } from "../src/cli/args.js";

test("tokenizeArgv handles POSIX/GNU options and --", () => {
  const tokens = tokenizeArgv(
    ["-czf", "out.tgz", "--verbose", "src", "--", "--literal"],
    { shortValue: new Set(["f"]) },
  );
  assert.deepEqual(tokens, [
    { kind: "option", raw: "-c", name: "c", short: "c", long: false },
    { kind: "option", raw: "-z", name: "z", short: "z", long: false },
    { kind: "option", raw: "-czf", name: "f", short: "f", value: "out.tgz", long: false },
    { kind: "option", raw: "--verbose", name: "verbose", value: undefined, long: true },
    { kind: "operand", value: "src", raw: "src" },
    { kind: "terminator", raw: "--" },
    { kind: "operand", value: "--literal", raw: "--literal" },
  ]);
});

test("tokenizeArgv supports first bare tar-style cluster and stopAtFirstOperand", () => {
  const tokens = tokenizeArgv(
    ["czf", "out.tgz", "src", "--watch"],
    { shortValue: new Set(["f"]), firstTokenGroupedShort: true, stopAtFirstOperand: true },
  );
  assert.deepEqual(tokens, [
    { kind: "option", raw: "-c", name: "c", short: "c", long: false },
    { kind: "option", raw: "-z", name: "z", short: "z", long: false },
    { kind: "option", raw: "-czf", name: "f", short: "f", value: "out.tgz", long: false },
    { kind: "operand", value: "src", raw: "src" },
    { kind: "operand", value: "--watch", raw: "--watch" },
  ]);
});

test("tokenizeArgv throws on missing option values", () => {
  assert.throws(
    () => tokenizeArgv(["-o"], { shortValue: new Set(["o"]) }),
    (err) => err instanceof ArgError && err.message === "option -o requires an argument",
  );
  assert.throws(
    () => tokenizeArgv(["--output"], { longValue: new Set(["output"]) }),
    (err) => err instanceof ArgError && err.message === "option --output requires an argument",
  );
});

test("collectSimpleFlags preserves grouped shorts, long flags, and operands", () => {
  const parsed = collectSimpleFlags(["-al", "--recursive", "dir", "--", "--literal"]);
  assert.equal(hasFlag(parsed, "-a"), true);
  assert.equal(hasFlag(parsed, "-l"), true);
  assert.equal(hasFlag(parsed, "--recursive"), true);
  assert.deepEqual(parsed.operands, ["dir", "--literal"]);
});
