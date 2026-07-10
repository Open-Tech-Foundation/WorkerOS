// Unit tests for the userland Node module resolver (src/node/resolve.js) — the
// logic that used to (wrongly) live in the kernel. Pure over a fake in-memory
// sync `fs` + the real `path`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, isBuiltinSpec, builtinKey } from "../src/node/resolve.js";
import { createPath } from "../src/node/path.js";

function fakeFs(files) {
  const dirs = new Set(["/"]);
  for (const p of Object.keys(files)) {
    let d = p.slice(0, p.lastIndexOf("/")) || "/";
    for (;;) {
      dirs.add(d);
      if (d === "/") break;
      d = d.slice(0, d.lastIndexOf("/")) || "/";
    }
  }
  const enoent = (p) => Object.assign(new Error("ENOENT " + p), { code: "ENOENT" });
  return {
    statSync(p) {
      if (p in files) return { isDirectory: () => false, isFile: () => true };
      if (dirs.has(p)) return { isDirectory: () => true, isFile: () => false };
      throw enoent(p);
    },
    readFileSync(p) {
      if (p in files) return files[p];
      throw enoent(p);
    },
  };
}

const mk = (files) => createResolver({ fs: fakeFs(files), path: createPath() });

test("builtin detection", () => {
  assert.equal(isBuiltinSpec("fs"), true);
  assert.equal(isBuiltinSpec("node:fs"), true);
  assert.equal(isBuiltinSpec("node:anything"), true); // node: is always a builtin
  assert.equal(isBuiltinSpec("lodash"), false);
  assert.equal(builtinKey("node:path"), "path");
  assert.equal(builtinKey("fs/promises"), "fs/promises");
  assert.equal(builtinKey("lodash"), null);
});

test("relative resolution with extension + index fallback", () => {
  const r = mk({
    "/proj/a.js": "",
    "/proj/lib/index.js": "",
    "/proj/data.json": "",
  });
  assert.equal(r.resolveFrom("/proj", "./a"), "/proj/a.js");
  assert.equal(r.resolveFrom("/proj", "./a.js"), "/proj/a.js");
  assert.equal(r.resolveFrom("/proj", "./lib"), "/proj/lib/index.js");
  assert.equal(r.resolveFrom("/proj", "./data.json"), "/proj/data.json");
  assert.equal(r.resolveFrom("/proj", "./nope"), null);
});

test("node_modules: main, and the walk up to an ancestor", () => {
  const r = mk({
    "/proj/node_modules/leftpad/package.json": '{"main":"lib/index.js"}',
    "/proj/node_modules/leftpad/lib/index.js": "",
  });
  assert.equal(r.resolveFrom("/proj/src/deep", "leftpad"), "/proj/node_modules/leftpad/lib/index.js");
});

test("exports conditions prefer import over require", () => {
  const r = mk({
    "/proj/node_modules/edgy/package.json":
      '{"exports":{".":{"require":"./cjs.js","import":"./esm.js"}}}',
    "/proj/node_modules/edgy/esm.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "edgy"), "/proj/node_modules/edgy/esm.js");
});

test("scoped subpath exports and ./* wildcard", () => {
  const r = mk({
    "/proj/node_modules/@scope/u/package.json":
      '{"exports":{"./str":"./build/str.js","./*":"./src/*.js"}}',
    "/proj/node_modules/@scope/u/build/str.js": "",
    "/proj/node_modules/@scope/u/src/math.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "@scope/u/str"), "/proj/node_modules/@scope/u/build/str.js");
  assert.equal(r.resolveFrom("/proj", "@scope/u/math"), "/proj/node_modules/@scope/u/src/math.js");
});

test("module field wins over main for ESM", () => {
  const r = mk({
    "/proj/node_modules/dual/package.json": '{"main":"cjs.js","module":"esm.js"}',
    "/proj/node_modules/dual/esm.js": "",
    "/proj/node_modules/dual/cjs.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "dual"), "/proj/node_modules/dual/esm.js");
});
