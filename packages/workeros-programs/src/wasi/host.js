// WASI Preview 1 host — the guest runtime that lets an unmodified `wasm32-wasip1`
// binary run as a WorkerOS process (ADR-005: WASI P1 is the ABI floor).
//
// It provides the `wasi_snapshot_preview1` import module: each call reads/writes
// the wasm instance's linear memory and translates to the kernel's `sys` syscalls.
//
// Scope of this first slice (INV-5 — honest, not a silent stub):
//   • stdout/stderr writes, args, environ, clocks, random, and proc_exit work.
//   • Blocking reads and the filesystem (fd_read on a pipe/file, path_open, …)
//     need the SAB *synchronous* syscall channel (ADR-010/-016), which isn't wired
//     yet — `sys.*` here is async but WASI calls must return synchronously. Those
//     calls return `ENOSYS`/EOF for now and are the next WASI increment.
//
// A note on sync vs async: a wasm `_start` runs synchronously to completion, so a
// WASI import must return a value immediately. stdout `fd_write` works because the
// kernel write is fire-and-forget (nwritten is known locally); anything that needs
// a value *back* from the kernel is what's blocked on the sync channel.

// WASI Preview 1 errno subset.
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

// __wasi_filetype_t
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_REGULAR_FILE = 4;

const encoder = new TextEncoder();

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

/**
 * Build the `wasi_snapshot_preview1` import object.
 *
 * @param {object} deps
 * @param {*} deps.sys                 the guest `sys` ABI (write/exit/…)
 * @param {string[]} deps.argv         the program argv (argv[0] = program)
 * @param {Record<string,string>} deps.env
 * @param {() => WebAssembly.Memory} deps.getMemory  the instance's memory (set post-instantiate)
 * @returns {{ wasi_snapshot_preview1: Record<string, Function> }}
 */
export function createWasiImports({ sys, argv, env, getMemory }) {
  const view = () => new DataView(getMemory().buffer);
  const u8 = () => new Uint8Array(getMemory().buffer);

  const envPairs = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);

  // Write a list of C strings as a WASI arg/environ vector: an array of pointers
  // at `ptrPtr` and the NUL-terminated bytes packed at `bufPtr`.
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

  const wasi = {
    args_sizes_get: (countPtr, sizePtr) => sizesOf(argv, countPtr, sizePtr),
    args_get: (argvPtr, bufPtr) => writeStringVec(argv, argvPtr, bufPtr),
    environ_sizes_get: (countPtr, sizePtr) => sizesOf(envPairs, countPtr, sizePtr),
    environ_get: (envPtr, bufPtr) => writeStringVec(envPairs, envPtr, bufPtr),

    clock_res_get: (_id, resPtr) => {
      view().setBigUint64(resPtr, 1000n, true); // 1µs
      return ERRNO_SUCCESS;
    },
    clock_time_get: (_id, _prec, timePtr) => {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true); // ns
      return ERRNO_SUCCESS;
    },
    random_get: (bufPtr, len) => {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      u8().set(bytes, bufPtr);
      return ERRNO_SUCCESS;
    },

    // stdin(0)/stdout(1)/stderr(2) are character devices; everything else is
    // reported as a regular file so std doesn't try to seek stdout.
    fd_fdstat_get: (fd, ptr) => {
      const dv = view();
      dv.setUint8(ptr, fd <= 2 ? FILETYPE_CHARACTER_DEVICE : FILETYPE_REGULAR_FILE);
      dv.setUint16(ptr + 2, 0, true); // fs_flags
      dv.setBigUint64(ptr + 8, 0xffffffffffffffffn, true); // rights_base
      dv.setBigUint64(ptr + 16, 0xffffffffffffffffn, true); // rights_inheriting
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
      sys.write(fd, concat(parts)); // fire-and-forget → nwritten is known locally
      dv.setUint32(nwrittenPtr, total, true);
      return ERRNO_SUCCESS;
    },

    // Reads block on a value from the kernel → need the SAB sync channel. Until
    // then, report EOF (0 bytes) rather than pretend or hang.
    fd_read: (_fd, _iovsPtr, _iovsLen, nreadPtr) => {
      view().setUint32(nreadPtr, 0, true);
      return ERRNO_SUCCESS;
    },
    fd_close: () => ERRNO_SUCCESS,
    fd_fdstat_set_flags: () => ERRNO_SUCCESS,
    fd_seek: (_fd, _off, _whence, newOffPtr) => {
      view().setBigUint64(newOffPtr, 0n, true);
      return ERRNO_SUCCESS;
    },
    fd_tell: (_fd, offPtr) => {
      view().setBigUint64(offPtr, 0n, true);
      return ERRNO_SUCCESS;
    },
    sched_yield: () => ERRNO_SUCCESS,

    // No preopened directories yet → ends wasi-libc's preopen scan.
    fd_prestat_get: () => ERRNO_BADF,
    fd_prestat_dir_name: () => ERRNO_BADF,

    proc_exit: (code) => {
      sys.exit(code | 0); // throws ProcessExit to unwind _start
    },
  };

  // Everything else in the WASI P1 surface is not implemented yet: provide it so
  // instantiation never fails on a missing import, but return ENOSYS honestly.
  const NOT_YET = [
    "fd_advise", "fd_allocate", "fd_datasync", "fd_filestat_get",
    "fd_filestat_set_size", "fd_filestat_set_times", "fd_pread", "fd_pwrite",
    "fd_readdir", "fd_renumber", "fd_sync", "path_create_directory",
    "path_filestat_get", "path_filestat_set_times", "path_link", "path_open",
    "path_readlink", "path_remove_directory", "path_rename", "path_symlink",
    "path_unlink_file", "poll_oneoff", "proc_raise", "sock_accept", "sock_recv",
    "sock_send", "sock_shutdown", "fd_fdstat_set_rights", "clock_nanosleep",
  ];
  for (const name of NOT_YET) {
    if (!wasi[name]) wasi[name] = () => ERRNO_NOSYS;
  }

  return { wasi_snapshot_preview1: wasi };
}
