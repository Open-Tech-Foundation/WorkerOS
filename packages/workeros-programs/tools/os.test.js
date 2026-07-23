// Unit tests for the `node:os` builtin (src/node/os.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOs } from "../src/node/os.js";

test("constants and posix personality", () => {
  const os = createOs();
  assert.equal(os.EOL, "\n");
  // A real Node platform (Linux-personality) so `process.platform`/`os.platform()`
  // branches don't error on an unknown value; true identity is os.type().
  assert.equal(os.platform(), "linux");
  assert.equal(os.type(), "WorkerOS");
  assert.equal(os.arch(), "wasm32");
  assert.equal(os.endianness(), "LE");
  assert.equal(os.devNull, "/dev/null");
});

test("tmpdir/homedir read process.env, with defaults", () => {
  const os = createOs();
  const saved = globalThis.process.env.HOME;
  try {
    delete globalThis.process.env.HOME;
    assert.equal(os.homedir(), "/root");
    globalThis.process.env.HOME = "/home/dev";
    assert.equal(os.homedir(), "/home/dev");
    assert.equal(os.tmpdir(), "/tmp");
  } finally {
    if (saved === undefined) delete globalThis.process.env.HOME;
    else globalThis.process.env.HOME = saved;
  }
});

test("cpus() length tracks availableParallelism and has the right shape", () => {
  const os = createOs();
  const cpus = os.cpus();
  assert.equal(cpus.length, os.availableParallelism());
  assert.ok(cpus.length >= 1);
  assert.deepEqual(Object.keys(cpus[0].times).sort(), ["idle", "irq", "nice", "sys", "user"]);
});

test("memory and loadavg are documented approximations, not crashes", () => {
  const os = createOs();
  assert.ok(os.totalmem() > 0);
  assert.equal(os.freemem(), os.totalmem());
  assert.deepEqual(os.loadavg(), [0, 0, 0]);
  assert.deepEqual(os.networkInterfaces(), {});
});

test("userInfo and priority constants", () => {
  const os = createOs();
  const u = os.userInfo();
  assert.equal(u.username, "root");
  assert.equal(u.uid, 0);
  assert.equal(os.constants.priority.PRIORITY_NORMAL, 0);
});
