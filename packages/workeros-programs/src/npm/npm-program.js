// `npm` — the WorkerOS package manager, a guest program (INV-1: npm is just a
// program, like on Linux; the kernel knows nothing about registries or tarballs).
//
// It runs as a real process against the `sys` ABI plus the worker's `fetch` /
// `DecompressionStream`. It fetches packuments and tarballs from the npm registry
// (ADR-008 — outbound fetch to a CORS-enabled host), resolves semver, unpacks the
// gzip+tar into `/node_modules`, and runs `scripts` via a sub-shell (`sys.exec`).
//
// Authored as a top-level-await ESM program so it can share the guest argv helper.
// The host installs its text into the VFS at `/bin/npm` on boot.

import { tokenizeArgv } from "/lib/workeros-cli/args.js";

const REGISTRY = "https://registry.npmjs.org/";
const enc = new TextEncoder();
const dec = new TextDecoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));

// ---- path helpers ----------------------------------------------------------
function join(...parts) {
  const segs = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}
const dirname = (p) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
const abs = (p) => (p.startsWith("/") ? p : join(sys.cwd, p));

// An install context: where packages unpack (`nmRoot`) and where their `.bin`
// launchers go. A local install targets the project's `node_modules` (next to
// the cwd's package.json); `-g` targets the persistent global store `/.node_modules`,
// whose `.bin` a shell profile (`/etc/profile`) puts on PATH. Everything else —
// fetch, untar, semver, bin-linking — is identical across the two (INV-1: npm is
// just a program placing files; the OS learns nothing about node_modules).
const GLOBAL_NM = "/.node_modules";
const localCtx = () => {
  const nmRoot = join(sys.cwd, "node_modules");
  return { nmRoot, binDir: join(nmRoot, ".bin") };
};
const globalCtx = () => ({ nmRoot: GLOBAL_NM, binDir: join(GLOBAL_NM, ".bin") });

// ---- VFS helpers -----------------------------------------------------------
async function statKind(p) {
  try {
    return (await sys.stat(p)).kind;
  } catch {
    return null;
  }
}
async function readText(p) {
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
  return dec.decode(concat(chunks));
}
async function readJson(p) {
  return JSON.parse(await readText(p));
}
async function mkdirp(dir) {
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) {
    cur += "/" + part;
    try {
      await sys.mkdir(cur);
    } catch {
      /* exists — fine */
    }
  }
}
async function writeBytes(p, bytes) {
  await mkdirp(dirname(p));
  const fd = await sys.open(p, { create: true, truncate: true });
  sys.write(fd, bytes);
  await sys.close(fd);
}
async function writeText(p, text) {
  await writeBytes(p, enc.encode(text));
}
function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const buf = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return buf;
}

// ---- registry / semver -----------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  return res.json();
}

function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  return { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] || "" };
}
function cmp(a, b) {
  if (a.maj !== b.maj) return a.maj - b.maj;
  if (a.min !== b.min) return a.min - b.min;
  if (a.pat !== b.pat) return a.pat - b.pat;
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}
// Does version `v` satisfy a single comparator (^ ~ >= <= > < = or bare/x-range)?
function satisfiesOne(v, c) {
  c = c.trim();
  if (c === "" || c === "*" || c === "x" || c === "latest") return !v.pre;
  const pv = v;
  const range = (lo, hi) => cmp(pv, lo) >= 0 && (hi ? cmp(pv, hi) < 0 : true);
  let m;
  if ((m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(c))) {
    const a = +m[1], b = +m[2], p = +m[3];
    const lo = { maj: a, min: b, pat: p, pre: "" };
    let hi;
    if (a > 0) hi = { maj: a + 1, min: 0, pat: 0, pre: "" };
    else if (b > 0) hi = { maj: 0, min: b + 1, pat: 0, pre: "" };
    else hi = { maj: 0, min: 0, pat: p + 1, pre: "" };
    return !pv.pre && range(lo, hi);
  }
  if ((m = /^~(\d+)\.(\d+)\.(\d+)/.exec(c))) {
    const a = +m[1], b = +m[2], p = +m[3];
    return !pv.pre && range({ maj: a, min: b, pat: p, pre: "" }, { maj: a, min: b + 1, pat: 0, pre: "" });
  }
  if ((m = /^(>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(c))) {
    const op = m[1] || "=";
    const t = { maj: +m[2], min: +m[3], pat: +m[4], pre: m[5] || "" };
    const d = cmp(pv, t);
    if (op === "=") return d === 0;
    if (op === ">") return d > 0;
    if (op === "<") return d < 0;
    if (op === ">=") return d >= 0;
    if (op === "<=") return d <= 0;
  }
  // x-ranges: 1.x / 1.2.x / 1
  if ((m = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(c))) {
    const a = +m[1];
    const b = m[2] === undefined || m[2] === "x" || m[2] === "*" ? null : +m[2];
    if (b === null) return !pv.pre && range({ maj: a, min: 0, pat: 0, pre: "" }, { maj: a + 1, min: 0, pat: 0, pre: "" });
    const p = m[3] === undefined || m[3] === "x" || m[3] === "*" ? null : +m[3];
    if (p === null) return !pv.pre && range({ maj: a, min: b, pat: 0, pre: "" }, { maj: a, min: b + 1, pat: 0, pre: "" });
    return cmp(pv, { maj: a, min: b, pat: p, pre: "" }) === 0;
  }
  return false;
}
function satisfies(version, range) {
  const v = parseVer(version);
  if (!v) return false;
  return String(range)
    .split("||")
    .some((part) => part.trim().split(/\s+/).every((c) => satisfiesOne(v, c)));
}
function maxSatisfying(packument, range) {
  const tags = packument["dist-tags"] || {};
  if (range === "" || range === "latest" || range === "*") return tags.latest;
  if (tags[range]) return tags[range]; // a dist-tag like "next"
  let best = null;
  for (const ver of Object.keys(packument.versions || {})) {
    if (!satisfies(ver, range)) continue;
    if (!best || cmp(parseVer(ver), parseVer(best)) > 0) best = ver;
  }
  return best;
}

// ---- gzip + tar ------------------------------------------------------------
async function gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function octal(bytes) {
  const s = dec.decode(bytes).replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}
function untar(buf) {
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    let name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) break; // two zero blocks = end of archive
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const prefix = dec.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    const dataStart = off + 512;
    if (type === "0" || type === "\0" || type === "") {
      files.push({ name, data: buf.subarray(dataStart, dataStart + size) });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

// ---- install ---------------------------------------------------------------
// installed: top-level name -> version already placed at <ctx.nmRoot>/<name>.
async function installOne(name, range, installed, depth, ctx) {
  const pack = await fetchJson(REGISTRY + name.replace("/", "%2f"));
  const version = maxSatisfying(pack, range);
  if (!version) throw new Error("no version of " + name + " satisfies " + range);
  const meta = pack.versions[version];

  // Hoist to the context's node_modules; if a different version already sits
  // there, nest under the requiring package instead (npm's basic dedupe).
  let target = join(ctx.nmRoot, name);
  const have = installed.get(name);
  if (have === version) return; // already satisfied at top level
  if (have && have !== version) target = null; // conflict -> caller nests (MVP: skip)
  if (target === null) return;

  out("  ".repeat(depth) + "+ " + name + "@" + version + "\n");
  const tgz = new Uint8Array(await (await fetch(meta.dist.tarball, { mode: "cors" })).arrayBuffer());
  const files = untar(await gunzip(tgz));
  for (const f of files) {
    const rel = f.name.replace(/^package\//, "");
    if (!rel) continue;
    await writeBytes(join(target, rel), f.data);
  }
  installed.set(name, version);
  await linkBins(name, meta, target, ctx);

  const deps = meta.dependencies || {};
  for (const [dn, dr] of Object.entries(deps)) {
    await installOne(dn, dr, installed, depth + 1, ctx);
  }
}

// A generated `node_modules/.bin/<name>` launcher (PLAN Phase 5·E). The VFS has
// no symlinks, so this is a tiny native program that runs the package's real bin
// under `/bin/node`, forwarding argv and the exit code. The kernel resolves it
// because command resolution now searches `node_modules/.bin` ahead of PATH. The
// bin inherits the controlling terminal, so `process.stdin` reaches it (the bin
// can prompt interactively).
function binLauncherSource(targetAbs) {
  return (
    "// Auto-generated by `npm install` (bin-linking). Runs the package's bin\n" +
    "// under /bin/node, forwarding args + exit code; the bin inherits the TTY.\n" +
    "const q = (s) => \"'\" + String(s).replace(/'/g, \"'\\\\''\") + \"'\";\n" +
    `const target = ${JSON.stringify(targetAbs)};\n` +
    'const line = ["node", q(target)].concat(sys.argv.slice(1).map(q)).join(" ");\n' +
    "sys.exit(await sys.exec(line));\n"
  );
}

// Write `.bin` launchers for a package's `bin` field: a string (named after the
// package's unscoped name) or a `{ name: relpath }` map.
async function linkBins(name, meta, pkgDir, ctx) {
  const bin = meta.bin;
  if (!bin) return;
  const unscoped = name.split("/").pop();
  const entries = typeof bin === "string" ? { [unscoped]: bin } : bin;
  for (const [rawName, rel] of Object.entries(entries)) {
    const binName = rawName.split("/").pop(); // guard against path segments
    if (!binName || !rel) continue;
    await writeText(join(ctx.binDir, binName), binLauncherSource(join(pkgDir, rel)));
  }
}

async function loadInstalled(nmRoot) {
  const installed = new Map();
  const nm = nmRoot;
  if ((await statKind(nm)) !== "dir") return installed;
  for (const e of await sys.readdir(nm)) {
    if (!e.is_dir || e.name.startsWith(".")) continue;
    const scan = async (dir, name) => {
      const pj = join(dir, "package.json");
      if ((await statKind(pj)) === "file") {
        try {
          installed.set(name, (await readJson(pj)).version);
        } catch {}
      }
    };
    if (e.name.startsWith("@")) {
      for (const s of await sys.readdir(join(nm, e.name))) {
        if (s.is_dir) await scan(join(nm, e.name, s.name), e.name + "/" + s.name);
      }
    } else {
      await scan(join(nm, e.name), e.name);
    }
  }
  return installed;
}

// ---- commands --------------------------------------------------------------
const top = tokenizeArgv(sys.argv.slice(1), { stopAtFirstOperand: true });
// `-g` / `--global` may appear as an option before the subcommand
// (`npm -g install x`) or — because `stopAtFirstOperand` turns post-command
// args into operands — as an operand after it (`npm install -g x`). Recognize
// both, and drop the operand form so it isn't parsed as a package spec.
const isGlobalTok = (tok) =>
  (tok.kind === "option" && (tok.short === "g" || tok.name === "global")) ||
  (tok.kind === "operand" && (tok.value === "-g" || tok.value === "--global"));
const global = top.some(isGlobalTok);
const cmdIndex = top.findIndex((tok) => tok.kind === "operand" && !isGlobalTok(tok));
const cmd = cmdIndex >= 0 ? top[cmdIndex].value : null;
const rest = cmdIndex >= 0
  ? top.slice(cmdIndex + 1).filter((tok) => tok.kind === "operand" && !isGlobalTok(tok)).map((tok) => tok.value)
  : [];
const pkgJsonPath = join(sys.cwd, "package.json");

// npm create <x> == npm init <x> == exec the `create-<x>` package's bin (npx
// semantics). Map the initializer name to its package, preserving a scope and
// any trailing @version: foo->create-foo, @s->@s/create, @s/foo->@s/create-foo.
function initializerPackage(spec) {
  let name = spec, ver = "";
  const at = spec.lastIndexOf("@");
  if (at > 0) { name = spec.slice(0, at); ver = spec.slice(at + 1); }
  let pkg;
  if (name[0] === "@") {
    const slash = name.indexOf("/");
    pkg = slash < 0 ? name + "/create" : name.slice(0, slash + 1) + "create-" + name.slice(slash + 1);
  } else {
    pkg = "create-" + name;
  }
  return [pkg, ver];
}

// Fetch an initializer into an ephemeral `/tmp` prefix (discarded on close) and
// run its bin under /bin/node with the user's cwd, so it scaffolds in place. The
// bin inherits the controlling terminal, so interactive scaffolders can prompt
// (`process.stdin` reads the TTY — flowing, paused, and raw/keypress modes).
async function runInitializer(spec, args) {
  const [pkgName, ver] = initializerPackage(spec);
  const stage = "/tmp/.npm-create-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const ctx = { nmRoot: join(stage, "node_modules"), binDir: join(stage, "node_modules", ".bin") };
  out("npm: fetching " + pkgName + (ver ? "@" + ver : "") + " ...\n");
  await installOne(pkgName, ver, new Map(), 0, ctx);
  const pkgDir = join(ctx.nmRoot, pkgName);
  const meta = await readJson(join(pkgDir, "package.json"));
  const unscoped = pkgName.split("/").pop();
  let binRel;
  if (typeof meta.bin === "string") binRel = meta.bin;
  else if (meta.bin && typeof meta.bin === "object") binRel = meta.bin[unscoped] || Object.values(meta.bin)[0];
  binRel = binRel || meta.main || "index.js";
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const line = ["node", q(join(pkgDir, binRel))].concat(args.map(q)).join(" ");
  sys.exit((await sys.exec(line)) | 0);
}

async function readPkgJson() {
  if ((await statKind(pkgJsonPath)) === "file") return readJson(pkgJsonPath);
  return { name: "app", version: "1.0.0", dependencies: {} };
}

try {
  if (cmd === "create" || (cmd === "init" && rest.length)) {
    // `npm create <x>` / `npm init <x>` — scaffold via the create-* package.
    if (!rest.length) {
      err("usage: npm create <initializer> [args...]\n");
      sys.exit(1);
    }
    const args = rest[1] === "--" ? rest.slice(2) : rest.slice(1);
    await runInitializer(rest[0], args);
  } else if (cmd === "init") {
    const name = sys.cwd.split("/").filter(Boolean).pop() || "app";
    const pkg = { name, version: "1.0.0", type: "commonjs", main: "index.js", scripts: { start: "node index.js" }, dependencies: {} };
    await writeText(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
    out("Wrote " + pkgJsonPath + "\n");
    sys.exit(0);
  } else if (cmd === "install" || cmd === "i" || cmd === "add") {
    // `-g` installs into the persistent global store; otherwise into the
    // project's node_modules (and package.json is updated).
    const ctx = global ? globalCtx() : localCtx();
    const pkg = global ? null : await readPkgJson();
    if (pkg) pkg.dependencies = pkg.dependencies || {};
    const installed = await loadInstalled(ctx.nmRoot);
    let toInstall;
    if (rest.length) {
      toInstall = rest.map((spec) => {
        const at = spec.lastIndexOf("@");
        return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
      });
    } else if (global) {
      err("npm: `install -g` needs a package name\n");
      sys.exit(1);
    } else {
      toInstall = Object.entries(pkg.dependencies);
    }
    if (!toInstall.length) {
      out("nothing to install\n");
      sys.exit(0);
    }
    for (const [name, range] of toInstall) {
      await installOne(name, range === "latest" ? "" : range, installed, 0, ctx);
      if (pkg && rest.length) pkg.dependencies[name] = "^" + installed.get(name);
    }
    if (pkg && rest.length) await writeText(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
    out("done. " + installed.size + " package(s) in " + ctx.nmRoot + ".\n");
    sys.exit(0);
  } else if (cmd === "run" || cmd === "run-script") {
    const pkg = await readPkgJson();
    const script = rest[0];
    const line = (pkg.scripts || {})[script];
    if (!line) {
      err("npm: missing script: " + script + "\n");
      sys.exit(1);
    }
    out("> " + line + "\n\n");
    const extra = rest[1] === "--" ? rest.slice(2) : rest.slice(1);
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const code = await sys.exec(extra.length ? line + " " + extra.map(q).join(" ") : line);
    sys.exit(code | 0);
  } else if (cmd === "ls" || cmd === "list") {
    const installed = await loadInstalled((global ? globalCtx() : localCtx()).nmRoot);
    if (!installed.size) out("(empty)\n");
    for (const [name, version] of installed) out(name + "@" + version + "\n");
    sys.exit(0);
  } else {
    err("usage: npm <init [initializer]|create <initializer>|install [-g] [pkg...]|run <script>|ls [-g]>\n");
    sys.exit(cmd ? 1 : 0);
  }
} catch (e) {
  err("npm error: " + (e && e.message ? e.message : e) + "\n");
  sys.exit(1);
}
