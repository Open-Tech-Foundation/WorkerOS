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

// --- Async callback API ---------------------------------------------------

test("async readFile/writeFile round-trip; callback is deferred, not sync", async () => {
  const fs = createFs(createFakeSyncFs());
  let ran = false;
  await new Promise((resolve, reject) => {
    fs.writeFile("/a.txt", "hello", (err) => {
      if (err) return reject(err);
      // Callback must fire on a later tick — never in the caller's stack.
      assert.equal(ran, true, "callback should be deferred");
      fs.readFile("/a.txt", "utf8", (e, data) => {
        if (e) return reject(e);
        assert.equal(data, "hello");
        resolve();
      });
    });
    ran = true;
  });
});

test("async stat/mkdir/readdir/rmdir chain", async () => {
  const fs = createFs(createFakeSyncFs());
  await new Promise((resolve, reject) => {
    fs.mkdir("/d", (err) => {
      if (err) return reject(err);
      fs.writeFile("/d/f", "x", (e1) => {
        if (e1) return reject(e1);
        fs.readdir("/d", (e2, names) => {
          if (e2) return reject(e2);
          assert.deepEqual(names, ["f"]);
          fs.stat("/d", (e3, st) => {
            if (e3) return reject(e3);
            assert.equal(st.isDirectory(), true);
            resolve();
          });
        });
      });
    });
  });
});

test("async error surfaces as error-first callback with code/path", async () => {
  const fs = createFs(createFakeSyncFs());
  const err = await new Promise((resolve) => fs.stat("/missing", (e) => resolve(e)));
  assert.equal(err.code, "ENOENT");
  assert.equal(err.path, "/missing");
});

test("async mkdir twice → EEXIST in the callback", async () => {
  const fs = createFs(createFakeSyncFs());
  await new Promise((r) => fs.mkdir("/d", r));
  const err = await new Promise((resolve) => fs.mkdir("/d", (e) => resolve(e)));
  assert.equal(err.code, "EEXIST");
});

test("async open/write/read/close by fd", async () => {
  const fs = createFs(createFakeSyncFs());
  const fd = await new Promise((res, rej) => fs.open("/f", "w", (e, fd) => e ? rej(e) : res(fd)));
  const n = await new Promise((res, rej) => fs.write(fd, "abcdef", (e, n) => e ? rej(e) : res(n)));
  assert.equal(n, 6);
  await new Promise((res, rej) => fs.close(fd, (e) => e ? rej(e) : res()));
  const rfd = await new Promise((res, rej) => fs.open("/f", "r", (e, fd) => e ? rej(e) : res(fd)));
  const buf = new Uint8Array(6);
  const read = await new Promise((res, rej) => fs.read(rfd, buf, 0, 6, 0, (e, n, b) => e ? rej(e) : res({ n, b })));
  assert.equal(read.n, 6);
  assert.equal(dec.decode(read.b), "abcdef");
});

test("async exists uses a boolean (non-error-first) callback", async () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "x");
  assert.equal(await new Promise((r) => fs.exists("/f", r)), true);
  assert.equal(await new Promise((r) => fs.exists("/nope", r)), false);
});

test("async op with a non-function callback throws synchronously", () => {
  const fs = createFs(createFakeSyncFs());
  assert.throws(() => fs.stat("/f"), (e) => e.code === "ERR_INVALID_ARG_TYPE");
});

test("writeSync rejects non-buffer/string data with ERR_INVALID_ARG_TYPE", () => {
  const fs = createFs(createFakeSyncFs());
  for (const bad of [true, false, 0, 1, Infinity, () => {}, {}, [], undefined, null]) {
    assert.throws(() => fs.writeSync(1, bad), (e) => e.code === "ERR_INVALID_ARG_TYPE" && /"buffer"/.test(e.message), `value: ${String(bad)}`);
  }
});

test("fs.constants: null prototype, expected mode bits, no stray keys", () => {
  const fs = createFs(createFakeSyncFs());
  assert.equal(Object.getPrototypeOf(fs.constants), null);
  assert.notEqual(fs.constants.S_IRUSR, undefined);
  assert.notEqual(fs.constants.S_IWUSR, undefined);
  const known = new Set([
    "F_OK", "R_OK", "W_OK", "X_OK", "O_RDONLY", "O_WRONLY", "O_RDWR",
    "O_CREAT", "O_EXCL", "O_TRUNC", "O_APPEND",
    "S_IFMT", "S_IFREG", "S_IFDIR", "S_IFCHR", "S_IFBLK", "S_IFIFO", "S_IFLNK", "S_IFSOCK",
    "S_IRWXU", "S_IRUSR", "S_IWUSR", "S_IXUSR", "S_IRWXG", "S_IRGRP", "S_IWGRP", "S_IXGRP",
    "S_IRWXO", "S_IROTH", "S_IWOTH", "S_IXOTH", "COPYFILE_EXCL",
  ]);
  for (const k of Object.keys(fs.constants)) assert.ok(known.has(k), `unexpected fs.constant: ${k}`);
});

test("fs.promises round-trip and rejection", async () => {
  const fs = createFs(createFakeSyncFs());
  await fs.promises.writeFile("/p", "data");
  assert.equal(await fs.promises.readFile("/p", "utf8"), "data");
  await assert.rejects(fs.promises.readFile("/missing"), (e) => e.code === "ENOENT");
});

// --- Tier 1/2/3: full surface --------------------------------------------

test("truncateSync grows (zero-fill) and shrinks; ftruncateSync by fd", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "hello world");
  fs.truncateSync("/f", 5);
  assert.equal(fs.readFileSync("/f", "utf8"), "hello");
  fs.truncateSync("/f", 8); // grow with NUL padding
  const grown = fs.readFileSync("/f");
  assert.equal(grown.length, 8);
  assert.deepEqual([...grown.subarray(5)], [0, 0, 0]);
  const fd = fs.openSync("/f", "r+");
  fs.ftruncateSync(fd, 2);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync("/f", "utf8"), "he");
});

test("chmod/chown validate existence then no-op; bad fd throws EBADF", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "x");
  fs.chmodSync("/f", 0o644); // no throw
  fs.chownSync("/f", 0, 0);
  assert.throws(() => fs.chmodSync("/missing", 0o644), (e) => e.code === "ENOENT");
  assert.throws(() => fs.fchmodSync(999), (e) => e.code === "EBADF");
});

test("utimesSync updates mtime through the kernel op; futimes by fd", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "x");
  fs.utimesSync("/f", new Date(5000), new Date(9000));
  assert.equal(fs.statSync("/f").mtimeMs, 9000);
  const fd = fs.openSync("/f", "r");
  fs.futimesSync(fd, 1, 12); // seconds → 12000ms
  fs.closeSync(fd);
  assert.equal(fs.statSync("/f").mtimeMs, 12000);
});

test("fsync/fdatasync are validated no-ops", () => {
  const fs = createFs(createFakeSyncFs());
  const fd = fs.openSync("/f", "w");
  fs.fsyncSync(fd);
  fs.fdatasyncSync(fd);
  fs.closeSync(fd);
  assert.throws(() => fs.fsyncSync(999), (e) => e.code === "EBADF");
});

test("readvSync/writevSync scatter-gather round-trip", () => {
  const fs = createFs(createFakeSyncFs());
  let fd = fs.openSync("/f", "w");
  const written = fs.writevSync(fd, [Buffer.from("abc"), Buffer.from("de")]);
  assert.equal(written, 5);
  fs.closeSync(fd);
  fd = fs.openSync("/f", "r");
  const a = new Uint8Array(3), b = new Uint8Array(2);
  assert.equal(fs.readvSync(fd, [a, b]), 5);
  fs.closeSync(fd);
  assert.equal(dec.decode(a) + dec.decode(b), "abcde");
});

test("mkdtempSync makes a unique directory", () => {
  const fs = createFs(createFakeSyncFs());
  const d1 = fs.mkdtempSync("/tmp-");
  const d2 = fs.mkdtempSync("/tmp-");
  assert.notEqual(d1, d2);
  assert.equal(fs.statSync(d1).isDirectory(), true);
  assert.ok(d1.startsWith("/tmp-"));
});

test("statfsSync returns a plausible shape; bigint option", () => {
  const fs = createFs(createFakeSyncFs());
  const s = fs.statfsSync("/");
  assert.equal(typeof s.bsize, "number");
  assert.ok(s.blocks > 0);
  const big = fs.statfsSync("/", { bigint: true });
  assert.equal(typeof big.bsize, "bigint");
});

test("cpSync copies a file, a tree, and a symlink", () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/src");
  fs.writeFileSync("/src/a.txt", "A");
  fs.mkdirSync("/src/sub");
  fs.writeFileSync("/src/sub/b.txt", "B");
  fs.symlinkSync("a.txt", "/src/link");
  fs.cpSync("/src", "/dst", { recursive: true });
  assert.equal(fs.readFileSync("/dst/a.txt", "utf8"), "A");
  assert.equal(fs.readFileSync("/dst/sub/b.txt", "utf8"), "B");
  assert.equal(fs.readlinkSync("/dst/link"), "a.txt");
  // Copying a directory without recursive throws.
  assert.throws(() => fs.cpSync("/src", "/dst2"), (e) => e.code === "EISDIR");
});

test("opendirSync yields Dir entries via readSync and async iteration", async () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/d");
  fs.writeFileSync("/d/a", "1");
  fs.writeFileSync("/d/b", "2");
  const dir = fs.opendirSync("/d");
  assert.equal(dir.path, "/d");
  const names = [];
  let e;
  while ((e = dir.readSync()) !== null) names.push(e.name);
  assert.deepEqual(names.sort(), ["a", "b"]);
  // async iteration over a fresh handle
  const dir2 = fs.opendirSync("/d");
  const async = [];
  for await (const ent of dir2) async.push(ent.name);
  assert.deepEqual(async.sort(), ["a", "b"]);
});

test("globSync matches **, *, and ? patterns", () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/p");
  fs.mkdirSync("/p/sub");
  fs.writeFileSync("/p/a.js", "");
  fs.writeFileSync("/p/b.ts", "");
  fs.writeFileSync("/p/sub/c.js", "");
  assert.deepEqual(fs.globSync("**/*.js", { cwd: "/p" }).sort(), ["a.js", "sub/c.js"]);
  assert.deepEqual(fs.globSync("*.ts", { cwd: "/p" }), ["b.ts"]);
});

test("URL and Buffer paths are accepted everywhere", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync(new URL("file:///u.txt"), "via-url");
  assert.equal(fs.readFileSync(new URL("file:///u.txt"), "utf8"), "via-url");
  assert.equal(fs.existsSync(Buffer.from("/u.txt")), true);
});

test("bad path type throws ERR_INVALID_ARG_TYPE synchronously", () => {
  const fs = createFs(createFakeSyncFs());
  assert.throws(() => fs.readFileSync(true), (e) => e.code === "ERR_INVALID_ARG_TYPE");
  assert.throws(() => fs.statSync({}), (e) => e.code === "ERR_INVALID_ARG_TYPE");
});

test("numeric open flags (O_CREAT|O_TRUNC|O_APPEND) work", () => {
  const fs = createFs(createFakeSyncFs());
  const O = fs.constants;
  let fd = fs.openSync("/n", O.O_WRONLY | O.O_CREAT | O.O_TRUNC);
  fs.writeSync(fd, "x");
  fs.closeSync(fd);
  fd = fs.openSync("/n", O.O_WRONLY | O.O_APPEND);
  fs.writeSync(fd, "y");
  fs.closeSync(fd);
  assert.equal(fs.readFileSync("/n", "utf8"), "xy");
});

test("copyFileSync COPYFILE_EXCL fails when the dest exists", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/src", "s");
  fs.writeFileSync("/dst", "d");
  assert.throws(() => fs.copyFileSync("/src", "/dst", fs.constants.COPYFILE_EXCL), (e) => e.code === "EEXIST");
  fs.copyFileSync("/src", "/dst"); // no mode → overwrite ok
  assert.equal(fs.readFileSync("/dst", "utf8"), "s");
});

test("statSync bigint option returns BigInt fields + ns", () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/f", "abc");
  const st = fs.statSync("/f", { bigint: true });
  assert.equal(typeof st.size, "bigint");
  assert.equal(st.size, 3n);
  assert.equal(typeof st.mtimeNs, "bigint");
});

test("read/write options-object form + ERR_OUT_OF_RANGE bounds", () => {
  const fs = createFs(createFakeSyncFs());
  let fd = fs.openSync("/f", "w");
  const buf = Buffer.from("HELLO");
  assert.equal(fs.writeSync(fd, buf, { offset: 1, length: 3 }), 3);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync("/f", "utf8"), "ELL");
  fd = fs.openSync("/f", "r");
  const out = new Uint8Array(3);
  assert.equal(fs.readSync(fd, out, { offset: 0, length: 3 }), 3);
  fs.closeSync(fd);
  assert.equal(dec.decode(out), "ELL");
  const fd2 = fs.openSync("/f", "r");
  assert.throws(() => fs.readSync(fd2, new Uint8Array(2), 0, 5), (e) => e.code === "ERR_OUT_OF_RANGE");
  fs.closeSync(fd2);
});

test("readdirSync recursive + withFileTypes (parentPath, symlink dirent)", () => {
  const fs = createFs(createFakeSyncFs());
  fs.mkdirSync("/r");
  fs.mkdirSync("/r/sub");
  fs.writeFileSync("/r/sub/x", "1");
  fs.symlinkSync("sub/x", "/r/lnk");
  assert.deepEqual(fs.readdirSync("/r", { recursive: true }).sort(), ["lnk", "sub", "sub/x"]);
  const types = fs.readdirSync("/r", { withFileTypes: true });
  const link = types.find((d) => d.name === "lnk");
  assert.equal(link.isSymbolicLink(), true);
  assert.equal(link.parentPath, "/r");
});

test("createWriteStream then createReadStream round-trip", async () => {
  const fs = createFs(createFakeSyncFs());
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream("/s");
    ws.on("error", reject);
    ws.on("finish", resolve);
    ws.write("hello ");
    ws.end("world");
  });
  const data = await new Promise((resolve, reject) => {
    const rs = fs.createReadStream("/s", { encoding: "utf8" });
    let out = "";
    rs.on("data", (c) => { out += c; });
    rs.on("error", reject);
    rs.on("end", () => resolve(out));
  });
  assert.equal(data, "hello world");
});

test("createReadStream honors start/end byte range", async () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/s", "0123456789");
  const data = await new Promise((resolve, reject) => {
    const rs = fs.createReadStream("/s", { start: 2, end: 5, encoding: "utf8" });
    let out = "";
    rs.on("data", (c) => { out += c; });
    rs.on("error", reject);
    rs.on("end", () => resolve(out));
  });
  assert.equal(data, "2345");
});

test("promises.open → FileHandle read/write/stat/truncate/close", async () => {
  const fs = createFs(createFakeSyncFs());
  const fh = await fs.promises.open("/fh", "w+");
  const { bytesWritten } = await fh.write("abcdef");
  assert.equal(bytesWritten, 6);
  assert.equal((await fh.stat()).size, 6);
  await fh.truncate(3);
  await fh.close();
  assert.equal(fs.readFileSync("/fh", "utf8"), "abc");
});

test("openAsBlob returns a Blob over the file bytes", async () => {
  const fs = createFs(createFakeSyncFs());
  fs.writeFileSync("/b", "blobby");
  const blob = await fs.openAsBlob("/b");
  assert.equal(blob.size, 6);
  assert.equal(await blob.text(), "blobby");
});

test("async Tier 3 ops surface errors via error-first callbacks", async () => {
  const fs = createFs(createFakeSyncFs());
  const err = await new Promise((r) => fs.truncate("/missing", 0, (e) => r(e)));
  assert.equal(err.code, "ENOENT");
  await new Promise((res, rej) => fs.mkdtemp("/t-", (e, d) => e ? rej(e) : (assert.ok(d.startsWith("/t-")), res())));
});
