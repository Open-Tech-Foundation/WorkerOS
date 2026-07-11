// `gzip` / `gunzip` / `zcat` — compress or expand files with gzip (RFC 1952).
// A guest program (INV-1), installed at /bin/gzip, /bin/gunzip, /bin/zcat and run
// from wsh. It dispatches on its own name, layers node:zlib over the `sys` ABI,
// and follows the familiar GNU semantics:
//
//   gzip file.txt        → writes file.txt.gz, removes file.txt
//   gzip -k file.txt     → keep the original too
//   gzip -c file.txt     → write to stdout (implies keep)
//   gunzip file.txt.gz   → writes file.txt, removes file.txt.gz
//   zcat file.txt.gz     → decompress to stdout
//   … | gzip | …         → no file operands: stream stdin → stdout
//
// Authored as a top-level-await ESM program: it imports the shared codec from
// /lib and uses the `sys` global the program worker installs.

import { zlib } from "/lib/workeros-node/zlib.js";

const enc = new TextEncoder();
const err = (s) => sys.write(2, enc.encode(s));

const concat = (chunks) => {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};
const readAll = async (fd) => {
  const chunks = [];
  for (;;) { const b = await sys.read(fd, 1 << 16); if (b.length === 0) break; chunks.push(b); }
  return concat(chunks);
};
const readFile = async (p) => { const fd = await sys.open(p, {}); try { return await readAll(fd); } finally { await sys.close(fd); } };
const writeFile = async (p, bytes) => { const fd = await sys.open(p, { create: true, truncate: true }); try { await sys.write(fd, bytes); } finally { await sys.close(fd); } };
const exists = async (p) => { try { await sys.stat(p); return true; } catch { return false; } };

const self = (sys.argv[0] || "gzip").split("/").pop();
let decompress = self === "gunzip" || self === "zcat";
let toStdout = self === "zcat";
let keep = false, force = false;
const files = [];

for (const a of sys.argv.slice(1)) {
  if (a === "-" || !a.startsWith("-")) { files.push(a); continue; }
  if (a === "--stdout") { toStdout = true; continue; }
  if (a === "--decompress" || a === "--uncompress") { decompress = true; continue; }
  if (a === "--keep") { keep = true; continue; }
  if (a === "--force") { force = true; continue; }
  if (a === "--help") { err("usage: gzip [-cdkf] [file...]\n"); sys.exit(0); }
  for (let i = 1; i < a.length; i++) {
    const c = a[i];
    if (c === "d") decompress = true;
    else if (c === "c") toStdout = true;
    else if (c === "k") keep = true;
    else if (c === "f") force = true;
    else if (c >= "1" && c <= "9") { /* compression level — accepted, ignored */ }
    else { err(`${self}: invalid option -- '${c}'\n`); sys.exit(2); }
  }
}

const xform = (bytes) => (decompress ? zlib.gunzipSync(bytes) : zlib.gzipSync(bytes));

let code = 0;

// No file operands (or a bare "-"): stream stdin → stdout.
if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
  try { sys.write(1, xform(await readAll(0))); } catch (e) { err(`${self}: ${e.message}\n`); code = 1; }
  sys.exit(code);
}

for (const f of files) {
  try {
    if (f === "-") { sys.write(1, xform(await readAll(0))); continue; }
    const input = await readFile(f);
    const output = xform(input);

    if (toStdout) { sys.write(1, output); continue; }

    let target;
    if (decompress) {
      if (f.endsWith(".gz")) target = f.slice(0, -3);
      else if (f.endsWith(".tgz")) target = f.slice(0, -4) + ".tar";
      else { err(`${self}: ${f}: unknown suffix -- ignored\n`); code = 1; continue; }
    } else {
      if (f.endsWith(".gz")) { err(`${self}: ${f} already has .gz suffix -- unchanged\n`); code = 1; continue; }
      target = f + ".gz";
    }

    if (!force && (await exists(target))) { err(`${self}: ${target} already exists; use -f to overwrite\n`); code = 1; continue; }
    await writeFile(target, output);
    if (!keep) await sys.unlink(f);
  } catch (e) {
    err(`${self}: ${f}: ${e.message}\n`);
    code = 1;
  }
}

sys.exit(code);
