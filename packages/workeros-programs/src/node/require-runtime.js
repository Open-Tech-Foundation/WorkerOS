// The Node CommonJS module runtime — the "lightweight node".
//
// This is GUEST code (INV-1): the kernel knows nothing about `require`, package
// folders, or `node_modules`. `node index.js` runs an ordinary process; this
// runtime is what that process uses to load a CJS module graph out of the VFS —
// exactly like the real `node` binary is just a program on Linux.
//
// Scope: CommonJS (the classic npm/`require` case). ESM entries keep going
// through the kernel's ahead-of-time graph + the program worker's stitch path.

import { createPath } from "./path.js";
import { createOs } from "./os.js";
import { createUrl } from "./url.js";
import { createFs } from "./fs.js";
import { createModule } from "./module.js";
import { hasEsmSyntax } from "./esm-graph.js";
import { buffer as bufferModule } from "./buffer.js";
import { assert as assertModule, strict as assertStrictModule } from "./assert.js";
import { stringDecoder as stringDecoderModule } from "./string_decoder.js";
import { EventEmitter } from "./events.js";
import { util as utilModule } from "./util.js";
import { createNet } from "./net.js";
import { createHttp } from "./http.js";
import { crypto as cryptoModule } from "./crypto.js";
import { stream as streamModule } from "./stream.js";
import { createTimers } from "./timers.js";
import { createTimersPromises } from "./timers-promises.js";
import { createReadline } from "./readline.js";
import { zlib as zlibModule } from "./zlib.js";
import { createChildProcess } from "./child-process.js";
import querystringModule from "./querystring.js";
import perfHooksModule from "./perf-hooks.js";
import { vm as vmModule } from "./vm.js";
import constantsModule from "./constants.js";

// ---- core builtins --------------------------------------------------------
// `require('fs')` / `require('node:fs')` and friends resolve to guest builtins,
// not to files in the VFS (PLAN Phase 5·C, B). The registry grows here as more
// `node:` builtins land (`stream`, `zlib`, …). Exported so `/bin/node`'s ESM
// stitch can synthesize a re-export module for each `node:` import the kernel
// marked as a builtin edge (Phase 5·C-ESM). The map's keys are the builtin keys
// the kernel resolves to (see `resolver.rs` `NODE_BUILTINS`).
// `extras` carries builtins that only the running program can supply — `process`
// and `tty` need per-process state (argv/env/stdio, the fds' TTY-ness) that this
// pure factory has no access to. `/bin/node` builds them and passes them here so
// both `require('process')`/`require('tty')` (CJS) and `import 'node:process'`
// (ESM) resolve to the same objects, not just one path.
export function makeBuiltins(sys, extras) {
  const fs = createFs(sys.syncFs, sys.onFsEvent);
  const path = createPath();
  const os = createOs();
  const url = createUrl();
  // Networking (ADR-021): net is the socket layer, http is built on it. Both are
  // pure over `sys` (async `otf:net_*` calls) — the kernel only moves bytes.
  const net = createNet(sys, EventEmitter);
  const http = createHttp(sys, EventEmitter, net);
  const timers = createTimers(globalThis);
  const timersPromises = createTimersPromises(globalThis);
  const readline = createReadline(sys);
  // `child_process` runs sub-commands through the shell driver over two syscalls
  // the runtime adds (`execCapture`/`execCaptureSync`); pure over `sys`, like net.
  const childProcess = createChildProcess(sys);
  const reg = new Map([
    ["fs", fs],
    ["fs/promises", fs.promises],
    ["path", path],
    ["path/posix", path],
    ["os", os],
    ["url", url],
    ["buffer", bufferModule],
    ["assert", assertModule],
    ["assert/strict", assertStrictModule],
    ["string_decoder", stringDecoderModule],
    ["events", EventEmitter],
    ["util", utilModule],
    ["util/types", utilModule.types],
    ["stream", streamModule],
    ["timers", timers],
    ["timers/promises", timersPromises],
    ["readline", readline],
    ["net", net],
    ["http", http],
    ["crypto", cryptoModule],
    ["zlib", zlibModule],
    ["child_process", childProcess],
    ["querystring", querystringModule],
    ["perf_hooks", perfHooksModule],
    ["vm", vmModule],
    ["constants", constantsModule],
  ]);
  // Seed "module" before building it so its `builtinModules` list counts itself;
  // `module.createRequire` reads back through `reg`, so it resolves every builtin.
  reg.set("module", null);
  reg.set("module", createModule({ fs, path, url, builtins: reg, detectFormat }));
  if (extras) for (const [k, v] of Object.entries(extras)) if (v !== undefined) reg.set(k, v);
  return reg;
}

/**
 * Should this entry run through the CommonJS runtime? Only when it actually uses
 * `require`/`module.exports` — a plain async script (coreutils, `npm`) has neither
 * and keeps going through the ESM `import()` path, which permits top-level `await`.
 * `.cjs`/`.mjs` extensions are authoritative.
 */
export function usesCommonjs(source, p = "") {
  if (p.endsWith(".cjs") || p.endsWith(".cts")) return true;
  if (p.endsWith(".mjs") || p.endsWith(".mts")) return false;
  // Static ESM syntax wins: a module with `import`/`export` (or `import.meta`) is
  // ESM even when it also calls a `require` — e.g. one made via
  // `createRequire(import.meta.url)`. Such source can't run in the CJS evaluator.
  if (hasEsmSyntax(source)) return false;
  return (
    /(^|[^.\w$])require\s*\(/.test(source) ||
    /\bmodule\.exports\b/.test(source) ||
    /\bexports\.[\w$]/.test(source)
  );
}

// The nearest enclosing `package.json`'s `type` (Node's module-format authority):
// walk up from the file's directory; the first package.json found decides
// (`"module"`/`"commonjs"`, defaulting to `"commonjs"` when the field is absent, as
// Node does). Returns null if no package scope exists up to `/`.
function nearestType(absPath, { fs, path }) {
  let dir = path.dirname(absPath);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      return pkg.type === "module" ? "module" : "commonjs";
    } catch {
      // no/broken package.json here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The module format of `absPath` the way Node decides it — by extension and the
 * nearest `package.json` `"type"`, NOT by sniffing source:
 *   - `.mjs` → esm, `.cjs`/`.json` → cjs,
 *   - `.js`/extensionless → the enclosing package's `"type"` (`module` → esm),
 *   - no package scope (loose scripts, `-e`) → fall back to syntax (lenient, so a
 *     standalone `import`-using script still runs).
 * `deps` = `{ fs, path }`; omit it to force the syntax-only fallback.
 */
export function detectFormat(source, absPath, deps) {
  if (absPath.endsWith(".mjs") || absPath.endsWith(".mts")) return "esm";
  if (absPath.endsWith(".cjs") || absPath.endsWith(".cts") || absPath.endsWith(".json")) return "cjs";
  // `.ts`/`.tsx` follow the nearest package.json `"type"`, exactly like `.js`
  // (handled below) — no special case needed here.
  // Inside a package, `"type"` is authoritative (Node's rule) — `.js` is ESM iff the
  // enclosing package is `"type":"module"`, regardless of what the source looks like.
  const type = deps ? nearestType(absPath, deps) : null;
  if (type === "module") return "esm";
  if (type === "commonjs") return "cjs";
  // No package scope (loose scripts, coreutils, `-e`): sniff. A require/module.exports
  // script is CommonJS; anything else — including a plain top-level-await program —
  // stays ESM so TLA works.
  return usesCommonjs(source) ? "cjs" : "esm";
}

// ---- the runtime -----------------------------------------------------------
export function createNodeRuntime(sys, extras) {
  const builtins = makeBuiltins(sys, extras);
  const path = createPath();
  const url = createUrl();
  const fs = builtins.get("fs");

  /** Run a CJS entry file (already read) as `node <entryPath>`. */
  return async function run(entryPath, entrySource) {
    const shadowFs = {
      statSync(p) {
        if (p === entryPath) return { isDirectory: () => false, isFile: () => true };
        return fs.statSync(p);
      },
      readFileSync(p, options) {
        if (p === entryPath) {
          const encoding = typeof options === "string" ? options : options && options.encoding;
          return encoding ? entrySource : new TextEncoder().encode(entrySource);
        }
        return fs.readFileSync(p, options);
      },
    };
    const mod = createModule({ fs: shadowFs, path, url, builtins, detectFormat });
    builtins.set("module", mod);
    mod._loadMain(entryPath); // the entry is the process main: require.main === module
  };
}
