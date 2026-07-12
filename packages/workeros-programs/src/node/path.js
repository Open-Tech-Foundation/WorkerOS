// `node:path` (posix) — a filesystem builtin for the WorkerOS Node runtime.
//
// GUEST code (INV-1). WorkerOS has a single posix-style VFS, so this is the posix
// variant only (`path.win32` is intentionally absent). Pure string logic — no
// syscalls — so it is fully unit-testable on its own.

function normalizeArray(parts, allowAboveRoot) {
  const res = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (res.length && res[res.length - 1] !== "..") res.pop();
      else if (allowAboveRoot) res.push("..");
    } else res.push(p);
  }
  return res;
}

export function createPath() {
  const path = {
    sep: "/",
    delimiter: ":",

    isAbsolute(p) {
      return typeof p === "string" && p.charCodeAt(0) === 47; // '/'
    },

    normalize(p) {
      if (p === "") return ".";
      const isAbs = path.isAbsolute(p);
      const trailing = p.length > 1 && p.endsWith("/");
      let out = normalizeArray(p.split("/"), !isAbs).join("/");
      if (!out && !isAbs) out = ".";
      if (out && trailing) out += "/";
      return (isAbs ? "/" : "") + out;
    },

    join(...parts) {
      const joined = parts.filter((p) => typeof p === "string" && p.length > 0).join("/");
      return joined === "" ? "." : path.normalize(joined);
    },

    resolve(...parts) {
      let resolved = "";
      let isAbs = false;
      for (let i = parts.length - 1; i >= 0 && !isAbs; i--) {
        const p = parts[i];
        if (typeof p !== "string" || p === "") continue;
        resolved = p + "/" + resolved;
        isAbs = path.isAbsolute(p);
      }
      const out = normalizeArray(resolved.split("/"), !isAbs).join("/");
      if (isAbs) return "/" + out;
      return out === "" ? "." : out;
    },

    dirname(p) {
      if (p.length === 0) return ".";
      const hasRoot = p.charCodeAt(0) === 47;
      let end = -1;
      let sawNonSep = false;
      for (let i = p.length - 1; i >= 1; i--) {
        if (p.charCodeAt(i) === 47) {
          if (sawNonSep) { end = i; break; }
        } else sawNonSep = true;
      }
      if (end === -1) return hasRoot ? "/" : ".";
      if (hasRoot && end === 1) return "//";
      return p.slice(0, end);
    },

    basename(p, ext) {
      let start = 0;
      let end = -1;
      let sawNonSep = false;
      for (let i = p.length - 1; i >= 0; i--) {
        if (p.charCodeAt(i) === 47) {
          if (sawNonSep) { start = i + 1; break; }
        } else {
          if (end === -1) { sawNonSep = true; end = i + 1; }
        }
      }
      if (end === -1) return "";
      let base = p.slice(start, end);
      if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, base.length - ext.length);
      return base;
    },

    extname(p) {
      const base = path.basename(p);
      const dot = base.lastIndexOf(".");
      return dot <= 0 ? "" : base.slice(dot);
    },

    relative(from, to) {
      const f = path.resolve(from).split("/").filter(Boolean);
      const t = path.resolve(to).split("/").filter(Boolean);
      let i = 0;
      while (i < f.length && i < t.length && f[i] === t[i]) i++;
      const up = f.slice(i).map(() => "..");
      return [...up, ...t.slice(i)].join("/");
    },

    parse(p) {
      const root = path.isAbsolute(p) ? "/" : "";
      const base = path.basename(p);
      const ext = path.extname(base);
      const dir = path.dirname(p);
      return { root, dir: dir === "." && root === "" ? "" : dir, base, ext, name: base.slice(0, base.length - ext.length) };
    },

    format(obj) {
      const dir = obj.dir || obj.root || "";
      const base = obj.base || (obj.name || "") + (obj.ext || "");
      if (!dir) return base;
      if (dir === obj.root) return dir + base;
      return dir + "/" + base;
    },
  };
  path.posix = path;

  // Windows path semantics. WorkerOS is posix, but npm and other cross-platform
  // tooling call `path.win32.*` defensively — e.g. `win32.isAbsolute`/`win32.parse`
  // to recognize Windows-style paths. Both '/' and '\' are separators; drive
  // letters (`C:`) and root (`\`) are recognized; output uses '\'. Guest paths are
  // posix, so these mostly inspect posix input and return sane results.
  const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const reSepW = /[\\/]+/;
  const win = {
    sep: "\\",
    delimiter: ";",

    isAbsolute(p) {
      if (typeof p !== "string" || p.length === 0) return false;
      const c0 = p.charCodeAt(0);
      if (c0 === 47 || c0 === 92) return true; // '/' or '\'
      return p.length >= 3 && isLetter(c0) && p.charCodeAt(1) === 58 &&
        (p.charCodeAt(2) === 47 || p.charCodeAt(2) === 92); // 'C:\' or 'C:/'
    },

    // Root prefix: "", "C:", "C:\\", or "\\".
    _root(p) {
      if (p.length === 0) return "";
      const c0 = p.charCodeAt(0);
      if (isLetter(c0) && p.charCodeAt(1) === 58) {
        return p.length >= 3 && (p.charCodeAt(2) === 47 || p.charCodeAt(2) === 92)
          ? p.slice(0, 2) + "\\" : p.slice(0, 2);
      }
      return c0 === 47 || c0 === 92 ? "\\" : "";
    },

    normalize(p) {
      if (p === "") return ".";
      const root = win._root(p);
      const abs = root.endsWith("\\");
      const trailing = p.length > 1 && (p.endsWith("/") || p.endsWith("\\"));
      let out = normalizeArray(p.slice(root.length).split(reSepW), !abs && !root).join("\\");
      if (!out && !root) out = ".";
      if (out && trailing) out += "\\";
      return root + out;
    },

    join(...parts) {
      const joined = parts.filter((p) => typeof p === "string" && p.length > 0).join("\\");
      return joined === "" ? "." : win.normalize(joined);
    },

    resolve(...parts) {
      let resolved = "";
      let abs = false;
      for (let i = parts.length - 1; i >= 0 && !abs; i--) {
        const p = parts[i];
        if (typeof p !== "string" || p === "") continue;
        resolved = p + "\\" + resolved;
        abs = win.isAbsolute(p);
      }
      if (!abs) resolved = "C:\\" + resolved; // Node anchors to the cwd drive
      const root = win._root(resolved);
      const out = normalizeArray(resolved.slice(root.length).split(reSepW), false).join("\\");
      return root + out || root;
    },

    basename(p, ext) {
      const segs = p.split(reSepW).filter(Boolean);
      let base = segs.length ? segs[segs.length - 1] : "";
      if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, base.length - ext.length);
      return base;
    },

    dirname(p) {
      const root = win._root(p);
      const segs = p.slice(root.length).split(reSepW).filter(Boolean);
      if (segs.length <= 1) return root || ".";
      return root + segs.slice(0, -1).join("\\");
    },

    extname(p) {
      const base = win.basename(p);
      const dot = base.lastIndexOf(".");
      return dot <= 0 ? "" : base.slice(dot);
    },

    relative(from, to) {
      const f = win.resolve(from).split(reSepW).filter(Boolean);
      const t = win.resolve(to).split(reSepW).filter(Boolean);
      let i = 0;
      while (i < f.length && i < t.length && f[i].toLowerCase() === t[i].toLowerCase()) i++;
      return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("\\");
    },

    parse(p) {
      const root = win._root(p);
      const base = win.basename(p);
      const ext = win.extname(base);
      const dir = win.dirname(p);
      return { root, dir: dir === "." && !root ? "" : dir, base, ext, name: base.slice(0, base.length - ext.length) };
    },

    format(obj) {
      const dir = obj.dir || obj.root || "";
      const base = obj.base || (obj.name || "") + (obj.ext || "");
      if (!dir) return base;
      if (dir === obj.root) return dir + base;
      return dir + "\\" + base;
    },

    toNamespacedPath(p) { return p; },
  };
  win.posix = path;
  win.win32 = win;
  path.win32 = win;
  path.toNamespacedPath = (p) => p;
  return path;
}
