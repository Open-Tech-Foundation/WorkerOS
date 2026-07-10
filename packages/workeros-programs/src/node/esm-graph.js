// Build a user script's ES module graph in userland (`/bin/node`), over the
// synchronous `fs`. This is the job the kernel used to do — but resolving
// `node_modules`/`exports`/`node:` is Node policy, so it lives here now, not in
// the kernel (INV-1). The kernel is just the filesystem the reads go through.

import { createResolver, isBuiltinSpec, builtinKey } from "./resolve.js";

// ---- import scanner --------------------------------------------------------
// A minimal ES-module token stream: identifiers, string literals, and single
// punctuation, with comments and string internals skipped — so `import` inside a
// string or comment is never mistaken for a real import. Deliberately not a full
// parser (computed dynamic imports aren't resolved ahead of time; documented).

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      let s = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          s += src[i + 1] ?? "";
          i += 2;
        } else {
          s += src[i];
          i++;
        }
      }
      i++; // closing quote
      toks.push({ t: "str", v: s });
    } else if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      toks.push({ t: "punct", v: c });
      i++;
    }
  }
  return toks;
}

/** Extract module specifiers: `from "x"`, `import "x"`, `import("x")`. */
export function scanEsmImports(src) {
  const toks = tokenize(src);
  const specs = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== "str") continue;
    const prev = toks[k - 1];
    if (prev && prev.t === "id" && (prev.v === "from" || prev.v === "import")) {
      specs.push(toks[k].v);
    } else if (prev && prev.t === "punct" && prev.v === "(") {
      const prev2 = toks[k - 2];
      if (prev2 && prev2.t === "id" && prev2.v === "import") specs.push(toks[k].v);
    }
  }
  return specs;
}

// ---- graph builder ---------------------------------------------------------

/**
 * Resolve + read the ES module graph rooted at `entryPath`. Builtin imports
 * become `{ builtin: true, resolved: <key> }` edges (no file); everything else
 * resolves to a VFS file that is read and walked. Shape matches what the old
 * kernel graph produced, so `/bin/node`'s stitch is unchanged.
 */
export function buildEsmGraph({ fs, path, resolver }, entryPath, entrySource) {
  resolver = resolver || createResolver({ fs, path });
  const modules = [];
  const seen = new Set();
  const queue = [[entryPath, entrySource]];
  while (queue.length) {
    const [p, src] = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const dir = path.dirname(p);
    const imports = [];
    for (const spec of scanEsmImports(src)) {
      if (isBuiltinSpec(spec)) {
        imports.push({ specifier: spec, resolved: builtinKey(spec), builtin: true });
        continue;
      }
      const resolved = resolver.resolveFrom(dir, spec);
      if (!resolved) throw new Error(`Cannot find module '${spec}' from '${dir}'`);
      imports.push({ specifier: spec, resolved, builtin: false });
      if (!seen.has(resolved)) queue.push([resolved, fs.readFileSync(resolved, "utf8")]);
    }
    modules.push({ path: p, source: src, imports });
  }
  // Entry first, for a stable graph (the stitch orders by dependency anyway).
  const i = modules.findIndex((m) => m.path === entryPath);
  if (i > 0) modules.unshift(modules.splice(i, 1)[0]);
  return { entry: entryPath, kind: "js", modules };
}
