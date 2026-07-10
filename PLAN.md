# WorkerOS — Implementation Plan

Phased build with hard exit criteria. Each phase is **gated**: do not begin a phase until the prior phase's exit criteria are demonstrably met. Phases 0–2 are the MVP. Everything from Phase 3 onward is post-MVP and individually optional/orderable.

Conventions: **[MVP]** = required for the first usable milestone · **[post-MVP]**. Cross-references point at `ARCHITECTURE.md` (§) and `DECISIONS.md` (ADR-###).

---

## Phase 0 — Scaffold & harness · [MVP]

**Goal:** A buildable Rust→wasm kernel skeleton, a host runtime that boots it in a worker, and a test harness — no execution yet.

- Workspace: `workeros-kernel` (Rust lib, `cdylib` + native test target), `workeros-web` (wasm-bindgen bindings + host JS runtime), `workeros-node` (empty stub; later folded into `workeros-programs/node`).
- Kernel builds to `wasm32-unknown-unknown` and loads in a Web Worker; a `boot()` returns a version handshake to the main thread.
- Control transport up: `postMessage` message framing + a `SharedArrayBuffer` ring-buffer primitive with `Atomics.wait`/`notify` (the synchronous syscall channel, ADR-010). Unit-test the ring buffer natively.
- Cross-origin isolation dev server (COOP/COEP headers) so SAB works locally.
- CI: `cargo test` (native), `cargo build --target wasm32-unknown-unknown`, a headless-browser smoke test that boots the kernel.

**Exit criteria:**
- `boot()` round-trips a handshake main→kernel→main in a real browser.
- SAB ring buffer passes native concurrency tests (producer/consumer, block-until-data).
- CI green on native tests + wasm build + headless boot.

---

## Phase 1 — VFS + syscall spine · [MVP]

**Goal:** The kernel's authoritative core: filesystem, process table (data only), and the WASI-shaped syscall dispatch — still no guest execution.

- `Vfs` trait + in-memory implementation (inode tree). Ops: open/read/write/close/seek, mkdir/readdir/unlink, path normalization, cwd. (§9, ADR-011)
- Process table structure: `pid/ppid/argv/env/cwd/state/stdio/exit_code/start_time`. Allocation, lookup, reap. No workers yet — populate via test fixtures. (§5)
- Syscall dispatch layer implementing the WASI P1 host surface against the VFS/stdio: `fd_read/fd_write/fd_close/fd_seek`, `path_open/path_create_directory/path_unlink_file/fd_readdir`, `args_get/environ_get` (+ `_sizes`), `clock_time_get`, `random_get`, `proc_exit`. (§6.1, ADR-005)
- Capability set type: which fds/env/argv/`otf:*` a process may use.

**Exit criteria:**
- Full VFS unit-test suite (native) passes, including path edge cases and readdir.
- A simulated "process" fixture can perform a scripted sequence of WASI calls (open→write→seek→read→close) entirely through the dispatch layer, asserting VFS state.
- Zero Node-isms in the kernel (grep gate in CI for forbidden identifiers — enforces INV-1/ADR-007).

---

## Phase 2 — Run a JS program · [MVP] ← first usable milestone

**Goal:** The headline MVP capability: `spawn` a JS file, it runs on the host engine in its own worker, stdout/stderr/exit flow back.

- Program worker: thin JS shim that receives {source, capability set, transport endpoint} and evaluates the JS module on the host engine (`Full` level first, ADR-009/§7.1).
- `otf:spawn` wired end-to-end: kernel resolves entrypoint via the Rust resolver (§7), creates a worker, injects source + caps, registers the process.
- stdio streaming: guest `console.log`/writes → `fd_write` → kernel → main-thread stdout stream. stderr + exit code likewise.
- `otf:kill` / hard `terminate()` for runaway processes; `wait(pid)`.
- Minimal Node `process` shim (now in `workeros-programs/node`): just enough `process` (`argv`, `env`, `stdout.write`, `exit`) for ordinary scripts. **No `require` graph yet** beyond relative `import` of local files via the kernel resolver.
- Public client API on main thread: `boot()`, `fs.write(path, bytes)`, `spawn(argv)`, `onStdout`, `onExit`.

**Exit criteria (the MVP acceptance test):**
- Given a JS file written into the VFS, `spawn(["node", "main.js"])` (or `spawn(["js","main.js"])`) runs it and streams correct stdout/stderr and a correct exit code.
- A relative `import "./util.js"` resolves through the kernel and executes.
- An infinite-loop program can be killed from the host via `otf:kill` without freezing the kernel or other processes (proves ADR-003/-004).
- Two programs run concurrently in separate workers and interleave output (proves real parallelism).

> **Ship checkpoint.** At the end of Phase 2 WorkerOS does the thing the whole design was gated on: *run a JS program, get results, kill it, run several at once* — with a Rust-authoritative kernel and a real per-process worker model. Everything below is expansion.

---

## Phase 3 — Shell + coreutils · [post-MVP]

**Goal:** A usable interactive surface.

- `wsh` (§10, ADR-012): argv, env assignment, `cd`/`pwd`, run program, exit codes → then pipes `|`, redirects `> >> <`, `&&`/`||`/`;`, globbing, quoting.
- IPC pipes via `otf:ipc_open` so `A | B` streams concurrently (§6.3, ADR-006).
- Coreutils as guest programs against the VFS: `ls cat cp mv rm mkdir echo pwd env true false`.
- `ps` / `jobs` / background `&` reading the process table.
- xterm-style terminal binding on the host. **✅ done** — a real **TTY layer**: the
  kernel owns a controlling-terminal device (`workeros-kernel/tty.rs`) with a line
  discipline (canonical/raw, echo, editing, `Ctrl-C`/`Ctrl-D`/`Ctrl-Z`, winsize),
  terminal `stdin` reads block through it, and `isatty`/termios/winsize are exposed
  over the wasm bindings. The kernel worker runs the shell REPL against the TTY; the
  playground renders it with **xterm.js** (vendored same-origin), shipping raw
  keystrokes to `os.input()` and painting `os.onOutput()`. Verified end-to-end in a
  headless browser (pipes, line editing, `Ctrl-C` interrupt). **Guest terminal
  awareness ✅** — WASI `isatty(0..2)` returns true (stdio is a non-seekable
  character device) and the node runtime sets `process.*.isTTY` +
  `stdout.columns`/`rows` (via new `isatty`/`winsize` syscalls), reversing the
  Phase-5 `isTTY=false` stopgap. **Cooperative signals ✅** — a foreground process
  that installs a `SIGINT` handler catches `Ctrl-C` instead of being killed;
  `SIGWINCH` is delivered on resize (refreshing `process.stdout.columns`/`rows`);
  `SIGTSTP` is delivered on `Ctrl-Z` (default: ignore). **Readline prompt ✅** —
  the interactive prompt is a raw-mode line editor (`src/shell/readline.js`):
  ↑/↓ history, in-line cursor movement (←/→, Home/End, `Ctrl-A`/`E`/`B`/`F`),
  editing (Backspace, Del, `Ctrl-U`/`K`/`W`), `Ctrl-L`; programs reading stdin
  still get the kernel cooked discipline. Remaining TTY follow-ups: real **job
  control** (`SIGTSTP` suspend + `fg`/`bg`, process groups); async signal delivery
  to **WASI** guests (only JS guests are cooperative today); **UTF-8-aware editing
  + bracketed paste**, and multi-line/soft-wrap in the readline redraw; a
  `require('tty')`/`node:tty` builtin (gated on the node: builtin registry, Phase 5
  §C); WASI termios/window-size are not expressible in Preview 1.

**Exit criteria:** `echo hi | cat > f && cat f` produces `hi`; `ps` lists live processes; a backgrounded job survives and is killable; coreutils pass a behavior test suite.

---

## Phase 4 — WASI host for compiled modules · [post-MVP] ← key differentiator · 🚧 started

**Goal:** Run unmodified `wasm32-wasi` binaries as first-class processes (the thing that makes WorkerOS a JS+WASM OS, not a Node polyfill).

- Program worker gains a WASM path: instantiate a `.wasm` with imports bound to the kernel's WASI host + `otf:*` dispatch (§5.1, §6). **✅ done** — `kind === "wasm"` entries read from the VFS, instantiate with the WASI P1 host (`workeros-programs/wasi`), and call `_start`.
- Validate against real binaries: a `wasm32-wasi` build of a small CLI runs unmodified, reading VFS and writing stdout. **✅ done** — the **SAB synchronous-syscall channel** (ADR-010/-016) is built (`workeros-web/sync-syscall.js`), so a real rustc-built `wasm32-wasip1` binary runs unmodified with correct stdio/exit **and** reads the VFS (`std::fs::File::open`/read), seeks (`fd_seek`, backed by a `sys_seek` kernel binding), lists directories (`fd_readdir`), renames (`path_rename`), and blocks on `stdin` from a pipe. A `curl` program downloads a wasm over HTTP into the VFS so it can be run. Remaining: `esbuild-wasm`/PGlite and an off-the-shelf CLI (`jq`/`ripgrep`) as the marquee proof.
- Integrate a WASM **library** tool end-to-end (esbuild-wasm or swc-wasm) as a callable build step. **⏳ gated on Node compat.** The underlying capability is proven — a spike drove **esbuild-wasm** installed via the OS's own `npm` (loads its ESM API + `esbuild.wasm` from the VFS `node_modules`, runs the Go service on-thread with `worker:false`, bundles+transpiles a multi-file project through a VFS resolver plugin, verified in a real browser). But that spike required a bespoke `/bin/esbuild` driver baked into a core package, which violates the clean-OS goal, so it was **backed out**. The right shape: esbuild ships as a normal package (`npm install esbuild-wasm`) whose **own** `bin/esbuild` runs under `/bin/node`, with `node_modules/.bin` on PATH — no OS-specific shim. That needs the Phase-5 Node-compat parts below (VFS-backed `fs`/`path`, `worker_threads` or its no-worker fallback, `node:` builtins) plus **npm bin-linking** and **`node_modules/.bin` on PATH** (PATH is currently just `/bin:/sbin`). Track it there, not as a core program.
- PGlite as a process in its own worker: `import`, query, and a `ps`-visible/killable wrapper (§5.1). Document the daemon-costume caveat. **⏳ TODO**

**Exit criteria:** an off-the-shelf `wasm32-wasi` CLI runs with zero source changes and correct stdio/exit; PGlite runs a query inside a WorkerOS process without freezing the kernel. *(Substantially met for the WASI host: rustc-built `wasm32-wasip1` binaries run unmodified with full stdio/exit + VFS reads/seek/readdir/rename + blocking stdin. The WASM-library build step is proven as a spike (esbuild-wasm bundles a multi-file project) but not shipped — it belongs on the standard `npm`+`node` path once Node compat lands, not as a core program. Still to prove: an off-the-shelf CLI like `jq`/`ripgrep`, and PGlite.)*

---

## Phase 5 — Package manager · [post-MVP] · 🚧 in progress

**Goal:** `install` real packages into the VFS.

- Fetch npm tarballs from the registry (§8, ADR-008); unpack into `node_modules` in the VFS. **✅ done** — `npm` is a guest program (`workeros-programs`, `/bin/npm`): packument fetch, semver resolution, tarball download → in-browser `DecompressionStream` gunzip → untar, transitive deps.
- Node-style resolution in the guest node layer (`workeros-programs/node`): the `require`/`import` `node_modules` walk, `package.json` `main`/`exports`. (Stays in the guest layer — INV-1.) **✅ CommonJS `require`** works (`node index.js` resolves installed packages); ESM `import` of installed packages and `node:` builtins are still TODO.
- Lockfile + integrity; dedupe. **⏳ TODO** — dedupe is currently basic (hoist, first-writer-wins); no lockfile yet.
- Node compatibility is an **ongoing, incremental** effort (grow `workeros-programs/node` over time), not a one-shot. The concrete pending work is scoped below.

### Node-compat — pending work

The goal is that **real npm packages and their bins run on the host JS engine** via the guest node layer (INV-1) — *not* by hosting a foreign runtime (see the out-of-scope note). Two concrete proofs drive the scope: **esbuild-wasm** (its own `bin/esbuild` needs `module`/`path`/**synchronous `fs`**) and **edge.js** (ESM-only, imports `node:fs`/`node:path`/`node:url` and subpath-exported deps). Workstreams, roughly in dependency order:

- **A · Synchronous VFS `fs` builtin** ✅ — the keystone, **done**. The per-process **SAB sync-syscall channel** (ADR-010/-016) is exposed to JS programs as `sys.syncFs` (a sync `write` carrying request bytes was added to the transport + kernel-worker `serviceSync`), and `node:fs` (`src/node/fs.js`, `createFs(syncFs)`) implements the sync ops — `readFileSync`/`writeFileSync`/`appendFileSync`/`openSync`/`readSync`/`writeSync`/`closeSync`/`statSync`/`existsSync`/`readdirSync`/`mkdirSync`(recursive)/`rmSync`/`rmdirSync`/`unlinkSync`/`renameSync`/`copyFileSync`/`realpathSync`/`fstatSync` + a thin `fs.promises` — with kernel-errno→Node-code mapping (`ENOENT`/`EEXIST`/`ENOSPC`/…). Unit-tested in pure Node against a fake `syncFs`, and end-to-end in a browser (`node app.js` doing real `require('fs')` I/O). Honest surface (INV-5): reads return a `Uint8Array` unless an encoding is given; no symlinks/perms/mtimes.
- **B · Core builtins** 🚧 — mostly **done**: `node:path` (posix, `createPath()`), **`node:os`** (`createOs()` — platform/EOL/arch/tmpdir/homedir/hostname/endianness/cpus/…, browser-signal-backed where honest), **`node:url`** (`createUrl()` — WHATWG `URL`/`URLSearchParams` re-export + `fileURLToPath`/`pathToFileURL` + legacy `parse`/`format`/`resolve`), and **`node:module`** (`createModule()` — `createRequire(filename)`, a *synchronous* on-demand `require` built on Phase 5·A's sync `fs`; `builtinModules`/`isBuiltin`/`require.cache`). `process` grew `chdir`/`hrtime`(+`.bigint`)/`nextTick`/`arch`/`versions`. All unit-tested + a browser e2e. Still ⏳: `crypto.getRandomValues` (a `crypto` builtin), `tty.isatty→false`, and deeper `process` (`hrtime` already in; `chdir` is process-local until a kernel `chdir`).
- **C · `node:` builtin resolution** 🚧 — **CJS done**: `require('fs')`, `require('node:fs')`, `require('fs/promises')`, and `require('path')`/`require('node:path')` resolve to the builtin registry (`makeBuiltins` in `require-runtime.js`). The CJS runtime is now wired into `/bin/node` (a CJS entry runs through it) and the guest runtime library is installed into the VFS at `/lib/workeros-node/` so `/bin/node` imports it via the kernel resolver. Still ⏳: `import … from 'node:…'` (the kernel ESM resolver treating `node:` as runtime-provided externals).
- **D · ESM `import` of installed packages** ⏳ — extend `sys.resolveGraph` (the kernel ESM resolver) to walk `node_modules` with `package.json` `exports`/`module`/`browser` and **subpath exports** (e.g. `@poppinss/utils/lodash`). This is the gate for ESM-only packages like `edge.js`.
- **E · npm bin-linking + PATH** ⏳ — `npm install` creates `node_modules/.bin/<name>` for packages with a `bin` field (a generated launcher, since the VFS has no symlinks), and shell command resolution prepends `./node_modules/.bin` (walking up) ahead of `/bin:/sbin` — so an installed package's command is runnable as a bare name, the standard Unix/npm model, with **no OS-specific shim baked into core**.

**Proof targets (add opt-in browser tests when green):** `npm install esbuild-wasm && esbuild src/main.ts --bundle` runs the package's own bin under `/bin/node` (A+B+C+E); `npm install edge.js` then a script that renders a template imports it as ESM (C+D+B). A spike already proved esbuild-wasm loads + bundles from the VFS, but via a bespoke `/bin/esbuild` driver that was **backed out** to keep core clean (Phase 4 note).

**Out of scope — hosting a foreign runtime.** Dropping a prebuilt Node-compatible runtime *binary* into WorkerOS is not the path. Concretely, the Edge.js runtime (edgejs.org) ships an `edge-wasix` build, but it is not a portable WASI guest: its 61 MB V8-in-WASIX module imports **284 host functions** — the full **WASIX** extension surface (`wasix_32v1`: threads/`futex_*`, sockets/`sock_*`, `epoll_*`, `proc_spawn3`/`proc_exec4`), a **shared imported memory** + `wasi.thread-spawn`, and **~198 host-provided N-API functions** (`napi` + `napi_extension_wasmer_v0`, Wasmer's V8 embedding API). It would fail at instantiation (link error) and would require WorkerOS to become a Wasmer-compatible WASIX + N-API host with real threads/sockets/fork — enormous and partly at odds with the browser sandbox (ADR-008: no raw sockets). Node compat comes from running packages on the host engine, not from embedding another runtime.

**Exit criteria:** `install express` (or similar pure-JS package) then a script that imports and uses it runs correctly; a Vite-class dependency tree installs. *(Partially met: pure-JS packages with transitive deps install and run under `require` — e.g. `is-even`; larger ESM/tooling trees pending on the workstreams above.)*

---

## Phase 6 — Preview / networking simulation · [post-MVP]

**Goal:** "Servers" that a browser can actually hit.

- `otf:preview` + Service Worker interception: a guest "server" registers routes; SW routes `fetch` on the preview URL into the kernel/handler (§8).
- HTTP-server shim in the guest node layer (`workeros-programs/node`) mapping `http.createServer` onto the route registry.
- Target: a Vite dev server boots and its preview URL renders in an iframe.

**Exit criteria:** a Vite (or equivalent) project runs `dev` and the preview URL serves the app through the Service Worker; HMR-style reload optional.

---

## Phase 7 — Persistence & isolation hardening · [post-MVP]

**Goal:** Durability and stronger sandboxing options.

- IndexedDB `Vfs` implementation behind the existing trait; snapshot / COW overlay for "reset project" (§9, ADR-011).
- `Membrane` execution level: frozen intrinsics + proxied global / `ShadowRealm` (§7.1, ADR-009).
- (Optional, later) `Wasm` execution level via a pure-Rust JS engine for strong capability isolation.
- **Protected system paths** (ADR-018): a kernel-level protected-prefix / read-only-subtree check so `/sbin` (system binaries) and other protected paths reject mutating syscalls with `EPERM` — turning today's `/sbin` *convention* into real enforcement.

**Exit criteria:** a project persists across reloads; a project can be reset to a snapshot; membrane level denies ambient `fetch`/globals to a guest while still running ordinary code.

---

## Phase 8 — Resource limits & fault isolation · [post-MVP] · [INV-6, ADR-020] · 🚧 accounting caps done

**Goal:** No guest can exhaust or wedge the instance. Bound every resource; contain every fault. This is the quantitative half of the sandbox (§7.2) that the **embedding** and **untrusted / AI-generated code** use cases (§2) depend on — the `Membrane` level (Phase 7) denies *capabilities*, this caps *consumption*. Orderable independently and **worth pulling ahead of Phases 4–7 for any deployment that runs untrusted code**, since the accounting guards are cheap and the DoS surface is live today.

- **`ResourceLimits` in the kernel** (`workeros-kernel/limits.rs`, Rust, natively tested) **✅** — a policy set on the `Kernel`, granted per instance; `Kernel::boot_with_limits` is the seam the host-override API (below) will call. Hardcoded to `RECOMMENDED` in v1. Per-process-tree inheritance (a `ResourceUsage` rollup a child charges to its ancestors) is the additive next step.
- **Accounting caps (kernel-authoritative) — ✅ implemented with recommended v1 values:**
  - Process count — cap on *live* (non-zombie) processes in `Kernel::spawn` → `SpawnError::LimitExceeded` (`EAGAIN`). **Default 128.** Fork-bomb guard; also keeps spawns under the browser's real concurrent-worker ceiling.
  - Open fds/pipes — per-process cap in `ProcessCtx::alloc_fd` → `EMFILE`. **Default 256** (incl. stdio). fd/pipe-bomb guard.
  - VFS storage — total-byte + inode quota in `MemVfs::write_at` / `alloc` (released on truncate/unlink/rmdir) → `ENOSPC`. **Defaults 256 MiB / 100k inodes.** Disk-fill guard; bounds the eventual IndexedDB footprint (Phase 7).
- **Temporal caps (kernel-worker watchdog, host-side — the only agent with a clock + `terminate()`) — ⏳ pending.** Recommended values are declared kernel-side (`limits::WATCHDOG`) as the single source of truth the watchdog mirrors:
  - CPU/wall-time budget (**30s**) + idle timeout per process; on breach, cooperative signal → grace → `worker.terminate()` (generalizes the existing `Ctrl-C` two-phase hard-kill).
  - Memory high-water ceiling (**512 MiB**) via `performance.measureUserAgentSpecificMemory()` sampling (available under the ADR-010 cross-origin isolation) → `terminate()`, exit `137`. **Soft/sampled, documented as such** (INV-5).
- **Fault containment (all stop-paths reap through one seam) — ⏳ partly (ordinary exit + cooperative kill already close IO + restore TTY):** guest crash (`worker.onerror`) reaps + unblocks downstream pipes + restores TTY like an exit; **kill reason** recorded on the process record (`Killed (out of memory)` / `Killed (CPU time)`) so `ps`/`wait`/the shell report an honest *why*; bounded `Atomics.wait` on the SAB path so a lost kernel reply can't hang a WASI guest; kernel-worker crash surfaced to the client as fatal (reboot).
- **Host-override API — ⏳ post-v1.** Expose `boot_with_limits` (and later a per-process override inherited by children) through the wasm bindings + client API so an embedder can raise/lower any cap; ship a generous `Full`-level default and a tight untrusted/AI-agent profile.

**Exit criteria:** a fork-bomb (`while true; do spawn & done`-shaped) hits the process cap with `EAGAIN` instead of killing the tab **✅**; filling the VFS past quota returns `ENOSPC` **✅**; a process exhausting its fd budget gets `EMFILE` **✅**; a synchronous infinite-loop process is reaped by the time watchdog with a `Killed (CPU time)` reason and does not freeze the kernel or siblings ⏳; a runaway allocator is `terminate()`d at the memory ceiling and reaps as `137` ⏳; a crashing guest reaps deterministically and its downstream pipe reader sees EOF ⏳. Accounting caps proven in native `cargo test` **✅** (`process_count_cap_refuses_forkbomb`, `open_fd_cap_returns_emfile_and_frees_on_close`, `byte_quota_*`/`inode_quota_*`); the two watchdog limits to be proven in a headless-browser test.

---

## Deferred / explicitly out of scope

- Raw TCP/UDP, real DNS, `net`/`dgram` (ADR-008).
- Native addons / C-ABI (`.node`) (§1.1).
- **Hosting a foreign JS runtime binary** (e.g. Edge.js's `edge-wasix`, a Deno/Bun-in-wasm). These are not portable WASI guests — they import the **WASIX** superset (threads/sockets/`epoll`/fork-exec), a shared imported memory + `wasi.thread-spawn`, and host-provided **N-API** — i.e. they assume a specific embedder (Wasmer). Node compat comes from running packages on the host JS engine (Phase 5), not from embedding another runtime. See Phase 5 "Out of scope — hosting a foreign runtime".
- WASM Component Model / WASI Preview 2 host (forward path only; ADR-005).
- The native/server tier & V8 isolates — that's `es-runtime`, a separate product (ADR-002, §12).
- Spectre-class isolation (ADR-009).

---

## Milestone map

| Milestone | Phases | Capability |
|-----------|--------|------------|
| **M1 — Boot** | 0–1 | Kernel boots, VFS + syscall spine, fully tested, no execution |
| **M2 — Run JS (MVP)** | 2 | Spawn/run/kill JS programs, concurrent, Rust-authoritative |
| **M3 — Usable shell** | 3 | `wsh`, pipes, coreutils, `ps` |
| **M4 — WASM apps** | 4 | Unmodified WASI binaries + WASM-library build step + PGlite as processes — 🚧 wasm32-wasip1 runs with stdio/exit + VFS reads + blocking stdin (sync-syscall channel done); esbuild-wasm build step proven as a spike but deferred to the `npm`+`node` path (Node compat); PGlite + off-the-shelf CLI pending |
| **M5 — Ecosystem** | 5–6 | npm install + Vite dev preview — 🚧 `npm` registry install + `node` CommonJS `require` done; **sync `fs` + `node:fs`/`node:path` builtins done** (Phase 5·A, CJS side of C); pending: `import 'node:…'` / ESM `node_modules` / bin-linking+PATH, preview + lockfiles |
| **M6 — Durable & hardened** | 7 | Persistence + membrane isolation |
| **M7 — Bounded & contained** | 8 | Resource limits + deterministic fault reaping — INV-6/ADR-020 (pull ahead of M4–M6 for untrusted-code deployments) — 🚧 kernel accounting caps done (proc 128 / fd 256 / VFS 256 MiB · 100k inodes, native-tested); host memory/CPU-time watchdog + fault-path reaping + host-override API pending |
