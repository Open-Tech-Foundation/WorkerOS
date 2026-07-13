# WorkerOS — Architecture

**Status:** Authoritative design document
**License:** Apache-2.0
**Owner:** Open Tech Foundation (`opentf`)
**Crates / packages:** `workeros-kernel` (Rust core), `workeros-web` (wasm/JS bindings + host runtime), `workeros-coreutils` (system binaries, installed in `/sbin`), `workeros-programs` (OS programs like `npm` in `/bin`, plus the Node-compat guest runtime under `/node`)

---

## 1. What WorkerOS is

WorkerOS is a lightweight, language-agnostic **operating-system personality** that boots inside a Web Worker and runs applications — written in JavaScript **or** WebAssembly — as real processes.

The one-line thesis:

> **An OS-style runtime where the executable format is JavaScript or WASM instead of native binaries, and the "CPU" is the host's own JS/WASM engine.**

It is the open, Rust-based answer to proprietary in-browser runtimes (WebContainer, Nodebox). Node.js compatibility is **one tenant layer** on top of a Node-agnostic kernel — not the identity of the system.

### 1.1 What it is NOT (non-goals — state these loudly)

WorkerOS deliberately does **not** attempt any of the following. These are not "later" items; they are architectural non-goals:

- **Not a real OS / kernel.** No hardware, no CPU emulation, no ring-0, no drivers, no multi-user model.
- **Not a VM.** It does not emulate a CPU (unlike v86 / WebVM / container2wasm). The host engine executes code directly.
- **No raw sockets.** No `socket()`/`bind()`/`listen()`; no raw TCP/UDP. The browser forbids it. Servers are *simulated* (see §8).
- **No `fork`/`exec` of native binaries.** No ELF, no `.exe`, no native (`.node`/C-ABI) addons.
- **Not Spectre-proof.** Isolation is capability- and worker-based, not a defense against motivated side-channel attackers (see §7).

The naming discipline matters: WorkerOS is an **"OS-style runtime,"** never a "full OS." Over-claiming invites the exact bug reports ("why won't my TCP server / bash script / native addon work?") that plague every project in this space.

---

## 2. Positioning & use cases

**Value proposition:** Instant, backend-free, safe execution of JS/WASM projects in the browser — for docs, education, playgrounds, embedded IDEs, and AI-generated code.

**Strong-fit problems this solves:**

1. Interactive documentation & live code samples (no server cost).
2. In-browser coding education — zero install, identical env for everyone.
3. Playgrounds / REPLs / minimal bug reproductions.
4. Embeddable execution surface inside a SaaS product.
5. **AI agent code execution** — cheap, instant, safe sandbox to run LLM-generated JS/WASM and feed results back. No container spin-up.

**Competitive wedge vs. prior art:** WebContainer / Nodebox are proprietary. NodePod (the closest OSS project) is a TypeScript *Node-runtime* — Node is its whole world, and native/WASI loading is unbuilt. WorkerOS differentiates on three axes: **(1)** a Rust/WASM kernel, **(2)** a **WASI-first** design where compiled WASM apps are first-class processes, and **(3)** a Node-agnostic kernel with Node as a swappable tenant. The open niche is precisely this middle: a lightweight, Rust-based, WASI-first OS where JS and WASM are co-equal.

---

## 3. Core invariants

These constraints are load-bearing. Violating any of them collapses WorkerOS back into "NodePod-in-Rust" and forfeits the differentiation.

- **INV-1 — Node-agnostic kernel.** The kernel understands *processes, files, syscalls, and the ABI*. It must **not** know what `require`, `express`, or `node_modules` are. All Node-isms live in the guest-side node layer (`workeros-programs/node`) — exactly as Node would be "just a program" on real Linux. (`npm` likewise is a guest program in `workeros-programs`, not a kernel feature.)
- **INV-2 — Rust is the control center.** The Rust kernel is authoritative for module resolution, VFS, the process table, scheduling, and capability granting. Host JS is a "dumb CPU": it executes source it is handed and reports results back. Logic never leaks host-side.
- **INV-3 — WASI is the floor, `otf:*` is the ceiling.** Anything WASI Preview 1 can express is done with WASI (so unmodified `wasm32-wasi` binaries run). Custom `otf:*` calls exist **only** where WASI has no primitive.
- **INV-4 — Every process is a real, killable process.** A process is backed by its own worker; it can run in parallel and be terminated externally. No "fake" cooperative-only processes in the core model.
- **INV-5 — Honest surface.** Where a capability cannot be truly provided (sockets, native addons), it is either absent or explicitly a documented simulation — never a silent lie.
- **INV-6 — Bounded & contained.** Every process runs under an explicit resource budget (processes, fds, memory, CPU-time, storage), and every fault (guest crash, kill, lost syscall reply) reaps deterministically without wedging the kernel or leaking the resource. A guest can fail; it cannot take down the instance. (§7.2, ADR-020.)

---

## 4. System topology

WorkerOS uses a **kernel-worker + program-worker** model.

```
┌─────────────────────────────────────────────────────────────┐
│  Main thread (host page)                                     │
│   • thin client API (boot, mount, spawn, stdio streams)      │
│   • Service Worker registration (preview/networking, later)  │
└───────────────┬─────────────────────────────────────────────┘
                │ postMessage / SharedArrayBuffer
┌───────────────▼─────────────────────────────────────────────┐
│  KERNEL WORKER  (workeros-kernel, Rust→wasm)                 │
│   • VFS (in-memory, trait-backed)                            │
│   • process table (pid/ppid/state/stdio/exit)               │
│   • scheduler & placement                                    │
│   • module resolver (authoritative)                          │
│   • capability broker (WASI host + otf:* dispatch)          │
│   • shell (bash-flavored) as a builtin-ish process           │
└───┬───────────────────────────┬─────────────────────────────┘
    │ spawn (own worker each)   │
┌───▼──────────────┐     ┌──────▼───────────┐
│ PROGRAM WORKER A │     │ PROGRAM WORKER B │   ... one per process
│ thin JS shim     │     │ thin JS shim     │
│ • runs JS on     │     │ • runs a WASI    │
│   host engine    │     │   .wasm module   │
│ • or instantiates│     │ • syscalls →     │
│   a WASM module  │     │   kernel         │
└──────────────────┘     └──────────────────┘
```

- **Kernel worker:** one instance. Owns all authoritative state. Never executes guest code itself.
- **Program worker:** one per process. Executes exactly one program (a JS entrypoint or a WASM module) on the host engine. Isolated, parallel, and `terminate()`-able.
- **Transport:** `postMessage` for control/streaming; `SharedArrayBuffer` + `Atomics` for the synchronous syscall path (a WASI guest expects blocking `fd_read`; a SAB ring buffer + `Atomics.wait` provides the block-until-satisfied semantics). Requires cross-origin isolation headers (COOP/COEP) — see §11.

**Why this topology (and not a single cooperative worker):** binding each process to its own worker makes `kill` real (`worker.terminate()` is the *only* way to stop a runaway synchronous loop from outside), gives true parallelism, and provides per-process memory isolation — from day one, not as a later tier.

---

## 5. Process model

The kernel maintains a POSIX-shaped process table. Each entry: `pid`, `ppid`, `argv`, `env`, `cwd`, `state` (`running`/`sleeping`/`zombie`), `stdio` handles, `exit_code`, `start_time`, and the backing worker handle.

Supported today / near-term:
- `spawn(argv, env, cwd) -> pid` — creates a program worker, wires stdio.
- `kill(pid, signal)` — cooperative signal delivery where possible; `terminate()` for hard kill.
- `wait(pid) -> exit_code`.
- `ps` / task-manager view — reads the process table; looks and behaves like a real one.
- Pipes: `A | B` streams A's stdout into B's stdin, both live concurrently (see IPC, §6.3).
- Background jobs (`&`), `jobs`, `fg`/`bg`.

**Signals are emulated.** `SIGTERM` etc. are delivered cooperatively (a flag / `AbortController` the guest observes at an await point); `SIGKILL` maps to `worker.terminate()`. This is honest and sufficient.

### 5.1 Running WASM tools as processes

A WASM module becomes a **process** when it is (a) self-contained WASM+JS and (b) needs no `fork`/`exec` or raw sockets. Three tiers:

| Tier | Example | How it runs |
|------|---------|-------------|
| WASM **library** | esbuild-wasm, PGlite, sql.js | JS shim drives it; works trivially once module resolution exists |
| WASI **module** | a `wasm32-wasi` Rust/Go/Zig CLI (ripgrep, jq) | kernel's WASI host wires `fd_*`/`args_*`/`clock_*` to VFS/stdio → runs as a first-class process, unmodified |
| WASM **component** (future) | typed WIT modules | component host; deferred |

**Worked example — PGlite:** Postgres compiled to WASM, single-user, single-connection (Emscripten can't `fork`, so it runs in Postgres single-user mode). It plugs in cleanly:
- `import { PGlite }` and query it → trivial (it's a WASM library).
- Wrap it in a process so it shows in `ps` and is killable → put it in its own program worker (this is exactly why per-process workers matter: a heavy query must not freeze the kernel/shell).
- A `postgres` "daemon on :5432" that other processes connect to → a **daemon-costume simulation**: a single PGlite instance behind the IPC layer pretending to be a socket. Not a real multi-client server, and that's fine — nobody uses PGlite that way.

**Generalizable rule:** a WASM tool runs as a process if it doesn't need multi-process forking or real sockets. `ripgrep`-in-WASI is *completely real*; `nginx`-in-WASI can only ever be a single-process daemon costume.

---

## 6. The ABI (kernel ⇄ program contract)

**Design rule (INV-3): WASI is your userland ABI (how a program talks to the OS); `otf:*` is your kernel ABI (how the OS manages processes). Real operating systems separate these too — WASI simply never specified the second half. WorkerOS supplies the blank part, it does not extend WASI.**

### 6.1 WASI Preview 1 surface (the floor)

Implemented as a host in the kernel; a plain `wasm32-wasi` binary uses these unmodified:

- `fd_read`, `fd_write`, `fd_close`, `fd_seek` — stdio + files, mapped to the VFS.
- `path_open`, `path_create_directory`, `path_unlink_file`, `fd_readdir` — filesystem.
- `args_get` / `args_sizes_get`, `environ_get` / `environ_sizes_get`.
- `clock_time_get`, `random_get`, `proc_exit`.

For JS programs, the guest node layer (`workeros-programs/node`) maps Node's `fs`/`path`/`process` onto these same kernel primitives — so JS and WASI guests bottom out at one VFS/stdio surface.

### 6.2 `otf:*` extensions (the ceiling — v1 is exactly three)

WASI P1 has **no** primitive for process creation, termination, or inter-process channels. Since WorkerOS is multi-process by definition (INV-4), these are unavoidable — not stylistic additions:

- `otf:spawn(argv, env, cwd) -> pid` — create a new process (program worker).
- `otf:kill(pid, signal) -> result` — signal / terminate.
- `otf:ipc_open(pid_or_channel) -> fd` + read/write via the `fd_*` calls — pipes and channels between processes.

Everything else (networking, preview, GPU/canvas, live-reload) is **deferred** to later `otf:*` namespaces (`otf:net`, `otf:preview`, …) and is out of v1 scope.

### 6.3 IPC

Pipes and channels are the kernel's own construct (WASI has none). An `otf:ipc_open` returns an fd that behaves like any other under `fd_read`/`fd_write`, so `A | B` is just "B's stdin fd is wired to A's stdout channel." Cross-worker transport is a SAB ring buffer; the shell sets the wiring up at spawn time.

Pipes are **bounded and POSIX-shaped** (ADR-023): a pipe buffers at most 64 KiB (`PIPE_CAPACITY`), a writer into a full pipe **blocks** (its worker thread parks in `Atomics.wait` until the reader drains — real backpressure, not host-side buffering), and a write to a pipe whose last reader closed is **`EPIPE`** with the POSIX default **SIGPIPE** disposition (the writer is killed with `128+13` unless it catches the signal) — so `producer | head`-style pipelines terminate exactly as on Unix. All-external shell pipelines run concurrently over these kernel pipes; a pipeline stage that is a shell builtin falls back to buffered collect-and-feed.

---

## 7. Execution & module-loading handshake

**Contract (INV-2 — Rust is authoritative):**

1. Shell/kernel decides to run a program: `spawn(argv, env, cwd)`.
2. **Rust resolver** locates the entrypoint against the VFS (relative paths, then node-style `node_modules` walk for the Node layer), reads the bytes, and determines kind (JS source vs WASM module).
3. Kernel creates a program worker and hands it: the **source/bytes** + a **capability set** (which fds, env, argv, allowed `otf:*` calls) + the syscall transport endpoint (SAB + port).
4. The **thin JS shim** in the program worker executes:
   - **JS:** evaluate the module on the host engine (via dynamic `import()` of a blob, or the configured isolation wrapper — see §7.1). `import "./x"` inside guest code calls **back** to the kernel resolver; the shim never resolves paths itself.
   - **WASM:** instantiate with imports bound to the WASI host + `otf:*` dispatch.
5. Syscalls travel program-worker → kernel over the transport; the kernel is the sole authority that touches VFS/process-table/capabilities.
6. `stdout`/`stderr` stream back; `proc_exit`/return sets `exit_code`; kernel reaps the process.

The guest is a "dumb CPU": all resolution, capability, and state decisions are the kernel's. This keeps the door open to swap the JS execution strategy (§7.1) without touching kernel logic.

### 7.1 Isolation as a policy knob

Execution sits behind one trait with a selectable trust level (implementation- or user-chosen):

| Level | Mechanism | Isolation | Use |
|-------|-----------|-----------|-----|
| `Full` | bare `import()` in the program worker | process-level (worker) only | trusted / acknowledged code |
| `Membrane` | frozen intrinsics + proxied global (SES / `ShadowRealm`) inside the worker | capability-level | untrusted-ish npm code |
| `Wasm` (later) | Boa or similar pure-Rust JS engine in WASM | strong capability sandbox | adversarial code |

Per-process worker isolation (memory + `terminate()`) applies at **all** levels. The membrane adds capability denial (no ambient `fetch`, `postMessage`, prototypes); the future WASM engine adds true linear-memory containment. None of these defend against Spectre-class side channels — that requires native/server-tier V8 isolates, which is a *different product* (see §12).

### 7.2 Resource limits & fault isolation (INV-6)

Isolation (§7.1) is *qualitative* — which capabilities a guest holds. Limits are the *quantitative* half: how much of each resource it may consume, and what happens when a process faults. Together they are the "safe sandbox" the AI-agent and embedding use cases (§2) depend on. A guest with no ambient `fetch` that can still fork-bomb the tab is not sandboxed.

**The ownership split (the load-bearing decision, ADR-020).** Limits divide by what the wasm kernel *can* do. The kernel has no wall clock and no handle on the workers, so it owns the **accounting** limits (pure bookkeeping, natively `cargo test`-able) while the **kernel worker** (JS, ADR-016) — the only agent with a clock and `worker.terminate()` — owns the two **temporal** ones. The host still decides no policy: the kernel owns the numbers; the host reports breaches back.

| Resource | Cap (v1 default) | Owner | On breach | Enforcement seam | Status |
|----------|-----|-------|-----------|------------------|--------|
| Processes (fork-bomb) | 128 live procs | **kernel** (Rust) | `EAGAIN` | `Kernel::spawn` | ✅ |
| Open fds / pipes | 256 / process | **kernel** (Rust) | `EMFILE` | `ProcessCtx::alloc_fd` | ✅ |
| VFS storage | 256 MiB · 100k inodes | **kernel** (Rust) | `ENOSPC` | `MemVfs::write_at`/`alloc` | ✅ |
| CPU time (unresponsiveness) | 30s continuous | **kernel worker** (JS watchdog) | SIGTERM → grace → `terminate()`, exit `152`, reason "CPU time" | PING/PONG liveness + syscall activity + SAB park-state | ✅ |
| Memory | 512 MiB high-water | **kernel worker** (JS watchdog) | `terminate()`, exit `137`, reason "out of memory" | per-worker `measureUserAgentSpecificMemory()` self-sampling (where exposed) | ✅ |

The recommended values live in one place — `workeros-kernel/limits.rs` (`RECOMMENDED` for the kernel-enforced caps, `WATCHDOG` for the temporal ones the host mirrors); the temporal budgets are overridable per boot (`boot({ watchdog })`, `0` disables — the seam for a tight untrusted/AI-agent profile), and kernel caps via `Kernel::boot_with_limits`. "CPU time" is measured as **continuous unresponsiveness** — a process is alive if it makes syscalls, answers the liveness ping, or is parked in a kernel-serviced blocking call — so servers and blocked readers live forever while a synchronous `for(;;)` is reaped (ADR-020 deviation note). Every watchdog kill records a **kill reason** in the kernel (`mark_killed` → `ProcInfo.kill_reason`) and prints a shell-visible `Killed (…)` to the process's stderr.

**Policy object.** A `ResourceLimits` set is granted at spawn alongside the `CapabilitySet` (§7.1 is *what*; this is *how much*) and is **inherited by children** — a descendant's usage counts against its ancestors' budgets, so a whole process tree is bounded, not just a single pid. A `ResourceUsage` counter set is maintained on every spawn / reap / fd-alloc / VFS write. Two default profiles: a generous one for the trusted `Full` level, and a tight one for the untrusted / AI-agent profile (paired with the `Membrane` level).

**Fault paths.** Every way a process can stop reaps through one seam so nothing wedges or leaks:
- **Ordinary exit / cooperative kill** — already handled: `mark_exited` closes IO fds (EOF downstream) and the host restores the TTY.
- **Guest crash** (`worker.onerror` / uncaught throw) — reaps with a distinguished fault code, unblocks downstream pipe readers, restores the TTY, same as an exit.
- **Limit kill** — the watchdog delivers a cooperative signal first, then hard-`terminate()`s after a grace period (the two-phase the `Ctrl-C` path already uses), recording a **kill reason** (`Killed (out of memory)` / `Killed (CPU time)`) so `ps`/`wait`/the shell report an honest *why*.
- **Lost syscall reply** — a guest parked in `Atomics.wait` on the SAB path (§6.3) is exempt from the watchdog (the kernel worker reads the slot state: that wait is the kernel's debt, not a spin). The wait itself is unbounded today: the only way a reply is genuinely lost is a kernel-worker crash, which is already fatal to the instance (below) — the client reboots and the parked worker is torn down with it. A wedged-but-alive program worker is the watchdog's case and is reaped.
- **Kernel-worker crash** — the one unrecoverable fault (the authoritative wasm state is gone): surfaced to the main-thread client as fatal, which may reboot the instance.

**Honest surface (INV-5).** The memory ceiling is a *soft, sampled* high-water mark, not a hard allocator limit — a single synchronous huge allocation can still OOM the tab between samples; a hard cap arrives only with the future `Wasm`/Boa level (§7.1). Time enforcement is cooperative-first, not preemptive time-slicing (the browser schedules workers; WorkerOS caps *concurrency*, it does not time-slice). Quotas are per-session until persistence (§9) gives them a durable home. See ADR-020.

---

## 8. Networking model (load-bearing section)

The browser cannot open raw sockets, and that limit passes straight through. WorkerOS exposes only what the platform allows, and *simulates* the rest honestly.

- **No listening sockets.** When a guest "starts a dev server on :5173," nothing is actually listening on a port. Instead: the server registers routes in a kernel-side registry, and a **Service Worker** on the same origin intercepts the browser's `fetch` to the preview URL and routes it into the kernel/handler. The port is a convincing fiction maintained by the Service Worker. (This is how WebContainer previews work; it is why the Service Worker is load-bearing, not an afterthought.)
- **`net`/`dgram` (raw TCP/UDP):** unsupported. A guest doing `net.connect(5432, host)` has no socket to receive. Optionally shimmable over WebSocket **iff** a WS↔TCP proxy exists server-side; out of scope for the browser-only product.
- **Outbound HTTP:** `fetch` works but is CORS-bound. The npm registry therefore needs a **CORS proxy** for package downloads. Egress is a **kernel-granted capability** (ADR-024): `CapabilitySet.net_egress` (default allowed, inherited by children like POSIX credentials — a denied guest cannot shell out to regain it); a denial is enforced by the program worker removing the egress globals (`fetch`, `WebSocket`, XHR, …) before any guest code runs. Coarse, same-realm, pre-`Membrane` — stated honestly (INV-5). Client surface: `os.spawn(argv, { net: false })`.
- **Extension surface:** all of the above lives behind `otf:net` / `otf:preview` extensions, deferred past MVP.

---

## 9. Filesystem

- In-memory VFS in Rust: a tree of inodes (e.g. `BTreeMap<Path, Inode>`), exposed through a `Vfs` trait.
- All WASI `path_*`/`fd_*` calls and the Node `fs` shim bottom out here — one source of truth.
- **Persistence (later):** an IndexedDB-backed implementation of the same `Vfs` trait; no call-site changes.
- **Overlay (later):** copy-on-write layers for cheap "reset to clean project" and snapshotting.

---

## 10. Shell

A custom, Rust-implemented shell — **bash-flavored, not bash** (real bash is a native ELF binary; running it would require CPU emulation, defeating the lightweight goal). It resolves a command name → a program → runs it, and does not care what language implements the command.

- **MVP:** `argv`, env assignment (`FOO=bar cmd`), `cd`, `pwd`, run program, exit codes.
- **Phase 2:** pipes `|`, redirects `> >> <`, `&&`/`||`/`;`, globbing `*`, quoting.
- **Later:** subshells `$(...)`, minimal `if`/`for`, background `&`.

Named e.g. `wsh`. Documented explicitly as **not** bash-compatible, only bash-flavored, to set expectations.

---

## 11. Platform requirements

- **Cross-origin isolation** (COOP: `same-origin`, COEP: `require-corp`) is required for `SharedArrayBuffer`, which the synchronous syscall path depends on. Embedders must serve these headers.
- **Service Worker** must be served from the app's own origin (preview/networking).
- Host engine assumed modern (V8/SpiderMonkey/JSC) with `ShadowRealm` where the `Membrane` level is used.

---

## 12. Relationship to other OpenTF runtimes

- **`es-runtime` (V8-based):** V8 does not compile to `wasm32`, so it cannot be the in-browser engine. It is the **native/server tier** — V8-isolate-per-process, real heap limits, real termination. That tier is a *different product* answering the adversarial-isolation and full-Node-fidelity cases WorkerOS intentionally does not. WorkerOS may later share the `otf:*` ABI shape with it so guests are portable across tiers.
- WorkerOS is the **browser-first, lightweight** member of the family.

---

## 13. Summary of load-bearing decisions

1. Host-engine execution (borrow the worker's JS engine; ship no JS engine in v1).
2. Kernel-worker + program-worker-per-process topology → real, parallel, killable processes.
3. Rust kernel authoritative; JS shim is a dumb CPU.
4. WASI P1 floor + a **three-call** `otf:*` kernel ABI (`spawn`, `kill`, `ipc`).
5. Node is a guest layer, kernel is Node-agnostic.
6. Servers are Service-Worker simulations; no raw sockets.
7. Isolation is a policy knob (Full / Membrane / Wasm-later); never claimed Spectre-proof.
8. Every process is bounded and every fault is contained (INV-6): the kernel accounts proc/fd/storage caps (Rust, natively tested), the kernel worker enforces memory/CPU-time via a sampling watchdog + `terminate()`.

See `DECISIONS.md` for the rationale trail behind each.
