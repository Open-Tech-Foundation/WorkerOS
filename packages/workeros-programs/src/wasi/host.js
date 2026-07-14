// WASI Preview 1 host — lets an unmodified `wasm32-wasip1` binary run as a
// WorkerOS process (ADR-005: WASI P1 is the ABI floor).
//
// It provides the `wasi_snapshot_preview1` import module: each call reads/writes
// the wasm instance's linear memory and translates to the kernel's syscalls.
// stdout/stderr writes go on the async fire-and-forget path (nwritten is known
// locally). Calls that need a value *back* — `fd_read`, `path_open`, `fd_close`,
// `*_filestat_get` — use the synchronous SAB channel (`syncCall`, ADR-010/-016),
// which blocks this thread while the kernel worker services the request.
//
// Filesystem access uses a single preopened directory: WASI fd 3 = "/". wasi-libc
// resolves absolute paths (e.g. `/app/data.txt`) against it, calling
// `path_open(3, "app/data.txt")`.

// WASI Preview 1 errno subset.
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_IO = 29;
const ERRNO_NOENT = 44;
const ERRNO_NOSPC = 51;
const ERRNO_NOSYS = 52;
const ERRNO_NOTDIR = 54;
const ERRNO_PIPE = 64;

// __wasi_filetype_t
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SYMBOLIC_LINK = 7;

// __wasi_lookupflags_t
const LOOKUPFLAGS_SYMLINK_FOLLOW = 1;

/** Map a kernel stat DTO `kind` onto the WASI filetype. */
const filetypeOf = (kind) =>
  kind === "dir" ? FILETYPE_DIRECTORY : kind === "symlink" ? FILETYPE_SYMBOLIC_LINK : FILETYPE_REGULAR_FILE;

// __wasi_rights_t bits used to decide isatty (a TTY is a non-seekable chardev).
const RIGHTS_FD_SEEK = 1n << 2n;
const RIGHTS_FD_TELL = 1n << 5n;

// oflags
const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;

const PREOPEN_FD = 3;
const PREOPEN_NAME = "/";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Join a WASI (preopen-relative) path onto "/" and normalize.
function absPath(rel) {
  const segs = [];
  for (const part of `/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}

// Map a kernel-error status from the sync channel to a WASI errno.
function mapErr(value) {
  const m = value && value.error ? String(value.error) : "";
  if (/Noent/.test(m)) return ERRNO_NOENT;
  if (/Notdir/.test(m)) return ERRNO_NOTDIR;
  if (/Inval/.test(m)) return ERRNO_INVAL;
  if (/Nospc/.test(m)) return ERRNO_NOSPC;
  if (/errno Pipe\b|EPIPE/.test(m)) return ERRNO_PIPE;
  return ERRNO_IO;
}

/**
 * @param {object} deps
 * @param {*} deps.sys        guest `sys` ABI (async; used for fire-and-forget writes + exit)
 * @param {Function} deps.syncCall  blocking syscall over the SAB: (call, args, binary) => {status, bytes|value}
 * @param {string[]} deps.argv
 * @param {Record<string,string>} deps.env
 * @param {() => WebAssembly.Memory} deps.getMemory
 */
export function createWasiImports({ sys, syncCall, argv, env, getMemory }) {
  const view = () => new DataView(getMemory().buffer);
  const u8 = () => new Uint8Array(getMemory().buffer);
  const envPairs = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);

  // WASI fd (≥4) → { kfd: kernel fd, path, offset }. 0/1/2 are stdio; 3 is the preopen.
  const fds = new Map();
  let nextFd = 4;

  function readStr(ptr, len) {
    return decoder.decode(u8().slice(ptr, ptr + len));
  }
  function writeStringVec(list, ptrPtr, bufPtr) {
    const dv = view();
    const mem = u8();
    let ptr = ptrPtr;
    let buf = bufPtr;
    for (const s of list) {
      dv.setUint32(ptr, buf, true);
      ptr += 4;
      const bytes = encoder.encode(s);
      mem.set(bytes, buf);
      buf += bytes.length;
      mem[buf] = 0;
      buf += 1;
    }
    return ERRNO_SUCCESS;
  }
  function sizesOf(list, countPtr, sizePtr) {
    const dv = view();
    dv.setUint32(countPtr, list.length, true);
    let size = 0;
    for (const s of list) size += encoder.encode(s).length + 1;
    dv.setUint32(sizePtr, size, true);
    return ERRNO_SUCCESS;
  }
  // __wasi_filestat_t is 64 bytes; we fill filetype (@16) and size (@32).
  function writeFilestat(ptr, filetype, size) {
    const dv = view();
    for (let i = 0; i < 64; i += 4) dv.setUint32(ptr + i, 0, true);
    dv.setUint8(ptr + 16, filetype);
    dv.setBigUint64(ptr + 32, BigInt(size), true);
    dv.setBigUint64(ptr + 24, 1n, true); // nlink
  }

  const wasi = {
    args_sizes_get: (c, s) => sizesOf(argv, c, s),
    args_get: (p, b) => writeStringVec(argv, p, b),
    environ_sizes_get: (c, s) => sizesOf(envPairs, c, s),
    environ_get: (p, b) => writeStringVec(envPairs, p, b),

    clock_res_get: (_id, resPtr) => {
      view().setBigUint64(resPtr, 1000n, true);
      return ERRNO_SUCCESS;
    },
    clock_time_get: (_id, _prec, timePtr) => {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true);
      return ERRNO_SUCCESS;
    },
    random_get: (bufPtr, len) => {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      u8().set(bytes, bufPtr);
      return ERRNO_SUCCESS;
    },

    fd_fdstat_get: (fd, ptr) => {
      const dv = view();
      const isTty = fd <= 2;
      const ft = isTty ? FILETYPE_CHARACTER_DEVICE : fd === PREOPEN_FD ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE;
      dv.setUint8(ptr, ft);
      dv.setUint16(ptr + 2, 0, true);
      // fs_rights_base. wasi-libc's isatty() is `filetype == character_device &&
      // no FD_SEEK/FD_TELL rights` — a terminal isn't seekable. So for stdio we
      // advertise all rights *minus* seek/tell, which is what makes isatty(0..2)
      // return true. Files keep every right (they are seekable).
      const rights = isTty ? 0xffffffffffffffffn & ~(RIGHTS_FD_SEEK | RIGHTS_FD_TELL) : 0xffffffffffffffffn;
      dv.setBigUint64(ptr + 8, rights, true);
      dv.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
      return ERRNO_SUCCESS;
    },
    fd_fdstat_set_flags: () => ERRNO_SUCCESS,

    // --- preopen: a single directory, "/" at fd 3 ---
    fd_prestat_get: (fd, ptr) => {
      if (fd !== PREOPEN_FD) return ERRNO_BADF;
      const dv = view();
      dv.setUint8(ptr, 0); // tag: dir
      dv.setUint32(ptr + 4, encoder.encode(PREOPEN_NAME).length, true);
      return ERRNO_SUCCESS;
    },
    fd_prestat_dir_name: (fd, pathPtr, pathLen) => {
      if (fd !== PREOPEN_FD) return ERRNO_BADF;
      u8().set(encoder.encode(PREOPEN_NAME).subarray(0, pathLen), pathPtr);
      return ERRNO_SUCCESS;
    },

    path_open: (_dirfd, _dirflags, pathPtr, pathLen, oflags, _rb, _ri, _fdflags, openedFdPtr) => {
      const path = absPath(readStr(pathPtr, pathLen));
      const opts = {
        create: !!(oflags & O_CREAT),
        truncate: !!(oflags & O_TRUNC),
        exclusive: !!(oflags & O_EXCL),
        directory: !!(oflags & O_DIRECTORY),
      };
      const r = syncCall("open", { path, opts }, false);
      if (r.status < 0) return mapErr(r.value);
      const wfd = nextFd++;
      fds.set(wfd, { kfd: r.value.fd, path, offset: 0 });
      view().setUint32(openedFdPtr, wfd, true);
      return ERRNO_SUCCESS;
    },

    fd_read: (fd, iovsPtr, iovsLen, nreadPtr) => {
      const info = fds.get(fd);
      const kfd = info ? info.kfd : fd; // stdin (0) reads the kernel fd 0
      const dv = view();
      const mem = u8();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const p = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(p, true);
        const bufLen = dv.getUint32(p + 4, true);
        if (bufLen === 0) continue;
        const r = syncCall("read", { fd: kfd, max: bufLen }, true);
        if (r.status < 0) {
          dv.setUint32(nreadPtr, total, true);
          return ERRNO_IO;
        }
        if (r.bytes.length === 0) break; // EOF
        mem.set(r.bytes, bufPtr);
        total += r.bytes.length;
        if (info) info.offset += r.bytes.length;
        if (r.bytes.length < bufLen) break; // short read
      }
      dv.setUint32(nreadPtr, total, true);
      return ERRNO_SUCCESS;
    },

    fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
      const dv = view();
      const mem = u8();
      const parts = [];
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const p = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(p, true);
        const bufLen = dv.getUint32(p + 4, true);
        parts.push(mem.slice(bufPtr, bufPtr + bufLen));
        total += bufLen;
      }
      const info = fds.get(fd);
      // `sys.write` blocks until every byte is accepted (a full pipe parks this
      // thread — ADR-023), so a short count is never reported. It throws on a
      // kernel errno: EPIPE only reaches here if the guest catches SIGPIPE (the
      // default disposition already terminated it), ENOSPC on a full VFS.
      try {
        sys.write(info ? info.kfd : fd, concat(parts));
      } catch (e) {
        return mapErr({ error: String((e && e.message) || e) });
      }
      dv.setUint32(nwrittenPtr, total, true);
      return ERRNO_SUCCESS;
    },

    fd_seek: (fd, offset, whence, newOffPtr) => {
      const info = fds.get(fd);
      if (!info && fd > 2) return ERRNO_BADF;
      const r = syncCall("seek", { fd: info ? info.kfd : fd, offset: Number(offset), whence }, false);
      if (r.status < 0) return mapErr(r.value);
      if (info) info.offset = r.value.offset;
      view().setBigUint64(newOffPtr, BigInt(r.value.offset), true);
      return ERRNO_SUCCESS;
    },
    fd_tell: (fd, offPtr) => {
      const info = fds.get(fd);
      view().setBigUint64(offPtr, BigInt(info ? info.offset : 0), true);
      return ERRNO_SUCCESS;
    },

    fd_filestat_get: (fd, ptr) => {
      if (fd <= 2) {
        writeFilestat(ptr, FILETYPE_CHARACTER_DEVICE, 0);
        return ERRNO_SUCCESS;
      }
      const info = fds.get(fd);
      if (!info) return ERRNO_BADF;
      const r = syncCall("stat", { path: info.path }, false);
      if (r.status < 0) return mapErr(r.value);
      writeFilestat(ptr, r.value.kind === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE, r.value.size);
      return ERRNO_SUCCESS;
    },
    path_filestat_get: (_dirfd, flags, pathPtr, pathLen, ptr) => {
      const path = absPath(readStr(pathPtr, pathLen));
      // Without SYMLINK_FOLLOW this is an lstat — how a guest (realpath, ln -s
      // checks) sees the symlink itself rather than what it points at.
      const call = flags & LOOKUPFLAGS_SYMLINK_FOLLOW ? "stat" : "lstat";
      const r = syncCall(call, { path }, false);
      if (r.status < 0) return mapErr(r.value);
      writeFilestat(ptr, filetypeOf(r.value.kind), r.value.size);
      return ERRNO_SUCCESS;
    },

    path_create_directory: (_dirfd, pathPtr, pathLen) => {
      const r = syncCall("mkdir", { path: absPath(readStr(pathPtr, pathLen)) }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    path_unlink_file: (_dirfd, pathPtr, pathLen) => {
      const r = syncCall("unlink", { path: absPath(readStr(pathPtr, pathLen)) }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    path_remove_directory: (_dirfd, pathPtr, pathLen) => {
      const r = syncCall("rmdir", { path: absPath(readStr(pathPtr, pathLen)) }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    path_rename: (_oldFd, oldPtr, oldLen, _newFd, newPtr, newLen) => {
      const from = absPath(readStr(oldPtr, oldLen));
      const to = absPath(readStr(newPtr, newLen));
      const r = syncCall("rename", { from, to }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    // The link *target* is stored uninterpreted (kernel symlink semantics), so it
    // must not be resolved against the preopen — only the new path is.
    path_symlink: (oldPtr, oldLen, _dirfd, newPtr, newLen) => {
      const target = readStr(oldPtr, oldLen);
      const path = absPath(readStr(newPtr, newLen));
      const r = syncCall("symlink", { target, path }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    path_link: (_oldFd, _oldFlags, oldPtr, oldLen, _newFd, newPtr, newLen) => {
      const existing = absPath(readStr(oldPtr, oldLen));
      const path = absPath(readStr(newPtr, newLen));
      const r = syncCall("link", { existing, path }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    path_readlink: (_dirfd, pathPtr, pathLen, bufPtr, bufLen, nusedPtr) => {
      const r = syncCall("readlink", { path: absPath(readStr(pathPtr, pathLen)) }, false);
      if (r.status < 0) return mapErr(r.value);
      const bytes = encoder.encode(String(r.value.target));
      const n = Math.min(bytes.length, bufLen);
      u8().set(bytes.subarray(0, n), bufPtr);
      view().setUint32(nusedPtr, n, true);
      return ERRNO_SUCCESS;
    },
    // WASI carries nanosecond timestamps + per-field flags; the kernel's utimes
    // sets both times in epoch ms. An unflagged field falls back to "now" — the
    // callers that matter (touch) always flag both.
    path_filestat_set_times: (_dirfd, _flags, pathPtr, pathLen, atim, mtim, fstFlags) => {
      const ms = (ns, set, now) => (now ? Date.now() : set ? Number(ns / 1000000n) : Date.now());
      const atime = ms(atim, fstFlags & 1, fstFlags & 2);
      const mtime = ms(mtim, fstFlags & 4, fstFlags & 8);
      const r = syncCall("utimes", { path: absPath(readStr(pathPtr, pathLen)), atime, mtime }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },
    // The kernel has no ftruncate syscall; like node/fs.js truncateAt, do it in
    // userland over the ops we have — read the prefix, rewrite grown (zero-
    // filled) or shrunk. Correct, if not atomic.
    fd_filestat_set_size: (fd, size) => {
      const info = fds.get(fd);
      if (!info) return ERRNO_BADF;
      const want = Number(size);
      const st = syncCall("stat", { path: info.path }, false);
      if (st.status < 0) return mapErr(st.value);
      const keep = Math.min(Number(st.value.size), want);
      const out = new Uint8Array(want);
      if (keep > 0) {
        const rfd = syncCall("open", { path: info.path, opts: {} }, false);
        if (rfd.status < 0) return mapErr(rfd.value);
        let off = 0;
        while (off < keep) {
          const r = syncCall("read", { fd: rfd.value.fd, max: Math.min(keep - off, 512 * 1024) }, true);
          if (r.status < 0) { syncCall("close", { fd: rfd.value.fd }, false); return mapErr(r.value); }
          if (!r.bytes || r.bytes.length === 0) break;
          out.set(r.bytes.subarray(0, Math.min(r.bytes.length, keep - off)), off);
          off += r.bytes.length;
        }
        syncCall("close", { fd: rfd.value.fd }, false);
      }
      const wfd = syncCall("open", { path: info.path, opts: { create: true, truncate: true } }, false);
      if (wfd.status < 0) return mapErr(wfd.value);
      try {
        sys.write(wfd.value.fd, out);
      } catch (e) {
        syncCall("close", { fd: wfd.value.fd }, false);
        return mapErr({ error: String((e && e.message) || e) });
      }
      syncCall("close", { fd: wfd.value.fd }, false);
      return ERRNO_SUCCESS;
    },
    fd_filestat_set_times: (fd, atim, mtim, fstFlags) => {
      const info = fds.get(fd);
      if (!info) return ERRNO_BADF;
      const ms = (ns, set, now) => (now ? Date.now() : set ? Number(ns / 1000000n) : Date.now());
      const atime = ms(atim, fstFlags & 1, fstFlags & 2);
      const mtime = ms(mtim, fstFlags & 4, fstFlags & 8);
      const r = syncCall("utimes", { path: info.path, atime, mtime }, false);
      return r.status < 0 ? mapErr(r.value) : ERRNO_SUCCESS;
    },

    fd_readdir: (fd, bufPtr, bufLen, cookie, bufusedPtr) => {
      const info = fds.get(fd);
      if (!info) return ERRNO_BADF;
      const r = syncCall("readdir", { path: info.path }, false);
      if (r.status < 0) return mapErr(r.value);
      // "." and ".." lead, then the directory's own entries.
      const list = [
        { name: ".", is_dir: true },
        { name: "..", is_dir: true },
        ...r.value.entries,
      ];
      const dv = view();
      const mem = u8();
      let used = 0;
      for (let i = Number(cookie); i < list.length; i++) {
        if (used + 24 > bufLen) {
          used = bufLen;
          break;
        }
        const e = list[i];
        const nameBytes = encoder.encode(e.name);
        const p = bufPtr + used;
        dv.setBigUint64(p, BigInt(i + 1), true); // d_next (cookie of next entry)
        dv.setBigUint64(p + 8, BigInt(i + 1), true); // d_ino
        dv.setUint32(p + 16, nameBytes.length, true); // d_namlen
        dv.setUint8(p + 20, e.is_dir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
        const room = Math.min(nameBytes.length, bufLen - used - 24);
        mem.set(nameBytes.subarray(0, room), p + 24);
        used += 24 + room;
        if (room < nameBytes.length) {
          used = bufLen; // truncated → signal "buffer full, call again"
          break;
        }
      }
      dv.setUint32(bufusedPtr, used, true);
      return ERRNO_SUCCESS;
    },

    fd_close: (fd) => {
      const info = fds.get(fd);
      if (info) {
        syncCall("close", { fd: info.kfd }, false);
        fds.delete(fd);
      }
      return ERRNO_SUCCESS;
    },
    sched_yield: () => ERRNO_SUCCESS,
    // Clock-only poll — what wasi-libc's nanosleep/thread::sleep compiles to.
    // A worker thread may block, so the wait is a plain Atomics.wait on a
    // scratch SAB. fd subscriptions stay honestly unimplemented (NOSYS).
    poll_oneoff: (inPtr, outPtr, nsubs, neventsPtr) => {
      const dv = view();
      const SUB = 48; // __wasi_subscription_t
      const EVT = 32; // __wasi_event_t
      let shortestMs = null;
      const clocks = [];
      for (let i = 0; i < nsubs; i++) {
        const p = inPtr + i * SUB;
        const userdata = dv.getBigUint64(p, true);
        const tag = dv.getUint8(p + 8);
        if (tag !== 0) return ERRNO_NOSYS; // only eventtype clock
        const timeoutNs = dv.getBigUint64(p + 24, true);
        const abstime = dv.getUint16(p + 40, true) & 1;
        const nowNs = BigInt(Date.now()) * 1000000n;
        const relNs = abstime ? (timeoutNs > nowNs ? timeoutNs - nowNs : 0n) : timeoutNs;
        const ms = Number(relNs / 1000000n);
        clocks.push(userdata);
        shortestMs = shortestMs === null ? ms : Math.min(shortestMs, ms);
      }
      if (shortestMs === null) return ERRNO_INVAL;
      if (shortestMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, shortestMs);
      }
      let n = 0;
      for (const userdata of clocks) {
        const e = outPtr + n * EVT;
        dv.setBigUint64(e, userdata, true);
        dv.setUint16(e + 8, ERRNO_SUCCESS, true);
        dv.setUint8(e + 10, 0); // eventtype clock
        n++;
      }
      dv.setUint32(neventsPtr, n, true);
      return ERRNO_SUCCESS;
    },

    proc_exit: (code) => {
      sys.exit(code | 0); // throws ProcessExit to unwind _start
    },
  };

  // Remaining WASI P1 surface: provided so instantiation never fails on a missing
  // import, but honestly ENOSYS until implemented.
  const NOT_YET = [
    "fd_advise", "fd_allocate", "fd_datasync",
    "fd_pread", "fd_pwrite", "fd_renumber",
    "fd_sync", "fd_fdstat_set_rights", "proc_raise",
    "sock_accept", "sock_recv", "sock_send", "sock_shutdown", "clock_nanosleep",
  ];
  for (const name of NOT_YET) {
    if (!wasi[name]) wasi[name] = () => ERRNO_NOSYS;
  }

  return { wasi_snapshot_preview1: wasi };
}
