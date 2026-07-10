// Unit tests for the userland ESM graph builder (src/node/esm-graph.js): the
// import scanner and the graph walk that /bin/node runs in place of the kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanEsmImports, buildEsmGraph } from "../src/node/esm-graph.js";
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

test("scanner: from/import/import(), skipping strings and comments", () => {
  const src = [
    "import a from './a.js';",
    "import { b } from \"./b.js\";",
    "import './side.js';",
    "export { c } from './c.js';",
    "const d = await import('./d.js');",
    "// import './comment.js' is ignored",
    "const s = 'not an ./import.js';",
  ].join("\n");
  assert.deepEqual(scanEsmImports(src).sort(), [
    "./a.js",
    "./b.js",
    "./c.js",
    "./d.js",
    "./side.js",
  ]);
});

test("builds a graph with builtin edges + node_modules resolution", () => {
  const files = {
    "/proj/app.js": "import fs from 'node:fs'; import dep from './dep.js'; import p from 'pkg';",
    "/proj/dep.js": "export default 1;",
    "/proj/node_modules/pkg/package.json": '{"main":"index.js"}',
    "/proj/node_modules/pkg/index.js": "export default 2;",
  };
  const g = buildEsmGraph({ fs: fakeFs(files), path: createPath() }, "/proj/app.js", files["/proj/app.js"]);
  assert.equal(g.entry, "/proj/app.js");
  assert.equal(g.modules[0].path, "/proj/app.js"); // entry first
  const edges = g.modules[0].imports;
  assert.deepEqual(edges[0], { specifier: "node:fs", resolved: "fs", builtin: true });
  assert.deepEqual(edges[1], { specifier: "./dep.js", resolved: "/proj/dep.js", builtin: false });
  assert.deepEqual(edges[2], { specifier: "pkg", resolved: "/proj/node_modules/pkg/index.js", builtin: false });
  // dep.js and the package file were both read into the graph.
  const paths = g.modules.map((m) => m.path).sort();
  assert.deepEqual(paths, ["/proj/app.js", "/proj/dep.js", "/proj/node_modules/pkg/index.js"]);
});

test("a missing import throws (honest failure, no silent stub)", () => {
  const files = { "/proj/app.js": "import x from './gone.js';" };
  assert.throws(
    () => buildEsmGraph({ fs: fakeFs(files), path: createPath() }, "/proj/app.js", files["/proj/app.js"]),
    /Cannot find module '.\/gone.js'/,
  );
});
