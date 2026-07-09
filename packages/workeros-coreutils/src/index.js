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
// The host installs these into the VFS at `/bin/*` on boot.

const PRELUDE = `const enc = new TextEncoder();
const dec = new TextDecoder();
const out = (s) => sys.write(1, enc.encode(s));
const err = (s) => sys.write(2, enc.encode(s));
const flags = sys.argv.slice(1).filter((a) => a.startsWith("-") && a !== "-");
const operands = sys.argv.slice(1).filter((a) => !a.startsWith("-") || a === "-");
const has = (f) => flags.some((g) => g.includes(f.replace("-", "")));
const basename = (p) => p.replace(/\\/+$/, "").split("/").pop();
`;

/** Wrap a coreutil body with the shared prelude. */
function util(body) {
  return PRELUDE + body;
}

export const coreutils = {
  "/bin/echo": util(`
let nl = true;
let args = sys.argv.slice(1);
if (args[0] === "-n") { nl = false; args = args.slice(1); }
out(args.join(" ") + (nl ? "\\n" : ""));
sys.exit(0);
`),

  "/bin/true": `sys.exit(0);`,
  "/bin/false": `sys.exit(1);`,

  "/bin/pwd": util(`out(sys.cwd + "\\n"); sys.exit(0);`),

  "/bin/env": util(`
const lines = Object.entries(sys.env).map(([k, v]) => k + "=" + v);
out(lines.join("\\n") + (lines.length ? "\\n" : ""));
sys.exit(0);
`),

  "/bin/cat": util(`
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

  "/bin/ls": util(`
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

  "/bin/mkdir": util(`
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

  "/bin/rm": util(`
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

  "/bin/cp": util(`
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

  "/bin/mv": util(`
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
};
