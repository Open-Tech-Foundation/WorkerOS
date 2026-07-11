// The ESM module runner — executes the module-runner JS that the node-bundler wasm
// (oxc) emits, so /bin/node loads ES modules through plain function evaluation
// instead of the browser's native loader. GUEST code (INV-1).
//
// Each ES module is transformed (import/export → `__workeros_*` runner calls) and
// run as an async function with four hooks:
//   __workeros_import__(spec[, opts])  → the imported module's exports (this loader)
//   __workeros_exports__               → this module's exports object (getters land here)
//   __workeros_dynamic_import__(spec)  → dynamic import() (same loader, returns a promise)
//   __workeros_import_meta__           → import.meta
//
// Cycles work exactly as they do in Node: a module's exports object is seeded in the
// registry *before* its body runs, so a re-entrant import gets the (partially filled)
// object whose live getters resolve as the body assigns — the same mechanism the CJS
// runtime already uses for `require` cycles.

import { isBuiltinSpec, builtinKey } from "./resolve.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Wrap CJS/builtin exports as an ES namespace so `import x from` (default) and
// `import { y } from` (named) both resolve: the object's own keys are the named
// exports, plus a `default` that is the whole `module.exports` (Node interop).
export function interopNamespace(exports) {
  if (exports != null && (typeof exports === "object" || typeof exports === "function")) {
    const ns = Object.assign(Object.create(null), exports);
    if (!("default" in ns)) ns.default = exports;
    return ns;
  }
  return { default: exports };
}

/**
 * @param deps.fs           sync fs (readFileSync)
 * @param deps.path         posix path
 * @param deps.resolver     createResolver(...) with import conditions
 * @param deps.transform    (source) => module-runner JS (the node-bundler wasm)
 * @param deps.detectFormat (source, abs, {fs,path}) => "esm" | "cjs"
 * @param deps.makeMeta     (abs) => import.meta object
 * @param deps.loadCjs      (abs) => module.exports  (the sync CJS loader)
 * @param deps.getBuiltin   (key) => the node: builtin object
 */
export function createEsmRunner({ fs, path, resolver, transform, detectFormat, makeMeta, loadCjs, getBuiltin }) {
  const registry = new Map(); // abs | builtin key -> exports namespace

  const importFrom = async (fromDir, spec) => {
    if (isBuiltinSpec(spec)) {
      const key = builtinKey(spec);
      if (!registry.has(key)) registry.set(key, interopNamespace(getBuiltin(key)));
      return registry.get(key);
    }
    const abs = resolver.resolveFrom(fromDir, spec);
    if (!abs) throw new Error(`Cannot find module '${spec}' from '${fromDir}'`);
    return load(abs);
  };

  const load = async (abs) => {
    const existing = registry.get(abs);
    if (existing) return existing; // cached, or a cycle → the seeded (partial) exports
    const source = fs.readFileSync(abs, "utf8");
    if (detectFormat(source, abs, { fs, path }) === "cjs") {
      const ns = interopNamespace(loadCjs(abs));
      registry.set(abs, ns);
      return ns;
    }
    const exports = Object.create(null);
    registry.set(abs, exports); // seed BEFORE running the body (cycle safety)
    const code = transform(source);
    const dir = path.dirname(abs);
    const fn = new AsyncFunction(
      "__workeros_import__",
      "__workeros_exports__",
      "__workeros_dynamic_import__",
      "__workeros_import_meta__",
      code,
    );
    await fn(
      (s) => importFrom(dir, s),
      exports,
      (s) => importFrom(dir, s),
      makeMeta(abs),
    );
    return exports;
  };

  return { load, importFrom, registry };
}
