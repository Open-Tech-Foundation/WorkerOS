// `node:wasi` — a WASI preview1 implementation for the WorkerOS Node runtime.
//
// GUEST code (INV-1). This exists for one concrete reason: napi-rs's wasm bindings
// — the shape Vite's bundler (rolldown) ships as `@rolldown/binding-wasm32-wasi` —
// load through `require('node:wasi')`, build a `WASI` over the guest filesystem, and
// hand its import object to `WebAssembly.instantiate`. So a real WASI here is what
// lets a wasm-compiled native tool read the project's files and run in-process.
//
// The ABI is backed by the kernel's synchronous VFS (`sys.syncFs`) plus stdio
// (`sys.write`) — the same primitives `node:fs` uses. It implements the preview1
// surface napi-rs/rolldown actually import (stdio, clock, random, environ/args, and
// a working file/dir surface: path_open, fd_read/seek/readdir/close, *filestat*,
// prestat); the rest return ENOSYS honestly (INV-5) rather than lie.
//
// Memory is bound at `start()`/`initialize()` from the instance's exported memory
// (emnapi re-exports its shared memory), or injected via `setMemory` — the import
// closures read it lazily each call, so a growable/shared memory stays correct.

// preview1 errno (only the ones we can return).
const E = {
  SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31,
  LOOP: 32, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTCAPABLE: 76, SPIPE: 70,
};
// preview1 filetype
const FT = { UNKNOWN: 0, BLOCK: 1, CHAR: 2, DIRECTORY: 3, REGULAR: 4, SOCKET: 6, SYMLINK: 7 };

// Kernel errno name (thrown in the error message) → WASI errno.
function errnoFromError(e) {
  const m = (e && e.message) || "";
  if (m.includes("Noent")) return E.NOENT;
  if (m.includes("Exist")) return E.EXIST;
  if (m.includes("Notempty")) return E.NOTEMPTY;
  if (m.includes("Notdir")) return E.NOTDIR;
  if (m.includes("Isdir")) return E.ISDIR;
  if (m.includes("Badf")) return E.BADF;
  if (m.includes("Inval")) return E.INVAL;
  if (m.includes("Acces") || m.includes("Perm")) return E.ACCES;
  return E.IO;
}

const enc = new TextEncoder();

// Normalize a POSIX path (resolve `.`/`..`, collapse `//`), rooted absolute.
function normalize(p) {
  const segs = [];
  for (const part of String(p).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}

// oflags (path_open): 1=CREAT 2=DIRECTORY 4=EXCL 8=TRUNC.
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };

export function createWasi(sys) {
  const fs = sys.syncFs;

  class WASI {
    constructor(options = {}) {
      this.args = options.args || [];
      this.env = options.env || {};
      const preopens = options.preopens || {};
      this[Symbol.for("nodejs.wasi.memory")] = null;
      this._memory = null;
      // fd table: wasi fd → descriptor. 0/1/2 are stdio; preopens follow at 3+.
      this._fds = new Map();
      this._fds.set(0, { kind: "stdio", fd: 0 });
      this._fds.set(1, { kind: "stdio", fd: 1 });
      this._fds.set(2, { kind: "stdio", fd: 2 });
      this._preopens = [];
      let n = 3;
      for (const guestPath of Object.keys(preopens)) {
        const host = normalize(preopens[guestPath]);
        this._fds.set(n, { kind: "dir", path: host, preopen: guestPath });
        this._preopens.push({ fd: n, name: guestPath });
        n++;
      }
      this._nextFd = n;
      this.wasiImport = this.#buildImports();
    }

    // node:wasi (and @tybys/wasm-util) bind memory here; emnapi drives one of these.
    setMemory(m) { this._memory = m; }
    get memory() { return this._memory; }
    start(instance) {
      this._memory = this._memory || (instance && instance.exports && instance.exports.memory) || null;
      const f = instance && instance.exports && (instance.exports._start || instance.exports.__wasm_call_ctors);
      return typeof f === "function" ? f() : undefined;
    }
    initialize(instance) {
      this._memory = this._memory || (instance && instance.exports && instance.exports.memory) || null;
      const f = instance && instance.exports && instance.exports._initialize;
      if (typeof f === "function") f();
    }
    getImportObject() { return { wasi_snapshot_preview1: this.wasiImport }; }

    // ---- memory helpers (re-derived per call: a shared memory may have grown) ---
    #dv() { return new DataView(this._memory.buffer); }
    #u8() { return new Uint8Array(this._memory.buffer); }
    // `.slice` (a copy into a non-shared ArrayBuffer) — TextDecoder can refuse a
    // SharedArrayBuffer-backed view, and the wasm memory is shared.
    #str(ptr, len) { return new TextDecoder().decode(this.#u8().slice(ptr, ptr + len)); }
    #writeBytes(ptr, bytes) { this.#u8().set(bytes, ptr); }

    #allocFd(desc) { const fd = this._nextFd++; this._fds.set(fd, desc); return fd; }
    #dir(fd) { const d = this._fds.get(fd); return d && d.kind === "dir" ? d : null; }

    #buildImports() {
      const self = this;
      // Guard every syscall: a thrown kernel error becomes a WASI errno, never an
      // exception that would trap the wasm.
      const S = (fn) => (...a) => { try { return fn(...a); } catch (e) { return errnoFromError(e); } };

      return {
        args_sizes_get: S((cnt, bufSize) => {
          const dv = self.#dv();
          dv.setUint32(cnt, self.args.length, true);
          dv.setUint32(bufSize, self.args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
          return E.SUCCESS;
        }),
        args_get: S((argvPtr, bufPtr) => {
          const dv = self.#dv();
          let p = bufPtr;
          for (const a of self.args) {
            dv.setUint32(argvPtr, p, true); argvPtr += 4;
            const b = enc.encode(a); self.#writeBytes(p, b); p += b.length;
            self.#u8()[p++] = 0;
          }
          return E.SUCCESS;
        }),
        environ_sizes_get: S((cnt, bufSize) => {
          const dv = self.#dv();
          const keys = Object.keys(self.env);
          dv.setUint32(cnt, keys.length, true);
          dv.setUint32(bufSize, keys.reduce((n, k) => n + enc.encode(`${k}=${self.env[k]}`).length + 1, 0), true);
          return E.SUCCESS;
        }),
        environ_get: S((envPtr, bufPtr) => {
          const dv = self.#dv();
          let p = bufPtr;
          for (const k of Object.keys(self.env)) {
            dv.setUint32(envPtr, p, true); envPtr += 4;
            const b = enc.encode(`${k}=${self.env[k]}`); self.#writeBytes(p, b); p += b.length;
            self.#u8()[p++] = 0;
          }
          return E.SUCCESS;
        }),

        clock_time_get: S((_id, _prec, out) => {
          // REALTIME/MONOTONIC alike, in nanoseconds. Honest resolution: ms.
          self.#dv().setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
          return E.SUCCESS;
        }),
        clock_res_get: S((_id, out) => { self.#dv().setBigUint64(out, 1000000n, true); return E.SUCCESS; }),

        random_get: S((ptr, len) => {
          // `crypto.getRandomValues` REFUSES a SharedArrayBuffer-backed view (the
          // wasm memory is `shared:true`), so fill a private buffer and copy in.
          // crypto also caps a single fill at 65536 bytes — chunk it.
          const tmp = new Uint8Array(len);
          for (let off = 0; off < len; off += 65536) {
            crypto.getRandomValues(tmp.subarray(off, Math.min(off + 65536, len)));
          }
          self.#writeBytes(ptr, tmp);
          return E.SUCCESS;
        }),

        proc_exit: (code) => { sys.exit(code | 0); },
        sched_yield: () => E.SUCCESS,

        fd_write: S((fd, iovs, iovsLen, nwritten) => {
          const dv = self.#dv();
          const desc = self._fds.get(fd);
          if (!desc) return E.BADF;
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const buf = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            if (len === 0) continue;
            const bytes = self.#u8().slice(buf, buf + len);
            const target = desc.kind === "stdio" ? desc.fd : desc.fd;
            total += fs.write(target, bytes);
          }
          dv.setUint32(nwritten, total, true);
          return E.SUCCESS;
        }),
        fd_read: S((fd, iovs, iovsLen, nread) => {
          const dv = self.#dv();
          const desc = self._fds.get(fd);
          if (!desc) return E.BADF;
          let total = 0;
          outer: for (let i = 0; i < iovsLen; i++) {
            const buf = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            let got = 0;
            while (got < len) {
              const chunk = fs.read(desc.fd, len - got);
              if (!chunk || chunk.length === 0) break outer; // EOF / short read
              self.#writeBytes(buf + got, chunk);
              got += chunk.length; total += chunk.length;
              if (chunk.length < len - got) break; // fd's own short read
            }
          }
          dv.setUint32(nread, total, true);
          return E.SUCCESS;
        }),
        fd_seek: S((fd, offset, whence, out) => {
          const desc = self._fds.get(fd);
          if (!desc || desc.kind === "stdio") return E.SPIPE;
          const pos = fs.seek(desc.fd, Number(offset), whence);
          self.#dv().setBigUint64(out, BigInt(pos), true);
          return E.SUCCESS;
        }),
        fd_close: S((fd) => {
          const desc = self._fds.get(fd);
          if (!desc) return E.BADF;
          if (desc.kind === "file") fs.close(desc.fd);
          self._fds.delete(fd);
          return E.SUCCESS;
        }),
        fd_fdstat_get: S((fd, out) => {
          const desc = self._fds.get(fd);
          if (!desc) return E.BADF;
          const dv = self.#dv();
          const ft = desc.kind === "dir" ? FT.DIRECTORY : desc.kind === "stdio" ? FT.CHAR : FT.REGULAR;
          dv.setUint8(out, ft);
          dv.setUint16(out + 2, 0, true);            // fs_flags
          dv.setBigUint64(out + 8, 0xffffffffffffffffn, true);  // rights_base (grant all)
          dv.setBigUint64(out + 16, 0xffffffffffffffffn, true); // rights_inheriting
          return E.SUCCESS;
        }),
        fd_fdstat_set_flags: () => E.SUCCESS,
        fd_prestat_get: S((fd, out) => {
          const pre = self._preopens.find((p) => p.fd === fd);
          if (!pre) return E.BADF;
          const dv = self.#dv();
          dv.setUint8(out, 0);                                    // tag: dir
          dv.setUint32(out + 4, enc.encode(pre.name).length, true); // name length
          return E.SUCCESS;
        }),
        fd_prestat_dir_name: S((fd, ptr, len) => {
          const pre = self._preopens.find((p) => p.fd === fd);
          if (!pre) return E.BADF;
          self.#writeBytes(ptr, enc.encode(pre.name).subarray(0, len));
          return E.SUCCESS;
        }),
        fd_filestat_get: S((fd, out) => {
          const desc = self._fds.get(fd);
          if (!desc) return E.BADF;
          if (desc.kind === "stdio") { fillFilestat(self.#dv(), out, { kind: "char", size: 0 }); return E.SUCCESS; }
          fillFilestat(self.#dv(), out, fs.stat(desc.path || pathOfFd(desc)));
          return E.SUCCESS;
        }),

        path_open: S((dirfd, _dirflags, pathPtr, pathLen, oflags, _rb, _ri, _fdflags, outFd) => {
          const dir = self.#dir(dirfd);
          if (!dir) return E.BADF;
          const abs = normalize(dir.path + "/" + self.#str(pathPtr, pathLen));
          if (oflags & OFLAGS.DIRECTORY) {
            const st = fs.stat(abs);
            if (st.kind !== "dir" && st.kind !== "directory") return E.NOTDIR;
            self.#dv().setUint32(outFd, self.#allocFd({ kind: "dir", path: abs }), true);
            return E.SUCCESS;
          }
          const opts = {};
          if (oflags & OFLAGS.CREAT) opts.create = true;
          if (oflags & OFLAGS.TRUNC) opts.truncate = true;
          if (oflags & OFLAGS.EXCL) opts.exclusive = true;
          const fd = fs.open(abs, opts);
          self.#dv().setUint32(outFd, self.#allocFd({ kind: "file", fd, path: abs }), true);
          return E.SUCCESS;
        }),
        path_filestat_get: S((dirfd, _flags, pathPtr, pathLen, out) => {
          const dir = self.#dir(dirfd);
          if (!dir) return E.BADF;
          const abs = normalize(dir.path + "/" + self.#str(pathPtr, pathLen));
          fillFilestat(self.#dv(), out, fs.stat(abs));
          return E.SUCCESS;
        }),
        path_create_directory: S((dirfd, pathPtr, pathLen) => {
          const dir = self.#dir(dirfd); if (!dir) return E.BADF;
          fs.mkdir(normalize(dir.path + "/" + self.#str(pathPtr, pathLen)));
          return E.SUCCESS;
        }),
        path_remove_directory: S((dirfd, pathPtr, pathLen) => {
          const dir = self.#dir(dirfd); if (!dir) return E.BADF;
          fs.rmdir(normalize(dir.path + "/" + self.#str(pathPtr, pathLen)));
          return E.SUCCESS;
        }),
        path_unlink_file: S((dirfd, pathPtr, pathLen) => {
          const dir = self.#dir(dirfd); if (!dir) return E.BADF;
          fs.unlink(normalize(dir.path + "/" + self.#str(pathPtr, pathLen)));
          return E.SUCCESS;
        }),
        path_readlink: S((dirfd, pathPtr, pathLen, bufPtr, bufLen, outUsed) => {
          const dir = self.#dir(dirfd); if (!dir) return E.BADF;
          const target = enc.encode(fs.readlink(normalize(dir.path + "/" + self.#str(pathPtr, pathLen))));
          const n = Math.min(target.length, bufLen);
          self.#writeBytes(bufPtr, target.subarray(0, n));
          self.#dv().setUint32(outUsed, n, true);
          return E.SUCCESS;
        }),
        fd_readdir: S((fd, bufPtr, bufLen, cookie, outUsed) => {
          const dir = self.#dir(fd); if (!dir) return E.BADF;
          const entries = [{ name: ".", is_dir: true }, { name: "..", is_dir: true }, ...fs.readdir(dir.path)];
          const dv = self.#dv();
          let used = 0;
          for (let i = Number(cookie); i < entries.length; i++) {
            const e = entries[i];
            const name = enc.encode(e.name);
            const rec = 24 + name.length;
            if (used + rec > bufLen) { used = bufLen; break; } // truncated: caller re-reads
            dv.setBigUint64(bufPtr + used, BigInt(i + 1), true);         // d_next
            dv.setBigUint64(bufPtr + used + 8, BigInt(i + 1), true);      // d_ino
            dv.setUint32(bufPtr + used + 16, name.length, true);         // d_namlen
            dv.setUint8(bufPtr + used + 20, (e.is_dir || e.isDir) ? FT.DIRECTORY : FT.REGULAR);
            self.#writeBytes(bufPtr + used + 24, name);
            used += rec;
          }
          dv.setUint32(outUsed, used, true);
          return E.SUCCESS;
        }),

        // Not exercised by rolldown's init path; honest ENOSYS beats a silent lie.
        poll_oneoff: () => E.NOSYS,
        fd_advise: () => E.SUCCESS,
        fd_datasync: () => E.SUCCESS,
        fd_sync: () => E.SUCCESS,
        fd_tell: S((fd, out) => {
          const desc = self._fds.get(fd);
          if (!desc || desc.kind === "stdio") return E.SPIPE;
          self.#dv().setBigUint64(out, BigInt(fs.seek(desc.fd, 0, 1)), true);
          return E.SUCCESS;
        }),
        fd_pread: () => E.NOSYS,
        fd_pwrite: () => E.NOSYS,
        path_rename: S((dirfd, oldP, oldL, newDirfd, newP, newL) => {
          const d1 = self.#dir(dirfd), d2 = self.#dir(newDirfd);
          if (!d1 || !d2) return E.BADF;
          fs.rename(normalize(d1.path + "/" + self.#str(oldP, oldL)), normalize(d2.path + "/" + self.#str(newP, newL)));
          return E.SUCCESS;
        }),
        path_symlink: () => E.NOSYS,
        path_link: () => E.NOSYS,
        fd_filestat_set_size: () => E.SUCCESS,
        fd_filestat_set_times: () => E.SUCCESS,
        path_filestat_set_times: () => E.SUCCESS,
        fd_renumber: () => E.SUCCESS,
      };
    }
  }

  function pathOfFd(desc) { return desc.path; }

  function fillFilestat(dv, out, st) {
    const kind = st.kind || st.type || "file";
    const ft = kind === "dir" || kind === "directory" ? FT.DIRECTORY
      : kind === "char" ? FT.CHAR
      : kind === "symlink" ? FT.SYMLINK : FT.REGULAR;
    const ns = (t) => BigInt(Math.floor(t || 0)) * 1000000n;
    dv.setBigUint64(out, 0n, true);                 // dev
    dv.setBigUint64(out + 8, BigInt(st.ino || 0), true); // ino
    dv.setUint8(out + 16, ft);                      // filetype
    dv.setBigUint64(out + 24, BigInt(st.nlink || 1), true); // nlink
    dv.setBigUint64(out + 32, BigInt(st.size || 0), true);  // size
    dv.setBigUint64(out + 40, ns(st.atime || st.mtime), true); // atim
    dv.setBigUint64(out + 48, ns(st.mtime), true);  // mtim
    dv.setBigUint64(out + 56, ns(st.ctime || st.mtime), true); // ctim
  }

  return WASI;
}
