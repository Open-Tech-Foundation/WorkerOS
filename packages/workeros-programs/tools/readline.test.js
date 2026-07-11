import test from "node:test";
import assert from "node:assert/strict";
import { readline } from "../src/node/readline.js";
import { EventEmitter } from "../src/node/events.js";
import { createNodeRuntime } from "../src/node/require-runtime.js";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

function fakeSys(stdinText = "") {
  const syncFs = createFakeSyncFs();
  let stdin = new TextEncoder().encode(stdinText);
  let stdinDone = false;
  return {
    syncFs,
    open: async (p, o = {}) => syncFs.open(p, o),
    read: async (fd, max) => {
      if (fd === 0) {
        if (stdinDone) return new Uint8Array(0);
        stdinDone = true;
        return stdin.subarray(0, max);
      }
      return syncFs.read(fd, max);
    },
    close: async (fd) => syncFs.close(fd),
    stat: async (p) => syncFs.stat(p),
  };
}

test("createInterface question reads one line from a data-emitting input stream", async () => {
  const input = new EventEmitter();
  input.resume = () => {};
  const writes = [];
  const output = { write(chunk) { writes.push(String(chunk)); return true; } };
  const rl = readline.createInterface({ input, output, terminal: false });
  const asked = rl.question("name? ");
  input.emit("data", new TextEncoder().encode("workeros\n"));
  assert.equal(await asked, "workeros");
  assert.equal(writes.join(""), "name? ");
});

test("cursor helpers delegate to the output stream methods", () => {
  const calls = [];
  const out = {
    cursorTo: (...args) => calls.push(["cursorTo", ...args]),
    moveCursor: (...args) => calls.push(["moveCursor", ...args]),
    clearLine: (...args) => calls.push(["clearLine", ...args]),
    clearScreenDown: (...args) => calls.push(["clearScreenDown", ...args]),
  };
  readline.cursorTo(out, 2, 3);
  readline.moveCursor(out, 1, -1);
  readline.clearLine(out, 0);
  readline.clearScreenDown(out);
  assert.deepEqual(calls, [
    ["cursorTo", 2, 3, undefined],
    ["moveCursor", 1, -1, undefined],
    ["clearLine", 0, undefined],
    ["clearScreenDown", undefined],
  ]);
});

test("promises facade exposes createInterface", () => {
  assert.equal(readline.promises.createInterface, readline.createInterface);
  assert.equal(readline.promises.Interface, readline.Interface);
});

test("guest require resolves readline and question reads cooked stdin", async () => {
  const sys = fakeSys("hello from stdin\n");
  const main = [
    "const readline = require('readline');",
    "const fs = require('fs');",
    "(async () => {",
    "  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "  const line = await rl.question('prompt> ');",
    "  rl.close();",
    "  fs.writeFileSync('/readline-ok', line);",
    "})();",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(createFs(sys.syncFs).readFileSync("/readline-ok", "utf8"), "hello from stdin");
});
