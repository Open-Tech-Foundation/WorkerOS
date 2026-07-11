// Node module resolution — the userland home of what must NOT live in the kernel
// (INV-1): the `node_modules` walk, `package.json` `exports`/`module`/`main`,
// subpath exports, extension/index fallbacks, and `node:` builtins. Pure over an
// injected synchronous `fs` + `path` (made possible by the sync-fs channel), so
// `/bin/node` resolves its own graph and the kernel stays a dumb filesystem.
// Shared by the CJS require runtime (`module.js`) and the ESM graph builder
// (`esm-graph.js`).

// Node core modules the guest runtime provides. `node:` is always a builtin (the
// runtime errors if it can't provide it); a bare name is a builtin only if listed.
export const NODE_BUILTINS = new Set([
  "fs",
  "fs/promises",
  "path",
  "path/posix",
  "os",
  "url",
  "module",
  "process",
  "tty",
  "buffer",
  "events",
  "util",
  "net",
  "http",
  "crypto",
]);

export const isBuiltinSpec = (spec) => spec.startsWith("node:") || NODE_BUILTINS.has(spec);

/** The builtin key for a spec (strip the `node:` scheme), or null if not a builtin. */
export const builtinKey = (spec) =>
  spec.startsWith("node:") ? spec.slice(5) : NODE_BUILTINS.has(spec) ? spec : null;

const isRelative = (s) => s.startsWith("./") || s.startsWith("../");

export function createResolver({ fs, path }) {
  const kind = (p) => {
    try {
      return fs.statSync(p).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  };
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  // Pick an ESM target from a conditions value: a string, or the first matching
  // of import/node/default/require (recursively), or the first of a fallback array.
  const pickCondition = (v) => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = pickCondition(x);
        if (r) return r;
      }
      return null;
    }
    if (v && typeof v === "object") {
      for (const c of ["import", "node", "default", "require"]) {
        if (c in v) {
          const r = pickCondition(v[c]);
          if (r) return r;
        }
      }
    }
    return null;
  };

  const resolveWildcard = (map, subpath) => {
    for (const [k, v] of Object.entries(map)) {
      if (k.endsWith("*")) {
        const prefix = k.slice(0, -1);
        if (subpath.startsWith(prefix)) {
          const t = pickCondition(v);
          if (t) return t.replace("*", subpath.slice(prefix.length));
        }
      }
    }
    return null;
  };

  // Resolve a subpath ("." or "./sub") against a package `exports` value.
  const resolveExport = (exports, subpath) => {
    if (typeof exports === "string") return subpath === "." ? exports : null;
    if (exports && typeof exports === "object") {
      const isSubpathMap = Object.keys(exports).some((k) => k.startsWith("."));
      if (isSubpathMap) {
        if (subpath in exports) return pickCondition(exports[subpath]);
        return resolveWildcard(exports, subpath);
      }
      return subpath === "." ? pickCondition(exports) : null;
    }
    return null;
  };

  // The package "." entry: exports["."] (ESM conditions), else module, else main.
  const pickEntry = (pkg) => {
    if (pkg.exports != null) {
      const t = resolveExport(pkg.exports, ".");
      if (t) return t;
    }
    return pkg.module || pkg.main || null;
  };

  const resolveFile = (p) => {
    if (kind(p) === "file") return p;
    for (const ext of [".js", ".mjs", ".cjs", ".json"]) {
      if (kind(p + ext) === "file") return p + ext;
    }
    if (kind(p) === "dir") return resolveDir(p);
    return null;
  };

  const resolveDir = (dir) => {
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg) {
      const t = pickEntry(pkg);
      if (t) {
        const r = resolveFile(path.join(dir, t));
        if (r) return r;
      }
    }
    for (const idx of ["index.js", "index.mjs", "index.cjs", "index.json"]) {
      const r = path.join(dir, idx);
      if (kind(r) === "file") return r;
    }
    return null;
  };

  // Split a bare specifier into [name, subpath], handling @scope/name.
  const splitPackage = (spec) => {
    const from = spec.startsWith("@") ? spec.indexOf("/") + 1 || spec.length : 0;
    const rel = spec.slice(from).indexOf("/");
    if (rel === -1) return [spec, ""];
    const idx = from + rel;
    return [spec.slice(0, idx), spec.slice(idx + 1)];
  };

  const resolveInPackage = (pkgDir, sub) => {
    const pkg = readJson(path.join(pkgDir, "package.json"));
    if (!sub) {
      if (pkg) {
        const t = pickEntry(pkg);
        if (t) {
          const r = resolveFile(path.join(pkgDir, t));
          if (r) return r;
        }
      }
      return resolveDir(pkgDir);
    }
    // A subpath: honor a subpath `exports` map if present (exports seals the
    // package), else resolve it as a plain file under the package.
    if (
      pkg &&
      pkg.exports &&
      typeof pkg.exports === "object" &&
      Object.keys(pkg.exports).some((k) => k.startsWith("."))
    ) {
      const t = resolveExport(pkg.exports, "./" + sub);
      return t ? resolveFile(path.join(pkgDir, t)) : null;
    }
    return resolveFile(path.join(pkgDir, sub));
  };

  // Walk `node_modules` from fromDir up to `/`.
  const resolveBare = (fromDir, spec) => {
    const [name, sub] = splitPackage(spec);
    let dir = fromDir;
    for (;;) {
      const pkgDir = path.join(dir, "node_modules", name);
      if (kind(pkgDir) === "dir") {
        const r = resolveInPackage(pkgDir, sub);
        if (r) return r;
      }
      if (dir === "/") return null;
      dir = path.dirname(dir);
    }
  };

  // Resolve a `#`-prefixed package-internal import against the nearest enclosing
  // package.json `imports` map (Node subpath imports — the sibling of `exports`,
  // scoped to the defining package). The map is keyed on `#name`/`#name/*`; a
  // target may be a relative file (rooted at that package) or another bare spec.
  // Chalk v5 needs this: its source does `import '#ansi-styles'`/`'#supports-color'`.
  const resolveImports = (fromDir, spec) => {
    let dir = fromDir;
    for (;;) {
      const pkg = readJson(path.join(dir, "package.json"));
      // The nearest package.json defines the scope (Node stops here whether or not
      // it matches); resolving against an ancestor's imports would cross packages.
      if (pkg) {
        const map = pkg.imports;
        if (map && typeof map === "object") {
          const t = spec in map ? pickCondition(map[spec]) : resolveWildcard(map, spec);
          if (t) return isRelative(t) ? resolveFile(path.join(dir, t)) : resolveBare(dir, t);
        }
        return null;
      }
      if (dir === "/") return null;
      dir = path.dirname(dir);
    }
  };

  const resolveFrom = (fromDir, spec) => {
    if (spec.startsWith("#")) return resolveImports(fromDir, spec);
    if (spec.startsWith("/")) return resolveFile(path.normalize(spec));
    if (isRelative(spec)) return resolveFile(path.join(fromDir, spec));
    return resolveBare(fromDir, spec);
  };

  return { resolveFile, resolveDir, resolveBare, resolveImports, resolveFrom, pickEntry };
}
