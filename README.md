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

There is now also a real **`npm` + `node`** inside the OS (a Phase-5 slice):
`npm install` fetches packages from the npm registry (semver + transitive deps),
gunzips/untars their tarballs into `node_modules`, and `node index.js` runs
CommonJS that `require()`s them — all as ordinary programs invoked through the
shell (`os.exec("npm install …")`, `os.exec("node app.js")`). npm/node are guest
programs; the kernel stays Node-agnostic (INV-1).

**WASI is running (Phase 4).** An unmodified `wasm32-wasip1` binary runs as a
WorkerOS process — the program worker instantiates the `.wasm` against a WASI
Preview 1 host bound to the kernel's syscalls and calls `_start`. It does stdio,
args/env, clocks, random, `proc_exit`, **and real blocking I/O**: a
SharedArrayBuffer synchronous-syscall channel lets a wasm program open/read VFS
files (`std::fs`), seek, `read_dir`, rename, and block on `stdin` from a pipe. A
`curl` program speaks HTTP(S) over the worker's `fetch` — downloads, headers,
methods, `-d`/`-F` bodies, Basic auth, `-i`/`-I`, `-w`, `-f`, `--max-time` — so you
can fetch and run a wasm, or hit a JSON API:

```sh
curl -o /hello.wasm https://example.com/hello.wasm   # needs CORS on the host
/hello.wasm
curl -sS -H 'Accept: application/json' https://api.example.com/thing
curl -X POST -d '{"a":1}' -H 'Content-Type: application/json' https://api.example.com/x
```

The transport is browser `fetch`, so its rules apply: cross-origin URLs must send
CORS headers, and forbidden request headers (Host/Cookie/User-Agent/…) are dropped.

| Milestone | Phases | State |
|-----------|--------|-------|
| M1 — Boot | 0–1 | ✅ kernel boots, VFS + WASI-shaped syscall spine, fully native-tested |
| M2 — Run JS (MVP) | 2 | ✅ spawn/run/kill JS, concurrent, `import` resolved by the kernel |
| M3 — Usable shell | 3 | ✅ `wsh` (pipes, redirects, `&&`/`\|\|`, glob, `&`), IPC pipes, coreutils, `ps` |
| M5 — Ecosystem | 5 | 🚧 `npm` (registry install, deps) + `node` CJS `require`; preview/lockfiles TBD |
| M4 / M6+ | 4,6,7 | ⏳ WASI binaries, preview, persistence |

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
