// `node:fs` — the synchronous filesystem builtin for the WorkerOS Node runtime.
//
// GUEST code (INV-1): the kernel knows nothing about Node's `fs`. This maps the
// Node `fs` surface onto the kernel's synchronous VFS primitives, exposed to a JS
// guest as `sys.syncFs` (the per-process SAB sync-syscall channel; ADR-010/-016).
// Real tools do runtime file I/O that can't be prefetched the way the CJS
// `require` graph is — this is the keystone that unblocks them (PLAN Phase 5·A).
//
// `createFs(syncFs, onFsEvent?)` takes the low-level primitive object
//   { open(path,opts)->fd, read(fd,max)->Uint8Array, write(fd,bytes)->n,
//     close(fd), seek(fd,offset,whence)->offset, stat/lstat(path)->meta,
//     symlink(target,path), readlink(path)->target,
//     readdir(path)->[{name,is_dir}], mkdir(path), unlink(path), rmdir(path),
//     rename(from,to), watchAdd(path,recursive)->id, watchRemove(id) }
// — each throwing a plain Error carrying the kernel errno name — plus an optional
// `onFsEvent(cb)` that registers the process's single fs.watch dispatcher (the
// kernel pushes change events to it). Returns the Node `fs` module (sync ops, a
// thin `fs.promises`, and `fs.watch`/`watchFile`). Dependency-injected so the
// whole surface is unit-testable in plain Node against a fake `syncFs`.
//
// Honest-surface notes (INV-5): reads return a `Uint8Array` (not a Node `Buffer`)
// unless an encoding is given; permissions/uid/gid are plausible constants. The
// VFS *does* model symlinks and mtime/ctime/btime (ADR-022), so `lstat`/`stat`
// report real timestamps + `isSymbolicLink()`, and `symlink`/`readlink` work;
// `atime` is reported as `mtime` (not separately tracked). Not a full Node
// fidelity claim, but real metadata where the kernel has it.

const enc = new TextEncoder();
const dec = new TextDecoder();

// SEEK_* (WASI/POSIX whence numbering the kernel expects).
const SEEK_SET = 0;
const SEEK_END = 2;

// A safe per-write chunk: the sync channel payload is 1 MiB, so stay under it and
// let the kernel report the actual `nwritten` (we loop on it regardless).
const WRITE_CHUNK = 1 << 19; // 512 KiB

// kernel errno name → Node error code.
const CODES = {
  Noent: "ENOENT",
  Exist: "EEXIST",
  Notdir: "ENOTDIR",
  Isdir: "EISDIR",
  Notempty: "ENOTEMPTY",
  Nospc: "ENOSPC",
  Mfile: "EMFILE",
  Nametoolong: "ENAMETOOLONG",
  Inval: "EINVAL",
  Badf: "EBADF",
  Notsup: "ENOTSUP",
  Spipe: "ESPIPE",
};

function toCode(message) {
  for (const name in CODES) if (message.includes(name)) return CODES[name];
  return "EIO";
}

// Wrap a kernel error as a Node fs error: `code`, `syscall`, `path`, `errno`.
function fsError(e, syscall, path) {
  const code = toCode(String((e && e.message) || e));
  const err = new Error(`${code}: ${syscall} '${path ?? ""}'`);
  err.code = code;
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  err.errno = -1;
  return err;
}

const toBytes = (data, encoding) => {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data && data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  return enc.encode(String(data));
};

// Node passes an encoding as either a string arg or `{ encoding }`.
function pickEncoding(options) {
  if (typeof options === "string") return options;
  if (options && typeof options === "object") return options.encoding || null;
  return null;
}

// `m` is the kernel stat DTO: { kind, size, mtime, ctime, btime, nlink } with
// times in ms since epoch (0 until the host clock stamps a mutation). `atime`
// isn't tracked by the VFS — we report `mtime` for it (noatime-style), honestly.
function makeStats(m) {
  const kind = m.kind;
  const dir = kind === "dir";
  const link = kind === "symlink";
  const size = m.size || 0;
  const mtimeMs = m.mtime || 0;
  const ctimeMs = m.ctime || 0;
  const birthtimeMs = m.btime || 0;
  const atimeMs = mtimeMs;
  return {
    size,
    mode: link ? 0o120777 : dir ? 0o040755 : 0o100644,
    nlink: m.nlink || 1,
    // Unmodeled fields stay plausible constants.
    uid: 0, gid: 0, dev: 0, ino: 0, rdev: 0, blksize: 4096,
    blocks: Math.ceil(size / 512),
    atimeMs, mtimeMs, ctimeMs, birthtimeMs,
    atime: new Date(atimeMs), mtime: new Date(mtimeMs),
    ctime: new Date(ctimeMs), birthtime: new Date(birthtimeMs),
    isFile: () => kind === "file",
    isDirectory: () => dir,
    isSymbolicLink: () => link,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function makeDirent(name, isDir) {
  return {
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

// Lexically normalize a path (no symlink/cwd resolution — the kernel resolves
// relative paths against the process cwd; this is for realpath's shape).
function normalize(p) {
  const abs = p.startsWith("/");
  const segs = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length && segs[segs.length - 1] !== "..") segs.pop();
      else if (!abs) segs.push("..");
    } else segs.push(part);
  }
  return (abs ? "/" : "") + segs.join("/") || (abs ? "/" : ".");
}

// Open flags ('r','w','a','w+',…) → kernel open opts (+ whether to seek to end).
function flagsToOpts(flags) {
  const f = flags || "r";
  const opts = {};
  let append = false;
  if (f.includes("x")) opts.exclusive = true;
  if (f[0] === "w") { opts.create = true; opts.truncate = true; }
  else if (f[0] === "a") { opts.create = true; append = true; }
  // 'r' / 'r+' open an existing file (no create/truncate).
  return { opts, append };
}

export function createFs(syncFs, onFsEvent) {
  // fd → path, so fstat/read/write-by-fd have something to report against.
  const openPaths = new Map();

  // --- fs.watch plumbing (ADR-022) --------------------------------------
  // The kernel emits change events to the worker; `onFsEvent` (when provided) is
  // the single dispatcher we register, fanning each event out to the FSWatcher
  // whose watch id it carries.
  const watchers = new Map(); // watchId → FSWatcher
  if (typeof onFsEvent === "function") {
    onFsEvent((watchId, eventType, filename) => {
      const w = watchers.get(watchId);
      if (w) w.emit("change", eventType, filename);
    });
  }

  const guard = (fn, syscall, path) => {
    try {
      return fn();
    } catch (e) {
      throw fsError(e, syscall, path);
    }
  };

  function openSync(path, flags = "r", _mode) {
    const { opts, append } = flagsToOpts(typeof flags === "string" ? flags : "r");
    const fd = guard(() => syncFs.open(path, opts), "open", path);
    openPaths.set(fd, path);
    if (append) {
      try { syncFs.seek(fd, 0, SEEK_END); } catch (e) { /* empty file: offset 0 */ }
    }
    return fd;
  }

  function closeSync(fd) {
    guard(() => syncFs.close(fd), "close", openPaths.get(fd));
    openPaths.delete(fd);
  }

  function readSync(fd, buffer, offset = 0, length = buffer.length, position = null) {
    if (position != null && position >= 0) guard(() => syncFs.seek(fd, position, SEEK_SET), "read", openPaths.get(fd));
    const bytes = guard(() => syncFs.read(fd, length), "read", openPaths.get(fd));
    buffer.set(bytes.subarray(0, length), offset);
    return bytes.length;
  }

  function writeSync(fd, data, offOrPos, lengthOrEnc, position) {
    let bytes;
    let pos = null;
    if (typeof data === "string") {
      bytes = enc.encode(data);
      pos = offOrPos ?? null; // writeSync(fd, string[, position[, encoding]])
    } else {
      const offset = offOrPos ?? 0;
      const length = lengthOrEnc ?? data.length - offset;
      bytes = toBytes(data).subarray(offset, offset + length);
      pos = position ?? null;
    }
    if (pos != null && pos >= 0) guard(() => syncFs.seek(fd, pos, SEEK_SET), "write", openPaths.get(fd));
    return writeAll(fd, bytes, openPaths.get(fd));
  }

  // Write every byte, looping on the kernel's reported `nwritten` (the sync
  // channel caps a single write at its payload size).
  function writeAll(fd, bytes, path) {
    let off = 0;
    while (off < bytes.length) {
      const n = guard(() => syncFs.write(fd, bytes.subarray(off, off + WRITE_CHUNK)), "write", path);
      if (n <= 0) break;
      off += n;
    }
    return off;
  }

  function readFileSync(path, options) {
    const fd = openSync(path, "r");
    try {
      const chunks = [];
      let total = 0;
      for (;;) {
        const b = guard(() => syncFs.read(fd, 1 << 20), "read", path);
        if (b.length === 0) break;
        chunks.push(b);
        total += b.length;
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      const encoding = pickEncoding(options);
      return encoding ? dec.decode(out) : out;
    } finally {
      closeSync(fd);
    }
  }

  function writeFileSync(path, data, options) {
    const encoding = pickEncoding(options);
    const bytes = toBytes(data, encoding);
    const fd = openSync(path, "w");
    try {
      writeAll(fd, bytes, path);
    } finally {
      closeSync(fd);
    }
  }

  function appendFileSync(path, data, options) {
    const bytes = toBytes(data, pickEncoding(options));
    const fd = openSync(path, "a");
    try {
      writeAll(fd, bytes, path);
    } finally {
      closeSync(fd);
    }
  }

  function statSync(path, options) {
    try {
      return makeStats(syncFs.stat(path));
    } catch (e) {
      const err = fsError(e, "stat", path);
      if (err.code === "ENOENT" && options && options.throwIfNoEntry === false) return undefined;
      throw err;
    }
  }

  // `lstat` — does not follow a final symlink (so `isSymbolicLink()` can be true).
  function lstatSync(path, options) {
    try {
      return makeStats(syncFs.lstat(path));
    } catch (e) {
      const err = fsError(e, "lstat", path);
      if (err.code === "ENOENT" && options && options.throwIfNoEntry === false) return undefined;
      throw err;
    }
  }

  // `symlinkSync(target, path[, type])` — `type` is a Windows-only hint, ignored.
  function symlinkSync(target, path, _type) {
    guard(() => syncFs.symlink(String(target), path), "symlink", path);
  }

  function readlinkSync(path, options) {
    const target = guard(() => syncFs.readlink(path), "readlink", path);
    const encoding = pickEncoding(options);
    return encoding === "buffer" ? enc.encode(target) : target;
  }

  function existsSync(path) {
    try {
      syncFs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  function readdirSync(path, options) {
    const entries = guard(() => syncFs.readdir(path), "scandir", path);
    const withTypes = options && typeof options === "object" && options.withFileTypes;
    return withTypes
      ? entries.map((e) => makeDirent(e.name, e.is_dir))
      : entries.map((e) => e.name);
  }

  function mkdirSync(path, options) {
    const recursive = options && typeof options === "object" && options.recursive;
    if (!recursive) {
      guard(() => syncFs.mkdir(path), "mkdir", path);
      return undefined;
    }
    // Create each missing ancestor; return the first one created (Node's contract).
    const parts = normalize(path).split("/").filter(Boolean);
    let cur = path.startsWith("/") ? "" : ".";
    let firstCreated;
    for (const part of parts) {
      cur = cur === "" ? "/" + part : cur + "/" + part;
      try {
        syncFs.mkdir(cur);
        if (firstCreated === undefined) firstCreated = cur;
      } catch (e) {
        if (toCode(String(e.message || e)) !== "EEXIST") throw fsError(e, "mkdir", cur);
      }
    }
    return firstCreated;
  }

  function unlinkSync(path) {
    guard(() => syncFs.unlink(path), "unlink", path);
  }

  function rmdirSync(path) {
    guard(() => syncFs.rmdir(path), "rmdir", path);
  }

  function renameSync(from, to) {
    guard(() => syncFs.rename(from, to), "rename", from);
  }

  // Recursive/force delete (Node's `fs.rmSync`).
  function rmSync(path, options) {
    const recursive = options && options.recursive;
    const force = options && options.force;
    let st;
    try {
      st = syncFs.stat(path);
    } catch (e) {
      if (force && toCode(String(e.message || e)) === "ENOENT") return;
      throw fsError(e, "stat", path);
    }
    if (st.kind === "dir") {
      if (!recursive) throw fsError(new Error("Isdir"), "rm", path);
      for (const e of syncFs.readdir(path)) rmSync(joinPath(path, e.name), options);
      rmdirSync(path);
    } else {
      unlinkSync(path);
    }
  }

  function copyFileSync(src, dest) {
    writeFileSync(dest, readFileSync(src));
  }

  function realpathSync(path) {
    // No symlinks: verify existence (ENOENT like Node) and return the normalized
    // path. Relative paths can't be cwd-resolved here — the kernel owns cwd — so
    // an absolute path is returned normalized; a relative one is normalized as-is.
    guard(() => syncFs.stat(path), "lstat", path);
    return normalize(path);
  }
  realpathSync.native = realpathSync;

  function accessSync(path, _mode) {
    guard(() => syncFs.stat(path), "access", path);
  }

  function fstatSync(fd) {
    const path = openPaths.get(fd);
    if (path === undefined) throw fsError(new Error("Badf"), "fstat");
    const m = guard(() => syncFs.stat(path), "fstat", path);
    return makeStats(m);
  }

  // A small path join used by rmSync (kept local to avoid a node:path dependency).
  function joinPath(a, b) {
    return a.endsWith("/") ? a + b : a + "/" + b;
  }

  // A minimal FSWatcher (Node returns an EventEmitter). Emits `change`
  // (eventType, filename), `error`, and `close`; `.close()` unregisters.
  function makeWatcher(id) {
    const listeners = { change: [], error: [], close: [] };
    const watcher = {
      on(ev, cb) { (listeners[ev] ||= []).push(cb); return watcher; },
      addListener(ev, cb) { return watcher.on(ev, cb); },
      once(ev, cb) {
        const wrap = (...a) => { watcher.off(ev, wrap); cb(...a); };
        return watcher.on(ev, wrap);
      },
      off(ev, cb) {
        const l = listeners[ev];
        if (l) { const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); }
        return watcher;
      },
      removeListener(ev, cb) { return watcher.off(ev, cb); },
      emit(ev, ...a) {
        (listeners[ev] || []).slice().forEach((cb) => cb(...a));
        return (listeners[ev] || []).length > 0;
      },
      ref() { return watcher; },
      unref() { return watcher; },
      close() {
        if (!watchers.has(id)) return;
        watchers.delete(id);
        try { syncFs.watchRemove(id); } catch { /* already gone */ }
        watcher.emit("close");
      },
    };
    return watcher;
  }

  // `fs.watch(filename[, options][, listener])` → an FSWatcher. `options` may be
  // an encoding string or `{ recursive, persistent, encoding }`; `listener` is
  // added as a `change` handler `(eventType, filename)`.
  function watch(path, options, listener) {
    if (typeof options === "function") { listener = options; options = undefined; }
    if (typeof options === "string") options = { encoding: options };
    options = options || {};
    if (typeof syncFs.watchAdd !== "function" || typeof onFsEvent !== "function") {
      throw fsError(new Error("Notsup"), "watch", path);
    }
    const id = guard(() => syncFs.watchAdd(path, !!options.recursive), "watch", path);
    const watcher = makeWatcher(id);
    watchers.set(id, watcher);
    if (typeof listener === "function") watcher.on("change", listener);
    return watcher;
  }

  // `fs.watchFile`/`unwatchFile`: a thin StatWatcher over the same mechanism.
  // Node polls and hands `(curr, prev)` Stats; we translate each change event.
  const fileWatchers = new Map(); // path → { watcher, prev, listeners:Set }
  function watchFile(path, options, listener) {
    if (typeof options === "function") { listener = options; options = undefined; }
    let entry = fileWatchers.get(path);
    if (!entry) {
      const zero = () => statSync(path, { throwIfNoEntry: false }) || makeStats({ kind: "file", size: 0 });
      const watcher = watch(path, {}, () => {
        const curr = zero();
        const prev = entry.prev;
        entry.prev = curr;
        for (const cb of entry.listeners) cb(curr, prev);
      });
      entry = { watcher, prev: zero(), listeners: new Set() };
      fileWatchers.set(path, entry);
    }
    if (typeof listener === "function") entry.listeners.add(listener);
    return entry.watcher;
  }
  function unwatchFile(path, listener) {
    const entry = fileWatchers.get(path);
    if (!entry) return;
    if (listener) entry.listeners.delete(listener);
    else entry.listeners.clear();
    if (entry.listeners.size === 0) { entry.watcher.close(); fileWatchers.delete(path); }
  }

  const constants = {
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
    O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000,
  };

  const fs = {
    // Sync ops
    openSync, closeSync, readSync, writeSync,
    readFileSync, writeFileSync, appendFileSync,
    statSync, lstatSync, fstatSync,
    symlinkSync, readlinkSync,
    existsSync, accessSync,
    readdirSync, mkdirSync, rmdirSync, unlinkSync, rmSync, renameSync,
    copyFileSync, realpathSync,
    watch, watchFile, unwatchFile,
    constants,
  };

  // A thin `fs.promises` — the sync op wrapped in a resolved/rejected Promise.
  // (No true async I/O yet; enough for tools that `await fs.promises.readFile`.)
  const wrapP = (fn) => (...args) => {
    try { return Promise.resolve(fn(...args)); } catch (e) { return Promise.reject(e); }
  };
  fs.promises = {
    readFile: wrapP(readFileSync),
    writeFile: wrapP(writeFileSync),
    appendFile: wrapP(appendFileSync),
    stat: wrapP(statSync),
    lstat: wrapP(lstatSync),
    symlink: wrapP(symlinkSync),
    readlink: wrapP(readlinkSync),
    readdir: wrapP(readdirSync),
    mkdir: wrapP(mkdirSync),
    rmdir: wrapP(rmdirSync),
    rm: wrapP(rmSync),
    unlink: wrapP(unlinkSync),
    rename: wrapP(renameSync),
    copyFile: wrapP(copyFileSync),
    realpath: wrapP(realpathSync),
    access: wrapP(accessSync),
  };

  return fs;
}
