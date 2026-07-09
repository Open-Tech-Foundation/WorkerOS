# Changelog — @opentf/workeros-web

Notable changes to the WorkerOS host runtime (kernel/program workers + the
main-thread client API). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **`resolveGraph` syscall** — the program worker's `sys` ABI can ask the kernel to
  resolve a script's module graph, so the userland `/bin/node` runtime evaluates the
  script in its own worker instead of the kernel special-casing a `node` interpreter.
- **`wsh` is now a real shell interpreter** (`src/shell/interp.js`), replacing the
  one-line planner. The grammar stays in Rust (parsed via the kernel's `shell_parse`
  wasm binding, ADR-012); JS walks the AST and drives execution — a wasm module can
  neither spawn a worker nor await one, so the evaluator must be host-side.
  - **Expansion:** `$VAR`/`${…}` operators (`:-` `:=` `:+` `#`/`##`/`%`/`%%` strip,
    `/`//` replace, `${#x}`, substrings), command substitution `$(…)`/backticks,
    arithmetic `$(( … ))`, quoting, IFS field-splitting, `*`/`?`/`[…]` globbing.
  - **Control flow:** `if`/`elif`/`else`, `for`/`while`/`until`, `case`, brace groups,
    subshells, functions with `local`, `&&`/`||`/`;`/`|`, background `&`, `#` comments.
  - **Builtins with no external:** `test`/`[`, `read` (incl. `while read`), `export`,
    `unset`, `local`, `set -e`, `shift`, `trap`, `printf`, `eval`, `source`, `cd`, `:`, …
  - **Redirects:** `<`, `>`, `>>`, `2>&1`, `/dev/null` (externals stream via a kernel
    stdio plan; builtins/compounds buffer in JS).
  - Covered by `tools/shell-interp.test.js` (drives the interpreter through the real
    Rust wasm parser) and browser cases in `tools/shell.test.js`.
- **Synchronous syscall channel** (`sync-syscall.js`) — a per-process
  SharedArrayBuffer request/response slot (ADR-010/-016). A program worker writes a
  blocking syscall, signals the kernel worker, and parks in `Atomics.wait`; the
  kernel worker services it (`read`/`open`/`close`/`seek`/`stat`/`readdir`/`mkdir`/
  `rename`/…) and wakes it via `Atomics.notify`. Would-block reads are parked and released when
  data/EOF arrives. This gives a synchronous wasm `_start` real blocking I/O —
  `fd_read`, `path_open`, and blocking `stdin` from a pipe.
- **`sys.exec(line)` syscall** — system(3)-style: run a command line as a
  sub-process through the shell driver, routing its output to the caller's streams
  and resolving the exit code. Powers `npm run <script>`.
- **CommonJS execution path** — the program worker routes `require`-using `node`
  entries through the guest node runtime (`workeros-programs/node`), so
  `node index.js` resolves `node_modules` from the VFS; ES-module and plain async
  scripts keep the kernel-resolved graph + stitch path. The kernel worker installs
  the OS programs (`/bin/npm`, …) into the VFS at boot alongside the coreutils.
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

### Changed
- **The program worker no longer knows about `node`.** It installs one native surface
  for every guest (`sys` + a routing `console`) and evaluates each JS program the same
  way (stitch the kernel-resolved graph → import). The `process` global and the (host)
  CommonJS path are gone from here — Node.js compatibility now lives entirely in the
  `/bin/node` program, which installs `process` and loads its target itself.

[Unreleased]: https://github.com/opentf/workeros/commits/main
