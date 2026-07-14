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

const PRELUDE = `import { collectSimpleFlags, hasFlag as hasParsedFlag } from "/lib/workeros-cli/args.js";
const enc = new TextEncoder();
const dec = new TextDecoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));
const parsedFlags = collectSimpleFlags(sys.argv.slice(1));
const { flags, longFlags, operands } = parsedFlags;
const has = (f) => hasParsedFlag(parsedFlags, f);
const basename = (p) => p.replace(/\\/+$/, "").split("/").pop();
const commandName = basename(sys.argv[0] || "coreutil");
const unsupportedOption = (option) => {
  err(commandName + ": unrecognized option '" + option + "'\\n");
  sys.exit(2);
};
const invalidUsage = (message) => {
  err(commandName + ": " + message + "\\n");
  sys.exit(1);
};
// These programs intentionally expose a small, useful option subset. Reject
// everything else so an unsupported flag can never appear to have succeeded.
const acceptOptions = (short = "", long = []) => {
  for (const flag of flags) if (!short.includes(flag)) unsupportedOption("-" + flag);
  for (const flag of longFlags) if (!long.includes(flag)) unsupportedOption("--" + flag);
};
// Read a whole fd without losing its original byte representation.
const readFdBytes = async (fd) => {
  const chunks = [];
  for (;;) { const b = await sys.read(fd, 65536); if (b.length === 0) break; chunks.push(b); }
  let n = 0; for (const c of chunks) n += c.length;
  const u = new Uint8Array(n); let o = 0; for (const c of chunks) { u.set(c, o); o += c.length; }
  return u;
};
const readFd = async (fd) => dec.decode(await readFdBytes(fd));
const readInputBytes = async (file) => {
  if (file === "-") return readFdBytes(0);
  const fd = await sys.open(file, {});
  try { return await readFdBytes(fd); }
  finally { await sys.close(fd); }
};
const readInput = async (file) => dec.decode(await readInputBytes(file));
const closeQuietly = async (fd) => {
  if (fd === null || fd === undefined) return;
  try { await sys.close(fd); } catch (_) {}
};
// Read a list of file operands (or stdin when empty / "-"), concatenated to text.
const readInputs = async (files) => {
  if (!files || files.length === 0) return readFd(0);
  let s = "";
  for (const f of files) s += await readInput(f);
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
let interpret = false;
let args = sys.argv.slice(1);
// Consume leading option groups: -n, -e, -E (and combos like -ne). Anything else
// (e.g. -foo, or a bare -) is treated as an operand, matching POSIX echo.
while (args.length && /^-[neE]+$/.test(args[0])) {
  const f = args[0].slice(1);
  if (f.includes("n")) nl = false;
  if (f.includes("e")) interpret = true;
  if (f.includes("E")) interpret = false;
  args = args.slice(1);
}
let s = args.join(" ");
if (interpret) {
  // -e: interpret backslash escapes (\\n \\t \\e \\xHH \\0NNN … ). Char codes keep
  // the source free of nested backslash-escaping. 92 is the backslash byte.
  const map = { n: 10, t: 9, r: 13, e: 27, E: 27, a: 7, b: 8, f: 12, v: 11 };
  let r = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 92 || i + 1 >= s.length) { r += s[i]; continue; }
    const c = s[++i];
    if (c === String.fromCharCode(92)) { r += String.fromCharCode(92); }
    else if (c in map) { r += String.fromCharCode(map[c]); }
    else if (c === "c") { nl = false; break; } // \\c: stop output, no newline
    else if (c === "x") {
      let h = "";
      while (h.length < 2 && i + 1 < s.length && /[0-9a-fA-F]/.test(s[i + 1])) h += s[++i];
      r += h ? String.fromCharCode(parseInt(h, 16)) : String.fromCharCode(92) + "x";
    } else if (c >= "0" && c <= "7") {
      let o = c;
      while (o.length < 3 && i + 1 < s.length && s[i + 1] >= "0" && s[i + 1] <= "7") o += s[++i];
      r += String.fromCharCode(parseInt(o, 8) & 0xff);
    } else { r += String.fromCharCode(92) + c; }
  }
  s = r;
}
out(s + (nl ? "\\n" : ""));
sys.exit(0);
`),

  // No prelude: they only exit. Kept import-free so the bundle is trivially empty.
  "/sbin/true": `sys.exit(0);`,
  "/sbin/false": `sys.exit(1);`,

  "/sbin/pwd": util(`
acceptOptions();
if (operands.length) invalidUsage("extra operand '" + operands[0] + "'");
out(sys.cwd + "\\n");
sys.exit(0);
`),

  "/sbin/env": util(`
acceptOptions();
if (operands.length) invalidUsage("unsupported operand '" + operands[0] + "'");
const lines = Object.entries(sys.env).map(([k, v]) => k + "=" + v);
out(lines.join("\\n") + (lines.length ? "\\n" : ""));
sys.exit(0);
`),

  "/sbin/cat": util(`
acceptOptions("n");
const numbered = has("n");
let lineNumber = 1, atLineStart = true;
const prefix = () => sys.write(1, enc.encode(String(lineNumber++).padStart(6) + "\\t"));
async function dump(fd) {
  for (;;) {
    const b = await sys.read(fd, 65536);
    if (b.length === 0) break;
    if (!numbered) { sys.write(1, b); continue; }
    let start = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== 10) continue;
      if (atLineStart) prefix();
      sys.write(1, b.subarray(start, i + 1));
      atLineStart = true; start = i + 1;
    }
    if (start < b.length) {
      if (atLineStart) prefix();
      sys.write(1, b.subarray(start));
      atLineStart = false;
    }
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
      try { await dump(fd); }
      finally { await sys.close(fd); }
    } catch (e) {
      err("cat: " + f + ": " + e.message + "\\n");
      code = 1;
    }
  }
}
sys.exit(code);
`),

  "/sbin/ls": util(`
acceptOptions("alhrRdt");
const showAll = has("a");
const long = has("l");
const human = has("h");
const reverse = has("r");
const recursive = has("R");
const directoryAsFile = has("d");
const sortTime = has("t");
let code = 0;

const formatSize = (bytes) => {
  if (!human) return String(bytes);
  const units = ['B', 'K', 'M', 'G', 'T'];
  let u = 0;
  while (bytes >= 1024 && u < units.length - 1) { bytes /= 1024; u++; }
  return (u === 0 ? String(bytes) : bytes.toFixed(1)) + units[u];
};
const displayMode = (kind) => kind === "dir" ? "drwxr-xr-x" : kind === "symlink" ? "lrwxrwxrwx" : "-rw-r--r--";
const formatTime = (mtime) => new Date(Number(mtime) || 0).toISOString().slice(0, 16).replace("T", " ");
const formatLong = (st, name) =>
  displayMode(st.kind) + " " + String(st.nlink || 1).padStart(2) + " " +
  formatSize(st.size).padStart(8) + " " + formatTime(st.mtime) + " " + name + "\\n";

async function listDir(t, many) {
  try {
    const st = await sys.stat(t);
    if (st.kind !== "dir" || directoryAsFile) {
      if (long) out(formatLong(st, t));
      else out(t + "\\n");
      return;
    }
    const entries = await sys.readdir(t);
    let names = entries.map((e) => e.name).filter((n) => showAll || !n.startsWith("."));
    if (sortTime) {
      const stamped = await Promise.all(names.map(async (name) => {
        const path = t.replace(/\\/+$/, "") + "/" + name;
        const st = await sys.stat(path).catch(() => null);
        return { name, mtime: Number(st?.mtime) || 0 };
      }));
      stamped.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      names = stamped.map((entry) => entry.name);
    } else names.sort();
    if (reverse) names.reverse();

    if (many) out(t + ":\\n");
    
    if (long) {
      for (const n of names) {
        const path = t.replace(/\\/+$/, "") + "/" + n;
        try {
          const cst = await sys.stat(path);
          out(formatLong(cst, n));
        } catch(e) {
          out("?????????? ?? ???????? ???????????????? " + n + "\\n");
        }
      }
    } else {
      out(names.join("\\n") + (names.length ? "\\n" : ""));
    }

    if (recursive) {
      for (const n of names) {
        if (n === "." || n === "..") continue;
        const path = t.replace(/\\/+$/, "") + "/" + n;
        const cst = await sys.stat(path).catch(() => null);
        if (cst && cst.kind === "dir") {
          out("\\n");
          await listDir(path, true);
        }
      }
    }
  } catch (e) {
    err("ls: " + t + ": " + e.message + "\\n");
    code = 1;
  }
}

const targets = operands.length ? operands : ["."];
targets.sort();
if (reverse) targets.reverse();
const many = targets.length > 1 || recursive;

for (let i = 0; i < targets.length; i++) {
  if (i > 0 && many && !recursive) out("\\n");
  await listDir(targets[i], many);
}
sys.exit(code);
`),

  "/sbin/mkdir": util(`
acceptOptions("p");
if (operands.length === 0) invalidUsage("missing operand");
const parents = has("p");
async function mkone(p) {
  if (parents) {
    const absolute = p.startsWith("/");
    let cur = absolute ? "" : ".";
    for (const part of p.split("/").filter(Boolean)) {
      cur = cur + "/" + part;
      try { await sys.mkdir(cur); }
      catch (e) {
        const st = await sys.stat(cur).catch(() => null);
        if (!st || st.kind !== "dir") throw e;
      }
    }
  } else {
    await sys.mkdir(p);
  }
}
let code = 0;
for (const d of operands) {
  try { await mkone(d); }
  catch (e) { err("mkdir: cannot create directory '" + d + "': " + e.message + "\\n"); code = 1; }
}
sys.exit(code);
`),

  "/sbin/rm": util(`
acceptOptions("rRf");
const recursive = has("r") || has("R");
const force = has("f");
if (operands.length === 0 && !force) invalidUsage("missing operand");
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
acceptOptions("r");
if (operands.length < 2) { err("cp: missing file operand\\n"); sys.exit(1); }
const recursive = has("r");
const sources = operands.slice(0, -1);
const destination = operands[operands.length - 1];
const dstat = await sys.stat(destination).catch(() => null);
if (sources.length > 1 && (!dstat || dstat.kind !== "dir")) invalidUsage("target '" + destination + "' is not a directory");
const ensureDir = async (path) => {
  const st = await sys.stat(path).catch(() => null);
  if (st) {
    if (st.kind !== "dir") throw new Error("destination is not a directory");
    return;
  }
  await sys.mkdir(path);
};
const copyEntry = async (src, dst) => {
  if (src === dst) throw new Error("source and destination are the same file");
  const sstat = await sys.stat(src);
  if (sstat.kind === "dir") {
    if (!recursive) throw new Error("is a directory (use -r)");
    const prefix = src.replace(/\\/+$/, "") + "/";
    if (dst.startsWith(prefix)) throw new Error("cannot copy a directory into itself");
    await ensureDir(dst);
    for (const entry of await sys.readdir(src)) {
      await copyEntry(prefix + entry.name, dst.replace(/\\/+$/, "") + "/" + entry.name);
    }
    return;
  }
  let fin = null, fout = null;
  try {
    fin = await sys.open(src, {});
    fout = await sys.open(dst, { create: true, truncate: true });
    for (;;) {
      const bytes = await sys.read(fin, 65536);
      if (bytes.length === 0) break;
      sys.write(fout, bytes);
    }
  } finally {
    await closeQuietly(fin);
    await closeQuietly(fout);
  }
};
let code = 0;
for (const src of sources) {
  const dst = dstat && dstat.kind === "dir"
    ? destination.replace(/\\/+$/, "") + "/" + basename(src)
    : destination;
  try { await copyEntry(src, dst); }
  catch (e) {
    err("cp: " + src + ": " + e.message + "\\n");
    code = 1;
  }
}
sys.exit(code);
`),

  "/sbin/mv": util(`
acceptOptions();
if (operands.length < 2) { err("mv: missing file operand\\n"); sys.exit(1); }
const sources = operands.slice(0, -1);
const destination = operands[operands.length - 1];
const dstat = await sys.stat(destination).catch(() => null);
if (sources.length > 1 && (!dstat || dstat.kind !== "dir")) invalidUsage("target '" + destination + "' is not a directory");
let code = 0;
for (const src of sources) {
  const dst = dstat && dstat.kind === "dir"
    ? destination.replace(/\\/+$/, "") + "/" + basename(src)
    : destination;
  try { await sys.rename(src, dst); }
  catch (e) { err("mv: " + src + ": " + e.message + "\\n"); code = 1; }
}
sys.exit(code);
`),

  // seq [FIRST [INCR]] LAST — print a number sequence.
  "/sbin/seq": util(`
const seqOperands = []; let seqTerminated = false;
const seqNumber = /^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$/;
for (const arg of sys.argv.slice(1)) {
  if (!seqTerminated && arg === "--") { seqTerminated = true; continue; }
  if (!seqTerminated && arg.startsWith("-") && !seqNumber.test(arg)) unsupportedOption(arg);
  seqOperands.push(arg);
}
if (seqOperands.length === 0) invalidUsage("missing operand");
if (seqOperands.length > 3) invalidUsage("extra operand '" + seqOperands[3] + "'");
for (const arg of seqOperands) if (!seqNumber.test(arg) || !Number.isFinite(Number(arg))) invalidUsage("invalid number '" + arg + "'");
const a = seqOperands.map(Number);
let first = 1, incr = 1, last = 0;
if (a.length === 1) { last = a[0]; }
else if (a.length === 2) { first = a[0]; last = a[1]; }
else if (a.length >= 3) { first = a[0]; incr = a[1]; last = a[2]; }
if (incr === 0) { err("seq: increment must not be zero\\n"); sys.exit(1); }
const inRange = incr > 0 ? first <= last : first >= last;
if (inRange && first !== last && first + incr === first) invalidUsage("increment is too small to make progress");
let buffer = "";
const append = (value) => {
  buffer += String(value) + "\\n";
  if (buffer.length >= 8192) { out(buffer); buffer = ""; }
};
if (incr > 0) {
  for (let i = first; i <= last;) {
    append(i);
    if (i === last) break;
    const next = i + incr;
    if (next === i) invalidUsage("increment is too small to make progress");
    i = next;
  }
} else {
  for (let i = first; i >= last;) {
    append(i);
    if (i === last) break;
    const next = i + incr;
    if (next === i) invalidUsage("increment is too small to make progress");
    i = next;
  }
}
if (buffer) out(buffer);
sys.exit(0);
`),

  // head [-n N] [files] — first N lines (default 10).
  "/sbin/head": util(`
let n = 10; const files = []; const av = sys.argv.slice(1);
const lineCount = (raw) => {
  if (raw === undefined) invalidUsage("option requires an argument -- 'n'");
  if (!/^\\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) invalidUsage("invalid number of lines: '" + raw + "'");
  return Number(raw);
};
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === "--") { files.push(...av.slice(i + 1)); break; }
  if (a === "-n") { n = lineCount(av[++i]); }
  else if (/^-n/.test(a)) { n = lineCount(a.slice(2)); }
  else if (/^-[0-9]+$/.test(a)) { n = lineCount(a.slice(1)); }
  else if (a.startsWith("-") && a !== "-") unsupportedOption(a);
  else files.push(a);
}
const inputs = files.length ? files : ["-"];
let code = 0, sections = 0;
for (const file of inputs) {
  let fd = null, owned = false;
  try {
    if (file === "-") fd = 0;
    else { fd = await sys.open(file, {}); owned = true; }
    if (inputs.length > 1) {
      if (sections++) out("\\n");
      out("==> " + (file === "-" ? "standard input" : file) + " <==\\n");
    }
    let lines = 0, done = n === 0;
    while (!done) {
      const bytes = await sys.read(fd, 65536);
      if (bytes.length === 0) break;
      let end = bytes.length;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 10 && ++lines === n) { end = i + 1; done = true; break; }
      }
      if (end) sys.write(1, bytes.subarray(0, end));
    }
  } catch (e) {
    err("head: cannot open '" + file + "': " + e.message + "\\n");
    code = 1;
  } finally { if (owned) await closeQuietly(fd); }
}
sys.exit(code);
`),

  // tail [-n N] [files] — last N lines (default 10).
  "/sbin/tail": util(`
let n = 10; const files = []; const av = sys.argv.slice(1);
const lineCount = (raw) => {
  if (raw === undefined) invalidUsage("option requires an argument -- 'n'");
  if (!/^\\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) invalidUsage("invalid number of lines: '" + raw + "'");
  return Number(raw);
};
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === "--") { files.push(...av.slice(i + 1)); break; }
  if (a === "-n") { n = lineCount(av[++i]); }
  else if (/^-n/.test(a)) { n = lineCount(a.slice(2)); }
  else if (/^-[0-9]+$/.test(a)) { n = lineCount(a.slice(1)); }
  else if (a.startsWith("-") && a !== "-") unsupportedOption(a);
  else files.push(a);
}
const inputs = files.length ? files : ["-"];
let code = 0, sections = 0;
const lastLines = async (fd) => {
  const ring = [], pending = [];
  let pendingSize = 0;
  const finishLine = (segment) => {
    const size = pendingSize + segment.length;
    const line = new Uint8Array(size);
    let offset = 0;
    for (const part of pending) { line.set(part, offset); offset += part.length; }
    line.set(segment, offset);
    pending.length = 0; pendingSize = 0;
    if (n > 0) { ring.push(line); if (ring.length > n) ring.shift(); }
  };
  for (;;) {
    const bytes = await sys.read(fd, 65536);
    if (bytes.length === 0) break;
    if (n === 0) continue;
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      finishLine(bytes.subarray(start, i + 1));
      start = i + 1;
    }
    if (start < bytes.length) {
      const part = bytes.subarray(start);
      pending.push(part); pendingSize += part.length;
    }
  }
  if (pendingSize > 0) finishLine(new Uint8Array(0));
  return ring;
};
for (const file of inputs) {
  let fd = null, owned = false;
  try {
    if (file === "-") fd = 0;
    else { fd = await sys.open(file, {}); owned = true; }
    const lines = await lastLines(fd);
    if (inputs.length > 1) {
      if (sections++) out("\\n");
      out("==> " + (file === "-" ? "standard input" : file) + " <==\\n");
    }
    for (const line of lines) sys.write(1, line);
  } catch (e) {
    err("tail: cannot open '" + file + "': " + e.message + "\\n");
    code = 1;
  } finally { if (owned) await closeQuietly(fd); }
}
sys.exit(code);
`),

  // wc [-l|-w|-c] [files] — count lines, words, characters.
  "/sbin/wc": util(`
acceptOptions("lwc");
const countInput = async (file) => {
  let fd = null, owned = false;
  if (file === "-") fd = 0;
  else { fd = await sys.open(file, {}); owned = true; }
  try {
    const decoder = new TextDecoder();
    let lines = 0, words = 0, byteCount = 0, inWord = false;
    const consume = (text) => {
      for (const char of text) {
        if (/\\s/.test(char)) inWord = false;
        else if (!inWord) { words++; inWord = true; }
      }
    };
    for (;;) {
      const bytes = await sys.read(fd, 65536);
      if (bytes.length === 0) break;
      byteCount += bytes.length;
      for (const byte of bytes) if (byte === 10) lines++;
      consume(decoder.decode(bytes, { stream: true }));
    }
    consume(decoder.decode());
    return { lines, words, bytes: byteCount };
  } finally { if (owned) await closeQuietly(fd); }
};
const values = (counts) => {
  const parts = [];
  if (has("l")) parts.push(counts.lines);
  if (has("w")) parts.push(counts.words);
  if (has("c")) parts.push(counts.bytes);
  return parts.length ? parts : [counts.lines, counts.words, counts.bytes];
};
const inputs = operands.length ? operands : ["-"];
const total = { lines: 0, words: 0, bytes: 0 };
let code = 0;
for (const file of inputs) {
  try {
    const counts = await countInput(file);
    total.lines += counts.lines; total.words += counts.words; total.bytes += counts.bytes;
    out(values(counts).join(" ") + (operands.length ? " " + file : "") + "\\n");
  } catch (e) {
    err("wc: " + file + ": " + e.message + "\\n");
    code = 1;
  }
}
if (operands.length > 1) out(values(total).join(" ") + " total\\n");
sys.exit(code);
`),

  // sort [-r] [-n] [-u] [files] — sort lines.
  "/sbin/sort": util(`
acceptOptions("rnu");
let arr = toLines(await readInputs(operands));
if (has("n")) arr.sort((a, b) => parseFloat(a) - parseFloat(b));
else arr.sort();
if (has("r")) arr.reverse();
if (has("u")) arr = arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
emit(arr);
sys.exit(0);
`),

  // uniq [-c] [input [output]] — collapse adjacent duplicate lines.
  "/sbin/uniq": util(`
acceptOptions("c");
if (operands.length > 2) invalidUsage("extra operand '" + operands[2] + "'");
if (operands.length === 2 && operands[0] === operands[1]) invalidUsage("input and output are the same file");
let code = 0;
let inputFd = null, outputFd = 1, ownInput = false, ownOutput = false;
try {
  if (operands[0]) { inputFd = await sys.open(operands[0], {}); ownInput = true; }
  else inputFd = 0;
  if (operands[1]) {
    outputFd = await sys.open(operands[1], { create: true, truncate: true });
    ownOutput = true;
  }
  const decoder = new TextDecoder();
  let carry = "", prev = null, count = 0, prevTerminated = false;
  const emitGroup = () => {
    if (prev === null) return;
    const prefix = has("c") ? String(count).padStart(7) + " " : "";
    sys.write(outputFd, enc.encode(prefix + prev + (prevTerminated ? "\\n" : "")));
  };
  const acceptLine = (line, terminated) => {
    if (line === prev) { count++; prevTerminated ||= terminated; }
    else { emitGroup(); prev = line; count = 1; prevTerminated = terminated; }
  };
  for (;;) {
    const bytes = await sys.read(inputFd, 65536);
    if (bytes.length === 0) break;
    const lines = (carry + decoder.decode(bytes, { stream: true })).split("\\n");
    carry = lines.pop();
    for (const line of lines) acceptLine(line, true);
  }
  carry += decoder.decode();
  if (carry !== "") acceptLine(carry, false);
  emitGroup();
} catch (e) {
  err("uniq: " + e.message + "\\n");
  code = 1;
} finally {
  if (ownInput) await closeQuietly(inputFd);
  if (ownOutput) await closeQuietly(outputFd);
}
sys.exit(code);
`),

  // cut -d DELIM -f LIST [files] — select fields (1-based; ranges 1-3, lists 1,3).
  "/sbin/cut": util(`
let delim = "\\t", spec = null; const files = []; const av = sys.argv.slice(1);
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === "--") { files.push(...av.slice(i + 1)); break; }
  if (a === "-d") {
    if (av[i + 1] === undefined) invalidUsage("option requires an argument -- 'd'");
    delim = av[++i];
  }
  else if (/^-d/.test(a)) delim = a.slice(2);
  else if (a === "-f") {
    if (av[i + 1] === undefined) invalidUsage("option requires an argument -- 'f'");
    spec = av[++i];
  }
  else if (/^-f/.test(a)) spec = a.slice(2);
  else if (a.startsWith("-") && a !== "-") unsupportedOption(a);
  else files.push(a);
}
if (!spec) { err("cut: you must specify a list of fields with -f\\n"); sys.exit(1); }
if ([...delim].length !== 1) invalidUsage("the delimiter must be a single character");
const idx = [];
for (const part of spec.split(",")) {
  const range = part.match(/^(\\d+)-(\\d+)$/);
  const single = part.match(/^\\d+$/);
  if (!range && !single) invalidUsage("invalid field list '" + spec + "'");
  if (range) {
    const x = Number(range[1]), y = Number(range[2]);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < x || y - x > 100000) invalidUsage("invalid field list '" + spec + "'");
    for (let i = x; i <= y; i++) idx.push(i);
  } else {
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 1) invalidUsage("invalid field list '" + spec + "'");
    idx.push(value);
  }
}
const selected = new Set(idx);
const selectFields = (line) => {
  if (!line.includes(delim)) return line;
  return line.split(delim).filter((_, i) => selected.has(i + 1)).join(delim);
};
let buffer = "", code = 0;
const emitLine = (line, terminated) => {
  buffer += selectFields(line) + (terminated ? "\\n" : "");
  if (buffer.length >= 8192) { out(buffer); buffer = ""; }
};
const inputs = files.length ? files : ["-"];
for (const file of inputs) {
  let fd = null, owned = false;
  try {
    if (file === "-") fd = 0;
    else { fd = await sys.open(file, {}); owned = true; }
    const decoder = new TextDecoder();
    let carry = "";
    for (;;) {
      const bytes = await sys.read(fd, 65536);
      if (bytes.length === 0) break;
      const lines = (carry + decoder.decode(bytes, { stream: true })).split("\\n");
      carry = lines.pop();
      for (const line of lines) emitLine(line, true);
    }
    carry += decoder.decode();
    if (carry !== "") emitLine(carry, false);
  } catch (e) {
    err("cut: " + file + ": " + e.message + "\\n");
    code = 1;
  } finally { if (owned) await closeQuietly(fd); }
}
if (buffer) out(buffer);
sys.exit(code);
`),

  // tr SET1 [SET2] / tr -d SET1 — translate or delete characters (reads stdin).
  "/sbin/tr": util(`
acceptOptions("d");
if (has("d") && operands.length !== 1) invalidUsage(operands.length < 1 ? "missing operand" : "extra operand '" + operands[1] + "'");
if (!has("d") && operands.length !== 2) invalidUsage(operands.length < 2 ? "missing operand" : "extra operand '" + operands[2] + "'");
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
const set1 = expand(operands[0] || "");
const deleting = has("d");
const deleted = deleting ? new Set(set1) : null;
const map = {};
if (!deleting) {
  const chars1 = [...set1], chars2 = [...expand(operands[1] || "")];
  for (let i = 0; i < chars1.length; i++) map[chars1[i]] = chars2[Math.min(i, chars2.length - 1)] ?? chars1[i];
}
const transform = (text) => deleting
  ? [...text].filter((char) => !deleted.has(char)).join("")
  : [...text].map((char) => (char in map ? map[char] : char)).join("");
const decoder = new TextDecoder();
for (;;) {
  const bytes = await sys.read(0, 65536);
  if (bytes.length === 0) break;
  const result = transform(decoder.decode(bytes, { stream: true }));
  if (result) out(result);
}
const final = transform(decoder.decode());
if (final) out(final);
sys.exit(0);
`),
};

async function fetchText(rel) {
  const url = new URL(rel, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`workeros-coreutils: ${rel} -> HTTP ${res.status}`);
  return res.text();
}

// The installable coreutils, each a single **self-contained bundle**. The build
// step (`tools/bundle.mjs`, esbuild) inlines the one shared import — the CLI arg
// parser at `/lib/workeros-cli/args.js` (the real implementation lives in the
// sibling programs package; there is no clone here) — so each coreutil reaches
// the kernel as one module with no imports to resolve. The raw `coreutils`
// strings above are the bundler's inputs (and drive the unit tests); boot
// installs the built bundle. Dev, tests, and production all load the same
// artifact, exactly like the /bin programs.
export const bundledCoreutils = Object.keys(coreutils).map((path) => ({
  path,
  source: () => fetchText(`./bundles/${path.split("/").pop()}.js`),
}));
