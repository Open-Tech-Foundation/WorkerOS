// The Node CommonJS module runtime — the "lightweight node".
//
// This is GUEST code (INV-1): the kernel knows nothing about `require`, package
// folders, or `node_modules`. `node index.js` runs an ordinary process; this
// runtime is what that process uses to load a CJS module graph out of the VFS —
// exactly like the real `node` binary is just a program on Linux.
//
// `require` is synchronous, but the VFS syscalls (`sys.read`) are async. So we
// resolve + read the whole `require` graph up front (async), then execute it with
// a synchronous `require` backed by that in-memory cache. Computed requires
// (`require(variable)`) can't be prefetched — the same honest, documented limit
// the kernel's ESM scanner has (resolver.rs).
//
// Scope: CommonJS (the classic npm/`require` case). ESM entries keep going
// through the kernel's ahead-of-time graph + the program worker's stitch path.

import { createFs } from "./fs.js";
import { createPath } from "./path.js";
import { createOs } from "./os.js";
import { createUrl } from "./url.js";
import { createModule } from "./module.js";

// ---- core builtins --------------------------------------------------------
// `require('fs')` / `require('node:fs')` and friends resolve to guest builtins,
// not to files in the VFS (PLAN Phase 5·C, B). The registry grows here as more
// `node:` builtins land (`crypto`, `stream`, …). Exported so `/bin/node`'s ESM
// stitch can synthesize a re-export module for each `node:` import the kernel
// marked as a builtin edge (Phase 5·C-ESM). The map's keys are the builtin keys
// the kernel resolves to (see `resolver.rs` `NODE_BUILTINS`).
export function makeBuiltins(sys) {
  const fs = createFs(sys.syncFs);
  const path = createPath();
  const os = createOs();
  const url = createUrl();
  const reg = new Map([
    ["fs", fs],
    ["fs/promises", fs.promises],
    ["path", path],
    ["path/posix", path],
    ["os", os],
    ["url", url],
  ]);
  // Seed "module" before building it so its `builtinModules` list counts itself;
  // `module.createRequire` reads back through `reg`, so it resolves every builtin.
  reg.set("module", null);
  reg.set("module", createModule({ fs, path, url, builtins: reg }));
  return reg;
}

// A specifier's builtin key, stripping the `node:` scheme.
const builtinKey = (spec) => (spec.startsWith("node:") ? spec.slice(5) : spec);

// ---- tiny POSIX-ish path helpers ------------------------------------------
const path = {
  dirname(p) {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  },
  join(...parts) {
    const segs = [];
    for (const part of parts.join("/").split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segs.pop();
      else segs.push(part);
    }
    return "/" + segs.join("/");
  },
};

const dec = new TextDecoder();

/**
 * Should this entry run through the CommonJS runtime? Only when it actually uses
 * `require`/`module.exports` — a plain async script (coreutils, `npm`) has neither
 * and keeps going through the ESM `import()` path, which permits top-level `await`.
 * `.cjs`/`.mjs` extensions are authoritative.
 */
export function usesCommonjs(source, p = "") {
  if (p.endsWith(".cjs")) return true;
  if (p.endsWith(".mjs")) return false;
  return (
    /(^|[^.\w$])require\s*\(/.test(source) ||
    /\bmodule\.exports\b/.test(source) ||
    /\bexports\.[\w$]/.test(source)
  );
}

// ---- require() specifier scan (string-literal args only) ------------------
function scanRequires(src) {
  const specs = [];
  const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[2]);
  return specs;
}

const isRelative = (s) => s.startsWith("./") || s.startsWith("../") || s.startsWith("/");

// ---- the runtime -----------------------------------------------------------
export function createNodeRuntime(sys) {
  const builtins = makeBuiltins(sys);

  async function readFile(p) {
    const fd = await sys.open(p, {});
    const chunks = [];
    try {
      for (;;) {
        const b = await sys.read(fd, 65536);
        if (b.length === 0) break;
        chunks.push(b);
      }
    } finally {
      await sys.close(fd);
    }
    let len = 0;
    for (const c of chunks) len += c.length;
    const buf = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) {
      buf.set(c, o);
      o += c.length;
    }
    return dec.decode(buf);
  }

  async function statKind(p) {
    try {
      return (await sys.stat(p)).kind; // "file" | "dir"
    } catch {
      return null;
    }
  }

  // Resolve a file path with extension + index fallbacks (Node CJS rules, subset).
  async function resolveFile(p) {
    if ((await statKind(p)) === "file") return p;
    for (const ext of [".js", ".cjs", ".json"]) {
      if ((await statKind(p + ext)) === "file") return p + ext;
    }
    if ((await statKind(p)) === "dir") {
      const pkg = path.join(p, "package.json");
      if ((await statKind(pkg)) === "file") {
        const main = pickMain(JSON.parse(await readFile(pkg)));
        if (main) {
          const r = await resolveFile(path.join(p, main));
          if (r) return r;
        }
      }
      for (const idx of ["index.js", "index.cjs", "index.json"]) {
        const r = path.join(p, idx);
        if ((await statKind(r)) === "file") return r;
      }
    }
    return null;
  }

  // The CJS entry a package.json points at: exports["."] require/default, then main.
  function pickMain(pkg) {
    const e = pkg.exports;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const dot = e["."] ?? e;
      if (typeof dot === "string") return dot;
      if (dot && typeof dot === "object") {
        const cond = dot.require ?? dot.node ?? dot.default;
        if (typeof cond === "string") return cond;
      }
    }
    return pkg.main || "index.js";
  }

  async function resolveBare(spec, fromDir) {
    const slash = spec.indexOf("/", spec[0] === "@" ? spec.indexOf("/") + 1 : 0);
    const name = slash === -1 ? spec : spec.slice(0, slash);
    const sub = slash === -1 ? "" : spec.slice(slash + 1);
    let dir = fromDir;
    for (;;) {
      const pkgDir = path.join(dir, "node_modules", name);
      if ((await statKind(pkgDir)) === "dir") {
        const target = sub ? path.join(pkgDir, sub) : pkgDir;
        const r = await resolveFile(target);
        if (r) return r;
      }
      if (dir === "/") break;
      dir = path.dirname(dir);
    }
    return null;
  }

  async function resolve(spec, fromDir) {
    const abs = isRelative(spec)
      ? await resolveFile(path.join(fromDir, spec))
      : await resolveBare(spec, fromDir);
    if (!abs) throw new Error(`Cannot find module '${spec}' from '${fromDir}'`);
    return abs;
  }

  // Prefetch the whole require graph into `sources` + `resolutions`.
  const sources = new Map(); // absPath → source text
  const resolutions = new Map(); // `${fromDir}\0${spec}` → absPath

  async function prefetch(absPath) {
    const source = sources.get(absPath);
    if (absPath.endsWith(".json")) return; // JSON has no requires
    const dir = path.dirname(absPath);
    for (const spec of scanRequires(source)) {
      if (builtins.has(builtinKey(spec))) continue; // builtin: no VFS file to read
      const key = dir + "\0" + spec;
      if (resolutions.has(key)) continue;
      let dep;
      try {
        dep = await resolve(spec, dir);
      } catch {
        // Unresolved requires (e.g. a missing dep or `node:` builtin) surface at
        // call time, not here — matches Node's lazy failure.
        continue;
      }
      resolutions.set(key, dep);
      if (!sources.has(dep)) {
        sources.set(dep, await readFile(dep));
        await prefetch(dep);
      }
    }
  }

  // Synchronous CJS evaluation over the prefetched cache.
  const cache = new Map(); // absPath → module.exports

  function load(absPath) {
    if (cache.has(absPath)) return cache.get(absPath);
    const source = sources.get(absPath);
    if (source === undefined) throw new Error(`module not prefetched: ${absPath}`);
    if (absPath.endsWith(".json")) {
      const val = JSON.parse(source);
      cache.set(absPath, val);
      return val;
    }
    const module = { exports: {} };
    cache.set(absPath, module.exports); // seed before eval for require cycles
    const dir = path.dirname(absPath);
    const require = (spec) => {
      const b = builtins.get(builtinKey(spec));
      if (b) return b;
      const abs = resolutions.get(dir + "\0" + spec);
      if (!abs) throw new Error(`Cannot find module '${spec}'`);
      return load(abs);
    };
    require.resolve = (spec) =>
      builtins.has(builtinKey(spec)) ? spec : resolutions.get(dir + "\0" + spec) || spec;
    const fn = new Function("require", "module", "exports", "__dirname", "__filename", source);
    fn(require, module, module.exports, dir, absPath);
    cache.set(absPath, module.exports);
    return module.exports;
  }

  /** Run a CJS entry file (already read) as `node <entryPath>`. */
  return async function run(entryPath, entrySource) {
    sources.set(entryPath, entrySource);
    await prefetch(entryPath);
    load(entryPath);
  };
}
