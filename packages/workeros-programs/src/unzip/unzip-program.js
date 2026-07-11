// `unzip` — list or extract a ZIP archive. A guest program (INV-1), installed at
// /bin/unzip and run from wsh. Reads the container via /lib/workeros-archive/zip.js
// (DEFLATE via node:zlib). Common usage:
//
//   unzip archive.zip            extract into the current directory
//   unzip archive.zip -d /dest   extract into /dest
//   unzip -l archive.zip         list contents (no extraction)
//   unzip -o archive.zip         overwrite without prompting (the default here)

import { parseZip } from "/lib/workeros-archive/zip.js";
import { ArgError, tokenizeArgv } from "/lib/workeros-cli/args.js";
import { zlib } from "/lib/workeros-node/zlib.js";

const enc = new TextEncoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));

function normalize(p) {
  const abs = p.startsWith("/");
  const segs = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (segs.length) segs.pop(); } else segs.push(part);
  }
  return (abs ? "/" : "") + segs.join("/");
}
const join = (...parts) => normalize(parts.filter((p) => p != null && p !== "").join("/"));
const dirname = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i); };
const concat = (chunks) => { let n = 0; for (const c of chunks) n += c.length; const b = new Uint8Array(n); let o = 0; for (const c of chunks) { b.set(c, o); o += c.length; } return b; };
const readAll = async (fd) => { const c = []; for (;;) { const b = await sys.read(fd, 1 << 16); if (b.length === 0) break; c.push(b); } return concat(c); };
const readFile = async (p) => { const fd = await sys.open(p, {}); try { return await readAll(fd); } finally { await sys.close(fd); } };
const writeFile = async (p, bytes) => { const fd = await sys.open(p, { create: true, truncate: true }); try { await sys.write(fd, bytes); } finally { await sys.close(fd); } };
const statOf = async (p) => { try { return await sys.stat(p); } catch { return null; } };
async function mkdirp(p) {
  if (p === "/" || p === "." || p === "") return;
  if (await statOf(p)) return;
  await mkdirp(dirname(p));
  try { await sys.mkdir(p); } catch { /* exists — fine */ }
}

let listOnly = false, destDir = null, archive = null;
try {
  for (const tok of tokenizeArgv(sys.argv.slice(1), {
    shortAlias: { d: "dir", l: "list", o: "overwrite", q: "quiet", n: "never" },
    shortValue: new Set(["d"]),
  })) {
    if (tok.kind === "operand") {
      if (!archive) archive = tok.value;
      continue;
    }
    if (tok.kind !== "option") continue;
    if (tok.name === "dir") destDir = tok.value;
    else if (tok.name === "list") listOnly = true;
    else if (tok.name === "overwrite" || tok.name === "quiet" || tok.name === "never") { /* accepted */ }
    else { err(`unzip: invalid option -- '${tok.short || tok.name}'\n`); sys.exit(2); }
  }
} catch (e) {
  if (e instanceof ArgError) {
    err("unzip: " + e.message + "\n");
    sys.exit(e.exitCode);
  }
  throw e;
}
if (!archive) { err("usage: unzip [-l] [-o] archive.zip [-d dir]\n"); sys.exit(2); }

const resolve = (p) => (p.startsWith("/") ? normalize(p) : join(sys.cwd, p));

let entries;
try {
  entries = parseZip(await readFile(resolve(archive)), zlib);
} catch (e) {
  err(`unzip: ${archive}: ${e.message}\n`);
  sys.exit(1);
}

if (listOnly) {
  out("  Length      Name\n---------  ----\n");
  let total = 0;
  for (const e of entries) { total += e.size || 0; out(`${String(e.size || 0).padStart(9)}  ${e.name}${e.type === "dir" ? "/" : ""}\n`); }
  out(`---------  ----\n${String(total).padStart(9)}  ${entries.length} files\n`);
  sys.exit(0);
}

const base = destDir ? resolve(destDir) : sys.cwd;
for (const e of entries) {
  const target = join(base, e.name);
  if (e.type === "dir") { await mkdirp(target); }
  else { await mkdirp(dirname(target)); await writeFile(target, e.data); out(`  inflating: ${e.name}\n`); }
}
sys.exit(0);
