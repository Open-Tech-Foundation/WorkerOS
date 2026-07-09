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
];
