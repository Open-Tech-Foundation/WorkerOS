// /bin/npm — launcher for the *real* npm CLI (vendored into the OS image; see
// tools/vendor-npm.mjs). npm is a third-party userland program, not something we
// reimplement: this stands up its file tree and hands off to it.
//
// The vendored tarball ships (ephemerally, reinstalled each boot) at
// `/lib/workeros-npm/npm.tgz`. On first use we unpack it once into the
// **persistent** `/usr/lib/npm` (so the ~1800-file cost is paid once, not per
// boot — /usr is durable, unlike the /bin,/sbin,/lib,/tmp OS trees), then exec
// `node /usr/lib/npm/bin/npm-cli.js`, forwarding argv and the exit code. A new
// vendored asset (different byte size) triggers a re-unpack, so version bumps
// take effect. INV-1: npm only places files; the kernel learns nothing.
import { parseTar } from "/lib/workeros-archive/tar.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const err = (s) => sys.write(2, enc.encode(s));

const TGZ = "/lib/workeros-npm/npm.tgz";
const ROOT = "/usr/lib/npm";
const CLI = ROOT + "/bin/npm-cli.js";
const MARKER = ROOT + "/.workeros-src-size"; // vendored asset size we unpacked from

async function statOr(p) {
  try { return await sys.stat(p); } catch { return null; }
}
async function readBytes(p) {
  const fd = await sys.open(p, {});
  const chunks = [];
  try {
    for (;;) { const b = await sys.read(fd, 1 << 20); if (b.length === 0) break; chunks.push(b); }
  } finally { await sys.close(fd); }
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
async function readText(p) { return dec.decode(await readBytes(p)); }
async function mkdirp(dir) {
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) {
    cur += "/" + part;
    try { await sys.mkdir(cur); } catch { /* exists */ }
  }
}
async function writeBytes(p, bytes) {
  await mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
  const fd = await sys.open(p, { create: true, truncate: true });
  sys.write(fd, bytes);
  await sys.close(fd);
}
async function rmrf(p) {
  const st = await statOr(p);
  if (!st) return;
  if (st.kind === "dir") {
    for (const e of await sys.readdir(p)) await rmrf(p.replace(/\/+$/, "") + "/" + e.name);
    await sys.rmdir(p);
  } else {
    await sys.unlink(p);
  }
}
async function gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

async function ensureUnpacked() {
  const tgz = await statOr(TGZ);
  if (!tgz) {
    err("npm: not installed — vendored asset " + TGZ + " is missing (build it: npm run build:vendor-npm)\n");
    sys.exit(127);
  }
  const want = String(tgz.size);
  const cli = await statOr(CLI);
  if (cli) {
    const have = await readText(MARKER).catch(() => null);
    if (have === want) return; // already unpacked at this version
  }
  // Fresh install or an upgraded asset: replace the tree wholesale.
  await rmrf(ROOT);
  const files = parseTar(await gunzip(await readBytes(TGZ)));
  for (const f of files) {
    if (f.type !== "file") continue;
    const rel = f.name.replace(/^package\//, ""); // npm tarballs nest under package/
    if (!rel || rel === f.name) continue; // skip anything not under package/
    await writeBytes(ROOT + "/" + rel, f.data);
  }
  await writeBytes(MARKER, enc.encode(want));
}

await ensureUnpacked();

// Hand off to the real CLI through the shell driver (system(3)-style), inheriting
// the controlling terminal so npm can prompt / render progress.
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const line = ["node", q(CLI)].concat(sys.argv.slice(1).map(q)).join(" ");
sys.exit(await sys.exec(line));
