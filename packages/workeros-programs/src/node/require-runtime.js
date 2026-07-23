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
import { createWasi } from "./wasi.js";
import { createModule } from "./module.js";
import { hasEsmSyntax } from "./esm-graph.js";
import { buffer as bufferModule } from "./buffer.js";
import { assert as assertModule, strict as assertStrictModule } from "./assert.js";
import { stringDecoder as stringDecoderModule } from "./string_decoder.js";
import { EventEmitter } from "./events.js";
import { util as utilModule } from "./util.js";
import { createNet } from "./net.js";
import { createHttp } from "./http.js";
import { createHttps } from "./https.js";
import { createTls } from "./tls.js";
import { createDns } from "./dns.js";
import { createHttp2 } from "./http2.js";
import { createV8 } from "./v8.js";
import { crypto as cryptoModule } from "./crypto.js";
import { stream as streamModule, web as streamWeb, consumers as streamConsumers } from "./stream.js";
import { createTimers } from "./timers.js";
import { createTimersPromises } from "./timers-promises.js";
import { createReadline } from "./readline.js";
import { zlib as zlibModule } from "./zlib.js";
import { createChildProcess } from "./child-process.js";
import querystringModule from "./querystring.js";
import perfHooksModule from "./perf-hooks.js";
import diagnosticsChannelModule from "./diagnostics-channel.js";
import consoleModule from "./console.js";
import inspectorModule, { promises as inspectorPromises } from "./inspector.js";
import asyncHooksModule from "./async-hooks.js";
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
// The live working directory that `path.resolve`/`path.relative` fall back to,
// read from the running process (whose `cwd()` tracks `chdir`), with a static-spawn
// and "/" fallback so a `path` built before `process` exists still resolves.
const liveCwd = (sys, extras) => () => {
  try {
    const c = extras && extras.process && extras.process.cwd();
    if (typeof c === "string" && c) return c;
  } catch { /* process not ready */ }
  return (sys && typeof sys.cwd === "string" && sys.cwd) || "/";
};

export function makeBuiltins(sys, extras) {
  const fs = createFs(sys.syncFs, sys.onFsEvent);
  const path = createPath(liveCwd(sys, extras));
  const os = createOs();
  const url = createUrl();
  // Networking (ADR-021): net is the socket layer, http is built on it. Both are
  // pure over `sys` (async `otf:net_*` calls) — the kernel only moves bytes.
  const net = createNet(sys, EventEmitter);
  const http = createHttp(sys, EventEmitter, net);
  // Outbound HTTPS rides fetch (browser owns TLS/DNS/TCP); tls/dns/http2 are
  // load-only stubs so npm's fetch stack constructs its (unused) agents. ADR-008.
  const https = createHttps(EventEmitter, http);
  const tls = createTls(EventEmitter);
  const dns = createDns();
  const http2 = createHttp2();
  const v8 = createV8();
  const timers = createTimers(globalThis);
  const timersPromises = createTimersPromises(globalThis);
  const readline = createReadline(sys);
  // `child_process` runs sub-commands through the shell driver over two syscalls
  // the runtime adds (`execCapture`/`execCaptureSync`); pure over `sys`, like net.
  const childProcess = createChildProcess(sys);
  // `node:wasi` — the WASI preview1 host over the guest VFS, so wasm-compiled native
  // tools (napi-rs bindings like Vite's rolldown) instantiate and run in-process.
  const wasi = { WASI: createWasi(sys) };
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
    ["stream/promises", streamModule.promises],
    ["stream/web", streamWeb],
    ["stream/consumers", streamConsumers],
    ["timers", timers],
    ["timers/promises", timersPromises],
    ["readline", readline],
    ["net", net],
    ["http", http],
    ["https", https],
    ["tls", tls],
    ["dns", dns],
    ["dns/promises", dns.promises],
    ["http2", http2],
    ["v8", v8],
    ["crypto", cryptoModule],
    ["zlib", zlibModule],
    ["child_process", childProcess],
    ["querystring", querystringModule],
    ["perf_hooks", perfHooksModule],
    ["diagnostics_channel", diagnosticsChannelModule],
    ["console", consoleModule],
    ["inspector", inspectorModule],
    ["inspector/promises", inspectorPromises],
    ["async_hooks", asyncHooksModule],
    ["vm", vmModule],
    ["constants", constantsModule],
    ["wasi", wasi],
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
// `builtins` may be passed in to SHARE the one set the process already built for
// its ESM/dynamic-import path. This matters: several builtins are stateful and
// single-instance per process (child_process's live-children map + its
// `onChildEvent` dispatcher, worker_threads, the fork-IPC dispatcher). Building a
// second set here — the old default — meant a CJS entry and the modules it
// `import()`s used *different* child_process instances, and the single-slot
// kernel dispatchers routed child stdout/exit/IPC to only one of them. That broke
// `next dev`, whose CJS bin dynamically imports the CJS worker that forks the
// server. Omitting `builtins` (tests, `-e`) still builds a fresh set.
export function createNodeRuntime(sys, extras, builtins = makeBuiltins(sys, extras)) {
  const path = createPath(liveCwd(sys, extras));
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
