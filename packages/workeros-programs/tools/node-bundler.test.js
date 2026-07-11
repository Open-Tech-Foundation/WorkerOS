// Unit test for the node-bundler bridge (src/node/node-bundler.js): instantiate the
// built wasm directly and transform ESM through the pointer/length ABI. Skipped when
// the wasm hasn't been built (npm run build:bundler).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundlerFromExports } from "../src/node/node-bundler.js";

const wasmPath = fileURLToPath(new URL("../src/node-bundler/bundler.wasm", import.meta.url));
let bundler = null;
try {
  const bytes = readFileSync(wasmPath);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  bundler = bundlerFromExports(instance.exports);
} catch {
  bundler = null; // not built — skip
}
const opts = { skip: bundler ? false : "bundler.wasm not built (npm run build:bundler)" };

test("transforms ESM into WorkerOS runner calls with live bindings", opts, () => {
  const out = bundler.transform(
    "import { b } from './b.js';\nexport function a() { return 'A' + b(); }\nexport const A = 1;",
  );
  // import rewritten to a runner call; the use of `b` is a live property read.
  assert.match(out, /__workeros_import__\("\.\/b\.js"/);
  assert.match(out, /__workeros_import_0__\.b/);
  // exports are live getters on the runner exports object.
  assert.match(out, /Object\.defineProperty\(__workeros_exports__, "a"/);
  assert.match(out, /Object\.defineProperty\(__workeros_exports__, "A"/);
  // no Vite branding leaks into the OS.
  assert.doesNotMatch(out, /vite/i);
});

test("dynamic import() and import.meta become runner hooks", opts, () => {
  const out = bundler.transform("const m = await import('./x.js');\nconsole.log(import.meta.url);");
  assert.match(out, /__workeros_dynamic_import__\(/);
  assert.match(out, /__workeros_import_meta__/);
});
