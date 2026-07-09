# Changelog — @opentf/workeros-node

Notable changes to the Node.js compatibility tenant layer — a **guest-side**
program that maps Node semantics onto the kernel's WASI-shaped primitives
(INV-1 / ADR-007). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
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
