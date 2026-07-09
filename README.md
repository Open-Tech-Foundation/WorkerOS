# WorkerOS

A lightweight, language-agnostic operating-system personality that boots inside
a Web Worker and runs applications — written in JavaScript or WebAssembly — as
real processes.

> An OS-style runtime where the executable format is JavaScript or WASM instead
> of native binaries, and the "CPU" is the host's own JS/WASM engine.

The kernel is written in **Rust** (compiled to WASM), is **Node-agnostic**, and
is the sole authority for the VFS, the process table, module resolution, and
capability granting. Node compatibility is a swappable guest-side tenant layer,
never part of the kernel. See [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`PLAN.md`](./PLAN.md), and [`DECISIONS.md`](./DECISIONS.md).

## Status

**M3 — Usable shell reached.** On top of the MVP (spawn/run/kill/concurrent JS)
there is now `wsh`, a bash-flavored shell with pipes, redirects, `&&`/`||`/`;`,
globbing, background jobs, `cd`, and a set of coreutils (`echo cat ls cp mv rm
mkdir pwd env true false`) that run as real, `ps`-visible, killable processes.

There is also a **website + live playground** ([`website/`](./website)) built with
the OTF Web framework, including a **"try it" widget**: `os.run(code)` runs a JS
snippet as a real process, fetching any npm package it `import`s into the VFS
(guest-side Node resolution — INV-1) and returning its output — a Phase-5
down-payment aimed at live docs for JS packages.

| Milestone | Phases | State |
|-----------|--------|-------|
| M1 — Boot | 0–1 | ✅ kernel boots, VFS + WASI-shaped syscall spine, fully native-tested |
| M2 — Run JS (MVP) | 2 | ✅ spawn/run/kill JS, concurrent, `import` resolved by the kernel |
| M3 — Usable shell | 3 | ✅ `wsh` (pipes, redirects, `&&`/`\|\|`, glob, `&`), IPC pipes, coreutils, `ps` |
| M4+ | 4–7 | ⏳ WASI binaries, npm, preview, persistence |

## Layout

```
crates/workeros-kernel/    Rust core: VFS, process table, syscall dispatch, resolver, wsh parser/glob (native-testable)
packages/workeros-web/     wasm-bindgen bindings + host runtime (kernel/program workers, shell driver, client API)
packages/workeros-node/    guest-side Node-compat tenant layer (minimal `process` shim so far)
packages/workeros-coreutils/  coreutils as guest programs over the native `sys` ABI
examples/                  runnable demos (run-js, shell)
```

## Develop

Requires a Rust toolchain with the `wasm32-unknown-unknown` target, `wasm-pack`,
and Node.js.

```sh
# Native kernel tests (pure logic — no browser needed)
cargo test --workspace --exclude workeros-web-wasm

# Node-ism grep gate (keeps the kernel Node-agnostic — INV-1)
./ci/grep-gate.sh

# Build the kernel wasm + host runtime, then serve with COOP/COEP
cd packages/workeros-web
npm install
npm run build:wasm            # or build:wasm:dev
npm run serve                 # http://localhost:8080

# Headless browser tests (boot handshake + MVP acceptance)
npm test
```

Open a demo at
`http://localhost:8080/examples/run-js/index.html` (run a JS program) or
`http://localhost:8080/examples/shell/index.html` (the `wsh` terminal).

Cross-origin isolation (COOP: `same-origin`, COEP: `require-corp`) is required
for `SharedArrayBuffer`; the dev server sets these headers (ADR-010).

## License

Apache-2.0. See [NOTICE](./NOTICE) for attribution details.
