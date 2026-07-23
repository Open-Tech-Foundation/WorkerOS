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

test("transformModule: `import` as a method/property name is NOT a dynamic import", () => {
  // Vite's ModuleRunner defines `async import(url) {}` and calls `this.import(x)` /
  // `runner.import(x)`. `import` here is a plain identifier, not the keyword —
  // rewriting it produced `async globalThis.__workerosImport(` (a SyntaxError) and
  // `this.globalThis.__workerosImport(` (wrong target), so Vite's bundle wouldn't
  // even parse. These must pass through untouched.
  const src = [
    "class Runner {",
    "  async import(url) { return url; }",
    "  run() { return this.import('./a.js'); }",
    "}",
    "const r = new Runner();",
    "r.import('./b.js');",
    "const real = await import('./c.js');", // a genuine dynamic import still rewrites
  ].join("\n");
  const out = transformModule(src, "/proj/m.js", { staticUrl: tag });
  assert.match(out, /async import\(url\)/, "method name left intact");
  assert.match(out, /this\.import\('\.\/a\.js'\)/, "this.import call left intact");
  assert.match(out, /r\.import\('\.\/b\.js'\)/, "property call left intact");
  assert.doesNotMatch(out, /globalThis\.__workerosImport\([^"]*['"]\.\/[ab]\.js/, "no rewrite of method/property import");
  // the real dynamic import is still rewritten
  assert.match(out, /globalThis\.__workerosImport\("\/proj\/m\.js", '\.\/c\.js'\)/);
});

test("transformModule: a method named `import` with no prefix is not a dynamic import", () => {
  // Next.js's BloomFilter defines a plain `import(data) { … }` method — no async/
  // get/set/static prefix, so the prev-token guard doesn't catch it. A dynamic
  // import is an expression and is never followed by a `{` body, so the matching
  // `)` → `{` shape identifies the method. Rewriting it put dots in method-name
  // position ("Unexpected token '.'"), which crashed `next dev` at load.
  const src = [
    "class BloomFilter {",
    "  export() { return this.items; }",
    "  import(data) { this.items = data.items; return this; }",
    "  reload() { return import('./chunk.js'); }", // a genuine dynamic import
    "}",
  ].join("\n");
  const out = transformModule(src, "/proj/bloom.js", { staticUrl: tag });
  assert.match(out, /\n {2}import\(data\) \{/, "method `import` left intact");
  assert.doesNotMatch(out, /__workerosImport\([^)]*data/, "method not rewritten as a call");
  assert.match(out, /globalThis\.__workerosImport\("\/proj\/bloom\.js", '\.\/chunk\.js'\)/, "real dynamic import still rewritten");
  assert.doesNotThrow(() => new Function(out), "transformed source compiles");
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

test("tokenizer: nested template literals don't desync later import.meta / imports", () => {
  // A `${…}` interpolation containing another backtick template used to flip the
  // string-vs-code balance and silently drop everything after it — which is how a
  // real bundle (create-vite) lost the `import.meta.url` it computes its template
  // dir from. The interpolation stack must scan `${…}` as code and resume the
  // template at the matching brace, leaving trailing real code intact.
  const src = [
    "const cmd = `npm exec -- ${pkg(`@scope/${name}`)} run`;",
    "const dir = fileURLToPath(import.meta.url);",
    "const m = await import('./late.js');",
  ].join("\n");
  const out = transformModule(src, "/proj/m.js", { staticUrl: tag });
  // The nested-template value expressions stay untouched (they are runtime code).
  assert.match(out, /`npm exec -- \$\{pkg\(`@scope\/\$\{name\}`\)\} run`/);
  // …but the real code AFTER the template is still rewritten.
  assert.match(out, /globalThis\.__workerosMeta\("\/proj\/m\.js"\)/);
  assert.match(out, /fileURLToPath\(__workeros_import_meta\.url\)/);
  assert.match(out, /globalThis\.__workerosImport\("\/proj\/m\.js", '\.\/late\.js'\)/);
});

test("tokenizer: regex literals containing quotes/slashes don't desync the scan", () => {
  // A regex like /['\"]/ or a division that looks like a regex must not swallow the
  // rest of the file as a string. Both a regex and a real division precede the
  // trailing import that still has to be found.
  const src = [
    "const re = /['\"]\\/[a-z]+/g;",   // regex with quotes + an escaped slash
    "const half = count / 2;",           // division (not a regex)
    "import x from './a.js';",
  ].join("\n");
  const out = transformModule(src, "/proj/m.js", { staticUrl: tag });
  assert.match(out, /import x from "URL\(\.\/a\.js\)"/);
  assert.equal(scanEsmImports(src).sort().join(","), "./a.js");
});

test("scanner: a static specifier after a nested template is still found", () => {
  const src = "const t = `a${`b${c}d`}e`;\nimport y from './dep.js';\n";
  assert.deepEqual(scanEsmImports(src), ["./dep.js"]);
});

// A template interpolation ending in an identifier named `from`/`import` must not
// be misread as `import … from ""`. The `}` closing `${…}` emits no punct token,
// so the continuation span lands with `from` as its predecessor — a `str`-typed
// span would produce a phantom empty specifier (this is exactly what broke
// `npm create hono`: create-hono's bundle contains
// `` `unexpected parse option { from: '${parseOptions.from}' }` ``).
test("scanner: `${x.from}` inside a template is not a phantom empty specifier", () => {
  const src = "throw new Error(`opt { from: '${parseOptions.from}' }`);\nimport y from './dep.js';\n";
  assert.deepEqual(scanEsmImports(src), ["./dep.js"]);
});

test("scanner: no phantom edge from a template ending in `import` either", () => {
  const src = "const s = `use ${dynamic.import}`;\nexport { a } from './x.js';\n";
  assert.deepEqual(scanEsmImports(src), ["./x.js"]);
});

test("transformModule: a template ending in `.from` is left intact (no bad rewrite)", () => {
  const src = "const s = `${o.from}`;\nimport y from './dep.js';\n";
  const out = transformModule(src, "/a/b.js", { staticUrl: (s) => (s === "./dep.js" ? "blob:dep" : null) });
  assert.match(out, /`\$\{o\.from\}`/); // template untouched
  assert.match(out, /import y from "blob:dep"/); // real specifier rewritten
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
