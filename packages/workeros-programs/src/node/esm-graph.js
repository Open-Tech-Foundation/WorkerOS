// Build a user script's ES module graph in userland (`/bin/node`), over the
// synchronous `fs`. This is the job the kernel used to do — but resolving
// `node_modules`/`exports`/`node:` is Node policy, so it lives here now, not in
// the kernel (INV-1). The kernel is just the filesystem the reads go through.

import { createResolver, isBuiltinSpec, builtinKey } from "./resolve.js";

// A TypeScript module path (`.ts`/`.mts`/`.cts`/`.tsx`). TypeScript can't run on
// the engine natively and the JS import scanner below would mis-read its
// type-only syntax, so these are never blob-stitched or tokenized here — they go
// through the oxc runner (which strips types with a real parser). Shared by the
// loaders so the "what is TypeScript" rule lives in one place.
export const isTsPath = (p) => /\.(ts|mts|cts|tsx)$/.test(p);

// Drop a leading `#!…` shebang line, as Node does before compiling a module. The
// engine allows a hashbang in a real Script/Module, but our CJS evaluator wraps
// source in `new Function(...)` (a FunctionBody, where `#!` is a SyntaxError) and
// the ESM runner wraps it in an AsyncFunction — so we strip it for both.
export const stripShebang = (src) => (src.charCodeAt(0) === 35 && src[1] === "!" ? src.replace(/^#![^\n]*/, "") : src);

// ---- import scanner --------------------------------------------------------
// A minimal ES-module token stream: identifiers, string literals, and single
// punctuation, with comments and string internals skipped — so `import` inside a
// string or comment is never mistaken for a real import. Deliberately not a full
// parser (computed dynamic imports aren't resolved ahead of time; documented).

// Tokens carry `start`/`end` source offsets so `transformModule` can rewrite
// precisely (a specifier string, a dynamic `import(`, an `import.meta`) without
// disturbing anything else. Comments and whitespace produce no token, so the
// "next token" after `import` is the meaningful one (`(` → dynamic, `.` → meta).
// Keywords after which a `/` begins a regex literal (an operand is expected),
// rather than the division operator. Enough to disambiguate minified bundles.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "do", "else", "yield", "await", "case",
]);

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  const isDigit = (c) => c >= "0" && c <= "9";

  // `/` is a regex literal when the previous significant token can't end an
  // expression (a punctuator other than `)`/`]`, or a keyword expecting an
  // operand); otherwise it's division. Governs regex-vs-divide disambiguation.
  const regexAllowed = () => {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.t === "punct") return t.v !== ")" && t.v !== "]";
    if (t.t === "id") return REGEX_KEYWORDS.has(t.v);
    return false; // after a string/number/regex/template → division
  };

  // Template-literal interpolation stack: entering `${` records the brace depth to
  // return to template-string scanning at the matching `}`. Without this, a nested
  // template (`` `a${`b`}c` ``) flips string-vs-code and desyncs the rest of the
  // file — silently dropping later imports, `import.meta`, and dynamic `import()`.
  const tmpl = [];
  let depth = 0;

  // Scan a template-string span from `start` (just past a backtick or the `}` that
  // closed an interpolation). Emits one `str` token; returns "expr" when it stopped
  // at `${` (code follows) or "end" at the closing backtick.
  const readTemplateSpan = (start) => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; toks.push({ t: "str", v: "", start, end: i }); return "end"; }
      if (c === "$" && src[i + 1] === "{") { i += 2; toks.push({ t: "str", v: "", start, end: i }); return "expr"; }
      i++;
    }
    toks.push({ t: "str", v: "", start, end: i });
    return "end";
  };

  while (i < n) {
    const c = src[i];
    const start = i;
    // Comments.
    if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    // Regex literal (only where an operand is expected).
    if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === "\\") { i += 2; continue; }
        if (d === "\n") break; // unterminated → bail (treat what we consumed as regex)
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { i++; break; }
        i++;
      }
      while (i < n && isIdent(src[i])) i++; // flags
      toks.push({ t: "regex", v: "", start, end: i });
      continue;
    }
    // Single/double-quoted string.
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let s = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") { s += src[i + 1] ?? ""; i += 2; }
        else { s += src[i]; i++; }
      }
      i++;
      toks.push({ t: "str", v: s, start, end: i });
      continue;
    }
    // Template literal.
    if (c === "`") {
      i++;
      if (readTemplateSpan(start) === "expr") tmpl.push(depth);
      continue;
    }
    // Identifier / keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j), start, end: j });
      i = j;
      continue;
    }
    // Numeric literal (so a following `/` reads as division, not a regex).
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n && (isIdent(src[j]) || src[j] === ".")) j++;
      toks.push({ t: "num", v: src.slice(i, j), start, end: j });
      i = j;
      continue;
    }
    // Whitespace.
    if (/\s/.test(c)) { i++; continue; }
    // Punctuation, tracking brace depth so `${…}` interpolations close correctly.
    if (c === "}" && tmpl.length && tmpl[tmpl.length - 1] === depth) {
      tmpl.pop();
      i++; // consume `}`
      if (readTemplateSpan(i) === "expr") tmpl.push(depth);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    toks.push({ t: "punct", v: c, start, end: i + 1 });
    i++;
  }
  return toks;
}

// Is the string token at `k` a *static* module specifier — `import x from "s"`,
// `export … from "s"`, or the bare side-effect `import "s"`? (A dynamic
// `import("s")` has a `(` between `import` and the string, so its `prev` is `(`,
// not the `import`/`from` id — that is handled lazily, not as a graph edge.)
const isStaticSpecifier = (toks, k) => {
  const prev = toks[k - 1];
  return !!prev && prev.t === "id" && (prev.v === "from" || prev.v === "import");
};

/**
 * Does this source contain static ESM syntax — an `import`/`export` *declaration*
 * or `import.meta`? Tokenizer-based (so `import` inside a string/comment doesn't
 * count), and deliberately blind to dynamic `import()`, which is legal in CommonJS
 * too. This is what makes format detection authoritative: a module written with
 * `import`/`export` is ESM even if it also calls a `require` (e.g. one produced by
 * `createRequire(import.meta.url)`) — that source cannot run in the CJS evaluator.
 */
export function hasEsmSyntax(src) {
  const toks = tokenize(src);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== "id") continue;
    if (t.v !== "import" && t.v !== "export") continue;
    const prev = toks[k - 1];
    if (prev && prev.t === "punct" && prev.v === ".") continue; // `foo.import` / `foo.export`
    const nx = toks[k + 1];
    if (nx && nx.t === "punct" && nx.v === ":") continue; // an object key `{ import: … }` / `{ export: … }`
    if (t.v === "export") return true;
    if (!(nx && nx.t === "punct" && nx.v === "(")) return true; // static import / import.meta (not dynamic `import(`)
  }
  return false;
}

/** Extract *static* module specifiers (`import … from`, `export … from`, bare
 *  `import "x"`). Dynamic `import()` is deliberately excluded so it stays lazy. */
export function scanEsmImports(src) {
  const toks = tokenize(src);
  const specs = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t === "str" && isStaticSpecifier(toks, k)) specs.push(toks[k].v);
  }
  return specs;
}

// The local name `import.meta` is rewritten to (so `/bin/node` can back it with a
// real `file://` URL + fs-derived dirname/filename/resolve — the blob the browser
// actually evaluates never leaks out).
const META_VAR = "__workeros_import_meta";

/**
 * Rewrite one ES module's source for evaluation as a blob, keeping every
 * user-observable surface fs-backed rather than blob-backed:
 *   - static specifiers  → their dependency's blob URL (via `staticUrl`),
 *   - `import.meta`       → `__workeros_import_meta`, a real meta object bound from
 *                           `globalThis.__workerosMeta(<abs>)`,
 *   - dynamic `import(x)` → `globalThis.__workerosImport("<abs>", x)` — resolved
 *                           lazily against this module's real directory.
 * Purely textual, driven off token offsets; a module with none of these returns
 * unchanged. `absPath` is the module's real VFS path (the base for meta + dynamic
 * import resolution).
 */
export function transformModule(src, absPath, { staticUrl }) {
  const toks = tokenize(src);
  const edits = []; // { start, end, text }, applied left→right
  const baseLit = JSON.stringify(absPath);
  let usesMeta = false;
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "id" && tk.v === "import") {
      const a = toks[k + 1];
      // `import.meta`
      if (a?.t === "punct" && a.v === "." && toks[k + 2]?.t === "id" && toks[k + 2].v === "meta") {
        edits.push({ start: tk.start, end: toks[k + 2].end, text: META_VAR });
        usesMeta = true;
        k += 2;
        continue;
      }
      // dynamic `import(` — rewrite the callee and inject this module as the base
      if (a?.t === "punct" && a.v === "(") {
        edits.push({ start: tk.start, end: tk.end, text: "globalThis.__workerosImport" });
        edits.push({ start: a.end, end: a.end, text: baseLit + ", " });
        continue;
      }
    }
    // static specifier string → dependency blob URL
    if (tk.t === "str" && isStaticSpecifier(toks, k)) {
      const url = staticUrl(tk.v);
      if (url) edits.push({ start: tk.start, end: tk.end, text: JSON.stringify(url) });
    }
  }
  if (edits.length === 0 && !usesMeta) return src;
  edits.sort((x, y) => x.start - y.start);
  let out = "";
  let pos = 0;
  for (const e of edits) {
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += src.slice(pos);
  // `const` before hoisted `import` declarations is legal (imports hoist), so this
  // binds `import.meta` once per module without disturbing evaluation order.
  if (usesMeta) out = `const ${META_VAR} = globalThis.__workerosMeta(${baseLit});\n` + out;
  return out;
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
    // A TypeScript module can't be scanned by the JS tokenizer (type-only imports
    // would look like real edges) nor blob-stitched (the engine can't run TS). Mark
    // it and stop walking here: `evalEsm` sees any `ts` module and hands the whole
    // graph to the oxc runner, which reads + type-strips + links it itself.
    if (isTsPath(p)) {
      modules.push({ path: p, source: src, imports: [], ts: true });
      continue;
    }
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
