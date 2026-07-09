# Changelog — workeros-web-wasm

Notable changes to the wasm-bindgen bindings that expose the WorkerOS kernel to
the browser host runtime. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
No release cut yet — see **Unreleased**.

## [Unreleased]

### Added
- **`WebKernel` binding** — a `wasm-bindgen` façade over `workeros-kernel` that
  the kernel worker instantiates in the browser.
- **`sys_seek(pid, fd, offset, whence)`** binding (offset/result as JS numbers) for
  WASI `fd_seek`.
- **`resolve_graph(cwd, path)`** binding — returns the kernel-resolved module graph
  for a script without spawning, backing the `resolveGraph` syscall that the
  userland `/bin/node` runtime uses to evaluate scripts.
- **Boot handshake** — exposes the kernel `version` and `ABI`
  (`wasi-preview-1+otf-1`) so the host can verify it before use.
- **VFS bridge** — `fs` read/write crossing the JS↔wasm boundary.
- **Spawn / run** — turn a spawn request into a program plan (resolved module
  graph) the host executes in a program worker.
- **`shell_plan`** — parse a `wsh` command line and expand globs in Rust,
  returning the execution plan (pipes, redirects, `&&`/`||`/`;`, background) for
  the host to orchestrate.
- **`shell_parse(src)`** — parse a whole script into the rich bash-subset AST
  (returned as a JSON string) that the JS interpreter walks; keeps the shell
  grammar in Rust while the host drives the async execution it can't.
- **Marshaling** via `serde-wasm-bindgen` for structured values across the
  boundary.
- Built with `wasm-pack --target web`; `cdylib` + `rlib` crate types.

[Unreleased]: https://github.com/opentf/workeros/commits/main
