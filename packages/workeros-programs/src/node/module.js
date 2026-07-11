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

import { createResolver, builtinKey } from "./resolve.js";
import { transformModule } from "./esm-graph.js";

function moduleNotFound(spec, fromDir) {
  const e = new Error(`Cannot find module '${spec}' from '${fromDir}'`);
  e.code = "MODULE_NOT_FOUND";
  return e;
}

export function createModule({ fs, path, url, builtins }) {
  const cache = new Map(); // absPath → module.exports
  const moduleObjs = new Map(); // absPath → the CJS `module` object (for require.main identity)
  // The process's entry `module` (Node's `require.main` / `process.mainModule`) —
  // set when a CommonJS *entry* is loaded, so `require.main === module` is true in
  // the entry and the same object everywhere else. Undefined for an ESM entry (no
  // CJS main), matching Node.
  let mainModule;

  const kind = (p) => {
    try {
      return fs.statSync(p).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  };

  // CJS require path: match packages' `require`/`node` export conditions, so a dual
  // package hands us its CommonJS build (not its ESM one) — the caller-context split
  // Node makes between `require(...)` and `import ...`.
  const resolver = createResolver({ fs, path, conditions: ["node", "require"] });

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

  function load(absPath, isMain = false) {
    if (cache.has(absPath)) return cache.get(absPath);
    if (absPath.endsWith(".json")) {
      const val = JSON.parse(fs.readFileSync(absPath, "utf8"));
      cache.set(absPath, val);
      return val;
    }
    const module = {
      exports: {},
      id: isMain ? "." : absPath, // Node ids the entry module "."
      filename: absPath,
      path: path.dirname(absPath),
      loaded: false,
    };
    moduleObjs.set(absPath, module);
    if (isMain) mainModule = module;
    cache.set(absPath, module.exports); // seed before eval for require cycles
    const require = makeRequire(module.path);
    // Route dynamic `import()` to the fs-backed loader so a CJS module can import an
    // ESM one (as in Node). CJS has no static import/import.meta, so for ordinary
    // modules `transformModule` returns the source untouched.
    const source = transformModule(fs.readFileSync(absPath, "utf8"), absPath, { staticUrl: () => undefined });
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
      const abs = resolver.resolveFrom(fromDir, spec);
      if (!abs) throw moduleNotFound(spec, fromDir);
      return load(abs);
    };
    require.resolve = (spec) => {
      if (builtins.has(builtinKey(spec))) return spec;
      const abs = resolver.resolveFrom(fromDir, spec);
      if (!abs) throw moduleNotFound(spec, fromDir);
      return abs;
    };
    require.cache = cacheProxy;
    // `require.main` is the process entry module (Node's `process.mainModule`) —
    // the same object for every require, so `require.main === module` holds only in
    // the entry. A getter so it reflects the main set when the entry loads.
    Object.defineProperty(require, "main", { get: () => mainModule, enumerable: true, configurable: true });
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
    _loadMain: (p) => load(p, true), // internal: load the entry as the process main
    get mainModule() {
      return mainModule;
    },
    wrap: (src) =>
      "(function (exports, require, module, __filename, __dirname) { " + src + "\n});",
    _cache: cacheProxy,
    _resolveFilename: (spec, parent) => {
      if (isBuiltin(spec)) return spec;
      const dir = parent && parent.path ? parent.path : "/";
      const abs = resolver.resolveFrom(dir, spec);
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
