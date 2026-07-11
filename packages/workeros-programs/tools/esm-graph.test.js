// Unit tests for the userland ESM graph builder (src/node/esm-graph.js): the
// import scanner and the graph walk that /bin/node runs in place of the kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanEsmImports, buildEsmGraph, transformModule, hasEsmSyntax } from "../src/node/esm-graph.js";
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

test("scanner: static from/import only, skipping strings, comments, and dynamic import()", () => {
  const src = [
    "import a from './a.js';",
    "import { b } from \"./b.js\";",
    "import './side.js';",
    "export { c } from './c.js';",
    // Dynamic import is deliberately NOT a static graph edge — it resolves lazily
    // at call time (see transformModule), so the scanner must not report it.
    "const d = await import('./d.js');",
    "// import './comment.js' is ignored",
    "const s = 'not an ./import.js';",
  ].join("\n");
  assert.deepEqual(scanEsmImports(src).sort(), [
    "./a.js",
    "./b.js",
    "./c.js",
    "./side.js",
  ]);
});

// A `staticUrl` that just tags a specifier, so rewrites are visible in the output.
const tag = (spec) => `URL(${spec})`;

test("transformModule: static specifiers are rewritten to their dep URL", () => {
  const src = [
    "import a from './a.js';",
    "export { c } from \"./c.js\";",
    "import './side.js';",
  ].join("\n");
  const out = transformModule(src, "/proj/m.js", { staticUrl: tag });
  assert.match(out, /import a from "URL\(\.\/a\.js\)";/);
  assert.match(out, /export \{ c \} from "URL\(\.\/c\.js\)";/);
  assert.match(out, /import "URL\(\.\/side\.js\)";/);
});

test("transformModule: dynamic import() becomes the fs-backed runtime hook", () => {
  const src = "const m = await import(name);\nconst n = await import('./x.js');";
  const out = transformModule(src, "/proj/deep/m.js", { staticUrl: tag });
  // callee rewritten, importing module injected as the base — for a computed
  // specifier and a literal one alike (the literal is NOT pre-resolved).
  assert.match(out, /globalThis\.__workerosImport\("\/proj\/deep\/m\.js", name\)/);
  assert.match(out, /globalThis\.__workerosImport\("\/proj\/deep\/m\.js", '\.\/x\.js'\)/);
});

test("transformModule: import.meta is bound to a real meta object", () => {
  const src = "console.log(import.meta.url, import.meta.resolve('./x'));";
  const out = transformModule(src, "/proj/m.js", { staticUrl: tag });
  assert.match(out, /^const __workeros_import_meta = globalThis\.__workerosMeta\("\/proj\/m\.js"\);/);
  assert.match(out, /console\.log\(__workeros_import_meta\.url, __workeros_import_meta\.resolve\('\.\/x'\)\)/);
  assert.doesNotMatch(out, /import\.meta/);
});

test("transformModule: a module with nothing to rewrite is returned unchanged", () => {
  const src = "const x = 1;\nconsole.log(x);\n";
  assert.equal(transformModule(src, "/proj/m.js", { staticUrl: tag }), src);
});

test("hasEsmSyntax: import/export declarations and import.meta are ESM", () => {
  assert.equal(hasEsmSyntax("import x from './a.js';"), true);
  assert.equal(hasEsmSyntax("export const y = 1;"), true);
  assert.equal(hasEsmSyntax("export default 5;"), true);
  assert.equal(hasEsmSyntax("console.log(import.meta.url);"), true);
  // A module written in ESM that also builds a CJS-style require is still ESM.
  assert.equal(
    hasEsmSyntax("import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('./x');"),
    true,
  );
});

test("hasEsmSyntax: plain CJS and dynamic-import-only code are not ESM", () => {
  assert.equal(hasEsmSyntax("const x = require('x');\nmodule.exports = x;"), false);
  // Dynamic import() alone is legal in CommonJS, so it does not force ESM.
  assert.equal(hasEsmSyntax("const p = import('./x.js');"), false);
  // `import`/`export` as property names must not be mistaken for statements.
  assert.equal(hasEsmSyntax("module.exports = { export: 1, import: 2 };\nfoo.import();"), false);
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
