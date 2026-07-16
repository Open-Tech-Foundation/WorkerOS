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

const mk = (files, conditions) =>
  createResolver({ fs: fakeFs(files), path: createPath(), conditions });

test("builtin detection", () => {
  assert.equal(isBuiltinSpec("fs"), true);
  assert.equal(isBuiltinSpec("node:fs"), true);
  assert.equal(isBuiltinSpec("node:anything"), true); // node: is always a builtin
  assert.equal(isBuiltinSpec("lodash"), false);
  // process/tty are builtins too (chalk's supports-color imports node:process,
  // node:tty) — bare and node: forms both.
  assert.equal(isBuiltinSpec("process"), true);
  assert.equal(isBuiltinSpec("tty"), true);
  assert.equal(builtinKey("node:process"), "process");
  assert.equal(builtinKey("node:tty"), "tty");
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

// A `file:` URL is a legal ESM specifier. Vite bundles vite.config.js into
// node_modules/.vite-temp/ and has the output import Vite back by absolute
// file:// URL — treating that as a bare specifier looked for a package named
// "file:" and failed the whole dev server ("Cannot find module 'file:///…'").
test("file: URL specifiers resolve to the path they name", () => {
  const r = mk({
    "/proj/node_modules/vite/dist/node/index.js": "",
    "/proj/a b.js": "",
  });
  assert.equal(
    r.resolveFrom("/proj/node_modules/.vite-temp", "file:///proj/node_modules/vite/dist/node/index.js"),
    "/proj/node_modules/vite/dist/node/index.js",
  );
  // The `fromDir` is irrelevant — a file: URL is absolute.
  assert.equal(r.resolveFrom("/elsewhere", "file:///proj/a%20b.js"), "/proj/a b.js");
  // A cache-busting query/hash is routine on these generated imports.
  assert.equal(r.resolveFrom("/proj", "file:///proj/a%20b.js?t=1700000000"), "/proj/a b.js");
  assert.equal(r.resolveFrom("/proj", "file:///proj/a%20b.js#frag"), "/proj/a b.js");
  // RFC 8089: an empty or "localhost" authority is the local machine.
  assert.equal(r.resolveFrom("/proj", "file://localhost/proj/a%20b.js"), "/proj/a b.js");
  // A file: URL naming nothing still resolves to nothing (not a throw).
  assert.equal(r.resolveFrom("/proj", "file:///proj/missing.js"), null);
  // Not ours to resolve: another host, another scheme, a bad escape.
  assert.equal(r.resolveFrom("/proj", "file://example.com/proj/a%20b.js"), null);
  assert.equal(r.resolveFrom("/proj", "file:///proj/a%ZZ.js"), null);
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

test("package #imports: chalk-style subpath imports with conditions and wildcard", () => {
  // Mirrors chalk v5: a bare `exports` string plus `#`-prefixed internal imports,
  // one of which is a conditions map (node vs default/browser).
  const r = mk({
    "/proj/node_modules/chalk/package.json": JSON.stringify({
      exports: "./source/index.js",
      imports: {
        "#ansi-styles": "./source/vendor/ansi-styles/index.js",
        "#supports-color": {
          node: "./source/vendor/supports-color/index.js",
          default: "./source/vendor/supports-color/browser.js",
        },
        "#util/*": "./source/util/*.js",
      },
    }),
    "/proj/node_modules/chalk/source/index.js": "",
    "/proj/node_modules/chalk/source/vendor/ansi-styles/index.js": "",
    "/proj/node_modules/chalk/source/vendor/supports-color/index.js": "",
    "/proj/node_modules/chalk/source/vendor/supports-color/browser.js": "",
    "/proj/node_modules/chalk/source/util/fmt.js": "",
  });
  const src = "/proj/node_modules/chalk/source";
  // The entry resolves as a bare package (regression guard for the exports string).
  assert.equal(r.resolveFrom("/proj", "chalk"), src + "/index.js");
  assert.equal(r.resolveImports(src, "#ansi-styles"), src + "/vendor/ansi-styles/index.js");
  // node wins over default/browser — the runtime presents as Node.
  assert.equal(r.resolveImports(src, "#supports-color"), src + "/vendor/supports-color/index.js");
  assert.equal(r.resolveImports(src, "#util/fmt"), src + "/util/fmt.js");
  // A `#` spec with no matching key in the enclosing package is unresolved.
  assert.equal(r.resolveImports(src, "#nope"), null);
});

test("conditions honor the caller: require gets the CJS target, import the ESM one", () => {
  // A dual package. The resolver is condition-aware: an `import` caller (default)
  // takes ./esm.js, a `require` caller takes ./cjs.js — the split Node makes.
  const files = {
    "/proj/node_modules/dual/package.json":
      '{"exports":{".":{"import":"./esm.js","require":"./cjs.js"}}}',
    "/proj/node_modules/dual/esm.js": "",
    "/proj/node_modules/dual/cjs.js": "",
  };
  assert.equal(mk(files).resolveFrom("/proj", "dual"), "/proj/node_modules/dual/esm.js");
  assert.equal(
    mk(files, ["node", "require"]).resolveFrom("/proj", "dual"),
    "/proj/node_modules/dual/cjs.js",
  );
});

test("conditions match in package.json key order (not a fixed priority)", () => {
  // `default` appears before `node`; declaration order wins, so `default` is taken
  // even though a naive resolver might prefer the more specific `node`.
  const r = mk({
    "/proj/node_modules/ord/package.json":
      '{"exports":{".":{"default":"./d.js","node":"./n.js"}}}',
    "/proj/node_modules/ord/d.js": "",
    "/proj/node_modules/ord/n.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "ord"), "/proj/node_modules/ord/d.js");
});

test("a string `exports` seals the package: subpaths are not exported", () => {
  // Node: a string (or bare-conditions) exports exposes only ".". A subpath request
  // must NOT fall through to a plain file — the package is encapsulated.
  const r = mk({
    "/proj/node_modules/sealed/package.json": '{"exports":"./index.js"}',
    "/proj/node_modules/sealed/index.js": "",
    "/proj/node_modules/sealed/internal.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "sealed"), "/proj/node_modules/sealed/index.js");
  assert.equal(r.resolveFrom("/proj", "sealed/internal"), null);
  assert.equal(r.resolveFrom("/proj", "sealed/internal.js"), null);
});

test("a null exports target blocks a subpath", () => {
  const r = mk({
    "/proj/node_modules/blk/package.json":
      '{"exports":{"./ok":"./ok.js","./secret":null}}',
    "/proj/node_modules/blk/ok.js": "",
    "/proj/node_modules/blk/secret.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "blk/ok"), "/proj/node_modules/blk/ok.js");
  assert.equal(r.resolveFrom("/proj", "blk/secret"), null);
});

test("wildcard exports pick the most-specific (longest) matching pattern", () => {
  // Two patterns match `feat/x`; Node's PATTERN_KEY_COMPARE takes the longer base.
  const r = mk({
    "/proj/node_modules/w/package.json":
      '{"exports":{"./*":"./src/*.js","./feat/*":"./built/feat/*.js"}}',
    "/proj/node_modules/w/src/a.js": "",
    "/proj/node_modules/w/built/feat/x.js": "",
  });
  assert.equal(r.resolveFrom("/proj", "w/a"), "/proj/node_modules/w/src/a.js");
  assert.equal(r.resolveFrom("/proj", "w/feat/x"), "/proj/node_modules/w/built/feat/x.js");
});

test("package self-reference by its own name via exports", () => {
  // A file inside package `foo` importing `foo/feature` resolves through foo's own
  // exports (Node self-reference), without any foo entry under node_modules.
  const r = mk({
    "/proj/node_modules/foo/package.json":
      '{"name":"foo","exports":{".":"./index.js","./feature":"./feat.js"}}',
    "/proj/node_modules/foo/index.js": "",
    "/proj/node_modules/foo/feat.js": "",
    "/proj/node_modules/foo/lib/deep.js": "",
  });
  const from = "/proj/node_modules/foo/lib";
  assert.equal(r.resolveFrom(from, "foo"), "/proj/node_modules/foo/index.js");
  assert.equal(r.resolveFrom(from, "foo/feature"), "/proj/node_modules/foo/feat.js");
  // A subpath the package does not export is unresolved even via self-reference.
  assert.equal(r.resolveFrom(from, "foo/lib/deep"), null);
});

test("package #imports honor the caller's condition", () => {
  const files = {
    "/proj/node_modules/c/package.json": JSON.stringify({
      imports: { "#dep": { import: "./esm.js", require: "./cjs.js" } },
    }),
    "/proj/node_modules/c/esm.js": "",
    "/proj/node_modules/c/cjs.js": "",
  };
  const from = "/proj/node_modules/c";
  assert.equal(mk(files).resolveImports(from, "#dep"), "/proj/node_modules/c/esm.js");
  assert.equal(
    mk(files, ["node", "require"]).resolveImports(from, "#dep"),
    "/proj/node_modules/c/cjs.js",
  );
});

test("package #imports are scoped to the nearest package.json", () => {
  // An outer package defines `#x`; an inner nested package.json (without imports)
  // shadows the scope, so `#x` from inside the inner package does NOT reach out.
  const r = mk({
    "/proj/node_modules/outer/package.json": '{"imports":{"#x":"./real.js"}}',
    "/proj/node_modules/outer/real.js": "",
    "/proj/node_modules/outer/inner/package.json": '{"name":"inner"}',
    "/proj/node_modules/outer/inner/mod.js": "",
  });
  assert.equal(r.resolveImports("/proj/node_modules/outer", "#x"), "/proj/node_modules/outer/real.js");
  assert.equal(r.resolveImports("/proj/node_modules/outer/inner", "#x"), null);
});
