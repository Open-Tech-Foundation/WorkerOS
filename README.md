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

**M2 — Run JS (MVP) reached.** You can write a JS file into the VFS, `spawn` it,
stream its stdout/stderr/exit, kill a runaway loop, and run several programs
concurrently in separate workers — with a Rust-authoritative kernel.

| Milestone | Phases | State |
|-----------|--------|-------|
| M1 — Boot | 0–1 | ✅ kernel boots, VFS + WASI-shaped syscall spine, fully native-tested |
| M2 — Run JS (MVP) | 2 | ✅ spawn/run/kill JS, concurrent, `import` resolved by the kernel |
| M3+ | 3–7 | ⏳ shell, WASI binaries, npm, preview, persistence |

## Layout

```
crates/workeros-kernel/   Rust core: VFS, process table, syscall dispatch, resolver (native-testable)
packages/workeros-web/    wasm-bindgen bindings + host runtime (kernel/program workers + client API)
packages/workeros-node/   guest-side Node-compat tenant layer (minimal `process` shim so far)
examples/                 runnable demos
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

Open the demo at
`http://localhost:8080/examples/run-js/index.html`.

Cross-origin isolation (COOP: `same-origin`, COEP: `require-corp`) is required
for `SharedArrayBuffer`; the dev server sets these headers (ADR-010).

## License

Apache-2.0.
