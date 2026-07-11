// Integration test for the CommonJS runtime's builtin wiring: a `require`-using
// module resolves `fs` / `node:fs` / `node:path` to guest builtins and a relative
// module from the (fake) VFS, and `fs` writes actually land. Pure Node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeRuntime } from "../src/node/require-runtime.js";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

// A fake program-worker `sys`: sync primitives + async fd ops over one store.
function fakeSys() {
  const syncFs = createFakeSyncFs();
  return {
    syncFs,
    open: async (p, o = {}) => syncFs.open(p, o),
    read: async (fd, max) => syncFs.read(fd, max),
    close: async (fd) => syncFs.close(fd),
    stat: async (p) => syncFs.stat(p),
  };
}

test("CJS entry resolves fs/node:path builtins + a relative require, and fs writes land", async () => {
  const sys = fakeSys();
  sys.syncFs._put("/app/helper.js", "module.exports = { name: 'world' };");
  const main = [
    "const fs = require('fs');",
    "const path = require('node:path');",
    "const helper = require('./helper');",
    "fs.writeFileSync(path.join('/', 'out.txt'), 'hi ' + helper.name);",
  ].join("\n");

  const run = createNodeRuntime(sys);
  await run("/app/main.js", main);

  // Read back through an independent fs over the same store.
  const fs = createFs(sys.syncFs);
  assert.equal(fs.readFileSync("/out.txt", "utf8"), "hi world");
});

test("require('node:fs') is the same builtin as require('fs')", async () => {
  const sys = fakeSys();
  const main = [
    "const a = require('fs');",
    "const b = require('node:fs');",
    "a.writeFileSync('/ok', String(a === b));",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  assert.equal(createFs(sys.syncFs).readFileSync("/ok", "utf8"), "true");
});

test("CJS entry resolution reuses package imports from the shared resolver", async () => {
  const sys = fakeSys();
  sys.syncFs._put(
    "/app/package.json",
    JSON.stringify({
      imports: {
        "#helper": "./helper.js",
      },
    }),
  );
  sys.syncFs._put("/app/helper.js", "module.exports = 'resolved-by-imports';");
  const main = [
    "const fs = require('fs');",
    "const helper = require('#helper');",
    "fs.writeFileSync('/imports-ok', helper);",
  ].join("\n");

  await createNodeRuntime(sys)("/app/main.js", main);
  assert.equal(createFs(sys.syncFs).readFileSync("/imports-ok", "utf8"), "resolved-by-imports");
});

test("an unknown module still throws Cannot find module", async () => {
  const sys = fakeSys();
  const main = "require('totally-not-installed');";
  await assert.rejects(
    createNodeRuntime(sys)("/m.js", main),
    /Cannot find module 'totally-not-installed'/,
  );
});
