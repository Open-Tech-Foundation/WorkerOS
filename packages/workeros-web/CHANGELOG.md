# Changelog — @opentf/workeros-web

Notable changes to the WorkerOS host runtime (kernel/program workers + the
main-thread client API). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **`boot()`** — spins up the kernel worker, loads the kernel wasm, performs the
  boot handshake, and resolves a `WorkerOS` handle (`version`, `abi`).
- **`WorkerOS` client** — thin main-thread API over the kernel worker:
  - `fs.read` / `fs.write` against the kernel VFS.
  - `spawn(argv, { env, cwd })` → a `Process` with streamed `onStdout`/`onStderr`
    (Uint8Array chunks), an `exited` promise, `writeStdin()`, and `kill(signal)`.
  - `exec(line, { onStdout, onStderr })` → runs a full `wsh` command line (pipes,
    redirects, `&&`/`||`/`;`, glob, background `&`, `cd`) and resolves
    `{ code, cwd }`.
  - `ps()` — a snapshot of the live process table.
  - `kill(pid, signal)` and `shutdown()`.
- **Kernel worker** — hosts the wasm kernel, dispatches syscalls, and manages the
  process table; spawns one **program worker** per process to run guest modules.
- **`wsh` execution driver** (`shell-exec`) — host-side orchestration only:
  spawns a worker per command, wires pipes, sequences `&&`/`||`, runs `cd`, and
  backgrounds jobs. Every decision is a call back into the kernel (INV-2).
- **Ring-buffer** helpers (`RingBuffer`, `allocRingBuffer`) over
  `SharedArrayBuffer` for streaming I/O.
- **Worker message protocol** (`protocol`) shared by client and workers.
- **Dev server** (`tools/serve.js`) that sets COOP/COEP for cross-origin
  isolation (ADR-010), plus headless boot/MVP/shell tests.

[Unreleased]: https://github.com/opentf/workeros/commits/main
