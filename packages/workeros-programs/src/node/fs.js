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
// Honest-surface notes (INV-5): `readFile`/`readFileSync` without an encoding return
// a real `Buffer` (a Uint8Array subclass), as Node does, so `.toString()`/`JSON.parse`
// on the result behave; permissions/uid/gid are plausible constants. The
// VFS *does* model symlinks and mtime/ctime/btime (ADR-022), so `lstat`/`stat`
// report real timestamps + `isSymbolicLink()`, and `symlink`/`readlink` work;
// `atime` is reported as `mtime` (not separately tracked). Not a full Node
// fidelity claim, but real metadata where the kernel has it.

import { Readable, Writable } from "./stream.js";

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
  // Substring order matters here: "Spipe" (capital S) never matches "Pipe", so
  // both are safe under the includes() scan in toCode.
  Pipe: "EPIPE",
  EPIPE: "EPIPE",
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

// The low-level `write`/`writeSync` accept only a string or an ArrayBuffer view
// (Buffer/TypedArray/DataView) — anything else is a caller bug Node surfaces as a
// synchronous `ERR_INVALID_ARG_TYPE` naming the `"buffer"` argument.
function assertWriteData(data) {
  if (typeof data === "string" || ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return;
  const received = data === null ? "null" : Array.isArray(data) ? "an instance of Array" : typeof data;
  const err = new TypeError(
    'The "buffer" argument must be of type string or an instance of Buffer, ' +
      `TypedArray, or DataView. Received ${received}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  throw err;
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
function makeStats(m, bigint) {
  const kind = m.kind;
  const dir = kind === "dir";
  const link = kind === "symlink";
  const size = m.size || 0;
  const mtimeMs = m.mtime || 0;
  const ctimeMs = m.ctime || 0;
  const birthtimeMs = m.btime || 0;
  const atimeMs = mtimeMs;
  const mode = link ? 0o120777 : dir ? 0o040755 : 0o100644;
  const blocks = Math.ceil(size / 512);
  // `{ bigint: true }` reports every numeric field as a BigInt and adds the
  // nanosecond `*Ns` fields Node derives from the millisecond values.
  const N = bigint ? (v) => BigInt(Math.trunc(v)) : (v) => v;
  const base = {
    size: N(size),
    mode: N(mode),
    nlink: N(m.nlink || 1),
    // Unmodeled fields stay plausible constants.
    uid: N(0), gid: N(0), dev: N(0), ino: N(0), rdev: N(0), blksize: N(4096),
    blocks: N(blocks),
    atimeMs: N(atimeMs), mtimeMs: N(mtimeMs), ctimeMs: N(ctimeMs), birthtimeMs: N(birthtimeMs),
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
  if (bigint) {
    base.atimeNs = BigInt(Math.trunc(atimeMs)) * 1000000n;
    base.mtimeNs = BigInt(Math.trunc(mtimeMs)) * 1000000n;
    base.ctimeNs = BigInt(Math.trunc(ctimeMs)) * 1000000n;
    base.birthtimeNs = BigInt(Math.trunc(birthtimeMs)) * 1000000n;
  }
  return base;
}

function makeDirent(name, isDir, parentPath, isLink) {
  return {
    name,
    // Node 20+: the directory the entry lives in (`path` is the deprecated alias).
    parentPath,
    path: parentPath,
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir,
    isSymbolicLink: () => !!isLink,
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

// The parent directory of a posix path (no node:path dependency).
function dirname(p) {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}

// A shell glob → anchored RegExp: `**` spans separators, `*` a run within a
// segment, `?` one non-separator char. An approximation of Node's (experimental)
// glob, adequate for the common `**/*.ext` / `*.ext` shapes.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
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

// POSIX O_* bits — Node also accepts an integer flag (a bitwise-OR of these).
const O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
function numericFlagsToOpts(n) {
  const opts = {};
  if (n & O_CREAT) opts.create = true;
  if (n & O_EXCL) opts.exclusive = true;
  if (n & O_TRUNC) opts.truncate = true;
  const append = !!(n & O_APPEND);
  if (append) opts.create = opts.create || false;
  return { opts, append };
}

// `file://` URL → posix path (Node accepts a URL anywhere a path string is taken).
function fileURLToPath(u) {
  const url = typeof u === "string" ? new URL(u) : u;
  if (url.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
  return decodeURIComponent(url.pathname) || "/";
}

// Coerce a Node path argument (string | Buffer | `file:` URL) to a string, throwing
// Node's synchronous `ERR_INVALID_ARG_TYPE` for anything else. Applied at the entry
// of every path-taking op so bad input fails loudly and identically in sync + async.
function toPath(path) {
  if (typeof path === "string") return path;
  if (typeof URL !== "undefined" && path instanceof URL) return fileURLToPath(path);
  if (path && typeof path === "object" && path.protocol === "file:") return fileURLToPath(path);
  if (path instanceof Uint8Array) return dec.decode(path);
  const err = new TypeError(
    "The \"path\" argument must be of type string or an instance of Buffer or URL. " +
      `Received ${path === null ? "null" : typeof path}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  throw err;
}

// Validate a file descriptor argument (a non-negative integer), Node-style.
function assertFd(fd) {
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) {
    const err = new TypeError(`The \"fd\" argument must be of type number. Received ${typeof fd}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }
}

// A bounds check for read/write offset/length, throwing Node's `ERR_OUT_OF_RANGE`.
function assertRange(name, value, min, max) {
  if (typeof value !== "number" || value < min || value > max) {
    const err = new RangeError(
      `The value of \"${name}\" is out of range. It must be >= ${min} && <= ${max}. Received ${value}`,
    );
    err.code = "ERR_OUT_OF_RANGE";
    throw err;
  }
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
    path = toPath(path);
    const { opts, append } =
      typeof flags === "number" ? numericFlagsToOpts(flags) : flagsToOpts(flags == null ? "r" : flags);
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

  // `readSync(fd, buffer, offset, length, position)` — Node also accepts the
  // options-object form `readSync(fd, buffer, { offset, length, position })`.
  function readSync(fd, buffer, offset = 0, length, position = null) {
    assertFd(fd);
    if (offset !== null && typeof offset === "object") {
      ({ offset = 0, length, position = null } = offset);
    }
    if (offset == null) offset = 0;
    if (length == null) length = buffer.length - offset;
    assertRange("offset", offset, 0, buffer.length);
    assertRange("length", length, 0, buffer.length - offset);
    if (position != null && position >= 0) guard(() => syncFs.seek(fd, position, SEEK_SET), "read", openPaths.get(fd));
    // Node fills the buffer from a regular file in a single call (a short read
    // means EOF), but the sync channel caps one `syncFs.read` at its 1 MiB
    // payload. Loop from the current offset so a request for >1 MiB is fully
    // satisfied: npm's cacache reads cached content back with one large
    // `fs.read` and trusts the returned count, so a short read there truncates
    // the content and the integrity check fails (EBADSIZE — the bug that made
    // installs of large packuments/tarballs, e.g. a Vite scaffold, break).
    //
    // Only a chunk clipped by the channel cap can mean "more follows", though:
    // a regular file never reads short except at EOF, while a TTY yields one
    // line and a pipe what's buffered. Looping past those short reads blocks
    // the process on input it already consumed (a child's `readSync(0)` on the
    // terminal hung exactly this way after receiving its line).
    const path = openPaths.get(fd);
    const cap = syncFs.maxReadChunk ?? Infinity;
    let got = 0;
    while (got < length) {
      const want = length - got;
      const bytes = guard(() => syncFs.read(fd, want), "read", path);
      buffer.set(bytes, offset + got);
      got += bytes.length;
      if (bytes.length < Math.min(want, cap)) break; // EOF or a genuine short read
    }
    return got;
  }

  function writeSync(fd, data, offOrPos, lengthOrEnc, position) {
    assertFd(fd);
    assertWriteData(data);
    let bytes;
    let pos = null;
    if (typeof data === "string") {
      bytes = enc.encode(data);
      pos = offOrPos ?? null; // writeSync(fd, string[, position[, encoding]])
    } else {
      // Buffer form — positional `(offset, length, position)` or the
      // options-object form `writeSync(fd, buffer, { offset, length, position })`.
      let offset, length;
      if (offOrPos !== null && typeof offOrPos === "object") {
        ({ offset = 0, length, position } = offOrPos);
      } else {
        offset = offOrPos ?? 0;
        length = lengthOrEnc;
      }
      const view = toBytes(data);
      if (length == null) length = view.length - offset;
      assertRange("offset", offset, 0, view.length);
      assertRange("length", length, 0, view.length - offset);
      bytes = view.subarray(offset, offset + length);
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

  // Drain a file descriptor to EOF; `ownFd` closes it when we opened it ourselves.
  function readAllFromFd(fd, options, ownFd, path) {
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
      if (encoding) return dec.decode(out);
      // No encoding → a real `Buffer`, like Node (not a bare Uint8Array). A caller
      // that does `JSON.parse(readFileSync(p))` or `readFileSync(p).toString()`
      // relies on Buffer's utf8 `toString`; a Uint8Array stringifies as comma-joined
      // bytes (`"123,10,..."`) and breaks them — e.g. napi-rs reading package.json
      // while loading Vite's rolldown binding. Buffer subclasses Uint8Array, so this
      // is strictly more compatible. Zero-copy: it views the same bytes.
      const B = globalThis.Buffer;
      return B ? B.from(out.buffer, out.byteOffset, out.byteLength) : out;
    } finally {
      if (ownFd) closeSync(fd);
    }
  }

  function readFileSync(path, options) {
    // A numeric first arg is already an open fd (Node's readFileSync(fd)).
    if (typeof path === "number") return readAllFromFd(path, options, false, openPaths.get(path));
    path = toPath(path);
    const fd = openSync(path, "r");
    return readAllFromFd(fd, options, true, path);
  }

  function writeFileSync(path, data, options) {
    const bytes = toBytes(data, pickEncoding(options));
    // A numeric target is an already-open fd (Node writes to it, doesn't close it).
    if (typeof path === "number") return void writeAll(path, bytes, openPaths.get(path));
    path = toPath(path);
    const flag = (options && typeof options === "object" && options.flag) || "w";
    const fd = openSync(path, flag);
    try {
      writeAll(fd, bytes, path);
    } finally {
      closeSync(fd);
    }
  }

  function appendFileSync(path, data, options) {
    const bytes = toBytes(data, pickEncoding(options));
    if (typeof path === "number") return void writeAll(path, bytes, openPaths.get(path));
    path = toPath(path);
    const fd = openSync(path, "a");
    try {
      writeAll(fd, bytes, path);
    } finally {
      closeSync(fd);
    }
  }

  function statSync(path, options) {
    path = toPath(path);
    const bigint = !!(options && options.bigint);
    try {
      return makeStats(syncFs.stat(path), bigint);
    } catch (e) {
      const err = fsError(e, "stat", path);
      if (err.code === "ENOENT" && options && options.throwIfNoEntry === false) return undefined;
      throw err;
    }
  }

  // `lstat` — does not follow a final symlink (so `isSymbolicLink()` can be true).
  function lstatSync(path, options) {
    path = toPath(path);
    const bigint = !!(options && options.bigint);
    try {
      return makeStats(syncFs.lstat(path), bigint);
    } catch (e) {
      const err = fsError(e, "lstat", path);
      if (err.code === "ENOENT" && options && options.throwIfNoEntry === false) return undefined;
      throw err;
    }
  }

  // `symlinkSync(target, path[, type])` — `type` is a Windows-only hint, ignored.
  function symlinkSync(target, path, _type) {
    target = typeof target === "string" ? target : toPath(target);
    path = toPath(path);
    guard(() => syncFs.symlink(String(target), path), "symlink", path);
  }

  function readlinkSync(path, options) {
    path = toPath(path);
    const target = guard(() => syncFs.readlink(path), "readlink", path);
    const encoding = pickEncoding(options);
    return encoding === "buffer" ? enc.encode(target) : target;
  }

  function existsSync(path) {
    try {
      syncFs.stat(toPath(path));
      return true;
    } catch {
      return false;
    }
  }

  function readdirSync(path, options) {
    path = toPath(path);
    const withTypes = options && typeof options === "object" && options.withFileTypes;
    const recursive = options && typeof options === "object" && options.recursive;
    if (recursive) return readdirRecursive(path, "", withTypes);
    const entries = guard(() => syncFs.readdir(path), "scandir", path);
    return withTypes
      ? entries.map((e) => makeDirent(e.name, e.is_dir, path, e.is_symlink))
      : entries.map((e) => e.name);
  }

  // `readdir(path, { recursive: true })` — a depth-first walk yielding paths
  // relative to the top `path` (Node's contract), or Dirents with a real parentPath.
  function readdirRecursive(root, rel, withTypes) {
    const dirAbs = rel ? joinPath(root, rel) : root;
    const entries = guard(() => syncFs.readdir(dirAbs), "scandir", dirAbs);
    const out = [];
    for (const e of entries) {
      const childRel = rel ? rel + "/" + e.name : e.name;
      out.push(withTypes ? makeDirent(e.name, e.is_dir, dirAbs, e.is_symlink) : childRel);
      if (e.is_dir) out.push(...readdirRecursive(root, childRel, withTypes));
    }
    return out;
  }

  function mkdirSync(path, options) {
    path = toPath(path);
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
    path = toPath(path);
    guard(() => syncFs.unlink(path), "unlink", path);
  }

  function rmdirSync(path) {
    path = toPath(path);
    guard(() => syncFs.rmdir(path), "rmdir", path);
  }

  function renameSync(from, to) {
    from = toPath(from); to = toPath(to);
    guard(() => syncFs.rename(from, to), "rename", from);
  }

  // Recursive/force delete (Node's `fs.rmSync`).
  function rmSync(path, options) {
    path = toPath(path);
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

  // `copyFileSync(src, dest[, mode])` — `COPYFILE_EXCL` (mode & 1) fails if `dest`
  // already exists; `FICLONE*` clone hints degrade to a plain copy.
  function copyFileSync(src, dest, mode) {
    src = toPath(src); dest = toPath(dest);
    if ((mode & 1) && existsSync(dest)) throw fsError(new Error("Exist"), "copyfile", dest);
    writeFileSync(dest, readFileSync(src));
  }

  function realpathSync(path, options) {
    path = toPath(path);
    // Canonicalize through symlinks in the kernel (which owns cwd + the link
    // graph). Older kernels without the op fall back to existence + normalize.
    let real;
    if (typeof syncFs.realpath === "function") {
      real = guard(() => syncFs.realpath(path), "realpath", path);
    } else {
      guard(() => syncFs.stat(path), "lstat", path);
      real = normalize(path);
    }
    const encoding = pickEncoding(options);
    return encoding === "buffer" ? enc.encode(real) : real;
  }
  realpathSync.native = realpathSync;

  // `fs.linkSync(existingPath, newPath)` — a hard link (second name, shared inode).
  function linkSync(existingPath, newPath) {
    existingPath = toPath(existingPath); newPath = toPath(newPath);
    guard(() => syncFs.link(existingPath, newPath), "link", newPath);
  }

  // `accessSync(path[, mode])` — the WorkerOS VFS is single-user and permissionless
  // (INV-5), so any existing path is reachable; we honor F_OK by checking existence.
  function accessSync(path, _mode) {
    path = toPath(path);
    guard(() => syncFs.stat(path), "access", path);
  }

  function fstatSync(fd, options) {
    assertFd(fd);
    const path = openPaths.get(fd);
    if (path === undefined) throw fsError(new Error("Badf"), "fstat");
    const m = guard(() => syncFs.stat(path), "fstat", path);
    return makeStats(m, !!(options && options.bigint));
  }

  // --- Tier 3: truncate / metadata / sync -------------------------------
  // `truncate(path, len)` / `ftruncate(fd, len)`. The kernel has no truncate
  // syscall, so we do it in userland over the ops we have: read the file, then
  // rewrite it grown (zero-filled) or shrunk to `len`. Correct, if not atomic.
  function truncateAt(path, len = 0) {
    const cur = readFileSync(path);
    let out;
    if (len <= cur.length) {
      out = cur.subarray(0, len);
    } else {
      out = new Uint8Array(len);
      out.set(cur, 0);
    }
    writeFileSync(path, out);
  }
  function truncateSync(path, len = 0) {
    if (typeof path === "number") return ftruncateSync(path, len);
    truncateAt(toPath(path), len);
  }
  function ftruncateSync(fd, len = 0) {
    assertFd(fd);
    const path = openPaths.get(fd);
    if (path === undefined) throw fsError(new Error("Badf"), "ftruncate");
    truncateAt(path, len);
  }

  // Permission/ownership ops. The VFS models neither uid/gid nor a mode bitset, so
  // these validate that the target exists and then succeed as no-ops (the correct
  // observable behavior on a single-user, permissionless filesystem — INV-5). A
  // future kernel that grows the syscalls is used when present.
  function chmodSync(path, mode) {
    path = toPath(path);
    if (typeof syncFs.chmod === "function") return void guard(() => syncFs.chmod(path, mode), "chmod", path);
    guard(() => syncFs.stat(path), "chmod", path);
  }
  function fchmodSync(fd, _mode) { assertFd(fd); if (!openPaths.has(fd)) throw fsError(new Error("Badf"), "fchmod"); }
  function lchmodSync(path, mode) { chmodSync(path, mode); }
  function chownSync(path, _uid, _gid) {
    path = toPath(path);
    if (typeof syncFs.chown === "function") return void guard(() => syncFs.chown(path, _uid, _gid), "chown", path);
    guard(() => syncFs.stat(path), "chown", path);
  }
  function fchownSync(fd, _uid, _gid) { assertFd(fd); if (!openPaths.has(fd)) throw fsError(new Error("Badf"), "fchown"); }
  function lchownSync(path, uid, gid) { chownSync(path, uid, gid); }

  // `utimes(path, atime, mtime)`. The VFS tracks mtime/ctime/btime; when the kernel
  // exposes a set-times op we use it, otherwise we validate existence and no-op
  // (atime is not separately modeled — INV-5).
  const toEpochMs = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t * 1000 : Date.now());
  function utimesSync(path, atime, mtime) {
    path = toPath(path);
    if (typeof syncFs.utimes === "function") {
      return void guard(() => syncFs.utimes(path, toEpochMs(atime), toEpochMs(mtime)), "utimes", path);
    }
    guard(() => syncFs.stat(path), "utimes", path);
  }
  function futimesSync(fd, atime, mtime) {
    assertFd(fd);
    const path = openPaths.get(fd);
    if (path === undefined) throw fsError(new Error("Badf"), "futimes");
    utimesSync(path, atime, mtime);
  }
  function lutimesSync(path, atime, mtime) { utimesSync(path, atime, mtime); }

  // `fsync`/`fdatasync` — writes already land synchronously in the VFS, so a flush
  // is a validated no-op.
  function fsyncSync(fd) { assertFd(fd); if (!openPaths.has(fd)) throw fsError(new Error("Badf"), "fsync"); }
  const fdatasyncSync = fsyncSync;

  // Scatter/gather I/O over the single-buffer primitives.
  function readvSync(fd, buffers, position) {
    let total = 0;
    let pos = position ?? null;
    for (const buf of buffers) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      total += n;
      if (pos != null) pos += n;
      if (n < buf.length) break; // short read → EOF
    }
    return total;
  }
  function writevSync(fd, buffers, position) {
    let total = 0;
    let pos = position ?? null;
    for (const buf of buffers) {
      const n = writeSync(fd, buf, 0, buf.length, pos);
      total += n;
      if (pos != null) pos += n;
    }
    return total;
  }

  // `mkdtemp(prefix)` — create a uniquely-named dir `prefix` + 6 random chars.
  function mkdtempSync(prefix, options) {
    prefix = typeof prefix === "string" ? prefix : toPath(prefix);
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let attempt = 0; attempt < 100; attempt++) {
      let suffix = "";
      for (let i = 0; i < 6; i++) suffix += chars[(Math.random() * chars.length) | 0];
      const dir = prefix + suffix;
      try {
        syncFs.mkdir(dir);
        const encoding = pickEncoding(options);
        return encoding === "buffer" ? enc.encode(dir) : dir;
      } catch (e) {
        if (toCode(String(e.message || e)) !== "EEXIST") throw fsError(e, "mkdtemp", dir);
      }
    }
    throw fsError(new Error("Exist"), "mkdtemp", prefix);
  }

  // `statfs` — the VFS is one flat store; report a single plausible filesystem.
  function statfsSync(path, options) {
    toPath(path);
    const bigint = !!(options && options.bigint);
    const N = bigint ? (v) => BigInt(v) : (v) => v;
    return {
      type: N(0x9123683e), bsize: N(4096),
      blocks: N(1 << 20), bfree: N(1 << 19), bavail: N(1 << 19),
      files: N(1 << 16), ffree: N(1 << 15),
    };
  }

  // `cp`/`cpSync(src, dest, opts)` — recursive copy of a file, directory, or symlink.
  function cpSync(src, dest, options = {}) {
    src = toPath(src); dest = toPath(dest);
    const st = options.dereference ? statSync(src) : lstatSync(src);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(src);
      try { unlinkSync(dest); } catch { /* not there */ }
      symlinkSync(target, dest);
    } else if (st.isDirectory()) {
      if (!options.recursive) throw fsError(new Error("Isdir"), "cp", src);
      try { mkdirSync(dest, { recursive: true }); } catch (e) { if (e.code !== "EEXIST") throw e; }
      for (const name of readdirSync(src)) cpSync(joinPath(src, name), joinPath(dest, name), options);
    } else {
      if (options.force === false && existsSync(dest)) return;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest, options.errorOnExist ? 1 : 0);
    }
  }

  // `opendirSync(path)` → an `fs.Dir` over an eagerly-read directory listing.
  function opendirSync(path, _options) {
    path = toPath(path);
    const dirents = readdirSync(path, { withFileTypes: true });
    return new Dir(path, dirents);
  }

  // A minimal `fs.Dir`: sync + async `read()`, `close()`, and async iteration.
  class Dir {
    constructor(p, dirents) { this.path = p; this._entries = dirents; this._i = 0; }
    readSync() { return this._i < this._entries.length ? this._entries[this._i++] : null; }
    read(cb) {
      const v = this.readSync();
      if (cb) return void defer(() => cb(null, v));
      return Promise.resolve(v);
    }
    closeSync() {}
    close(cb) { if (cb) return void defer(() => cb(null)); return Promise.resolve(); }
    async *[Symbol.asyncIterator]() {
      for (const e of this._entries) yield e;
    }
  }

  // `glob`/`globSync(pattern[, options])` — walk `cwd` matching a shell-style
  // pattern (`**` any depth, `*` any run within a segment, `?` one char).
  function globSync(pattern, options = {}) {
    const cwd = toPath(options.cwd || "/");
    const pats = (Array.isArray(pattern) ? pattern : [pattern]).map(globToRegExp);
    const withTypes = !!options.withFileTypes;
    const out = [];
    const walk = (relDir) => {
      const abs = relDir ? joinPath(cwd, relDir) : cwd;
      let entries;
      try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = relDir ? relDir + "/" + e.name : e.name;
        if (pats.some((re) => re.test(rel))) out.push(withTypes ? e : rel);
        if (e.isDirectory()) walk(rel);
      }
    };
    walk("");
    return out;
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

  // --- Async callback API -------------------------------------------------
  // Node's async fs runs each op on the libuv threadpool and delivers the result
  // on a later loop tick. We have no threadpool: run the *sync* op, but always
  // deliver through a deferred macrotask so a callback never fires in the caller's
  // own stack (Node's contract) and the event loop is held open until it runs and
  // any chained op completes. `setTimeout` is the runtime's loop-installed,
  // ref-counting timer, so a pending async op keeps the process alive exactly as a
  // real one does; in plain-Node unit tests it's the native timer (same shape).
  const defer = (fn) => { setTimeout(fn, 0); };

  // Pull the trailing callback off an arg list, throwing synchronously (as Node
  // does) if it isn't a function.
  function takeCallback(all) {
    const cb = all[all.length - 1];
    if (typeof cb !== "function") {
      const err = new TypeError(
        `The "cb" argument must be of type function. Received ${cb === undefined ? "undefined" : typeof cb}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    return [all.slice(0, -1), cb];
  }

  // A sync op's async twin: (…leadingArgs, cb) → cb(err) | cb(null, result).
  const asyncify = (syncFn) => (...all) => {
    const [args, cb] = takeCallback(all);
    defer(() => {
      let result;
      try { result = syncFn(...args); } catch (e) { cb(e); return; }
      cb(null, result);
    });
  };

  // `fs.read(fd, buffer, offset, length, position, cb)` — also the modern
  // `fs.read(fd[, options], cb)` form. Delivers `(err, bytesRead, buffer)`.
  function read(fd, ...all) {
    const [rest, cb] = takeCallback(all);
    let buffer, offset, length, position;
    if (rest.length && ArrayBuffer.isView(rest[0])) {
      buffer = rest[0];
      offset = rest[1] ?? 0;
      length = rest[2] ?? buffer.length - offset;
      position = rest[3] ?? null;
    } else {
      const opts = rest[0] || {};
      buffer = opts.buffer || new Uint8Array(16384);
      offset = opts.offset ?? 0;
      length = opts.length ?? buffer.length - offset;
      position = opts.position ?? null;
    }
    defer(() => {
      let n;
      try { n = readSync(fd, buffer, offset, length, position); } catch (e) { cb(e); return; }
      cb(null, n, buffer);
    });
  }

  // `fs.write(fd, buffer[, offset[, length[, position]]], cb)` and
  // `fs.write(fd, string[, position[, encoding]], cb)`. Delivers `(err, n, data)`.
  function write(fd, data, ...all) {
    const [params, cb] = takeCallback(all);
    defer(() => {
      let n;
      try { n = writeSync(fd, data, ...params); } catch (e) { cb(e); return; }
      cb(null, n, data);
    });
  }

  // `fs.exists(path, cb)` — the one legacy fs API whose callback is *not*
  // error-first: it receives a single boolean.
  function exists(path, cb) {
    if (typeof cb !== "function") return;
    defer(() => cb(existsSync(path)));
  }

  // `readv(fd, buffers[, position], cb)` → cb(err, bytesRead, buffers).
  function readv(fd, buffers, ...all) {
    const [rest, cb] = takeCallback(all);
    const position = rest[0] ?? null;
    defer(() => {
      let n;
      try { n = readvSync(fd, buffers, position); } catch (e) { cb(e); return; }
      cb(null, n, buffers);
    });
  }
  // `writev(fd, buffers[, position], cb)` → cb(err, bytesWritten, buffers).
  function writev(fd, buffers, ...all) {
    const [rest, cb] = takeCallback(all);
    const position = rest[0] ?? null;
    defer(() => {
      let n;
      try { n = writevSync(fd, buffers, position); } catch (e) { cb(e); return; }
      cb(null, n, buffers);
    });
  }

  // `openAsBlob(path[, options])` → a `Blob` over the file's current bytes.
  function openAsBlob(path, options = {}) {
    return new Promise((resolve, reject) => {
      try { resolve(new Blob([readFileSync(toPath(path))], { type: options.type || "" })); }
      catch (e) { reject(e); }
    });
  }

  // --- Streams ------------------------------------------------------------
  // `createReadStream(path[, options])` → a Readable that pumps the file (from an
  // optional byte `start`..`end`) in `highWaterMark` chunks, opening the fd itself
  // unless one is supplied. Deferred pumping keeps emission asynchronous.
  function createReadStream(path, options = {}) {
    if (typeof options === "string") options = { encoding: options };
    const flags = options.flags || "r";
    const start = options.start ?? 0;
    const end = options.end; // inclusive, per Node
    const hwm = options.highWaterMark || 64 * 1024;
    const autoClose = options.autoClose !== false;
    const rs = new Readable({ encoding: options.encoding || null, highWaterMark: hwm });
    rs.path = path == null ? undefined : toPath(path);
    rs.bytesRead = 0;
    let fd = options.fd ?? null;
    const ownFd = options.fd == null;
    let pos = start;
    let opened = false;
    const fail = (e) => { rs.destroy(e); if (autoClose && ownFd && fd != null) { try { closeSync(fd); } catch { /* */ } } };
    rs.on("end", () => { if (autoClose && ownFd && fd != null) { try { closeSync(fd); } catch { /* */ } } });
    // Open once, lazily. Idempotent so both the eager `open`/`ready` notification
    // (which Node fires even for an unread stream) and the first `_read` share it.
    const ensureOpen = () => {
      if (opened) return;
      opened = true;
      if (fd == null) fd = openSync(rs.path, flags);
      if (start) syncFs.seek(fd, start, SEEK_SET);
      rs.emit("open", fd);
      rs.emit("ready");
    };
    // Pull-based: the streams core calls `_read` when it wants more, honoring the
    // highWaterMark. We push exactly one chunk per call (or null at EOF).
    rs._read = function () {
      try {
        ensureOpen();
        let want = hwm;
        if (end != null) {
          const remaining = end - pos + 1;
          if (remaining <= 0) return void rs.push(null);
          want = Math.min(want, remaining);
        }
        const chunk = guard(() => syncFs.read(fd, want), "read", rs.path);
        if (chunk.length === 0) return void rs.push(null);
        pos += chunk.length;
        rs.bytesRead += chunk.length;
        rs.push(chunk);
      } catch (e) { fail(e); }
    };
    defer(() => { try { ensureOpen(); } catch (e) { fail(e); } });
    return rs;
  }

  // `createWriteStream(path[, options])` → a Writable backed by an fd.
  function createWriteStream(path, options = {}) {
    if (typeof options === "string") options = { encoding: options };
    const flags = options.flags || "w";
    const autoClose = options.autoClose !== false;
    const ws = new Writable({ defaultEncoding: options.encoding || "utf8" });
    ws.path = path == null ? undefined : toPath(path);
    ws.bytesWritten = 0;
    let fd = options.fd ?? null;
    const ownFd = options.fd == null;
    try {
      if (fd == null) fd = openSync(ws.path, flags);
      if (options.start != null) syncFs.seek(fd, options.start, SEEK_SET);
    } catch (e) { defer(() => ws.emit("error", e)); return ws; }
    defer(() => { ws.emit("open", fd); ws.emit("ready"); });
    ws._write = (chunk, encoding, cb) => {
      try {
        ws.bytesWritten += writeAll(fd, toBytes(chunk, encoding), ws.path);
        cb();
      } catch (e) { cb(e); }
    };
    ws.on("finish", () => { if (autoClose && ownFd && fd != null) { try { closeSync(fd); } catch { /* */ } } });
    return ws;
  }

  // --- promises: FileHandle ----------------------------------------------
  // `fsPromises.open()` resolves to one of these. Each method runs the matching
  // sync op against the held fd and resolves/rejects a Promise.
  const settle = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
  class FileHandle {
    constructor(fd) { this.fd = fd; }
    read(buffer, offset, length, position) {
      return settle(() => {
        if (buffer && !ArrayBuffer.isView(buffer)) { // options-object form
          const o = buffer;
          buffer = o.buffer || new Uint8Array(16384);
          ({ offset = 0, length = buffer.length - offset, position = null } = o);
        }
        const bytesRead = readSync(this.fd, buffer, offset, length, position);
        return { bytesRead, buffer };
      });
    }
    write(data, offset, length, position) {
      return settle(() => {
        const bytesWritten = writeSync(this.fd, data, offset, length, position);
        return { bytesWritten, buffer: data };
      });
    }
    readv(buffers, position) { return settle(() => ({ bytesRead: readvSync(this.fd, buffers, position), buffers })); }
    writev(buffers, position) { return settle(() => ({ bytesWritten: writevSync(this.fd, buffers, position), buffers })); }
    readFile(options) { return settle(() => readFileSync(this.fd, options)); }
    writeFile(data, options) { return settle(() => writeFileSync(this.fd, data, options)); }
    appendFile(data, options) { return settle(() => appendFileSync(this.fd, data, options)); }
    stat(options) { return settle(() => fstatSync(this.fd, options)); }
    truncate(len) { return settle(() => ftruncateSync(this.fd, len)); }
    chmod(mode) { return settle(() => fchmodSync(this.fd, mode)); }
    chown(uid, gid) { return settle(() => fchownSync(this.fd, uid, gid)); }
    utimes(atime, mtime) { return settle(() => futimesSync(this.fd, atime, mtime)); }
    sync() { return settle(() => fsyncSync(this.fd)); }
    datasync() { return settle(() => fdatasyncSync(this.fd)); }
    createReadStream(options) { return createReadStream(null, { ...options, fd: this.fd, autoClose: false }); }
    createWriteStream(options) { return createWriteStream(null, { ...options, fd: this.fd, autoClose: false }); }
    close() { return settle(() => closeSync(this.fd)); }
    [Symbol.asyncDispose]() { return this.close(); }
  }

  const asyncApi = {
    access: asyncify(accessSync),
    readFile: asyncify(readFileSync),
    writeFile: asyncify(writeFileSync),
    appendFile: asyncify(appendFileSync),
    open: asyncify(openSync),
    close: asyncify(closeSync),
    read, write, readv, writev, exists,
    stat: asyncify(statSync),
    lstat: asyncify(lstatSync),
    fstat: asyncify(fstatSync),
    statfs: asyncify(statfsSync),
    symlink: asyncify(symlinkSync),
    readlink: asyncify(readlinkSync),
    link: asyncify(linkSync),
    realpath: asyncify(realpathSync),
    readdir: asyncify(readdirSync),
    mkdir: asyncify(mkdirSync),
    mkdtemp: asyncify(mkdtempSync),
    rmdir: asyncify(rmdirSync),
    rm: asyncify(rmSync),
    unlink: asyncify(unlinkSync),
    rename: asyncify(renameSync),
    copyFile: asyncify(copyFileSync),
    cp: asyncify(cpSync),
    opendir: asyncify(opendirSync),
    glob: asyncify(globSync),
    truncate: asyncify(truncateSync),
    ftruncate: asyncify(ftruncateSync),
    chmod: asyncify(chmodSync),
    fchmod: asyncify(fchmodSync),
    lchmod: asyncify(lchmodSync),
    chown: asyncify(chownSync),
    fchown: asyncify(fchownSync),
    lchown: asyncify(lchownSync),
    utimes: asyncify(utimesSync),
    futimes: asyncify(futimesSync),
    lutimes: asyncify(lutimesSync),
    fsync: asyncify(fsyncSync),
    fdatasync: asyncify(fdatasyncSync),
  };
  asyncApi.realpath.native = asyncApi.realpath;

  // `fs.constants` is a null-prototype object in Node; every key here is one of
  // the names Node's own `test-fs-constants` recognizes (no stray keys). We expose
  // the access-check + open flags we actually honor, plus the `S_IF*`/`S_I*` mode
  // bits (the `mode` fields in our Stats are built from these).
  const constants = Object.assign(Object.create(null), {
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
    O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000,
    S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFCHR: 0o020000,
    S_IFBLK: 0o060000, S_IFIFO: 0o010000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
    S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
    S_IRWXG: 0o070, S_IRGRP: 0o040, S_IWGRP: 0o020, S_IXGRP: 0o010,
    S_IRWXO: 0o007, S_IROTH: 0o004, S_IWOTH: 0o002, S_IXOTH: 0o001,
    COPYFILE_EXCL: 1,
  });

  const fs = {
    // Sync ops
    openSync, closeSync, readSync, writeSync, readvSync, writevSync,
    readFileSync, writeFileSync, appendFileSync,
    statSync, lstatSync, fstatSync, statfsSync,
    symlinkSync, readlinkSync,
    existsSync, accessSync,
    readdirSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, rmSync, renameSync,
    copyFileSync, realpathSync, linkSync, cpSync, opendirSync, globSync,
    truncateSync, ftruncateSync,
    chmodSync, fchmodSync, lchmodSync, chownSync, fchownSync, lchownSync,
    utimesSync, futimesSync, lutimesSync, fsyncSync, fdatasyncSync,
    // Async callback ops (deferred; see the async block above).
    ...asyncApi,
    openAsBlob,
    createReadStream, createWriteStream,
    watch, watchFile, unwatchFile,
    Dir, ReadStream: Readable, WriteStream: Writable,
    constants,
  };

  // `fs.promises` — the sync op wrapped in a resolved/rejected Promise, plus the
  // `FileHandle`-returning `open`. (No threadpool; enough for `await fs.promises.*`.)
  const wrapP = (fn) => (...args) => {
    try { return Promise.resolve(fn(...args)); } catch (e) { return Promise.reject(e); }
  };
  fs.promises = {
    readFile: wrapP(readFileSync),
    writeFile: wrapP(writeFileSync),
    appendFile: wrapP(appendFileSync),
    stat: wrapP(statSync),
    lstat: wrapP(lstatSync),
    statfs: wrapP(statfsSync),
    symlink: wrapP(symlinkSync),
    readlink: wrapP(readlinkSync),
    link: wrapP(linkSync),
    realpath: wrapP(realpathSync),
    readdir: wrapP(readdirSync),
    mkdir: wrapP(mkdirSync),
    mkdtemp: wrapP(mkdtempSync),
    rmdir: wrapP(rmdirSync),
    rm: wrapP(rmSync),
    unlink: wrapP(unlinkSync),
    rename: wrapP(renameSync),
    copyFile: wrapP(copyFileSync),
    cp: wrapP(cpSync),
    access: wrapP(accessSync),
    truncate: wrapP(truncateSync),
    chmod: wrapP(chmodSync),
    lchmod: wrapP(lchmodSync),
    chown: wrapP(chownSync),
    lchown: wrapP(lchownSync),
    utimes: wrapP(utimesSync),
    lutimes: wrapP(lutimesSync),
    glob: wrapP(globSync),
    opendir: wrapP(opendirSync),
    open: (path, flags = "r", mode) => settle(() => new FileHandle(openSync(path, flags, mode))),
    watch, // async-iterable in Node; here it returns the FSWatcher (EventEmitter)
    openAsBlob,
    constants,
  };

  return fs;
}
