// An in-memory fake of the kernel's synchronous VFS primitives (`sys.syncFs`),
// for unit-testing the Node `fs` builtin in plain Node — no browser, no SAB, no
// wasm. It mirrors the kernel's contract: methods throw an Error whose message
// carries the kernel errno *name* (Noent/Exist/Isdir/Notdir/Notempty), which is
// exactly what `createFs`'s error mapper keys on.

const enc = new TextEncoder();

const dirOf = (p) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * @param {object} [opts]
 * @param {number} [opts.writeCap] cap a single `write` to this many bytes (to
 *   exercise the caller's chunk loop). Default: unlimited.
 */
export function createFakeSyncFs(opts = {}) {
  const files = new Map(); // path → Uint8Array
  const dirs = new Set(["/"]); // directory paths
  const fds = new Map(); // fd → { path, offset }
  let nextFd = 3;

  const fail = (name) => {
    throw new Error("kernel errno " + name);
  };
  const exists = (p) => files.has(p) || dirs.has(p);

  const setBytes = (path, bytes) => files.set(path, bytes);
  const growWrite = (path, offset, bytes) => {
    const old = files.get(path) || new Uint8Array(0);
    const end = offset + bytes.length;
    const out = new Uint8Array(Math.max(old.length, end));
    out.set(old, 0);
    out.set(bytes, offset);
    setBytes(path, out);
  };

  return {
    _files: files,
    _dirs: dirs,

    open(path, o = {}) {
      if (dirs.has(path)) {
        const fd = nextFd++;
        fds.set(fd, { path, offset: 0, dir: true });
        return fd;
      }
      if (files.has(path)) {
        if (o.create && o.exclusive) fail("Exist");
        if (o.truncate) setBytes(path, new Uint8Array(0));
      } else {
        if (!o.create) fail("Noent");
        if (!dirs.has(dirOf(path))) fail("Noent");
        setBytes(path, new Uint8Array(0));
      }
      const fd = nextFd++;
      fds.set(fd, { path, offset: 0 });
      return fd;
    },
    read(fd, max) {
      const h = fds.get(fd);
      if (!h) fail("Badf");
      const data = files.get(h.path) || new Uint8Array(0);
      const slice = data.slice(h.offset, h.offset + max);
      h.offset += slice.length;
      return slice;
    },
    write(fd, bytes) {
      const h = fds.get(fd);
      if (!h) fail("Badf");
      const n = opts.writeCap ? Math.min(bytes.length, opts.writeCap) : bytes.length;
      growWrite(h.path, h.offset, bytes.subarray(0, n));
      h.offset += n;
      return n;
    },
    close(fd) {
      if (!fds.has(fd)) fail("Badf");
      fds.delete(fd);
    },
    seek(fd, offset, whence) {
      const h = fds.get(fd);
      if (!h) fail("Badf");
      const len = (files.get(h.path) || new Uint8Array(0)).length;
      const base = whence === 2 ? len : whence === 1 ? h.offset : 0;
      h.offset = base + offset;
      return h.offset;
    },
    stat(path) {
      if (dirs.has(path)) return { kind: "dir", size: 0 };
      if (files.has(path)) return { kind: "file", size: files.get(path).length };
      return fail("Noent");
    },
    readdir(path) {
      if (files.has(path)) fail("Notdir");
      if (!dirs.has(path)) fail("Noent");
      const out = [];
      const seen = new Set();
      for (const p of [...files.keys(), ...dirs]) {
        if (p === path) continue;
        if (dirOf(p) === path) {
          const name = nameOf(p);
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({ name, is_dir: dirs.has(p) });
        }
      }
      return out;
    },
    mkdir(path) {
      if (exists(path)) fail("Exist");
      if (!dirs.has(dirOf(path))) fail("Noent");
      dirs.add(path);
    },
    unlink(path) {
      if (dirs.has(path)) fail("Isdir");
      if (!files.has(path)) fail("Noent");
      files.delete(path);
    },
    rmdir(path) {
      if (!dirs.has(path)) fail(files.has(path) ? "Notdir" : "Noent");
      for (const p of [...files.keys(), ...dirs]) if (p !== path && dirOf(p) === path) fail("Notempty");
      dirs.delete(path);
    },
    rename(from, to) {
      if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
      } else if (dirs.has(from)) {
        dirs.delete(from);
        dirs.add(to);
      } else fail("Noent");
    },

    // test helper: seed a file
    _put(path, text) {
      setBytes(path, typeof text === "string" ? enc.encode(text) : text);
    },
  };
}
