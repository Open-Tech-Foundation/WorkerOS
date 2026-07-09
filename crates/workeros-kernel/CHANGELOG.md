# Changelog — workeros-kernel

All notable changes to the WorkerOS kernel crate. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project has not cut
a release yet, so everything lives under **Unreleased**.

## [Unreleased]

### Added
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
- **Capability sets** — the kernel is the sole authority for granting
  capabilities to guests.
- **Ring-buffer transport** (`ringbuf`) for host↔kernel byte streams.
- **ABI marker** — `ABI = "wasi-preview-1+otf-1"` (WASI Preview 1 floor + the
  three-call `otf:*` kernel ABI ceiling).
- Native unit tests (`cargo test`) covering the pure logic — no browser needed.

[Unreleased]: https://github.com/opentf/workeros/commits/main
