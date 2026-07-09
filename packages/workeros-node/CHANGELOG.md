# Changelog — @opentf/workeros-node

Notable changes to the Node.js compatibility tenant layer — a **guest-side**
program that maps Node semantics onto the kernel's WASI-shaped primitives
(INV-1 / ADR-007). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **CommonJS `node` runtime** (`require-runtime.js`) — `createNodeRuntime(sys)` runs
  a CJS entry as `node <file>` does: a `require()` with relative + `node_modules`
  resolution (package.json `exports`/`main`, `.js`/`.cjs`/`.json` + `index`
  fallbacks), reading files via `sys` and async-prefetching the whole graph so
  `require` itself is synchronous. JSON modules and `require` cycles supported.
  `usesCommonjs()` decides when an entry takes this path vs the kernel's ESM graph.
  This is the guest-side engine behind `node index.js` resolving installed packages.
- **`process` shim** (`process-shim.js`) — a minimal Node `process` for guests:
  `argv`, `env`, `stdout.write` / `stderr.write`, and `exit()` (via a
  `ProcessExit` signal), backed by kernel syscalls.
- **`createProcess()`** — installs the per-process `process`/`console` sugar the
  program worker exposes to each guest module.
- Package entry (`index.js`) as the tenant layer's public surface; deliberately
  contains no kernel concepts.

### Notes
- Scope is intentionally small. The `require` / `node_modules` graph and broader
  `fs`/`path` coverage are planned for a later milestone (M5+).

[Unreleased]: https://github.com/opentf/workeros/commits/main
