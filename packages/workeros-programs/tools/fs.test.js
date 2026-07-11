// Unit tests for the `node:fs` builtin (src/node/fs.js) against an in-memory
// fake of the kernel VFS primitives — pure Node, no browser/SAB/wasm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

const dec = new TextDecoder();

test("writeFileSync + readFileSync round-trip (bytes and utf8)", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/a.txt", "hello");
  assert.equal(dec.decode(fs.readFileSync("/a.txt")), "hello");
  assert.equal(fs.readFileSync("/a.txt", "utf8"), "hello");
  assert.equal(fs.readFileSync("/a.txt", { encoding: "utf-8" }), "hello");
});

test("writeFileSync truncates, appendFileSync extends", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "abcdef");
  fs.writeFileSync("/f", "xy"); // truncate
  assert.equal(fs.readFileSync("/f", "utf8"), "xy");
  fs.appendFileSync("/f", "Z");
  assert.equal(fs.readFileSync("/f", "utf8"), "xyZ");
});

test("large write loops on nwritten when the channel caps a write", () => {
  const fs = createFs(createFakeSyncFs({ writeCap: 8 })); // force multiple writes
  const data = "0123456789abcdefghij"; // 20 bytes > cap
  fs.writeFileSync("/big", data);
  assert.equal(fs.readFileSync("/big", "utf8"), data);
});

test("existsSync and statSync", () => {
  const fs = createFs(createFakeSyncFs());
  assert.equal(fs.existsSync("/nope"), false);
  fs.writeFileSync("/f", "abc");
  assert.equal(fs.existsSync("/f"), true);
  const st = fs.statSync("/f");
  assert.equal(st.isFile(), true);
  assert.equal(st.isDirectory(), false);
  assert.equal(st.size, 3);
});

test("statSync throwIfNoEntry:false returns undefined", () => {
  const fs = createFs(createFakeSyncFs());
  assert.equal(fs.statSync("/missing", { throwIfNoEntry: false }), undefined);
});

test("ENOENT is mapped with code/syscall/path", () => {
  const fs = createFs(createFakeSyncFs());
  try {
    fs.readFileSync("/missing");
    assert.fail("expected throw");
  } catch (e) {
    assert.equal(e.code, "ENOENT");
    assert.equal(e.syscall, "open");
    assert.equal(e.path, "/missing");
  }
});

test("mkdirSync recursive creates ancestors; readdirSync lists", () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/a/b/c", { recursive: true });
  assert.equal(fs.statSync("/a/b/c").isDirectory(), true);
  fs.writeFileSync("/a/b/c/f.txt", "1");
  fs.writeFileSync("/a/b/c/g.txt", "2");
  const names = fs.readdirSync("/a/b/c").sort();
  assert.deepEqual(names, ["f.txt", "g.txt"]);
  const dirents = fs.readdirSync("/a/b/c", { withFileTypes: true });
  assert.equal(dirents.every((d) => d.isFile()), true);
});

test("mkdirSync non-recursive throws EEXIST on existing", () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/d");
  assert.throws(() => fs.mkdirSync("/d"), (e) => e.code === "EEXIST");
});

test("rmSync recursive removes a tree; force ignores ENOENT", () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/t/x", { recursive: true });
  fs.writeFileSync("/t/x/f", "1");
  fs.writeFileSync("/t/g", "2");
  fs.rmSync("/t", { recursive: true });
  assert.equal(fs.existsSync("/t"), false);
  fs.rmSync("/t", { recursive: true, force: true }); // no throw
});

test("renameSync and copyFileSync", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/a", "data");
  fs.renameSync("/a", "/b");
  assert.equal(fs.existsSync("/a"), false);
  assert.equal(fs.readFileSync("/b", "utf8"), "data");
  fs.copyFileSync("/b", "/c");
  assert.equal(fs.readFileSync("/c", "utf8"), "data");
});

test("low-level openSync/writeSync/readSync/closeSync", () => {
  const fs = createFs(createFakeSyncFs());
  const fd = fs.openSync("/f", "w");
  fs.writeSync(fd, "hello world");
  fs.closeSync(fd);
  const rfd = fs.openSync("/f", "r");
  const buf = new Uint8Array(5);
  const n = fs.readSync(rfd, buf, 0, 5, 6); // read "world" at position 6
  fs.closeSync(rfd);
  assert.equal(n, 5);
  assert.equal(dec.decode(buf), "world");
});

test("fs.promises wraps sync ops", async () => {
  const fs = createFs(createFakeSyncFs());
  await fs.promises.writeFile("/p", "async");
  assert.equal(await fs.promises.readFile("/p", "utf8"), "async");
  await assert.rejects(fs.promises.readFile("/missing"), (e) => e.code === "ENOENT");
});

test("symlinkSync + readlinkSync + lstat vs stat (follow)", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/target.txt", "payload");
  fs.symlinkSync("/target.txt", "/link");
  // readlink returns the raw target.
  assert.equal(fs.readlinkSync("/link"), "/target.txt");
  // stat follows the link → the target file.
  const st = fs.statSync("/link");
  assert.equal(st.isFile(), true);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.size, "payload".length);
  // lstat sees the link itself.
  const ls = fs.lstatSync("/link");
  assert.equal(ls.isSymbolicLink(), true);
  assert.equal(ls.isFile(), false);
  // reading through the link yields the target's bytes.
  assert.equal(fs.readFileSync("/link", "utf8"), "payload");
});

test("linkSync creates a second name; realpathSync resolves symlinks", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/a.txt", "content");
  fs.linkSync("/a.txt", "/b.txt");
  assert.equal(fs.readFileSync("/b.txt", "utf8"), "content");
  assert.throws(() => fs.linkSync("/a.txt", "/b.txt"), (e) => e.code === "EEXIST");

  fs.mkdirSync("/real");
  fs.writeFileSync("/real/f", "x");
  fs.symlinkSync("/real", "/link");
  assert.equal(fs.realpathSync("/link"), "/real");
  const buf = fs.realpathSync("/link", "buffer");
  assert.ok(buf instanceof Uint8Array);
  assert.equal(dec.decode(buf), "/real");
  assert.throws(() => fs.realpathSync("/nope"), (e) => e.code === "ENOENT");
});

test("statSync reports real mtime after a write (host clock)", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "x");
  const st = fs.statSync("/f");
  assert.ok(st.mtimeMs > 0, "mtime is a real timestamp, not 0");
  assert.ok(st.mtime instanceof Date);
  assert.equal(st.atimeMs, st.mtimeMs, "atime reported as mtime (untracked)");
});

test("fs.watch fans events to the listener and close() unregisters", () => {
  const syncFs = createFakeSyncFs();
  // Capture the single dispatcher node:fs registers, so we can simulate the
  // kernel pushing change events.
  let dispatch = null;
  const fs = createFs(syncFs, (cb) => { dispatch = cb; });
  fs.mkdirSync("/w");
  fs.writeFileSync("/w/a.txt", "x");

  const seen = [];
  const watcher = fs.watch("/w", (eventType, filename) => seen.push([eventType, filename]));
  assert.equal(typeof watcher.close, "function");

  // Simulate the kernel delivering events for this watch (id 1 is the first).
  dispatch(1, "rename", "a.txt");
  dispatch(1, "change", "a.txt");
  assert.deepEqual(seen, [["rename", "a.txt"], ["change", "a.txt"]]);

  // After close, further events are dropped and 'close' fires.
  let closed = false;
  watcher.on("close", () => { closed = true; });
  watcher.close();
  assert.equal(closed, true);
  dispatch(1, "change", "a.txt");
  assert.equal(seen.length, 2, "no events after close");
});

test("fs.watch on a missing path throws ENOENT; no watch API → ENOTSUP", () => {
  const fs = createFs(createFakeSyncFs(), (cb) => cb);
  assert.throws(() => fs.watch("/missing", () => {}), (e) => e.code === "ENOENT");
  // Without an onFsEvent dispatcher, watch is unsupported.
  const bare = createFs(createFakeSyncFs());
  bare.mkdirSync("/d");
  assert.throws(() => bare.watch("/d", () => {}), (e) => e.code === "ENOTSUP");
});

test("readlinkSync on a non-link throws EINVAL; buffer encoding", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/reg", "x");
  assert.throws(() => fs.readlinkSync("/reg"), (e) => e.code === "EINVAL");
  fs.symlinkSync("../up", "/l");
  const buf = fs.readlinkSync("/l", "buffer");
  assert.ok(buf instanceof Uint8Array);
  assert.equal(dec.decode(buf), "../up");
});
