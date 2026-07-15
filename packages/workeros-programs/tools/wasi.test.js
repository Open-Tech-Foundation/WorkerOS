// Unit tests for the node:wasi WASI preview1 host (src/node/wasi.js), driven over a
// fake `sys` (in-memory syncFs + captured stdout) and a real WebAssembly.Memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasi } from "../src/node/wasi.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// A tiny in-memory VFS matching the sys.syncFs surface WASI uses.
function fakeSys() {
  const files = new Map(); // path -> Uint8Array
  const dirs = new Map();  // path -> [{name,is_dir}]
  const open = new Map();  // fd -> { path, off }
  let nextFd = 100;
  const out = [];          // stdout/stderr captures: [fd, bytes]
  const sys = {
    exit: (c) => { throw new Error("exit:" + c); },
    syncFs: {
      open: (path, opts) => {
        if (!files.has(path) && !(opts && opts.create)) { const e = new Error("Noent"); throw e; }
        if (!files.has(path)) files.set(path, new Uint8Array(0));
        if (opts && opts.truncate) files.set(path, new Uint8Array(0));
        const fd = nextFd++; open.set(fd, { path, off: 0 }); return fd;
      },
      read: (fd, max) => {
        const h = open.get(fd); const data = files.get(h.path);
        const chunk = data.subarray(h.off, h.off + max); h.off += chunk.length;
        return chunk;
      },
      write: (fd, bytes) => { out.push([fd, bytes]); return bytes.length; },
      close: (fd) => { open.delete(fd); },
      seek: (fd, offset, whence) => {
        const h = open.get(fd); const len = files.get(h.path).length;
        h.off = whence === 0 ? offset : whence === 2 ? len + offset : h.off + offset;
        return h.off;
      },
      stat: (path) => {
        if (dirs.has(path)) return { kind: "dir", size: 0, mtime: 1000, ino: 7 };
        if (files.has(path)) return { kind: "file", size: files.get(path).length, mtime: 2000, ino: 9 };
        throw new Error("Noent");
      },
      readdir: (path) => dirs.get(path) || [],
      mkdir: (path) => { dirs.set(path, []); },
    },
    __files: files, __dirs: dirs, __out: out,
  };
  return sys;
}

function setup() {
  const sys = fakeSys();
  const WASI = createWasi(sys);
  const memory = new WebAssembly.Memory({ initial: 4 }); // 256 KiB
  return { sys, WASI, memory };
}

test("wasi: args + environ round-trip through memory", () => {
  const { WASI, memory } = setup();
  const w = new WASI({ version: "preview1", args: ["rolldown", "build"], env: { NODE_ENV: "production" } });
  w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  const wi = w.wasiImport;

  assert.equal(wi.args_sizes_get(0, 8), 0);
  assert.equal(dv.getUint32(0, true), 2);                       // 2 args
  assert.equal(dv.getUint32(8, true), "rolldown\0build\0".length);
  assert.equal(wi.args_get(100, 200), 0);
  const p0 = dv.getUint32(100, true);
  assert.equal(dec.decode(new Uint8Array(memory.buffer).subarray(p0, p0 + 8)), "rolldown");

  assert.equal(wi.environ_sizes_get(0, 8), 0);
  assert.equal(dv.getUint32(0, true), 1);
  assert.equal(wi.environ_get(300, 400), 0);
  const e0 = dv.getUint32(300, true);
  assert.equal(dec.decode(new Uint8Array(memory.buffer).subarray(e0, e0 + 20)), "NODE_ENV=production\0".slice(0, 20));
});

test("wasi: clock + random write into memory", () => {
  const { WASI, memory } = setup();
  const w = new WASI({ version: "preview1" }); w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  assert.equal(w.wasiImport.clock_time_get(0, 0n, 16), 0);
  assert.ok(dv.getBigUint64(16, true) > 0n);
  const before = new Uint8Array(memory.buffer).slice(64, 96);
  assert.equal(w.wasiImport.random_get(64, 32), 0);
  const after = new Uint8Array(memory.buffer).slice(64, 96);
  assert.notDeepEqual([...before], [...after]); // (vanishingly unlikely to match)
});

test("wasi: fd_write scatters iovecs to the captured fd", () => {
  const { sys, WASI, memory } = setup();
  const w = new WASI({ version: "preview1" }); w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);
  // two iovecs → "hi" + "!!"
  u8.set(enc.encode("hi!!"), 1000);
  dv.setUint32(2000, 1000, true); dv.setUint32(2004, 2, true);      // iov[0] -> "hi"
  dv.setUint32(2008, 1002, true); dv.setUint32(2012, 2, true);      // iov[1] -> "!!"
  assert.equal(w.wasiImport.fd_write(1, 2000, 2, 3000), 0);
  assert.equal(dv.getUint32(3000, true), 4);
  const written = sys.__out.filter(([fd]) => fd === 1).map(([, b]) => dec.decode(b)).join("");
  assert.equal(written, "hi!!");
});

test("wasi: preopen → path_open → fd_read a real file", () => {
  const { sys, WASI, memory } = setup();
  sys.__files.set("/app/src/main.js", enc.encode("export const x = 1;"));
  const w = new WASI({ version: "preview1", preopens: { "/": "/" } });
  w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);

  // fd 3 is the "/" preopen
  assert.equal(w.wasiImport.fd_prestat_get(3, 100), 0);
  assert.equal(dv.getUint8(100), 0);                    // tag: dir
  assert.equal(dv.getUint32(104, true), 1);             // name "/" length

  const path = "app/src/main.js";
  u8.set(enc.encode(path), 500);
  // path_open(dirfd=3, dirflags, path, pathLen, oflags=0, ..., outFd)
  assert.equal(w.wasiImport.path_open(3, 0, 500, path.length, 0, 0n, 0n, 0, 600), 0);
  const fd = dv.getUint32(600, true);
  assert.ok(fd >= 3);

  // fd_read the whole file via one iovec
  dv.setUint32(700, 800, true); dv.setUint32(704, 64, true); // iov -> buf 800, len 64
  assert.equal(w.wasiImport.fd_read(fd, 700, 1, 900), 0);
  const n = dv.getUint32(900, true);
  assert.equal(dec.decode(u8.subarray(800, 800 + n)), "export const x = 1;");

  // filestat reports the size + regular type
  assert.equal(w.wasiImport.fd_filestat_get(fd, 1000), 0);
  assert.equal(dv.getUint8(1000 + 16), 4);              // filetype REGULAR
  assert.equal(Number(dv.getBigUint64(1000 + 32, true)), "export const x = 1;".length);
});

test("wasi: fd_readdir serializes dirents with . and ..", () => {
  const { sys, WASI, memory } = setup();
  sys.__dirs.set("/app", [{ name: "index.html", is_dir: false }, { name: "src", is_dir: true }]);
  const w = new WASI({ version: "preview1", preopens: { "/": "/app" } });
  w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  assert.equal(w.wasiImport.fd_readdir(3, 2000, 4096, 0n, 100), 0);
  const used = dv.getUint32(100, true);
  assert.ok(used > 0);
  // first entry is "." (namlen 1, type dir)
  assert.equal(dv.getUint32(2000 + 16, true), 1);
  assert.equal(dv.getUint8(2000 + 20), 3); // DIRECTORY
});

test("wasi: missing file → NOENT, bad fd → BADF (errors become errnos)", () => {
  const { WASI, memory } = setup();
  const w = new WASI({ version: "preview1", preopens: { "/": "/" } });
  w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);
  const path = "nope.txt";
  u8.set(enc.encode(path), 500);
  assert.equal(w.wasiImport.path_open(3, 0, 500, path.length, 0, 0n, 0n, 0, 600), 44); // NOENT
  assert.equal(w.wasiImport.fd_close(999), 8); // BADF
});

test("wasi: works over SHARED memory (crypto/TextDecoder can't touch a SAB view)", () => {
  // Regression: napi-rs instantiates over `new WebAssembly.Memory({shared:true})`.
  // crypto.getRandomValues and TextDecoder.decode both throw on a SharedArrayBuffer
  // view — rolldown's Rust std panicked with errno IO from random_get until fixed.
  const sys = fakeSys();
  sys.__files.set("/a.txt", enc.encode("hello"));
  const WASI = createWasi(sys);
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8, shared: true });
  assert.ok(memory.buffer instanceof SharedArrayBuffer);
  const w = new WASI({ version: "preview1", preopens: { "/": "/" } });
  w.setMemory(memory);
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);

  assert.equal(w.wasiImport.random_get(64, 32), 0); // must not throw/return IO
  // path string is read out of shared memory (TextDecoder path)
  u8.set(enc.encode("a.txt"), 500);
  assert.equal(w.wasiImport.path_open(3, 0, 500, 5, 0, 0n, 0n, 0, 600), 0);
  const fd = dv.getUint32(600, true);
  dv.setUint32(700, 800, true); dv.setUint32(704, 16, true);
  assert.equal(w.wasiImport.fd_read(fd, 700, 1, 900), 0);
  assert.equal(dec.decode(u8.slice(800, 800 + dv.getUint32(900, true))), "hello");
});

test("wasi: getImportObject wraps the namespace; start/initialize bind exported memory", () => {
  const { WASI, memory } = setup();
  const w = new WASI({ version: "preview1" });
  assert.ok(w.getImportObject().wasi_snapshot_preview1.fd_write);
  let ran = false;
  w.initialize({ exports: { memory, _initialize: () => { ran = true; } } });
  assert.equal(w.memory, memory);
  assert.equal(ran, true);
});
