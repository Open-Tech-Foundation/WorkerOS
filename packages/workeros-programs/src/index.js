// workeros-programs — the OS programs package.
//
// One home for every WorkerOS program that isn't a core system binary (those are
// the coreutils; see workeros-coreutils). Adding a program is one registry entry
// here instead of a new package per program. Programs may be JS today and WASM
// later — `type` is carried so a WASM exec path can slot in without reshaping this.
//
// The kernel worker installs the whole registry into the VFS at boot. Each entry
// carries the *relative file* that holds its bytes (`file`), split from *how* those
// bytes are produced (`source()`), so the same manifest drives two delivery modes:
//
//   • dev / source-served: `source()` fetches `file` relative to import.meta.url.
//   • published dist:      tools/build-dist.mjs reads every `file` at build time
//     and emits dist/index.js with the content inlined — a self-contained module a
//     bundler consumes by name (`@opentf/workeros-programs`), no runtime fetch.
//
// The Node-compatible guest runtime (process shim + CommonJS require) also lives
// in this package, under ./node, and is imported directly by the program worker.

function fetchText(rel) {
  return (async () => {
    const res = await fetch(new URL(rel, import.meta.url));
    if (!res.ok) throw new Error(`workeros-programs: ${rel} -> HTTP ${res.status}`);
    return res.text();
  })();
}

// Fetch a locally-built wasm binary (e.g. the Rust `grep`) as bytes. Returns null
// when it isn't built (`npm run build:grep` produces it), so environments that
// skip the wasm build — like CI's boot smoke test — still boot.
function fetchBytes(rel) {
  return (async () => {
    try {
      const res = await fetch(new URL(rel, import.meta.url));
      return res.ok ? await res.arrayBuffer() : null;
    } catch {
      return null;
    }
  })();
}

// A `file` is loaded as bytes when it is a binary asset (wasm image, npm tarball),
// as text otherwise (program/library source). Both delivery modes agree on this.
const isBinary = (file) => /\.(wasm|tgz)$/.test(file);
const fetchFile = (file) => (isBinary(file) ? fetchBytes(file) : fetchText(file));

/**
 * The installable programs, written to `bin` in the VFS at boot.
 *
 * Each `js` program ships as a single **self-contained bundle**: the build step
 * (`tools/bundle.mjs`, esbuild) inlines its `/lib/workeros-*` and relative
 * imports into `./bundles/<entry>`, so the program reaches the kernel as one
 * module with no imports to resolve. `entry` is the raw source (the bundler's
 * input); `file` is the built bundle that ships. WASM programs carry their binary
 * `file` directly (raw bytes, not bundled).
 * @type {{ bin: string, type: "js" | "wasm", entry?: string, file: string,
 *          links?: string[], source: () => Promise<string | ArrayBuffer> }[]}
 */
export const programs = [
  // `node` — the Node.js-compatibility runtime, a real user program (not a
  // kernel builtin). It asks the kernel to resolve a script's module graph and
  // evaluates it in-process with a `process` global.
  { bin: "/bin/node", type: "js", entry: "./node/node-program.js" },
  // `npm` — a thin launcher for the *real* npm CLI, vendored into the OS image
  // (tools/vendor-npm.mjs). The launcher unpacks it into /usr/lib/npm on first
  // use and execs it on /bin/node.
  { bin: "/bin/npm", type: "js", entry: "./npm/npm-launcher.js" },
  // `npx` — the same launcher, invoked as `npx`; execs npm's own bin/npx-cli.js.
  { bin: "/bin/npx", type: "js", entry: "./npm/npm-launcher.js" },
  { bin: "/bin/curl", type: "js", entry: "./curl/curl-program.js" },
  // Archive/compression tools. gzip/gunzip/zcat are one program that dispatches
  // on its invoked name.
  { bin: "/bin/gzip", type: "js", entry: "./gzip/gzip-program.js" },
  { bin: "/bin/gunzip", type: "js", entry: "./gzip/gzip-program.js" },
  { bin: "/bin/zcat", type: "js", entry: "./gzip/gzip-program.js" },
  { bin: "/bin/tar", type: "js", entry: "./tar/tar-program.js" },
  { bin: "/bin/zip", type: "js", entry: "./zip/zip-program.js" },
  { bin: "/bin/unzip", type: "js", entry: "./unzip/unzip-program.js" },
  // `nano` — a small modeless full-screen text editor (drives the terminal in
  // raw mode and paints frames itself).
  { bin: "/bin/nano", type: "js", entry: "./nano/nano-program.js" },
  { bin: "/bin/sh", type: "js", entry: "./sh/sh-program.js" },
  { bin: "/bin/bash", type: "js", entry: "./sh/sh-program.js" },
  // `grep` — a Rust `regex` binary compiled to wasm32-wasip1 (crates/wsh-grep),
  // run through the WASI host. Built by `npm run build:grep` into ./grep/.
  { bin: "/bin/grep", type: "wasm", file: "./grep/grep.wasm" },
  // The uutils coreutils tier (crates/wsh-utils): one multicall wasm32-wasip1
  // binary — real GNU-behavior utilities pulled in as `uu_*` crates. `links` get
  // /bin symlinks to this one blob at boot; the binary dispatches on argv[0].
  {
    bin: "/bin/coreutils",
    type: "wasm",
    file: "./utils/coreutils.wasm",
    links: [
      "base32", "base64", "basename", "cksum", "comm", "date", "dd", "dirname",
      "expand", "fold", "join", "ln", "mktemp", "nl", "od", "paste", "printf",
      "readlink", "realpath", "shuf", "sleep", "split", "tee", "touch",
      "truncate", "unexpand", "yes",
    ],
  },
];

// A js program's built bundle mirrors its `entry` under ./bundles/ (tools/bundle.mjs):
// `./node/node-program.js` → `./bundles/node/node-program.js`. Fill in `file` and
// the `source` loader for every entry from its declared `file`.
for (const prog of programs) {
  if (prog.type === "js" && prog.entry && !prog.file) {
    prog.file = prog.entry.replace(/^\.\//, "./bundles/");
  }
  prog.source = () => fetchFile(prog.file);
}

/**
 * Guest runtime *library* files installed into the VFS at boot (not `/bin`
 * programs). `/bin/node` imports these at load time through the kernel resolver
 * (INV-2), keeping `node` a self-contained guest whose library lives on the
 * filesystem — very much like `/lib` on a real system.
 * @type {{ path: string, file: string, source: () => Promise<string | ArrayBuffer> }[]}
 */
export const libraries = [
  { path: "/lib/workeros-cli/args.js", file: "./cli/args.js" },
  { path: "/lib/workeros-net/http.js", file: "./net/http.js" },
  { path: "/lib/workeros-node/require-runtime.js", file: "./node/require-runtime.js" },
  { path: "/lib/workeros-node/fs.js", file: "./node/fs.js" },
  { path: "/lib/workeros-node/path.js", file: "./node/path.js" },
  { path: "/lib/workeros-node/os.js", file: "./node/os.js" },
  { path: "/lib/workeros-node/querystring.js", file: "./node/querystring.js" },
  { path: "/lib/workeros-node/perf-hooks.js", file: "./node/perf-hooks.js" },
  { path: "/lib/workeros-node/vm.js", file: "./node/vm.js" },
  { path: "/lib/workeros-node/buffer.js", file: "./node/buffer.js" },
  { path: "/lib/workeros-node/assert.js", file: "./node/assert.js" },
  { path: "/lib/workeros-node/string_decoder.js", file: "./node/string_decoder.js" },
  { path: "/lib/workeros-node/events.js", file: "./node/events.js" },
  { path: "/lib/workeros-node/util.js", file: "./node/util.js" },
  { path: "/lib/workeros-node/stream.js", file: "./node/stream.js" },
  { path: "/lib/workeros-node/timers.js", file: "./node/timers.js" },
  { path: "/lib/workeros-node/timers-promises.js", file: "./node/timers-promises.js" },
  { path: "/lib/workeros-node/readline.js", file: "./node/readline.js" },
  { path: "/lib/workeros-node/tty.js", file: "./node/tty.js" },
  { path: "/lib/workeros-node/event-loop.js", file: "./node/event-loop.js" },
  { path: "/lib/workeros-node/url.js", file: "./node/url.js" },
  { path: "/lib/workeros-node/module.js", file: "./node/module.js" },
  { path: "/lib/workeros-node/resolve.js", file: "./node/resolve.js" },
  { path: "/lib/workeros-node/esm-graph.js", file: "./node/esm-graph.js" },
  { path: "/lib/workeros-node/esm-runner.js", file: "./node/esm-runner.js" },
  { path: "/lib/workeros-node/net.js", file: "./node/net.js" },
  { path: "/lib/workeros-node/http.js", file: "./node/http.js" },
  { path: "/lib/workeros-node/crypto.js", file: "./node/crypto.js" },
  { path: "/lib/workeros-node/zlib.js", file: "./node/zlib.js" },
  { path: "/lib/workeros-node/child-process.js", file: "./node/child-process.js" },
  { path: "/lib/workeros-node/worker-threads.js", file: "./node/worker-threads.js" },
  { path: "/lib/workeros-node/wasm-codec.js", file: "./node/wasm-codec.js" },
  { path: "/lib/workeros-node/node-bundler.js", file: "./node/node-bundler.js" },
  // The codec wasm (crates/workeros-codec) — a binary library. `source` returns
  // null when it isn't built, so zlib/crypto transparently use their JS fallback.
  { path: "/lib/workeros-codec/codec.wasm", file: "./codec/codec.wasm" },
  // The node-bundler wasm (crates/workeros-node-bundler) — the oxc ESM→module-runner
  // transform that lets /bin/node load ESM through the CJS runtime.
  { path: "/lib/workeros-node-bundler/bundler.wasm", file: "./node-bundler/bundler.wasm" },
  // Archive framing shared by /bin/tar, /bin/zip, /bin/unzip.
  { path: "/lib/workeros-archive/tar.js", file: "./archive/tar.js" },
  { path: "/lib/workeros-archive/zip.js", file: "./archive/zip.js" },
  // The vendored real npm CLI tarball (tools/vendor-npm.mjs). /bin/npm unpacks it
  // into persistent /usr/lib/npm on first use. `source` returns null when it isn't
  // vendored, so boot still works (npm just reports it isn't installed).
  { path: "/lib/workeros-npm/npm.tgz", file: "./vendor/npm.tgz" },
];

for (const lib of libraries) lib.source = () => fetchFile(lib.file);
