// `node:module` — CommonJS module utilities for the WorkerOS Node runtime.
//
// GUEST code (INV-1). The headline is `createRequire(filename)`: a *synchronous*
// `require` for arbitrary CJS modules, made possible now that the VFS has a
// synchronous `fs` (PLAN Phase 5·A). Unlike the ahead-of-time prefetch runtime
// (`require-runtime.js`, which must scan+read the whole graph before running so a
// sync `require` can hit an in-memory cache), this resolves + reads + evaluates
// each module on demand via `fs.*Sync`. So computed requires (`require(name)`)
// and `createRequire(import.meta.url)('pkg')` — the thing tools like `esbuild`'s
// launcher need — just work. Node CJS resolution subset: relative + `node_modules`
// walk, `.js`/`.cjs`/`.json` + `index`, package.json `exports`(".")/`main`, and
// the core `node:` builtins. Pure over an injected `fs`/`path`/`url` — unit-testable.

const isRelative = (s) => s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
const builtinKey = (spec) => (spec.startsWith("node:") ? spec.slice(5) : spec);

function moduleNotFound(spec, fromDir) {
  const e = new Error(`Cannot find module '${spec}' from '${fromDir}'`);
  e.code = "MODULE_NOT_FOUND";
  return e;
}

export function createModule({ fs, path, url, builtins }) {
  const cache = new Map(); // absPath → module.exports

  const kind = (p) => {
    try {
      return fs.statSync(p).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  };

  // The CJS entry a package.json points at: exports["."] require/default, then main.
  const pickMain = (pkg) => {
    const e = pkg.exports;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const dot = e["."] ?? e;
      if (typeof dot === "string") return dot;
      if (dot && typeof dot === "object") {
        const c = dot.require ?? dot.node ?? dot.default;
        if (typeof c === "string") return c;
      }
    }
    return pkg.main || "index.js";
  };

  // Resolve a path with extension + index fallbacks (Node CJS rules, subset).
  const resolveFile = (p) => {
    if (kind(p) === "file") return p;
    for (const ext of [".js", ".cjs", ".json"]) if (kind(p + ext) === "file") return p + ext;
    if (kind(p) === "dir") {
      const pkgPath = path.join(p, "package.json");
      if (kind(pkgPath) === "file") {
        const main = pickMain(JSON.parse(fs.readFileSync(pkgPath, "utf8")));
        if (main) {
          const r = resolveFile(path.join(p, main));
          if (r) return r;
        }
      }
      for (const idx of ["index.js", "index.cjs", "index.json"]) {
        const r = path.join(p, idx);
        if (kind(r) === "file") return r;
      }
    }
    return null;
  };

  const resolveBare = (spec, fromDir) => {
    const at = spec[0] === "@";
    const slash = spec.indexOf("/", at ? spec.indexOf("/") + 1 : 0);
    const name = slash === -1 ? spec : spec.slice(0, slash);
    const sub = slash === -1 ? "" : spec.slice(slash + 1);
    let dir = fromDir;
    for (;;) {
      const pkgDir = path.join(dir, "node_modules", name);
      if (kind(pkgDir) === "dir") {
        const r = resolveFile(sub ? path.join(pkgDir, sub) : pkgDir);
        if (r) return r;
      }
      if (dir === "/") break;
      dir = path.dirname(dir);
    }
    return null;
  };

  const resolveFrom = (spec, fromDir) =>
    isRelative(spec) ? resolveFile(path.join(fromDir, spec)) : resolveBare(spec, fromDir);

  // Node exposes require.cache keyed by filename → a { exports } record.
  const cacheProxy = new Proxy(
    {},
    {
      get: (_, k) =>
        cache.has(k) ? { id: k, filename: k, exports: cache.get(k), loaded: true } : undefined,
      has: (_, k) => cache.has(k),
      deleteProperty: (_, k) => (cache.delete(k), true),
      ownKeys: () => [...cache.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );

  function load(absPath) {
    if (cache.has(absPath)) return cache.get(absPath);
    if (absPath.endsWith(".json")) {
      const val = JSON.parse(fs.readFileSync(absPath, "utf8"));
      cache.set(absPath, val);
      return val;
    }
    const module = {
      exports: {},
      id: absPath,
      filename: absPath,
      path: path.dirname(absPath),
      loaded: false,
    };
    cache.set(absPath, module.exports); // seed before eval for require cycles
    const require = makeRequire(module.path);
    const source = fs.readFileSync(absPath, "utf8");
    const fn = new Function("require", "module", "exports", "__dirname", "__filename", source);
    fn(require, module, module.exports, module.path, absPath);
    module.loaded = true;
    cache.set(absPath, module.exports);
    return module.exports;
  }

  function makeRequire(fromDir) {
    const require = (spec) => {
      const b = builtins.get(builtinKey(spec));
      if (b) return b;
      const abs = resolveFrom(spec, fromDir);
      if (!abs) throw moduleNotFound(spec, fromDir);
      return load(abs);
    };
    require.resolve = (spec) => {
      if (builtins.has(builtinKey(spec))) return spec;
      const abs = resolveFrom(spec, fromDir);
      if (!abs) throw moduleNotFound(spec, fromDir);
      return abs;
    };
    require.cache = cacheProxy;
    require.main = undefined;
    require.extensions = { ".js": null, ".json": null, ".cjs": null };
    return require;
  }

  const toPath = (from) => {
    if (from && typeof from === "object" && "href" in from) return url.fileURLToPath(from);
    const s = String(from);
    return s.startsWith("file://") ? url.fileURLToPath(s) : s;
  };

  // Node: createRequire(filename) — a require whose relative resolution is rooted
  // at the filename's *directory* (accepts a path, a file: URL string, or a URL).
  const createRequire = (from) => {
    const p = toPath(from);
    const dir = kind(p) === "dir" ? p : path.dirname(p);
    return makeRequire(dir);
  };

  const isBuiltin = (name) => builtins.has(builtinKey(name));

  const mod = {
    createRequire,
    // Computed after the registry is fully populated (see makeBuiltins): the
    // "module" key is pre-seeded there so it counts itself.
    builtinModules: [...builtins.keys()],
    isBuiltin,
    syncRequire: makeRequire, // internal: a require rooted at an arbitrary dir
    _load: load, // internal: load a CJS module by absolute path (ESM-graph interop)
    wrap: (src) =>
      "(function (exports, require, module, __filename, __dirname) { " + src + "\n});",
    _cache: cacheProxy,
    _resolveFilename: (spec, parent) => {
      if (isBuiltin(spec)) return spec;
      const dir = parent && parent.path ? parent.path : "/";
      const abs = resolveFrom(spec, dir);
      if (!abs) throw moduleNotFound(spec, dir);
      return abs;
    },
  };
  // Both `require('module').createRequire` and `require('module').Module.createRequire`
  // are used in the wild; `default` covers ESM-interop importers.
  mod.Module = mod;
  mod.default = mod;
  return mod;
}
