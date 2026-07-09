// WorkerOS coreutils — guest programs (ADR-017).
//
// Each entry is a complete, self-contained program run as its own process. They
// are written against the WorkerOS-native `sys` ABI (installed on `globalThis`
// by the program worker): `sys.argv/env/cwd`, `sys.write/read`, and the file
// ops `open/close/readdir/stat/mkdir/unlink/rmdir/rename`, plus `sys.exit`.
//
// They are userland, not kernel (INV-1): every heavy decision (path resolution,
// glob, the VFS, pipes) is made by the Rust kernel behind these syscalls. A
// coreutil is a thin argv→syscall adapter. `sys.exit(code)` unwinds the program;
// unhandled errors are reported by the program worker as a non-zero exit.
//
// The host installs these into the VFS at `/sbin/*` (system binaries) on boot.

const PRELUDE = `const enc = new TextEncoder();
const dec = new TextDecoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));
const flags = sys.argv.slice(1).filter((a) => a.startsWith("-") && a !== "-");
const operands = sys.argv.slice(1).filter((a) => !a.startsWith("-") || a === "-");
const has = (f) => flags.some((g) => g.includes(f.replace("-", "")));
const basename = (p) => p.replace(/\\/+$/, "").split("/").pop();
// Read a whole fd to text.
const readFd = async (fd) => {
  const chunks = [];
  for (;;) { const b = await sys.read(fd, 65536); if (b.length === 0) break; chunks.push(b); }
  let n = 0; for (const c of chunks) n += c.length;
  const u = new Uint8Array(n); let o = 0; for (const c of chunks) { u.set(c, o); o += c.length; }
  return dec.decode(u);
};
// Read a list of file operands (or stdin when empty / "-"), concatenated to text.
const readInputs = async (files) => {
  if (!files || files.length === 0) return readFd(0);
  let s = "";
  for (const f of files) {
    if (f === "-") { s += await readFd(0); continue; }
    const fd = await sys.open(f, {}); s += await readFd(fd); await sys.close(fd);
  }
  return s;
};
// Split text into lines, dropping a single trailing newline's empty element.
const toLines = (t) => { const a = t.split("\\n"); if (a.length && a[a.length - 1] === "") a.pop(); return a; };
const emit = (arr) => out(arr.length ? arr.join("\\n") + "\\n" : "");
`;

/** Wrap a coreutil body with the shared prelude. */
function util(body) {
  return PRELUDE + body;
}

export const coreutils = {
  "/sbin/echo": util(`
let nl = true;
let args = sys.argv.slice(1);
if (args[0] === "-n") { nl = false; args = args.slice(1); }
out(args.join(" ") + (nl ? "\\n" : ""));
sys.exit(0);
`),

  "/sbin/true": `sys.exit(0);`,
  "/sbin/false": `sys.exit(1);`,

  "/sbin/pwd": util(`out(sys.cwd + "\\n"); sys.exit(0);`),

  "/sbin/env": util(`
const lines = Object.entries(sys.env).map(([k, v]) => k + "=" + v);
out(lines.join("\\n") + (lines.length ? "\\n" : ""));
sys.exit(0);
`),

  "/sbin/cat": util(`
async function dump(fd) {
  for (;;) {
    const b = await sys.read(fd, 65536);
    if (b.length === 0) break;
    sys.write(1, b);
  }
}
let code = 0;
if (operands.length === 0) {
  await dump(0); // stdin (a pipe, or empty terminal)
} else {
  for (const f of operands) {
    if (f === "-") { await dump(0); continue; }
    try {
      const fd = await sys.open(f, {});
      await dump(fd);
      await sys.close(fd);
    } catch (e) {
      err("cat: " + f + ": No such file or directory\\n");
      code = 1;
    }
  }
}
sys.exit(code);
`),

  "/sbin/ls": util(`
const showAll = has("a");
const targets = operands.length ? operands : ["."];
let code = 0;
const many = targets.length > 1;
for (const t of targets) {
  try {
    const st = await sys.stat(t);
    if (st.kind === "dir") {
      const entries = await sys.readdir(t);
      const names = entries.map((e) => e.name).filter((n) => showAll || !n.startsWith("."));
      if (many) out(t + ":\\n");
      out(names.join("\\n") + (names.length ? "\\n" : ""));
    } else {
      out(t + "\\n");
    }
  } catch (e) {
    err("ls: " + t + ": No such file or directory\\n");
    code = 1;
  }
}
sys.exit(code);
`),

  "/sbin/mkdir": util(`
const parents = has("p");
async function mkone(p) {
  if (parents) {
    const absolute = p.startsWith("/");
    let cur = absolute ? "" : ".";
    for (const part of p.split("/").filter(Boolean)) {
      cur = cur + "/" + part;
      try { await sys.mkdir(cur); } catch (e) { /* already exists — ok for -p */ }
    }
  } else {
    await sys.mkdir(p);
  }
}
let code = 0;
for (const d of operands) {
  try { await mkone(d); }
  catch (e) { err("mkdir: cannot create directory '" + d + "'\\n"); code = 1; }
}
sys.exit(code);
`),

  "/sbin/rm": util(`
const recursive = has("r") || has("R");
const force = has("f");
async function rmrf(p) {
  const st = await sys.stat(p);
  if (st.kind === "dir") {
    for (const e of await sys.readdir(p)) await rmrf(p.replace(/\\/+$/, "") + "/" + e.name);
    await sys.rmdir(p);
  } else {
    await sys.unlink(p);
  }
}
let code = 0;
for (const t of operands) {
  try {
    if (recursive) { await rmrf(t); }
    else {
      const st = await sys.stat(t);
      if (st.kind === "dir") throw new Error("is a directory");
      await sys.unlink(t);
    }
  } catch (e) {
    if (!force) { err("rm: cannot remove '" + t + "': " + e.message + "\\n"); code = 1; }
  }
}
sys.exit(code);
`),

  "/sbin/cp": util(`
if (operands.length < 2) { err("cp: missing file operand\\n"); sys.exit(1); }
const src = operands[0];
let dst = operands[1];
try {
  const dstat = await sys.stat(dst).catch(() => null);
  if (dstat && dstat.kind === "dir") dst = dst.replace(/\\/+$/, "") + "/" + basename(src);
  const fin = await sys.open(src, {});
  const fout = await sys.open(dst, { create: true, truncate: true });
  for (;;) {
    const b = await sys.read(fin, 65536);
    if (b.length === 0) break;
    sys.write(fout, b);
  }
  await sys.close(fin);
  await sys.close(fout);
  sys.exit(0);
} catch (e) {
  err("cp: " + e.message + "\\n");
  sys.exit(1);
}
`),

  "/sbin/mv": util(`
if (operands.length < 2) { err("mv: missing file operand\\n"); sys.exit(1); }
const src = operands[0];
let dst = operands[1];
try {
  const dstat = await sys.stat(dst).catch(() => null);
  if (dstat && dstat.kind === "dir") dst = dst.replace(/\\/+$/, "") + "/" + basename(src);
  await sys.rename(src, dst);
  sys.exit(0);
} catch (e) {
  err("mv: " + e.message + "\\n");
  sys.exit(1);
}
`),

  // seq [FIRST [INCR]] LAST — print a number sequence.
  "/sbin/seq": util(`
const a = operands.map(Number);
let first = 1, incr = 1, last = 0;
if (a.length === 1) { last = a[0]; }
else if (a.length === 2) { first = a[0]; last = a[1]; }
else if (a.length >= 3) { first = a[0]; incr = a[1]; last = a[2]; }
if (incr === 0) { err("seq: increment must not be zero\\n"); sys.exit(1); }
const res = [];
if (incr > 0) for (let i = first; i <= last; i += incr) res.push(i);
else for (let i = first; i >= last; i += incr) res.push(i);
emit(res.map(String));
sys.exit(0);
`),

  // head [-n N] [files] — first N lines (default 10).
  "/sbin/head": util(`
let n = 10; const files = []; const av = sys.argv.slice(1);
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === "-n") { n = parseInt(av[++i], 10); }
  else if (/^-n/.test(a)) { n = parseInt(a.slice(2), 10); }
  else if (/^-[0-9]+$/.test(a)) { n = parseInt(a.slice(1), 10); }
  else files.push(a);
}
emit(toLines(await readInputs(files)).slice(0, n));
sys.exit(0);
`),

  // tail [-n N] [files] — last N lines (default 10).
  "/sbin/tail": util(`
let n = 10; const files = []; const av = sys.argv.slice(1);
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === "-n") { n = parseInt(av[++i], 10); }
  else if (/^-n/.test(a)) { n = parseInt(a.slice(2), 10); }
  else if (/^-[0-9]+$/.test(a)) { n = parseInt(a.slice(1), 10); }
  else files.push(a);
}
const arr = toLines(await readInputs(files));
emit(n >= arr.length ? arr : arr.slice(arr.length - n));
sys.exit(0);
`),

  // wc [-l|-w|-c] [files] — count lines, words, characters.
  "/sbin/wc": util(`
const text = await readInputs(operands);
const lines = (text.match(/\\n/g) || []).length;
const words = text.trim() === "" ? 0 : text.trim().split(/\\s+/).length;
const chars = text.length;
let parts = [];
if (has("l")) parts.push(lines);
if (has("w")) parts.push(words);
if (has("c")) parts.push(chars);
if (parts.length === 0) parts = [lines, words, chars];
out(parts.join(" ") + "\\n");
sys.exit(0);
`),

  // sort [-r] [-n] [-u] [files] — sort lines.
  "/sbin/sort": util(`
let arr = toLines(await readInputs(operands));
if (has("n")) arr.sort((a, b) => parseFloat(a) - parseFloat(b));
else arr.sort();
if (has("r")) arr.reverse();
if (has("u")) arr = arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
emit(arr);
sys.exit(0);
`),

  // uniq [-c] [files] — collapse adjacent duplicate lines.
  "/sbin/uniq": util(`
const arr = toLines(await readInputs(operands));
const res = []; let prev = null, count = 0;
const push = () => { if (prev !== null) res.push(has("c") ? String(count).padStart(7) + " " + prev : prev); };
for (const l of arr) { if (l === prev) count++; else { push(); prev = l; count = 1; } }
push();
emit(res);
sys.exit(0);
`),

  // cut -d DELIM -f LIST [files] — select fields (1-based; ranges 1-3, lists 1,3).
  "/sbin/cut": util(`
let delim = "\\t", spec = null; const files = []; const av = sys.argv.slice(1);
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === "-d") delim = av[++i];
  else if (/^-d/.test(a)) delim = a.slice(2);
  else if (a === "-f") spec = av[++i];
  else if (/^-f/.test(a)) spec = a.slice(2);
  else files.push(a);
}
if (!spec) { err("cut: you must specify a list of fields with -f\\n"); sys.exit(1); }
const idx = [];
for (const part of spec.split(",")) {
  if (part.includes("-")) { const [x, y] = part.split("-").map(Number); for (let i = x; i <= y; i++) idx.push(i); }
  else idx.push(Number(part));
}
const arr = toLines(await readInputs(files));
emit(arr.map((l) => { const f = l.split(delim); return idx.map((i) => f[i - 1]).filter((v) => v !== undefined).join(delim); }));
sys.exit(0);
`),

  // tr SET1 [SET2] / tr -d SET1 — translate or delete characters (reads stdin).
  "/sbin/tr": util(`
const expand = (set) => {
  let r = "";
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] === "-" && set[i + 2] !== undefined) {
      for (let c = set.charCodeAt(i); c <= set.charCodeAt(i + 2); c++) r += String.fromCharCode(c);
      i += 2;
    } else r += set[i];
  }
  return r;
};
const text = await readFd(0);
const set1 = expand(operands[0] || "");
let res;
if (has("d")) { const s = new Set(set1); res = [...text].filter((c) => !s.has(c)).join(""); }
else {
  const set2 = expand(operands[1] || "");
  const map = {}; for (let i = 0; i < set1.length; i++) map[set1[i]] = set2[Math.min(i, set2.length - 1)] ?? set1[i];
  res = [...text].map((c) => (c in map ? map[c] : c)).join("");
}
out(res);
sys.exit(0);
`),

  // grep [-i] [-v] [-n] PATTERN [files] — JS regex grep (a Rust build is planned).
  "/sbin/grep": util(`
if (operands.length === 0) { err("usage: grep [-ivn] PATTERN [file...]\\n"); sys.exit(2); }
const pattern = operands[0];
const files = operands.slice(1);
let re;
try { re = new RegExp(pattern, has("i") ? "i" : ""); }
catch (e) { err("grep: invalid pattern: " + e.message + "\\n"); sys.exit(2); }
const invert = has("v"), number = has("n");
const arr = toLines(await readInputs(files));
let matched = false, buf = "";
arr.forEach((l, i) => { if (re.test(l) !== invert) { matched = true; buf += (number ? (i + 1) + ":" : "") + l + "\\n"; } });
out(buf);
sys.exit(matched ? 0 : 1);
`),
};
