// `node` — the Node.js-compatibility runtime, as an ordinary user program
// installed at /bin/node (INV-1). The kernel has no `node` concept: it owns only
// native JS resolution + execution. `node foo.js` therefore does exactly what the
// name implies and nothing more — it asks the kernel to resolve `foo.js` into a
// module graph (`sys.resolveGraph`, INV-2), installs the Node surface (`process`)
// on the guest global, and evaluates the graph *in this same worker*, so the
// script is one process: killable as a unit, sharing stdio directly.
//
// Because it's a plain program, it's swappable — replace /bin/node with a richer
// runtime (CommonJS `require`, more of `process`, a REPL) without touching the
// kernel. Today it is "just enough Node for ordinary ESM scripts" (INV-5): we do
// not claim to be Node, and unsupported bits fail honestly rather than pretending.
//
// Authored as a standalone top-level-await script (no import/export) so it runs
// through the program worker's ESM path, which awaits top-level await.

const enc = new TextEncoder();
const err = (s) => sys.write(2, enc.encode(s));

const script = sys.argv[1];
if (!script) {
  // Real Node drops into a REPL here; we have no TTY, so say so plainly.
  err("node: no script given (usage: node <file.js> [args…]); REPL is not supported\n");
  sys.exit(1);
}

// The Node `process` global, mapped onto the kernel's `sys` primitives. Installed
// before the script loads so its top-level code sees it.
const toBytes = (chunk) =>
  typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk);
// Query the controlling terminal once at startup: is each stdio fd a TTY, and its
// size. process.std*.isTTY must be a plain boolean (Node code reads it
// synchronously), so we resolve it here rather than on each access. (This is what
// makes chalk/ora/readline detect a terminal — reversing the old isTTY=false stub.)
const [in0, out1, err2, ws] = await Promise.all([
  sys.isatty(0), sys.isatty(1), sys.isatty(2), sys.winsize(),
]);
const stream = (fd, isTTY) => {
  const s = { write(chunk) { sys.write(fd, toBytes(chunk)); return true; }, isTTY };
  if (isTTY) { s.columns = ws.cols; s.rows = ws.rows; }
  return s;
};
globalThis.process = {
  // Node convention: argv[0] is the runtime, argv[1] the script.
  argv: ["node", ...sys.argv.slice(1)],
  env: { ...sys.env },
  platform: "workeros",
  // A truthful, non-Node-fidelity version tag (INV-5): we are not Node.
  version: "workeros-node/0.0.0",
  cwd: () => sys.cwd,
  stdin: { isTTY: in0 },
  stdout: stream(1, out1),
  stderr: stream(2, err2),
  // sys.exit reports the code to the kernel and throws to unwind the current tick,
  // exactly like Node's non-returning process.exit.
  exit: (code = 0) => sys.exit(code | 0),
};

// The kernel resolves the whole import graph against the VFS (every specifier→path
// decision is the kernel's — INV-2); we only evaluate what it hands back.
const graph = await sys.resolveGraph(script);
if (graph.kind === "wasm") {
  err("node: " + script + " is a wasm module, not JS (run it directly)\n");
  sys.exit(1);
}

// Stitch the resolved graph into blob URLs, dependencies first, rewriting each
// import specifier to its dependency's blob URL. Mechanical assembly only — the
// kernel already decided every target (mirrors the worker's own stitch step).
const pathToBlob = new Map();
let remaining = [...graph.modules];
while (remaining.length) {
  const built = [];
  for (const mod of remaining) {
    if (!mod.imports.every((imp) => pathToBlob.has(imp.resolved))) continue;
    let src = mod.source;
    for (const imp of mod.imports) {
      const url = pathToBlob.get(imp.resolved);
      src = src.split(`"${imp.specifier}"`).join(`"${url}"`);
      src = src.split(`'${imp.specifier}'`).join(`"${url}"`);
    }
    pathToBlob.set(mod.path, URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    built.push(mod.path);
  }
  if (built.length === 0) { err("node: unresolvable or cyclic module graph\n"); sys.exit(1); }
  remaining = remaining.filter((m) => !pathToBlob.has(m.path));
}

// Evaluate the script. A ProcessExit thrown by process.exit (via sys.exit) unwinds
// past here and is caught by the program worker, which reports the code; a genuine
// error likewise propagates to the worker's handler (stack + exit 1).
await import(pathToBlob.get(graph.entry));
