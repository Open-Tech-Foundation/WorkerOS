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
const ERRNO_NOSYS = 52;
const ERRNO_NOTDIR = 54;

// __wasi_filetype_t
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;

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
      const ft = fd <= 2 ? FILETYPE_CHARACTER_DEVICE : fd === PREOPEN_FD ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE;
      dv.setUint8(ptr, ft);
      dv.setUint16(ptr + 2, 0, true);
      dv.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
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
      sys.write(info ? info.kfd : fd, concat(parts)); // fire-and-forget
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
    path_filestat_get: (_dirfd, _flags, pathPtr, pathLen, ptr) => {
      const path = absPath(readStr(pathPtr, pathLen));
      const r = syncCall("stat", { path }, false);
      if (r.status < 0) return mapErr(r.value);
      writeFilestat(ptr, r.value.kind === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE, r.value.size);
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
    proc_exit: (code) => {
      sys.exit(code | 0); // throws ProcessExit to unwind _start
    },
  };

  // Remaining WASI P1 surface: provided so instantiation never fails on a missing
  // import, but honestly ENOSYS until implemented.
  const NOT_YET = [
    "fd_advise", "fd_allocate", "fd_datasync", "fd_filestat_set_size",
    "fd_filestat_set_times", "fd_pread", "fd_pwrite", "fd_renumber",
    "fd_sync", "fd_fdstat_set_rights", "path_filestat_set_times", "path_link",
    "path_readlink", "path_symlink", "poll_oneoff", "proc_raise",
    "sock_accept", "sock_recv", "sock_send", "sock_shutdown", "clock_nanosleep",
  ];
  for (const name of NOT_YET) {
    if (!wasi[name]) wasi[name] = () => ERRNO_NOSYS;
  }

  return { wasi_snapshot_preview1: wasi };
}
