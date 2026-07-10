# Changelog — workeros-kernel

All notable changes to the WorkerOS kernel crate. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project has not cut
a release yet, so everything lives under **Unreleased**.

## [Unreleased]

### Added
- **VFS symbolic links + inode timestamps (persistence Stage 1, ADR-022).** The
  inode model gains a `Symlink { target }` kind and `mtime`/`ctime`/`btime`
  (ms-epoch) fields. Path resolution now follows symlinks — intermediate always,
  the final one for `stat`/`open` but not `lstat`/`readlink`/create-remove —
  with relative targets resolved against the link's own directory (`.`/`..`
  honored) and an `ELOOP` (new `Errno::Loop`) depth cap of 40 catching cycles.
  New `Vfs` ops: `symlink`, `readlink`, `lstat`, and `set_time` (the kernel is
  clock-less per ADR-020, so the host feeds wall-clock time before mutations,
  which stamp `mtime`/`ctime`; `btime` is set at creation). `Metadata` now
  carries the times + `nlink`. Native-tested (relative/`..` targets, dir
  traversal through a link, dangling links, cycles→`ELOOP`, unlink-removes-link,
  and mtime/ctime stamping from the host clock).
- **Durable filesystem: snapshot / hydrate + path-based durability (ADR-022,
  PLAN Phase 7).** The in-memory `MemVfs` stays authoritative; persistence is a
  *projection* of it. `Kernel::snapshot` serializes the durable subtree to a
  compact, dependency-free byte blob (`b"WOFS"` + length-prefixed path/data
  records) and `Kernel::hydrate` replays one at boot (rejecting corrupt input
  with `EINVAL`, never panicking). Durability is **path-based** — a new
  `vfs::mount::MountTable` (longest-prefix match) whose default policy persists
  root `/` and marks `/tmp` plus the boot-reinstalled OS trees (`/bin`, `/sbin`,
  `/lib`) ephemeral; ephemeral subtrees with no persistent carve-out are pruned
  without being walked (so a `/tmp/node_modules` is never serialized).
  `Kernel::mount(prefix, ephemeral)` lets an embedder adjust the policy. A
  `MemVfs::generation` counter bumps on every mutation so the host write-behind
  re-snapshots only on change. The kernel never touches IndexedDB — it moves
  bytes; the host supplies the async store (ADR-015/-020 discipline). All
  native-tested (mount policy, round-trip, ephemeral exclusion, carve-outs,
  generation, corrupt-blob rejection).
- **Command resolution is `$PATH`-driven (PLAN Phase 5·E).** `resolve_invocation`
  now resolves a bare command against the process env's `PATH` (a plain
  colon-separated dir list), falling back to the system default (`/bin:/sbin`)
  when unset. The kernel knows nothing of `node_modules` or any ecosystem layout
  (INV-1) — it just searches the dirs it's given, in order. npm's
  `node_modules/.bin` convention lives entirely in userland: the shell (and
  `npm run`) prepends those dirs to `PATH`, exactly as real npm does (it edits
  the environment; it never teaches the OS about `node_modules`).

### Notes
- The resolver (`resolve_graph`) resolves **relative** specifiers only — generic
  ES-module-on-a-filesystem resolution. Bare / `node:` specifiers stay an honest
  `Unsupported` error: `node_modules`/`package.json` `exports`/`node:` builtins
  are Node-ecosystem policy that the guest node layer (`/bin/node`, which has
  synchronous `fs`) resolves for itself (INV-1). The kernel is deliberately kept
  free of that knowledge (and of `serde`/JSON parsing it would need for it).

### Added
- **Resource limits — kernel accounting caps (`limits` module; INV-6/ADR-020).**
  Bounds the runaway cases that would take down the tab. A **live-process cap**
  (default 128, excludes zombies) refuses fork-bombs in `Kernel::spawn`
  (`SpawnError::LimitExceeded`, guest-ABI `EAGAIN`); a **per-process open-fd cap**
  (default 256, incl. stdio) returns `EMFILE` from `ProcessCtx::alloc_fd`; a **VFS
  storage quota** (default 256 MiB + 100k inodes, released on truncate/unlink/rmdir)
  returns `ENOSPC` from `MemVfs::write_at`/`alloc`. The caps are a generous safety
  ceiling, not a tight quota, and are hardcoded to `ResourceLimits::RECOMMENDED` for
  v1; `Kernel::boot_with_limits` is the seam a post-v1 host-override API will call.
  Recommended temporal caps (30s wall-time, 512 MiB memory) are declared in
  `limits::WATCHDOG` for the pending host-side watchdog. New errnos `Again` (6) and
  `Nospc` (51); `ProcessTable::live_count`.

### Fixed
- **TTY line discipline drops stray control bytes.** In canonical mode the cooked
  line now ignores unhandled control characters (`< 0x20`, DEL) and swallows whole
  terminal escape sequences (`ESC [ …` / `ESC O …`, i.e. arrow/navigation keys), so
  a stray `^V`/arrow key can no longer leak into the line — and thus into `argv`
  (fixes `spawn: NotFound("\u{16}echo")`). Raw mode still passes everything through
  for TUIs.

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
