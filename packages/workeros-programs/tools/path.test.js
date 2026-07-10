// Unit tests for the posix `node:path` builtin (src/node/path.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPath } from "../src/node/path.js";

const path = createPath();

test("isAbsolute", () => {
  assert.equal(path.isAbsolute("/a/b"), true);
  assert.equal(path.isAbsolute("a/b"), false);
});

test("join normalizes and drops empties", () => {
  assert.equal(path.join("/a", "b", "c"), "/a/b/c");
  assert.equal(path.join("/a/", "/b/", "./c"), "/a/b/c");
  assert.equal(path.join("a", "..", "b"), "b");
  assert.equal(path.join(), ".");
});

test("resolve is right-to-left until absolute", () => {
  assert.equal(path.resolve("/a/b", "c"), "/a/b/c");
  assert.equal(path.resolve("/a/b", "/c/d"), "/c/d");
  assert.equal(path.resolve("a", "b"), "a/b");
  assert.equal(path.resolve("/a/b", "../c"), "/a/c");
});

test("dirname / basename / extname", () => {
  assert.equal(path.dirname("/a/b/c.js"), "/a/b");
  assert.equal(path.dirname("/a"), "/");
  assert.equal(path.dirname("a"), ".");
  assert.equal(path.basename("/a/b/c.js"), "c.js");
  assert.equal(path.basename("/a/b/c.js", ".js"), "c");
  assert.equal(path.extname("/a/b/c.js"), ".js");
  assert.equal(path.extname("/a/b/c"), "");
  assert.equal(path.extname("/a/.hidden"), "");
});

test("normalize collapses . and ..", () => {
  assert.equal(path.normalize("/a/./b/../c"), "/a/c");
  assert.equal(path.normalize("a/b/../../c"), "c");
  assert.equal(path.normalize("/a/b/"), "/a/b/");
});

test("relative", () => {
  assert.equal(path.relative("/a/b/c", "/a/b/d"), "../d");
  assert.equal(path.relative("/a/b", "/a/b/c/d"), "c/d");
});

test("parse / format round-trip", () => {
  const p = path.parse("/a/b/c.js");
  assert.equal(p.dir, "/a/b");
  assert.equal(p.base, "c.js");
  assert.equal(p.ext, ".js");
  assert.equal(p.name, "c");
  assert.equal(path.format({ dir: "/a/b", base: "c.js" }), "/a/b/c.js");
});

test("sep and posix self-reference", () => {
  assert.equal(path.sep, "/");
  assert.equal(path.posix, path);
});
