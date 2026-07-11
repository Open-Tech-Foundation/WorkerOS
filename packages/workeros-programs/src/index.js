// workeros-programs — the OS programs package.
//
// One home for every WorkerOS program that isn't a core system binary (those are
// the coreutils; see workeros-coreutils). Adding a program is one registry entry
// here instead of a new package per program. Programs may be JS today and WASM
// later — `type` is carried so a WASM exec path can slot in without reshaping this.
//
// The kernel worker installs the whole registry into the VFS at boot (everything
// at once for now; a selectable install manifest is future work). A program that
// needs top-level `await` (like `npm`) is authored as a normal script file and its
// text is fetched same-origin here — a guest program is standalone source, not a
// module the host imports.
//
// The Node-compatible guest runtime (process shim + CommonJS require) also lives
// in this package, under ./node, and is imported directly by the program worker
// (it's library code, not an installed /bin program).

async function fetchText(rel) {
  const url = new URL(rel, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`workeros-programs: ${rel} -> HTTP ${res.status}`);
  return res.text();
}

// Fetch a locally-built wasm binary (e.g. the Rust `grep`) as bytes. Returns null
// when it isn't built (`npm run build:grep` produces it), so environments that
// skip the wasm build — like CI's boot smoke test — still boot.
async function fetchBytes(rel) {
  try {
    const res = await fetch(new URL(rel, import.meta.url));
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * The installable programs, written to `bin` in the VFS at boot.
 * @type {{ bin: string, type: "js" | "wasm", source: () => Promise<string | ArrayBuffer> }[]}
 */
export const programs = [
  {
    // `node` — the Node.js-compatibility runtime, a real user program (not a
    // kernel builtin). It asks the kernel to resolve a script's module graph and
    // evaluates it in-process with a `process` global. Swappable: replace this to
    // grow Node coverage; the kernel keeps only the native `js` execution core.
    bin: "/bin/node",
    type: "js",
    source: () => fetchText("./node/node-program.js"),
  },
  {
    bin: "/bin/npm",
    type: "js",
    source: () => fetchText("./npm/npm-program.js"),
  },
  {
    bin: "/bin/curl",
    type: "js",
    source: () => fetchText("./curl/curl-program.js"),
  },
  // Archive/compression tools — day-to-day CLIs over node:zlib + the shared
  // /lib/workeros-archive framing. `gzip`/`gunzip`/`zcat` are one program that
  // dispatches on its invoked name.
  { bin: "/bin/gzip", type: "js", source: () => fetchText("./gzip/gzip-program.js") },
  { bin: "/bin/gunzip", type: "js", source: () => fetchText("./gzip/gzip-program.js") },
  { bin: "/bin/zcat", type: "js", source: () => fetchText("./gzip/gzip-program.js") },
  { bin: "/bin/tar", type: "js", source: () => fetchText("./tar/tar-program.js") },
  { bin: "/bin/zip", type: "js", source: () => fetchText("./zip/zip-program.js") },
  { bin: "/bin/unzip", type: "js", source: () => fetchText("./unzip/unzip-program.js") },
  {
    // `nano` — a small modeless full-screen text editor. A TUI: it drives the
    // terminal in raw mode (tcsetattr) and paints frames itself.
    bin: "/bin/nano",
    type: "js",
    source: () => fetchText("./nano/nano-program.js"),
  },
  {
    bin: "/bin/sh",
    type: "js",
    source: () => fetchText("./sh/sh-program.js"),
  },
  {
    bin: "/bin/bash",
    type: "js",
    source: () => fetchText("./sh/sh-program.js"),
  },
  {
    // `grep` — a Rust `regex` binary compiled to wasm32-wasip1 (crates/wsh-grep),
    // run through the WASI host. Built by `npm run build:grep` into ./grep/.
    bin: "/bin/grep",
    type: "wasm",
    source: () => fetchBytes("./grep/grep.wasm"),
  },
];

/**
 * Guest runtime *library* files installed into the VFS at boot (not `/bin`
 * programs). `/bin/node` imports these at load time through the kernel resolver
 * (INV-2), keeping `node` a self-contained guest whose library lives on the
 * filesystem — very much like `/lib` on a real system. The CommonJS runtime and
 * its `node:` builtins (`fs`, `path`) live here.
 * @type {{ path: string, source: () => Promise<string> }[]}
 */
export const libraries = [
  { path: "/lib/workeros-node/require-runtime.js", source: () => fetchText("./node/require-runtime.js") },
  { path: "/lib/workeros-node/fs.js", source: () => fetchText("./node/fs.js") },
  { path: "/lib/workeros-node/path.js", source: () => fetchText("./node/path.js") },
  { path: "/lib/workeros-node/os.js", source: () => fetchText("./node/os.js") },
  { path: "/lib/workeros-node/buffer.js", source: () => fetchText("./node/buffer.js") },
  { path: "/lib/workeros-node/events.js", source: () => fetchText("./node/events.js") },
  { path: "/lib/workeros-node/util.js", source: () => fetchText("./node/util.js") },
  { path: "/lib/workeros-node/tty.js", source: () => fetchText("./node/tty.js") },
  { path: "/lib/workeros-node/event-loop.js", source: () => fetchText("./node/event-loop.js") },
  { path: "/lib/workeros-node/url.js", source: () => fetchText("./node/url.js") },
  { path: "/lib/workeros-node/module.js", source: () => fetchText("./node/module.js") },
  { path: "/lib/workeros-node/resolve.js", source: () => fetchText("./node/resolve.js") },
  { path: "/lib/workeros-node/esm-graph.js", source: () => fetchText("./node/esm-graph.js") },
  { path: "/lib/workeros-node/net.js", source: () => fetchText("./node/net.js") },
  { path: "/lib/workeros-node/http.js", source: () => fetchText("./node/http.js") },
  { path: "/lib/workeros-node/crypto.js", source: () => fetchText("./node/crypto.js") },
  { path: "/lib/workeros-node/zlib.js", source: () => fetchText("./node/zlib.js") },
  { path: "/lib/workeros-node/wasm-codec.js", source: () => fetchText("./node/wasm-codec.js") },
  // The codec wasm (crates/workeros-codec) — a binary library. `fetchBytes` returns
  // null when it isn't built, so zlib/crypto transparently use their JS fallback.
  { path: "/lib/workeros-codec/codec.wasm", source: () => fetchBytes("./codec/codec.wasm") },
  // Archive framing shared by /bin/tar, /bin/zip, /bin/unzip. Pure bytes-in/out;
  // zip takes the node:zlib codec by injection (no cross-tree import).
  { path: "/lib/workeros-archive/tar.js", source: () => fetchText("./archive/tar.js") },
  { path: "/lib/workeros-archive/zip.js", source: () => fetchText("./archive/zip.js") },
];
