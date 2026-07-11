// `tar` — create, list, and extract POSIX tar archives, with optional gzip.
// A guest program (INV-1), installed at /bin/tar and run from wsh. The ustar
// framing lives in the shared /lib/workeros-archive/tar.js library; gzip is
// node:zlib. Familiar GNU-style usage (bundled or dashed flags both work):
//
//   tar -czf out.tgz src            create a gzip'd archive of src/
//   tar -xzf out.tgz -C /dest       extract into /dest
//   tar -tf archive.tar             list contents
//   tar cf - dir | …                write to stdout with -f -
//
// gzip is auto-detected on extract/list when the archive ends in .gz/.tgz.

import { createTar, parseTar } from "/lib/workeros-archive/tar.js";
import { ArgError, tokenizeArgv } from "/lib/workeros-cli/args.js";
import { zlib } from "/lib/workeros-node/zlib.js";

const enc = new TextEncoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));

// ---- path helpers (absolute, normalized — so -C works without a real chdir) --
function normalize(p) {
  const abs = p.startsWith("/");
  const segs = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (segs.length && segs[segs.length - 1] !== "..") segs.pop(); else if (!abs) segs.push(".."); }
    else segs.push(part);
  }
  return (abs ? "/" : "") + segs.join("/") || (abs ? "/" : ".");
}
const join = (...parts) => normalize(parts.filter((p) => p != null && p !== "").join("/"));
const dirname = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i); };

const concat = (chunks) => {
  let n = 0;
  for (const c of chunks) n += c.length;
  const b = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { b.set(c, o); o += c.length; }
  return b;
};
const readAll = async (fd) => { const c = []; for (;;) { const b = await sys.read(fd, 1 << 16); if (b.length === 0) break; c.push(b); } return concat(c); };
const readFile = async (p) => { const fd = await sys.open(p, {}); try { return await readAll(fd); } finally { await sys.close(fd); } };
const writeFile = async (p, bytes) => { const fd = await sys.open(p, { create: true, truncate: true }); try { await sys.write(fd, bytes); } finally { await sys.close(fd); } };
const statOf = async (p) => { try { return await sys.stat(p); } catch { return null; } };
async function mkdirp(p) {
  if (p === "/" || p === "." || p === "") return;
  if (await statOf(p)) return;
  await mkdirp(dirname(p));
  try { await sys.mkdir(p); } catch { /* raced/exists — fine */ }
}

// ---- argument parsing (supports `tar czf …` and `tar -czf …`) --------------
let op = null, gzipFlag = false, verbose = false, file = null, chdir = null;
const operands = [];
try {
  for (const tok of tokenizeArgv(sys.argv.slice(1), {
    shortValue: new Set(["f", "C"]),
    firstTokenGroupedShort: true,
  })) {
    if (tok.kind === "operand") { operands.push(tok.value); continue; }
    if (tok.kind !== "option") continue;
    const c = tok.short || tok.name;
    if (c === "c" || c === "x" || c === "t") op = c;
    else if (c === "z") gzipFlag = true;
    else if (c === "v") verbose = true;
    else if (c === "f") file = tok.value;
    else if (c === "C") chdir = tok.value;
    else { err(`tar: invalid option -- '${c}'\n`); sys.exit(2); }
  }
} catch (e) {
  if (e instanceof ArgError) {
    err("tar: " + e.message + "\n");
    sys.exit(e.exitCode);
  }
  throw e;
}
if (!op) { err("tar: you must specify one of -c, -x, -t\n"); sys.exit(2); }

const resolve = (p) => (p.startsWith("/") ? normalize(p) : join(sys.cwd, p));
const base = chdir ? resolve(chdir) : sys.cwd;
const useStdio = !file || file === "-";
const gz = gzipFlag || (op !== "c" && file && /\.(gz|tgz)$/.test(file));

// ---- create ----------------------------------------------------------------
async function create() {
  const entries = [];
  async function add(absPath, arcName) {
    const st = await statOf(absPath);
    if (!st) { err(`tar: ${arcName}: No such file or directory\n`); return 1; }
    if (st.kind === "dir") {
      entries.push({ name: arcName, type: "dir", mtime: st.mtime });
      for (const e of await sys.readdir(absPath)) await add(join(absPath, e.name), `${arcName}/${e.name}`);
    } else {
      entries.push({ name: arcName, type: "file", data: await readFile(absPath), mtime: st.mtime });
    }
    if (verbose) err(`${arcName}\n`);
    return 0;
  }
  let code = 0;
  for (const operand of operands) {
    const arc = normalize(operand);
    code |= await add(join(base, operand), arc);
  }
  let bytes = createTar(entries);
  if (gz) bytes = zlib.gzipSync(bytes);
  if (useStdio) sys.write(1, bytes);
  else await writeFile(resolve(file), bytes);
  return code;
}

// ---- read (extract / list) -------------------------------------------------
async function readArchive() {
  let bytes = useStdio ? await readAll(0) : await readFile(resolve(file));
  if (gz) bytes = zlib.gunzipSync(bytes);
  return parseTar(bytes);
}
async function list() {
  for (const e of await readArchive()) out(`${e.name}${e.type === "dir" ? "/" : ""}\n`);
  return 0;
}
async function extract() {
  for (const e of await readArchive()) {
    const target = join(base, e.name);
    if (e.type === "dir") { await mkdirp(target); }
    else { await mkdirp(dirname(target)); await writeFile(target, e.data); }
    if (verbose) err(`${e.name}\n`);
  }
  return 0;
}

sys.exit(await (op === "c" ? create() : op === "t" ? list() : extract()));
