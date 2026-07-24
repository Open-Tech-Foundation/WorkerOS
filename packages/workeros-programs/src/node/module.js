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
import { transformModule, isTsPath, stripShebang } from "./esm-graph.js";

function moduleNotFound(spec, fromDir) {
  const e = new Error(`Cannot find module '${spec}' from '${fromDir}'`);
  e.code = "MODULE_NOT_FOUND";
  return e;
}

export function createModule({ fs, path, url, builtins, detectFormat }) {
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

  // Node exposes require.cache keyed by filename → the real `module` object.
  // Tools reach through it and use the whole record — `require.cache[id].require`,
  // `.parent`, `.children` — so hand back the actual module object we built in
  // `load` (tracked in moduleObjs), not a { exports }-only stub. A currently-
  // evaluating module is already in moduleObjs (seeded before eval), so a cyclic
  // peek sees its live, partial exports — as in Node.
  const cacheProxy = new Proxy(
    {},
    {
      get: (_, k) => moduleObjs.get(k),
      has: (_, k) => moduleObjs.has(k),
      deleteProperty: (_, k) => (moduleObjs.delete(k), cache.delete(k), true),
      ownKeys: () => [...moduleObjs.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );

  function load(absPath, isMain = false, parent = null) {
    if (cache.has(absPath)) {
      // A cyclic require of a module that is still evaluating must see its CURRENT
      // `module.exports`: a module may reassign `module.exports = X` and only then
      // require the dependents that cycle back to it (pacote's fetcher.js exports
      // its base class, then requires the subclasses that `extends` it). The value
      // seeded in `cache` before eval is stale after such a reassignment — Node
      // returns the live exports, so read them off the in-flight module object.
      const inflight = moduleObjs.get(absPath);
      if (inflight && inflight.loaded === false) return inflight.exports;
      return cache.get(absPath);
    }
    if (absPath.endsWith(".json")) {
      const val = JSON.parse(fs.readFileSync(absPath, "utf8"));
      cache.set(absPath, val);
      return val;
    }
    // `require(esm)`: a CommonJS module requiring an ES module (Node allows it for
    // modules without top-level await). Hand it to the synchronous ESM runner
    // (`/bin/node` installs `__workerosRequireEsm`) and cache the returned namespace.
    if (detectFormat && !absPath.endsWith(".cjs")) {
      const src = fs.readFileSync(absPath, "utf8");
      if (detectFormat(src, absPath, { fs, path }) === "esm") {
        if (!globalThis.__workerosRequireEsm) {
          throw new Error("require() of ES Module " + absPath + " is not supported in this context");
        }
        const ns = globalThis.__workerosRequireEsm(absPath);
        cache.set(absPath, ns);
        return ns;
      }
    }
    const module = {
      exports: {},
      id: isMain ? "." : absPath, // Node ids the entry module "."
      filename: absPath,
      path: path.dirname(absPath),
      loaded: false,
      // Node always populates these on the `module` object handed to a CJS
      // wrapper. Omitting `parent` breaks the `module.parent.require(...)` idiom
      // some tools use; `parent` is the module that first required this one (null
      // for the process entry), deprecated but still present in Node.
      parent: isMain ? null : parent || null,
      children: [],
      paths: nodeModulePaths(path.dirname(absPath)),
    };
    moduleObjs.set(absPath, module);
    if (isMain) mainModule = module;
    if (parent && !isMain) parent.children.push(module);
    cache.set(absPath, module.exports); // seed before eval for require cycles
    // `module.require(id)` — resolves relative to this module's dir, like Node's.
    const require = makeRequire(module.path, module);
    module.require = require;
    // Route dynamic `import()` to the fs-backed loader so a CJS module can import an
    // ESM one (as in Node). CJS has no static import/import.meta, so for ordinary
    // modules `transformModule` returns the source untouched.
    let raw = stripShebang(fs.readFileSync(absPath, "utf8"));
    // A CommonJS TypeScript module (`.cts`, or `.ts` in a commonjs scope): strip
    // types with oxc before evaluating — `require`/`module.exports` stay intact
    // (strip-only, no ESM rewrite). `/bin/node` installs the stripper.
    if (isTsPath(absPath) && globalThis.__workerosStripTs) {
      raw = globalThis.__workerosStripTs(raw, absPath.endsWith(".tsx"));
    }
    const source = transformModule(raw, absPath, { staticUrl: () => undefined });
    const fn = new Function("require", "module", "exports", "__dirname", "__filename", source);
    try {
      fn(require, module, module.exports, module.path, absPath);
    } catch (e) {
      // A module that throws while evaluating is NOT cached (Node semantics): drop
      // the seed we set for cycle-safety so the next require/import re-evaluates
      // and re-throws, instead of silently handing back partial exports. Without
      // this, a dynamic `import()` of a throwing CJS module resolves against the
      // stale partial — hiding the real failure behind a missing named export
      // (e.g. `mod.nextDev is not a function` when next-dev.js actually threw).
      cache.delete(absPath);
      moduleObjs.delete(absPath);
      if (parent) parent.children = parent.children.filter((c) => c !== module);
      // Name the failing module — eval'd modules are anonymous blobs, so a raw
      // "Class extends value ..." otherwise gives no clue which file threw.
      if (e instanceof Error && !e._wosModule) {
        e._wosModule = absPath;
        try { e.message += ` [loading ${absPath}]`; } catch { /* frozen message */ }
      }
      throw e;
    }
    module.loaded = true;
    cache.set(absPath, module.exports);
    return module.exports;
  }

  function makeRequire(fromDir, ownerModule = null) {
    const require = (spec) => {
      const b = builtins.get(builtinKey(spec));
      if (b) return b;
      const abs = resolver.resolveFrom(fromDir, spec);
      if (!abs) throw moduleNotFound(spec, fromDir);
      return load(abs, false, ownerModule);
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

  // Node's `Module._nodeModulePaths(from)`: the `node_modules` search chain walking
  // up from `from` to the root (skipping any `node_modules` segments themselves).
  const nodeModulePaths = (from) => {
    const parts = path.resolve(from || "/").split("/").filter(Boolean);
    const paths = [];
    for (let i = parts.length; i >= 0; i--) {
      if (parts[i - 1] === "node_modules") continue;
      const base = parts.slice(0, i).join("/");
      paths.push((base ? "/" + base : "") + "/node_modules");
    }
    return paths;
  };

  const _resolveFilename = (spec, parent) => {
    if (isBuiltin(spec)) return spec;
    const dir = parent && parent.path ? parent.path : "/";
    const abs = resolver.resolveFrom(dir, spec);
    if (!abs) throw moduleNotFound(spec, dir);
    return abs;
  };

  // A constructable `Module` (Node's `require('module').Module`). Some tools do
  // `new Module(file, parent)` and then drive it themselves — notably `promzard`
  // (used by `npm init`), which builds a Module, reads `Module._nodeModulePaths`,
  // and calls `mod.require(...)` to evaluate an init template. A bare object won't
  // do: `new` needs a function. Instances resolve their own requires against the
  // module's directory, like Node's CJS `module.require`.
  function Module(id = "", parent) {
    this.id = id;
    this.path = id ? path.dirname(id) : ".";
    this.exports = {};
    this.filename = id || null;
    this.loaded = false;
    this.children = [];
    this.parent = parent || null;
    this.paths = id ? nodeModulePaths(this.path) : [];
  }
  Module.prototype.require = function (spec) {
    return makeRequire(this.filename ? path.dirname(this.filename) : this.path)(spec);
  };
  // `require('module')` IS the `Module` constructor in Node — not a namespace
  // object that merely *carries* it. Everything (createRequire, _cache, the
  // statics) hangs off `Module` itself, and `Module.Module === Module`. Getting
  // this shape right matters: `require('module').prototype.require` is a real
  // access — Next.js's require-hook reads it (`const originalRequire =
  // mod.prototype.require`), and a plain-object namespace has no `.prototype`, so
  // it throws "Cannot read properties of undefined (reading 'require')".
  Module._nodeModulePaths = nodeModulePaths;
  Module._resolveFilename = _resolveFilename;
  // Node's public static: resolve a *request* (against parent), then load it.
  Module._load = (spec, parent) => load(_resolveFilename(spec, parent));
  Module.createRequire = createRequire;
  // Computed after the registry is fully populated (see makeBuiltins): the
  // "module" key is pre-seeded there so it counts itself.
  Module.builtinModules = [...builtins.keys()];
  Module.isBuiltin = isBuiltin;
  // Node's `Module.findSourceMap(path)` → the SourceMap for a loaded file, or
  // undefined. We don't emit source maps, so the honest answer is always undefined
  // (INV-5) — but the method MUST exist: Next calls it while filtering error stack
  // frames during a render, and a missing function turned every such call into a
  // thrown TypeError that derailed the render (a page fell through to not-found).
  Module.findSourceMap = () => undefined;
  Module.wrap = (src) =>
    "(function (exports, require, module, __filename, __dirname) { " + src + "\n});";
  Module._cache = cacheProxy;
  Object.defineProperty(Module, "mainModule", {
    get: () => mainModule,
    enumerable: true,
    configurable: true,
  });
  // Internal (not Node's API): the ESM-graph interop loads an already-resolved
  // absolute path directly, bypassing request resolution. Kept distinct from the
  // public `_load(spec, parent)` so neither has to compromise its contract.
  Module._loadByPath = load;
  Module._loadMain = (p) => load(p, true); // load the entry as the process main
  Module.syncRequire = makeRequire; // a require rooted at an arbitrary dir
  // Node's self-referential shape: `require('module').Module === require('module')`.
  Module.Module = Module;
  Module.default = Module; // ESM-interop default import
  return Module;
}
