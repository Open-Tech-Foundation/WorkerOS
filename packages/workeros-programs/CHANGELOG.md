# Changelog — @opentf/workeros-programs

The OS programs package: installable `/bin` programs plus the Node-compatible
guest runtime. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **Program registry** (`src/index.js`) — one extensible list the kernel worker
  installs into the VFS at boot. Adding a program is a single entry (no package per
  program). Entries carry a `type` (`js` now, `wasm` later).
- **`node`** (`src/node/node-program.js`) — the Node.js-compatibility runtime, now
  a real user program at `/bin/node` instead of a kernel builtin. `node foo.js` asks
  the kernel to resolve `foo.js`'s module graph (`sys.resolveGraph`, INV-2), installs
  a `process` global, and evaluates the graph **in its own worker** — so the script
  is one process (killable as a unit, stdio shared) rather than a subprocess. The
  kernel has no `node` concept; replacing `/bin/node` swaps the whole compat layer.
  Scope today is ESM + `process` (argv/env/cwd/stdout/stderr/exit); CommonJS
  `require` (see `src/node/require-runtime.js`) is not wired in yet.
- **`npm`** (`src/npm/`) — the package manager, installed at `/bin/npm` and run
  from `wsh` (INV-1 — npm is just a program). Commands: `init`, `install [pkg…]`
  (npm-registry packument fetch, semver resolution — `^`/`~`/x-ranges/dist-tags,
  tarball download → in-browser `DecompressionStream` gunzip → untar into
  `<cwd>/node_modules`, transitive deps), `run <script>` (via `sys.exec`), `ls`.
- **WASI Preview 1 host** (`src/wasi/`) — `createWasiImports()` provides the
  `wasi_snapshot_preview1` import module bound to the kernel's `sys` syscalls, so an
  **unmodified `wasm32-wasip1` binary runs as a WorkerOS process** (the program
  worker reads the `.wasm` from the VFS, instantiates it, and calls `_start`).
  stdout/stderr, args, environ, clocks, random, and `proc_exit` work.
  - **Filesystem + blocking reads** work via the synchronous SAB syscall channel
    (see `@opentf/workeros-web` `sync-syscall.js`): `path_open`, `fd_read`,
    `fd_seek`, `fd_readdir`, `fd_close`, `fd_filestat_get`/`path_filestat_get`, and
    `path_create_directory`/`path_unlink_file`/`path_remove_directory`/`path_rename`,
    with a single `/` preopen so wasm resolves absolute paths; kernel errnos map to
    WASI errnos.
  - Verified with real rustc-built `wasm32-wasip1` binaries: reading a VFS file via
    `std::fs` (missing file → WASI `ENOENT`), blocking on `stdin` from a pipe
    (`echo … | prog.wasm`), `read_dir` of a directory, and `Seek`+read.
- **`sh` / `bash`** (`src/sh/`) — run a wsh script: from `-c "…"`, a script-file
  argument (with `$1…` positional params), or piped stdin. Runs it through the
  shell driver via `sys.exec`, so the installer idiom `curl -fsSL … | bash` now has
  a working entrypoint (subject to the wsh subset and the sandbox — no native
  binaries or sockets). Pairs with the expanded wsh interpreter in workeros-web.
- **`grep`** (`/bin/grep`) — a `type: "wasm"` program: the Rust `regex` binary
  from `crates/wsh-grep`, compiled to `wasm32-wasip1` and run through the WASI
  host (real regex, unlike a shell glob). The `.wasm` is gitignored and built by
  `npm run build:wasm` (dev) / the release GH action (publish); `fetchBytes` loads
  it into the VFS at boot.
- **`curl`** (`src/curl/`) — HTTP(S) transfer over the worker's `fetch` (ADR-008),
  streaming the response body through the `sys` ABI. Pairs with the WASI runtime:
  `curl` a wasm binary, then run it.
  - Download/output: `-o/--output` (`-` = stdout), `-O/--remote-name`, `-#` progress
    bar, and streamed writes (no full-response buffering).
  - Request shaping: `-X/--request`, `-H/--header` (repeatable), `-d/--data`,
    `--data-raw`/`--data-binary`/`--data-urlencode` (incl. `@file`), `-F/--form`
    multipart, `-G/--get`, `-T/--upload-file`, `-u/--user` (Basic auth),
    `-b/--cookie`, `-m/--max-time` (abort → exit 28).
  - Response: `-i/--include`, `-I/--head`, `-f/--fail` (exit 22 on ≥400),
    `-w/--write-out` (`%{http_code}`, `%{size_download}`, `%{content_type}`,
    `%{url_effective}`, `%{time_total}`, …), multiple URLs, `-s`/`-S`.
  - Honest about the browser ceiling (INV-5): cross-origin URLs must send CORS;
    forbidden request headers (Host/Cookie/User-Agent/…) are dropped with a warning;
    `-k`/`--compressed`/`-L` are accepted no-ops (the browser owns TLS, encoding,
    and redirect following). No raw sockets or non-HTTP protocols.
- **Node-compatible runtime** (`src/node/`) — the guest Node layer:
  - `process` shim (`argv`/`env`/`stdout`/`stderr`/`exit`).
  - CommonJS runtime (`createNodeRuntime`): a `require()` with relative +
    `node_modules` resolution (`exports`/`main`, `.js`/`.cjs`/`.json` + `index`
    fallbacks), reading files via `sys` and async-prefetching the graph so
    `require` is synchronous. Powers `node index.js` resolving installed packages.

### Notes
- Consolidated from the former `@opentf/workeros-npm` and `@opentf/workeros-node`
  packages so all OS programs and the node runtime live in one place.
- Node compatibility is an ongoing, incremental effort. Dependency dedupe is basic
  (hoist, first-writer-wins); lifecycle scripts and lockfiles are not implemented.

[Unreleased]: https://github.com/opentf/workeros/commits/main
