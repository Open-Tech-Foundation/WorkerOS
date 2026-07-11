// End-to-end (in-process) test of the ESM runner + node-bundler wasm: two modules
// that import each other (a cycle) actually execute correctly — the case the native
// blob loader cannot do. Uses the REAL oxc transform (built wasm) over a fake VFS.
// Skipped when the wasm isn't built (npm run build:bundler).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEsmRunner } from "../src/node/esm-runner.js";
import { createResolver } from "../src/node/resolve.js";
import { createPath } from "../src/node/path.js";
import { detectFormat } from "../src/node/require-runtime.js";
import { bundlerFromExports } from "../src/node/node-bundler.js";

const wasmPath = fileURLToPath(new URL("../src/node-bundler/bundler.wasm", import.meta.url));
let transform = null;
try {
  const bytes = readFileSync(wasmPath);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  transform = bundlerFromExports(instance.exports).transform;
} catch {
  transform = null;
}
const opts = { skip: transform ? false : "bundler.wasm not built (npm run build:bundler)" };

function fakeFs(files) {
  const dirs = new Set(["/"]);
  for (const p of Object.keys(files)) {
    let d = p.slice(0, p.lastIndexOf("/")) || "/";
    for (;;) { dirs.add(d); if (d === "/") break; d = d.slice(0, d.lastIndexOf("/")) || "/"; }
  }
  return {
    statSync(p) {
      if (p in files) return { isDirectory: () => false, isFile: () => true };
      if (dirs.has(p)) return { isDirectory: () => true, isFile: () => false };
      throw Object.assign(new Error("ENOENT " + p), { code: "ENOENT" });
    },
    readFileSync(p) {
      if (p in files) return files[p];
      throw Object.assign(new Error("ENOENT " + p), { code: "ENOENT" });
    },
  };
}

function runnerOver(files) {
  const fs = fakeFs(files);
  const path = createPath();
  const resolver = createResolver({ fs, path, conditions: ["node", "import"] });
  return createEsmRunner({
    fs, path, resolver, transform, detectFormat,
    makeMeta: (abs) => ({ url: "file://" + abs, filename: abs, dirname: path.dirname(abs) }),
    loadCjs: () => { throw new Error("no cjs in this test"); },
    getBuiltin: () => { throw new Error("no builtin in this test"); },
  });
}

test("a two-module import cycle executes correctly through the runner", opts, async () => {
  const runner = runnerOver({
    "/p/a.js": [
      "import { getB } from './b.js';",
      "export function getA() { return 'A'; }",
      "export function useB() { return getB(); }",
    ].join("\n"),
    "/p/b.js": [
      "import { getA } from './a.js';",
      "export function getB() { return 'B'; }",
      "export function useA() { return getA(); }",
    ].join("\n"),
  });
  const a = await runner.load("/p/a.js");
  const b = await runner.load("/p/b.js");
  // Each side reaches across the cycle via a live binding.
  assert.equal(a.useB(), "B");
  assert.equal(b.useA(), "A");
  assert.equal(a.getA(), "A");
});

test("loadSync: require(esm)-style synchronous load of an ES module graph", opts, () => {
  const runner = runnerOver({
    "/p/main.js": [
      "import { twice } from './util.js';",
      "export const four = twice(2);",
      "export function run() { return twice(5); }",
      "export default 'main';",
    ].join("\n"),
    "/p/util.js": "export const twice = (n) => n * 2;\n",
  });
  const ns = runner.loadSync("/p/main.js"); // synchronous — no await, no promise
  assert.equal(ns.four, 4);
  assert.equal(ns.run(), 10);
  assert.equal(ns.default, "main");
});

test("live bindings: a value exported later is seen through the cycle", opts, async () => {
  const runner = runnerOver({
    "/p/x.js": [
      "import { readY } from './y.js';",
      "export let val = 'x-init';",
      "export function bump() { val = 'x-updated'; }",
      "export function peekY() { return readY(); }",
    ].join("\n"),
    "/p/y.js": [
      "import { val } from './x.js';",
      // read x's live `val` at call time (after x may have mutated it)
      "export function readY() { return val; }",
    ].join("\n"),
  });
  const x = await runner.load("/p/x.js");
  assert.equal(x.peekY(), "x-init");   // y reads x.val live
  x.bump();
  assert.equal(x.peekY(), "x-updated"); // live binding reflects the update
});
