// Node module resolution — the userland home of what must NOT live in the kernel
// (INV-1): the `node_modules` walk, `package.json` `exports`/`imports`/`module`/
// `main`, subpath patterns, conditions, extension/index fallbacks, and `node:`
// builtins. Pure over an injected synchronous `fs` + `path` (made possible by the
// sync-fs channel), so `/bin/node` resolves its own graph and the kernel stays a
// dumb filesystem. Shared by the CJS require runtime (`module.js`) and the ESM
// graph builder (`esm-graph.js`).
//
// Fidelity: this implements Node's ESM/CJS resolution algorithm closely enough to
// run real npm packages — `exports`/`imports` with conditions matched in
// package.json key order, `*` subpath patterns with longest-match precedence
// (Node's PATTERN_KEY_COMPARE), `null` targets that block a path, package
// self-reference by `name`, and the `require`-vs-`import` condition split (the
// caller passes its active conditions; a dual package loaded via `require` gets its
// CJS target, via `import` its ESM target). Where we are deliberately *more*
// permissive than Node — extensionless/index fallback for ESM too — that never
// rejects a valid Node program; it only accepts a few Node would not.

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
  "assert",
  "assert/strict",
  "string_decoder",
  "events",
  "util",
  "util/types",
  "stream",
  "timers",
  "timers/promises",
  "readline",
  "net",
  "http",
  "crypto",
  "zlib",
  "child_process",
  "querystring",
  "perf_hooks",
  "worker_threads",
  "vm",
]);

export const isBuiltinSpec = (spec) => spec.startsWith("node:") || NODE_BUILTINS.has(spec);

/** The builtin key for a spec (strip the `node:` scheme), or null if not a builtin. */
export const builtinKey = (spec) =>
  spec.startsWith("node:") ? spec.slice(5) : NODE_BUILTINS.has(spec) ? spec : null;

const isRelative = (s) => s.startsWith("./") || s.startsWith("../");

// A resolved-but-blocked target (`"exports": { "./x": null }`) — distinct from
// "no match" so it stops condition/array fallback the way Node's null target does.
const BLOCKED = Symbol("blocked");

/**
 * @param {object} opts
 * @param opts.fs           synchronous fs (statSync/readFileSync)
 * @param opts.path         a posix `path`
 * @param {string[]} [opts.conditions]  active export/import conditions besides the
 *   always-on `"default"`. ESM callers pass `["node","import"]` (the default),
 *   CJS `require` callers pass `["node","require"]`. Order here does NOT set
 *   precedence — precedence follows the package.json key order (as in Node).
 */
export function createResolver({ fs, path, conditions = ["node", "import"] } = {}) {
  const condSet = new Set(conditions);
  const condActive = (key) => key === "default" || condSet.has(key);

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

  // Resolve a package `exports`/`imports` *target* against the active conditions.
  // A string is the target (with `*` expanded to `star` when this is a pattern
  // match); an array is a fallback list (first that resolves wins); an object is a
  // conditions map walked in key order (Node matches in declaration order, not by
  // a fixed priority). `null` is an explicit block. Returns a string target, null
  // (no match), or BLOCKED.
  const pickTarget = (v, star) => {
    if (v === null) return BLOCKED;
    if (typeof v === "string") return star != null ? v.replaceAll("*", star) : v;
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = pickTarget(x, star);
        if (r === BLOCKED) continue; // a blocked alternative just falls through
        if (r != null) return r;
      }
      return null;
    }
    if (typeof v === "object") {
      for (const key of Object.keys(v)) {
        if (!condActive(key)) continue;
        const r = pickTarget(v[key], star);
        if (r === BLOCKED) return BLOCKED; // a matched condition that blocks stops here
        if (r != null) return r;
      }
      return null;
    }
    return null;
  };

  // Match a subpath against an `exports`/`imports` key map: an exact key wins,
  // else the most-specific `*` pattern (Node PATTERN_KEY_COMPARE — longest base
  // wins, then longest trailer). Returns { value, star } or null.
  const matchPattern = (map, subpath) => {
    if (Object.prototype.hasOwnProperty.call(map, subpath)) return { value: map[subpath], star: null };
    let best = null;
    for (const key of Object.keys(map)) {
      const s = key.indexOf("*");
      if (s === -1) continue;
      const base = key.slice(0, s);
      const trailer = key.slice(s + 1);
      if (!subpath.startsWith(base)) continue;
      if (trailer && !subpath.endsWith(trailer)) continue;
      if (subpath.length < base.length + trailer.length) continue;
      if (
        !best ||
        base.length > best.base.length ||
        (base.length === best.base.length && trailer.length > best.trailer.length)
      ) {
        best = { key, base, trailer };
      }
    }
    if (!best) return null;
    const star = subpath.slice(best.base.length, subpath.length - best.trailer.length);
    return { value: map[best.key], star };
  };

  // Does this exports value use subpath keys (`"."`, `"./x"`) rather than being a
  // single "." target (a bare string / conditions object)?
  const isSubpathMap = (exports) =>
    exports && typeof exports === "object" && !Array.isArray(exports)
      ? Object.keys(exports).some((k) => k.startsWith("."))
      : false;

  // Resolve a subpath ("." or "./sub") against a package `exports` value, applying
  // conditions. A subpath map that doesn't match, or a blocked target, is null.
  const resolveExport = (exports, subpath) => {
    if (isSubpathMap(exports)) {
      const m = matchPattern(exports, subpath);
      if (!m) return null;
      const t = pickTarget(m.value, m.star);
      return t === BLOCKED || t == null ? null : t;
    }
    // No subpath keys: the whole value is the "." target; subpaths are sealed.
    if (subpath !== ".") return null;
    const t = pickTarget(exports, null);
    return t === BLOCKED || t == null ? null : t;
  };

  // The package "." entry. With `exports`, the field is authoritative and seals the
  // package — `main`/`module` are ignored (as in Node). Without it, prefer the
  // bundler `module` field for an ESM build, else `main` (legacy CJS).
  const pickEntry = (pkg) => {
    if (pkg.exports != null) return resolveExport(pkg.exports, ".");
    return pkg.module || pkg.main || null;
  };

  const resolveFile = (p) => {
    if (kind(p) === "file") return p;
    for (const ext of [".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".mts", ".cts"]) {
      if (kind(p + ext) === "file") return p + ext;
    }
    // TypeScript writes `import './x.js'` for a source file that is actually `x.ts`
    // (the emitted extension). When the literal `.js` sibling is absent, fall back
    // to the matching TS source — so a TS graph resolves without `.ts` in specifiers.
    const tsSwap = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts", ".jsx": ".tsx" };
    for (const [js, ts] of Object.entries(tsSwap)) {
      if (p.endsWith(js) && kind(p.slice(0, -js.length) + ts) === "file") {
        return p.slice(0, -js.length) + ts;
      }
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
    for (const idx of ["index.js", "index.mjs", "index.cjs", "index.json", "index.ts", "index.tsx"]) {
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

  // Resolve `name`/`name/sub` inside an already-located package directory. With an
  // `exports` field the package is sealed: both the "." entry and any subpath must
  // go through the exports map (with conditions), and anything not exported is
  // unresolved. Without it, fall back to the legacy entry/directory/plain-file
  // behavior.
  const resolveInPackage = (pkgDir, sub) => {
    const pkg = readJson(path.join(pkgDir, "package.json"));
    if (pkg && pkg.exports != null) {
      const t = resolveExport(pkg.exports, sub ? "./" + sub : ".");
      return t ? resolveFile(path.join(pkgDir, t)) : null;
    }
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
    return resolveFile(path.join(pkgDir, sub));
  };

  // Package self-reference: a package may import itself by its own `name` (Node
  // allows this when the defining package has `exports`). Walk to the nearest
  // enclosing package.json; if its `name` matches and it has `exports`, resolve the
  // subpath against that package. The nearest package.json defines the scope, so we
  // stop there whether or not it matches.
  const resolveSelf = (fromDir, name, sub) => {
    let dir = fromDir;
    for (;;) {
      const pkg = readJson(path.join(dir, "package.json"));
      if (pkg) {
        if (pkg.name === name && pkg.exports != null) {
          const t = resolveExport(pkg.exports, sub ? "./" + sub : ".");
          return t ? resolveFile(path.join(dir, t)) : null;
        }
        return null;
      }
      if (dir === "/") return null;
      dir = path.dirname(dir);
    }
  };

  // Walk `node_modules` from fromDir up to `/` (after trying self-reference).
  const resolveBare = (fromDir, spec) => {
    const [name, sub] = splitPackage(spec);
    const self = resolveSelf(fromDir, name, sub);
    if (self) return self;
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
  // scoped to the defining package). The map is keyed on `#name`/`#name/*`, honors
  // conditions, and a target may be a relative file (rooted at that package) or
  // another bare spec. Chalk v5 needs this: `import '#ansi-styles'` etc.
  const resolveImports = (fromDir, spec) => {
    let dir = fromDir;
    for (;;) {
      const pkg = readJson(path.join(dir, "package.json"));
      // The nearest package.json defines the scope (Node stops here whether or not
      // it matches); resolving against an ancestor's imports would cross packages.
      if (pkg) {
        const map = pkg.imports;
        if (map && typeof map === "object") {
          const m = matchPattern(map, spec);
          if (m) {
            const t = pickTarget(m.value, m.star);
            if (t && t !== BLOCKED) {
              return isRelative(t) ? resolveFile(path.join(dir, t)) : resolveBare(dir, t);
            }
          }
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
