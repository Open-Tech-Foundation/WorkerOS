// `zip` — package files into a ZIP archive. A guest program (INV-1), installed at
// /bin/zip and run from wsh. The container lives in /lib/workeros-archive/zip.js
// (DEFLATE via node:zlib). Common usage:
//
//   zip out.zip a.txt b.txt      archive two files
//   zip -r out.zip project       recurse into a directory
//   zip -q out.zip *             quiet (no per-file lines)
//
// Honest scope (INV-5): this writes a fresh archive from the operands (it does not
// update an existing one in place). A directory operand without -r is skipped.

import { createZip } from "/lib/workeros-archive/zip.js";
import { zlib } from "/lib/workeros-node/zlib.js";

const enc = new TextEncoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));

function normalize(p) {
  const segs = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop(); else segs.push(part);
  }
  return segs.join("/");
}
const join = (...parts) => parts.filter((p) => p != null && p !== "").join("/").replace(/\/+/g, "/");
const concat = (chunks) => { let n = 0; for (const c of chunks) n += c.length; const b = new Uint8Array(n); let o = 0; for (const c of chunks) { b.set(c, o); o += c.length; } return b; };
const readAll = async (fd) => { const c = []; for (;;) { const b = await sys.read(fd, 1 << 16); if (b.length === 0) break; c.push(b); } return concat(c); };
const readFile = async (p) => { const fd = await sys.open(p, {}); try { return await readAll(fd); } finally { await sys.close(fd); } };
const writeFile = async (p, bytes) => { const fd = await sys.open(p, { create: true, truncate: true }); try { await sys.write(fd, bytes); } finally { await sys.close(fd); } };
const statOf = async (p) => { try { return await sys.stat(p); } catch { return null; } };

let recurse = false, quiet = false, archive = null;
const inputs = [];
for (const a of sys.argv.slice(1)) {
  if (a.startsWith("-") && a !== "-") {
    if (a === "--recurse-paths") { recurse = true; continue; }
    if (a === "--quiet") { quiet = true; continue; }
    for (let i = 1; i < a.length; i++) {
      const c = a[i];
      if (c === "r" || c === "R") recurse = true;
      else if (c === "q") quiet = true;
      else if (c === "0" || c === "9" || (c >= "1" && c <= "8")) { /* level — accepted, ignored */ }
      else { err(`zip: invalid option -- '${c}'\n`); sys.exit(2); }
    }
    continue;
  }
  if (!archive) archive = a; else inputs.push(a);
}
if (!archive || inputs.length === 0) { err("usage: zip [-rq] archive.zip file...\n"); sys.exit(2); }
if (!/\.zip$/i.test(archive)) archive += ".zip";

const entries = [];
let code = 0;
async function add(absPath, arcName) {
  const st = await statOf(absPath);
  if (!st) { err(`zip warning: ${arcName} not found\n`); code = 12; return; }
  if (st.kind === "dir") {
    if (!recurse) { err(`zip warning: ${arcName} is a directory (skipped; use -r)\n`); return; }
    entries.push({ name: arcName + "/", type: "dir", mtime: st.mtime });
    if (!quiet) out(`  adding: ${arcName}/ (stored 0%)\n`);
    for (const e of await sys.readdir(absPath)) await add(join(absPath, e.name), `${arcName}/${e.name}`);
  } else {
    entries.push({ name: arcName, type: "file", data: await readFile(absPath), mtime: st.mtime });
    if (!quiet) out(`  adding: ${arcName}\n`);
  }
}

const resolve = (p) => (p.startsWith("/") ? p : join(sys.cwd, p));
for (const operand of inputs) await add(resolve(operand), normalize(operand));
if (entries.length) await writeFile(resolve(archive), createZip(entries, zlib));
sys.exit(code);
