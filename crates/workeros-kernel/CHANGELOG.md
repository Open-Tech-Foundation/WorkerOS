# Changelog — workeros-kernel

All notable changes to the WorkerOS kernel crate. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project has not cut
a release yet, so everything lives under **Unreleased**.

## [Unreleased]

### Added
- **TTY device (`tty` module)** — the controlling terminal with a real line
  discipline: canonical (cooked) and raw modes, echo, line editing (Backspace,
  `Ctrl-U` kill, `Ctrl-W` word-erase), `Ctrl-C`/`Ctrl-Z` signals, `Ctrl-D` EOF,
  and a window size. Terminal `stdin` reads now route through the shared TTY and
  block (`WouldBlock`) until a line is committed, so programs `read()` a terminal
  like on Unix. New `Kernel` API: `tty_input`, `tty_read_line`, `isatty`,
  `tty_get_attr`/`tty_set_attr`, `tty_winsize`/`tty_set_winsize`. Programmatic
  `feed_stdin` (the `writeStdin` API) still injects per-process stdin ahead of the
  interactive TTY.
- **`sys_seek` host wrapper** — exposes the process context's `fd_seek` to the host
  runtime so WASI guests can seek (`whence` = set/cur/end; returns the new offset).
- **Authoritative core.** The Node-agnostic kernel that owns all system state:
  VFS, process table, module resolution, scheduling, and capability granting
  (`caps`, `errno`, `process`, `resolver`, `ringbuf`, `shell`, `syscall`, `vfs`).
- **VFS** — an in-memory filesystem with path normalization, files/directories,
  metadata, and directory listing.
- **WASI-shaped syscall dispatch** — `path_open`, `path_stat`, `path_readdir`,
  `path_create_directory`, `path_unlink_file`, `path_remove_directory`, `rename`,
  `fd_read`/`fd_write`/`fd_seek`/`fd_close`/`fd_readdir`, `args`/`environ` access,
  `clock_time_get`, `random_get`, and `proc_exit`, over a `HostEnv` seam.
- **Process table** — pids, process state, spawn requests, and per-process I/O
  contexts with stdio bound to files or pipes.
- **IPC pipes** — a `PipeTable` with read/write ends, powering shell pipelines.
- **Module resolver** — kernel-owned resolution of a program's `import` graph
  (interpreters, module graph, default search path); deliberately free of
  Node's package-folder algorithm.
- **`wsh` planning** — the shell parser and glob expansion live here (the `shell`
  module): command lines lower to an execution plan the host merely orchestrates,
  keeping INV-2 (the shell's logic is Rust).
- **`wsh` script grammar** (`shell/script_{ast,lexer,parser}.rs`) — the full
  bash-subset parser behind the JS interpreter: expansion-aware words (`$x`,
  `${…}`, `$(…)`, `$(( … ))`, quoting), compound commands (`if`/`for`/`while`/
  `until`/`case`, brace groups, subshells), functions, and redirections incl.
  `2>&1`. `parse_script` returns an AST that serializes itself to JSON (the crate
  stays dependency-free); the host walks it. Keeps the grammar kernel-owned and
  native-tested (ADR-012).
- **Content-based wasm detection** (`resolver`) — the module resolver recognizes a
  wasm binary by its magic header (`\0asm`), not just a `.wasm` extension, so a
  program installed at an extensionless path (e.g. `/bin/grep`) runs through the
  WASI host instead of being misread as JS.
- **Capability sets** — the kernel is the sole authority for granting
  capabilities to guests.
- **Ring-buffer transport** (`ringbuf`) for host↔kernel byte streams.
- **ABI marker** — `ABI = "wasi-preview-1+otf-1"` (WASI Preview 1 floor + the
  three-call `otf:*` kernel ABI ceiling).
- Native unit tests (`cargo test`) covering the pure logic — no browser needed.

### Added
- **`Kernel::resolve_graph(cwd, path)`** — resolves a JS module graph without
  spawning. The kernel's JS-resolution service (INV-2): a userland runtime like
  `/bin/node` calls it to get a fully-resolved graph and then evaluates it itself.

### Changed
- **`node` is no longer a kernel concept.** The resolver keeps only `js` as the
  native execution keyword (`js foo.js` runs `foo.js` with the bare `sys` surface —
  the JS core the kernel owns). Every other command resolves through PATH and runs
  in place under that same native surface. `node` is now an ordinary user program
  (`/bin/node`) that resolves a script via `resolve_graph` and evaluates it with a
  `process` global — the kernel has no builtin `process`/`require`/`node` handling.

[Unreleased]: https://github.com/opentf/workeros/commits/main
