// Guest-side npm package resolution + install.
//
// Node-style package resolution deliberately lives OUTSIDE the kernel (INV-1 /
// PLAN Phase 5: "node_modules resolution stays in the guest layer"). The kernel
// only resolves specifiers against the VFS. So this module does the Node part:
// it fetches a self-contained ESM build of a package from a CORS-friendly CDN
// (ADR-008 — outbound fetch through a CDN/proxy) and writes it into the VFS as
// real files. User code's bare `import "pkg"` is then rewritten to the absolute
// VFS path of the installed entry, which the kernel graph-walks and runs as an
// ordinary process. Nothing here touches the kernel's authority (INV-2): it only
// puts files on disk and rewrites specifiers, exactly like a package manager.
//
// The CDN (`jsDelivr /+esm`) returns a bundle with the package's own modules
// inlined; any dependency it externalizes appears as a further `/+esm` import,
// which we follow recursively so the whole graph lands in the VFS. Every fetched
// module has its imports rewritten to the VFS paths of its dependencies before
// it is written, so the kernel never sees a bare specifier.

const CDN_ORIGIN = "https://cdn.jsdelivr.net";
const cdnUrl = (spec) => `${CDN_ORIGIN}/npm/${spec}/+esm`;

/** True for `./x`, `../x`, `/x` — resolved by the kernel against the VFS. */
export function isRelative(spec) {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

/** True for anything carrying a URL scheme (`https:`, `data:`, `node:`, …). */
export function hasScheme(spec) {
  return /^[a-z][a-z0-9+.-]*:/i.test(spec);
}

/** A bare package specifier: `lodash`, `@scope/pkg`, `@scope/pkg/sub`. */
export function isBare(spec) {
  return !isRelative(spec) && !hasScheme(spec);
}

// --- import scanning --------------------------------------------------------
// A token-level scan (comments and string internals skipped), mirroring the
// kernel's Rust scanner so host and kernel agree on what a specifier is. It
// recognizes `from "x"`, side-effect `import "x"`, and `import("x")`. Not a full
// parser (computed dynamic imports aren't seen) — the same documented limit the
// kernel has. ES imports are hoisted to the top of a module, so this reliably
// finds them even in minified bundles.
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
      while (i + 1 < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      const start = i;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      toks.push({ t: "str", v: src.slice(start, i) });
      i++;
    } else if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdent(src[i])) i++;
      toks.push({ t: "id", v: src.slice(start, i) });
    } else if (/\s/.test(c)) {
      i++;
    } else {
      toks.push({ t: "p", v: c });
      i++;
    }
  }
  return toks;
}

/** All module specifiers a source imports (deduped, in first-seen order). */
export function scanImports(src) {
  const toks = tokenize(src);
  const specs = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== "str") continue;
    const prev = toks[k - 1];
    const prev2 = toks[k - 2];
    const afterFromOrImport = prev && prev.t === "id" && (prev.v === "from" || prev.v === "import");
    const dynamicImport =
      prev && prev.t === "p" && prev.v === "(" && prev2 && prev2.t === "id" && prev2.v === "import";
    if (afterFromOrImport || dynamicImport) {
      if (!specs.includes(toks[k].v)) specs.push(toks[k].v);
    }
  }
  return specs;
}

/** Replace a bare specifier with an (absolute VFS) path — both quote styles. */
export function rewriteSpecifier(src, from, to) {
  return src.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`"${to}"`);
}

// --- install ----------------------------------------------------------------

/** Map a CDN URL to a stable, VFS-safe install path under /node_modules/.cdn. */
function urlToVfsPath(url) {
  const { pathname } = new URL(url);
  const safe = pathname
    .split("/")
    .map((seg) => seg.replace(/[^\w.@-]/g, "_"))
    .join("/");
  return `/node_modules/.cdn${safe}.mjs`;
}

/**
 * Install `spec` (and its transitive CDN graph) into the VFS and return the
 * absolute VFS path of its entry module.
 *
 * @param {import("./client.js").WorkerOS} os
 * @param {string} spec  a bare package specifier
 * @param {Map<string,string>} [cache]  spec/url → vfsPath, to dedupe across calls
 */
export async function installPackage(os, spec, cache = new Map()) {
  if (cache.has(spec)) return cache.get(spec);

  const seen = cache; // url → vfsPath, shared with the spec cache (distinct keys)

  async function fetchModule(url) {
    if (seen.has(url)) return seen.get(url);
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`install: ${url} → HTTP ${res.status}`);
    let source = await res.text();
    const vfsPath = urlToVfsPath(url);
    // Claim the path up front so import cycles terminate.
    seen.set(url, vfsPath);

    for (const dep of scanImports(source)) {
      if (isBare(dep)) {
        // A CDN bundle should not emit bare specifiers; if one appears (e.g. a
        // node: builtin), leave it for the kernel to reject loudly (INV-5).
        if (hasScheme(dep)) continue;
        throw new Error(`install: unexpected bare import "${dep}" in ${url}`);
      }
      // Resolve the dep URL relative to this module, fetch it, rewrite to its
      // VFS path so the written module imports a real file the kernel can walk.
      const depUrl = new URL(dep, url).href;
      const depPath = await fetchModule(depUrl);
      source = rewriteSpecifier(source, dep, depPath);
    }

    await os.fs.write(vfsPath, source);
    return vfsPath;
  }

  const entryPath = await fetchModule(cdnUrl(spec));
  cache.set(spec, entryPath);
  return entryPath;
}
