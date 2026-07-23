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

test("builtinModules includes module itself; isBuiltin and Module class", () => {
  const { mod } = makeModule({ "/x.js": "" });
  assert.ok(mod.builtinModules.includes("module"));
  assert.equal(mod.isBuiltin("node:fs"), true);
  assert.equal(mod.isBuiltin("leftpad"), false);
  // `Module` is a constructable class (Node's shape: Module.Module === Module),
  // carrying the static helpers used in the wild.
  assert.equal(typeof mod.Module, "function");
  assert.equal(mod.Module.Module, mod.Module);
  assert.equal(typeof mod.Module.createRequire, "function");
  assert.equal(typeof mod.Module._nodeModulePaths, "function");
});

test("new Module(file, parent) is constructable with require + paths (promzard)", () => {
  const { mod } = makeModule({
    "/proj/tpl.js": "",
    "/proj/node_modules/dep/index.js": "module.exports = 42;",
    "/proj/node_modules/dep/package.json": '{"name":"dep","version":"1.0.0","main":"index.js"}',
  });
  const m = new mod.Module("/proj/tpl.js", null);
  assert.equal(m.exports && typeof m.exports, "object");
  assert.deepEqual(m.paths, ["/proj/node_modules", "/node_modules"]);
  assert.equal(m.require("dep"), 42);
  assert.equal(mod.Module._resolveFilename("dep", m), "/proj/node_modules/dep/index.js");
});

test("loaded module has Node's parent/require/children/paths (module.parent.require idiom)", () => {
  // Next.js's dev server (and many CJS libs) reach for `module.parent.require(...)`.
  // Node always populates these on the `module` object; omitting `parent` broke
  // that with "Cannot read properties of undefined (reading 'require')".
  const { mod } = makeModule({
    "/proj/index.js": "module.exports = require('./dep');",
    "/proj/dep.js": `module.exports = {
      parentId: module.parent && module.parent.id,
      viaParentRequire: module.parent.require('path') === require('path'),
      requireIsFn: typeof module.require === 'function',
      childrenIsArray: Array.isArray(module.children),
      pathsIsArray: Array.isArray(module.paths),
    };`,
  });
  // index.js requires ./dep.js, so dep's parent is index (index's own parent is
  // null — createRequire has no owning module).
  const require = mod.createRequire("/proj/index.js");
  const dep = require("./index.js");
  assert.equal(dep.parentId, "/proj/index.js");
  assert.equal(dep.viaParentRequire, true);
  assert.equal(dep.requireIsFn, true);
  assert.equal(dep.childrenIsArray, true);
  assert.equal(dep.pathsIsArray, true);
});

test("the process main module has parent === null", () => {
  const { mod } = makeModule({
    "/app.js": "module.exports = { parent: module.parent, isNull: module.parent === null };",
  });
  const exp = mod._loadMain("/app.js");
  assert.equal(exp.isNull, true);
  assert.equal(mod.createRequire("/app.js").main.id, "."); // require.main is the entry
});

test("require('module') IS the Module constructor (Next.js require-hook shape)", () => {
  // Node: `require('module')` returns the Module function itself — so `.prototype`,
  // and thus `.prototype.require`, exist. Next.js's require-hook opens with
  // `const originalRequire = require('module').prototype.require`; when the builtin
  // was a plain namespace object, `.prototype` was undefined and that line threw
  // "Cannot read properties of undefined (reading 'require')".
  const { mod } = makeModule({ "/x.js": "" });
  assert.equal(typeof mod, "function");
  assert.equal(mod.Module, mod); // require('module').Module === require('module')
  assert.equal(typeof mod.prototype.require, "function");
  // Reproduce the require-hook access verbatim: it must not throw.
  assert.doesNotThrow(() => {
    const originalRequire = mod.prototype.require;
    const resolveFilename = mod._resolveFilename;
    void originalRequire;
    void resolveFilename;
  });
});

test("require.cache[id] is the real module object (require/parent/children), not a stub", () => {
  const { mod } = makeModule({
    "/proj/a.js": "require('./b'); module.exports = 1;",
    "/proj/b.js": "module.exports = 2;",
  });
  const require = mod.createRequire("/proj/index.js");
  require("./a.js");
  const entry = mod._cache["/proj/a.js"];
  assert.ok(entry, "loaded module is present in require.cache");
  // A tool reaching through require.cache (as many do) must find a usable module:
  // `.require` callable, `.children`/`.paths` arrays — not a bare { exports } stub.
  assert.equal(typeof entry.require, "function");
  assert.equal(entry.id, "/proj/a.js");
  assert.ok(Array.isArray(entry.children));
  assert.ok(Array.isArray(entry.paths));
  assert.equal(entry.require("./b.js"), 2); // require.cache[id].require(...) works
});
