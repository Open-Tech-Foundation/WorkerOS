// Unit tests for the `node:module` builtin (src/node/module.js): a synchronous
// createRequire over an injected sync `fs`. Uses a tiny in-memory fake `fs` (the
// two sync methods createModule needs) plus the real `path`/`url` builtins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createModule } from "../src/node/module.js";
import { createPath } from "../src/node/path.js";
import { createUrl } from "../src/node/url.js";

// files: { absPath: contents }. Directories are inferred from the paths.
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
  const enoent = (p) => {
    const e = new Error(`ENOENT: ${p}`);
    e.code = "ENOENT";
    return e;
  };
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

function makeModule(files, extraBuiltins = {}) {
  const path = createPath();
  const url = createUrl();
  const builtins = new Map([
    ["path", path],
    ["fs", { __marker: "fs" }],
    ...Object.entries(extraBuiltins),
  ]);
  const fs = fakeFs(files);
  builtins.set("module", null); // pre-seed so builtinModules counts itself
  const mod = createModule({ fs, path, url, builtins });
  builtins.set("module", mod);
  return { mod, builtins, path };
}

test("createRequire loads a relative module and caches singletons", () => {
  const { mod } = makeModule({
    "/proj/index.js": "module.exports = require('./dep');",
    "/proj/dep.js": "module.exports = { n: (globalThis.__c = (globalThis.__c||0)+1) };",
  });
  const require = mod.createRequire("/proj/index.js");
  const a = require("./dep");
  const b = require("./dep");
  assert.equal(a.n, 1);
  assert.equal(b, a); // cached, not re-evaluated
});

test("require resolves node: builtins, package main, node_modules, and json", () => {
  const { mod, builtins } = makeModule({
    "/proj/app.js": "",
    "/proj/data.json": '{"hi": 5}',
    "/proj/node_modules/leftpad/package.json": '{"main": "./lib/index.js"}',
    "/proj/node_modules/leftpad/lib/index.js": "module.exports = 'padded';",
  });
  const require = mod.createRequire("/proj/app.js");
  assert.equal(require("path"), builtins.get("path"));
  assert.equal(require("node:path"), builtins.get("path"));
  assert.equal(require("fs").__marker, "fs");
  assert.deepEqual(require("./data.json"), { hi: 5 });
  assert.equal(require("leftpad"), "padded");
});

test("require.resolve and MODULE_NOT_FOUND", () => {
  const { mod } = makeModule({ "/proj/app.js": "", "/proj/dep.js": "" });
  const require = mod.createRequire("/proj/app.js");
  assert.equal(require.resolve("./dep"), "/proj/dep.js");
  assert.equal(require.resolve("fs"), "fs");
  assert.throws(() => require("./nope"), { code: "MODULE_NOT_FOUND" });
  assert.throws(() => require.resolve("./nope"), { code: "MODULE_NOT_FOUND" });
});

test("createRequire accepts a file: URL (import.meta.url shape)", () => {
  const { mod } = makeModule({
    "/proj/a.js": "module.exports = require('./b');",
    "/proj/b.js": "module.exports = 42;",
  });
  const require = mod.createRequire("file:///proj/a.js");
  assert.equal(require("./b"), 42);
});

test("builtinModules includes module itself; isBuiltin and Module self-ref", () => {
  const { mod } = makeModule({ "/x.js": "" });
  assert.ok(mod.builtinModules.includes("module"));
  assert.equal(mod.isBuiltin("node:fs"), true);
  assert.equal(mod.isBuiltin("leftpad"), false);
  assert.equal(mod.Module, mod);
  assert.equal(typeof mod.Module.createRequire, "function");
});
