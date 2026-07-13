# WorkerOS

An operating system that boots inside a Web Worker and runs JavaScript or
WebAssembly programs as real processes — spawned, streamed, killable, and visible
in `ps`.

> The executable format is a JS or WASM module instead of a native binary, and the
> "CPU" is the host's own JS/WASM engine.

The kernel is written in **Rust** (compiled to WASM) and is the sole authority for
the VFS, the process table, module resolution, and capability granting. It is
**Node-agnostic**: Node compatibility is a swappable guest-side tenant layer, never
part of the kernel. A `wsh` shell (bash-subset scripting), POSIX-style coreutils, a
real `npm` + `node`, and unmodified `wasm32-wasip1` binaries all run as ordinary
processes on top of it.

For current capabilities and the milestone map, see [`PLAN.md`](./PLAN.md); for the
design, [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`DECISIONS.md`](./DECISIONS.md).

## Layout

```
crates/workeros-kernel/    Rust core: VFS, process table, syscall dispatch, resolver, wsh parser/glob (native-testable)
packages/workeros-web/     wasm-bindgen bindings + host runtime (kernel/program workers, shell driver, client API)
packages/workeros-coreutils/  system binaries: POSIX coreutils as guest programs over the `sys` ABI
packages/workeros-programs/ OS programs (npm, …) as installable /bin programs + the Node-compatible guest runtime (process shim + CommonJS require)
website/                   marketing site + live playground, built with the OTF Web framework
examples/                  runnable demos (run-js, shell)
```

Run a package inside the OS (all through the normal shell):

```sh
npm init -y
npm install is-even        # registry fetch → gunzip/untar → node_modules (+ deps)
echo 'console.log(require("is-even")(42))' > app.js
node app.js                # CommonJS require resolves node_modules → true
npm run start
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
