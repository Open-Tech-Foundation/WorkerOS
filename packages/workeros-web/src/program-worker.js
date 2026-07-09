// The program worker — one per process. A thin "dumb CPU" (INV-2): it evaluates
// exactly one program on the host JS engine and routes every syscall back to the
// kernel worker. It makes no resolution, filesystem, or capability decision —
// the kernel already resolved the whole module graph and handed it over.
//
// Isolation level: `Full` (bare dynamic import), ADR-009/§7.1. Per-process worker
// isolation (memory + terminate) applies regardless of level.

import { MSG } from "./protocol.js";
import { createProcess, ProcessExit } from "../../workeros-node/src/process-shim.js";

// The kernel worker created us; `self.postMessage` talks back to it.
const kernel = self;

/** Route an fd_write to the kernel (fire-and-forget; JS stdio does not block). */
function sysWrite(fd, bytes) {
  kernel.postMessage({ type: MSG.SYSCALL, call: "write", fd, data: bytes });
}

/**
 * Stitch a kernel-resolved module graph into blob URLs and return the entry's
 * URL. Dependencies are built first so each module's import specifiers can be
 * rewritten to the blob URL of its (already-built) target. This is mechanical
 * assembly only — the kernel decided every specifier→path mapping (INV-2).
 */
function stitch(graph) {
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
      const blob = new Blob([src], { type: "text/javascript" });
      pathToBlob.set(mod.path, URL.createObjectURL(blob));
      built.push(mod.path);
    }
    if (built.length === 0) {
      // No module became buildable => an import cycle (unsupported in MVP) or a
      // dangling edge. Fail honestly rather than hang.
      throw new Error("unresolvable or cyclic module graph");
    }
    remaining = remaining.filter((m) => !pathToBlob.has(m.path));
  }
  return pathToBlob.get(graph.entry);
}

/** Install the guest's ambient globals: a routing console, and (for node) process. */
function installGlobals(start, exit) {
  const encoder = new TextEncoder();
  const line = (fd, args) =>
    sysWrite(
      fd,
      encoder.encode(args.map((a) => stringify(a)).join(" ") + "\n"),
    );

  // A console that routes to the kernel's stdout/stderr (a terminal concern, so
  // it lives host-side, not in the Node tenant layer).
  globalThis.console = {
    log: (...a) => line(1, a),
    info: (...a) => line(1, a),
    debug: (...a) => line(1, a),
    warn: (...a) => line(2, a),
    error: (...a) => line(2, a),
  };

  if (start.interpreter === "node") {
    globalThis.process = createProcess({
      argv: start.argv,
      env: start.env,
      cwd: start.cwd,
      write: sysWrite,
      exit,
    });
  }
}

function stringify(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

let exited = false;
function reportExit(code) {
  if (exited) return;
  exited = true;
  kernel.postMessage({ type: MSG.PROC_EXIT, code: code | 0 });
}

self.onmessage = async (ev) => {
  const start = ev.data;
  if (start.type !== MSG.START) return;

  installGlobals(start, (code) => reportExit(code));

  try {
    const entryUrl = stitch(start.graph);
    await import(entryUrl);
    // Top-level completed without an explicit exit → success.
    reportExit(0);
  } catch (err) {
    if (err instanceof ProcessExit) {
      reportExit(err.code);
      return;
    }
    // Uncaught guest error: write it to stderr and exit non-zero (Node-ish).
    const enc = new TextEncoder();
    sysWrite(2, enc.encode(String(err && err.stack ? err.stack : err) + "\n"));
    reportExit(1);
  }
};
