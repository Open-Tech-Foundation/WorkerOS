# WorkerOS — Decisions Log

Architecture Decision Records. Each entry: the fork, the choice, why, and what it rules out. Deviations in implementation must be logged here against the original rationale.

Status legend: **[locked]** settled for v1 · **[deferred]** intentionally out of v1 · **[revisit]** may change with new information.

---

### ADR-001 — Execution engine: host engine, not a shipped engine · [locked]
**Choice:** Guest code runs on the host worker's own JS engine (V8/SpiderMonkey/JSC), not a JS engine we ship (Boa/QuickJS) in v1.
**Why:** Lighter (no engine bundle), faster, and fully spec-complete JS for free. Matches the WebContainer/NodePod model. A pure-Rust engine (Boa) can slot in later behind the same execution trait for stronger isolation.
**Rules out:** Guaranteed capability isolation by default (host engine shares the worker realm). Mitigated by per-worker processes + the `Membrane` level.

### ADR-002 — es-runtime / V8 isolates are the *server* tier, not the browser engine · [locked]
**Choice:** V8 isolates (and thus `es-runtime`) are excluded from the in-browser path; reserved for a separate native/server tier.
**Why:** V8 does not compile to `wasm32`; a web page cannot create child isolates. Isolates only exist to a native embedder. They remain ideal for the adversarial-isolation / full-Node-fidelity server product, which is deliberately a different thing.
**Rules out:** True (native) sandboxing and Spectre resistance in the browser product.

### ADR-003 — Topology: kernel worker + one worker per process · [locked]
**Choice:** Kernel boots in a single worker; every spawned program gets its own worker. (Not a single cooperative worker, even for MVP.)
**Why:** Makes `kill` real (`worker.terminate()` is the only way to stop a runaway synchronous loop from outside the realm), gives true parallelism, and provides per-process memory isolation from day one. Cost — heavier spawn, `postMessage`/SAB comms — is acceptable and buys an honest process model.
**Rules out:** Ultra-cheap in-realm "processes." Requires cross-origin isolation for SAB (ADR-010).

### ADR-004 — Rust kernel is the single authority · [locked]
**Choice:** Rust owns VFS, process table, module resolution, scheduling, and capability granting. The host JS shim only executes handed-over source and reports back.
**Why:** One authoritative core (consistent with OpenTF DBMS/es-runtime instincts). Prevents logic leaking host-side, keeps the execution strategy swappable, and keeps the kernel testable independent of the browser.
**Rules out:** JS-side module resolution / capability decisions.

### ADR-005 — ABI: WASI Preview 1 floor + `otf:*` ceiling · [locked]
**Choice:** Use WASI P1 for everything it can express; add custom `otf:*` calls *only* where WASI has no primitive.
**Why:** WASI-only cannot express process creation, kill, or IPC — but WorkerOS is multi-process by definition (ADR-003), so it necessarily exceeds WASI P1 the moment there is more than one process. WASI is the *userland* ABI; `otf:*` is the *kernel* ABI WASI never specified. WASI-first buys the entire `wasm32-wasi` ecosystem unmodified; the extension surface stays minimal and principled.
**Rejected alternatives:**
- *WASI-only:* impossible past a single process.
- *WASI Preview 2 only:* younger tooling, heavier (typed WIT/component host), and still lacks browser-specific primitives (SW networking, worker-spawn). Not worth it for v1.
- *Fully custom ABI (`wasm32-otf`):* elegant but strands you in an ecosystem of one — nothing compiles to it (the WasmLinux adoption trap).
**Rules out:** nothing needed; forward path to Preview 2 / components stays open.

### ADR-006 — `otf:*` v1 surface is exactly three calls · [locked]
**Choice:** v1 kernel ABI = `otf:spawn`, `otf:kill`, `otf:ipc_open`. Networking/preview/GPU are separate deferred namespaces.
**Why:** These three are the unavoidable minimum forced by a multi-process OS. Keeping v1 to three prevents ABI bloat and keeps the WASI-compat surface pure.
**Deferred:** `otf:net`, `otf:preview`, `otf:gpu`, live-reload.

### ADR-007 — Node is a guest tenant, kernel is Node-agnostic · [locked]
**Choice:** The kernel knows processes/files/syscalls only. All Node semantics (`require`, `node_modules` resolution, `fs`/`http`/`path` shims) live in the guest-side node layer (`workeros-programs/node`). `npm` is likewise a guest program (`workeros-programs`, installed at `/bin/npm`), not a kernel feature.
**Why:** This is *the* differentiator from NodePod (a Node-runtime). If Node concepts leak into the kernel, WorkerOS becomes "NodePod-in-Rust" and loses its reason to exist. On real Linux, Node is just a program; same here.
**Rules out:** Kernel-level Node fast-paths.

### ADR-008 — Networking: Service-Worker simulation, no raw sockets · [locked]
**Choice:** No `socket`/`listen`. "Servers" register routes; a same-origin Service Worker intercepts `fetch` to the preview URL and routes into the kernel. Outbound `fetch` is CORS-bound; npm needs a CORS proxy. `net`/`dgram` unsupported.
**Why:** The browser forbids raw sockets; this is the platform ceiling, not a design preference. SW interception is the only faithful way to present a "server."
**Rules out:** Real TCP/UDP servers/clients, real DNS. Documented as simulation.

### ADR-009 — Isolation is a policy knob; not Spectre-proof · [locked]
**Choice:** One execution trait, selectable levels: `Full` (bare import), `Membrane` (SES/`ShadowRealm` + frozen intrinsics), `Wasm` (Boa, later). Per-worker isolation applies at all levels.
**Why:** Different callers have different threat models. Membrane gives capability denial without a separate engine; the worker gives preemption/OOM containment; a future WASM engine gives linear-memory containment.
**Rules out:** Defense against motivated side-channel (Spectre-class) attackers — that needs the native tier (ADR-002). Stated openly.

### ADR-010 — Cross-origin isolation required · [locked]
**Choice:** Depend on `SharedArrayBuffer` (+ `Atomics`) for the synchronous syscall path; require COOP/COEP headers from embedders.
**Why:** WASI guests expect blocking `fd_read`; a SAB ring buffer with `Atomics.wait` is the standard way to provide block-until-satisfied across workers.
**Rules out:** Deployment on origins that cannot set COOP/COEP. Documented as a platform requirement.

### ADR-011 — In-memory VFS first, persistence behind the same trait · [locked/deferred]
**Choice:** v1 VFS is in-memory (Rust inode tree behind a `Vfs` trait). IndexedDB persistence and COW overlays are later implementations of the same trait.
**Why:** Keeps MVP simple; the trait boundary means persistence adds no call-site churn.
**Deferred:** IndexedDB backend, snapshot/overlay.

### ADR-012 — Custom bash-flavored shell, not bash · [locked]
**Choice:** Implement `wsh`, a small shell supporting the subset real projects use. Not bash-compatible.
**Why:** Real bash is a native ELF binary needing CPU emulation — antithetical to lightweight. ~95% of `package.json` scripts and build invocations need only argv/pipes/redirects/`&&`.
**Rules out:** Complex `.sh` scripts (arrays, `[[ ]]`, param expansion, traps, functions). Documented.

### ADR-013 — Name & packaging · [locked]
**Choice:** Product **WorkerOS**. Crates/packages: `workeros-kernel`, `workeros-web`, `workeros-coreutils` (system binaries), `workeros-programs` (OS programs + the Node-compat runtime; absorbed the former `workeros-node` and `workeros-npm`). GitHub `opentf/workeros`. Apache-2.0.
**Why:** Name is descriptive (boots in a worker, is OS-shaped), on-brand with the `*OS` style, and verified free on npm (`workeros`, `@opentf/workeros`) and GitHub (`opentf/workeros`). "webOS" was rejected — LG trademark + existing OSS edition. The "Worker" halo (Cloudflare Workers) is adjacent but non-colliding; the tagline resolves it.
**Rules out:** —

### ADR-014 — License: Apache-2.0 · [locked]
**Choice:** Apache-2.0 for the core.
**Why:** It's embeddable infrastructure; permissive licensing maximizes adoption, consistent with the "open answer to proprietary WebContainer" positioning.
**Revisit:** A future higher-value layer could be dual-licensed, as with other OpenTF projects — but the core stays Apache-2.0.

### ADR-015 — Ring-buffer transport: Rust reference spec + JS SAB mirror · [revisit]
**Context (the fork):** The synchronous syscall path (ADR-010) is a `SharedArrayBuffer` ring buffer touched by two agents: the JS program worker (which must block in `Atomics.wait` on `fd_read`) and the Rust→wasm kernel worker. Two ways to own the framing: (a) run the ring-buffer index/protocol logic inside the wasm kernel over the SAB as wasm *shared* memory (requires the `atomics` target feature + shared-memory build + `memory.atomic.wait`), or (b) implement the framing as a small, dumb byte-mover on each JS worker end, with the Rust kernel owning only the *semantic* syscall handling.
**Choice (v1):** (b). The ring-buffer framing is specified and unit-tested in Rust (`workeros-kernel::ringbuf`) as the authoritative reference; the browser SAB transport (`workeros-web/src/ringbuffer.js`) is a thin mirror of that exact byte layout. Both ends are dumb byte movers; every *semantic* decision (what a syscall means, VFS/caps/resolution) stays in Rust.
**Why:** Keeps the kernel natively unit-testable now (`cargo test`, Phase 0 exit criterion) without a wasm-threads/shared-memory build; keeps INV-2 intact because the transport carries bytes, it does not make decisions. The two implementations share one wire spec (documented in `ringbuf.rs`) and are cross-checked (native concurrency test + browser round-trip).
**Cost / what it rules out (for now):** Two implementations of the *framing* to keep in sync — mitigated by the shared spec and tests. 
**Revisit when:** we adopt a wasm shared-memory kernel build; at that point option (a) can subsume the JS framing and this ADR should move to `[locked]` on option (a) or be retired.

### ADR-016 — Phase 2 JS tier uses the async control channel, not the SAB sync path · [revisit]
**Context (the fork):** The SAB ring buffer (ADR-010/-015) exists for *synchronous* syscalls — a WASI guest's `fd_read` must block until data arrives. Phase 2 runs **JS** guests, whose stdio does not block: `console.log` / `process.stdout.write` return `void`, and top-level `await` handles asynchrony. So how should a JS guest's syscalls reach the kernel — over the blocking SAB path, or over async `postMessage`?
**Choice:** JS-tier syscalls in Phase 2 travel over the async control channel (`postMessage`) program-worker → kernel-worker → main. The SAB sync path is reserved for the WASI/WASM tier (Phase 4), where blocking is a real requirement. The ring buffer stays built and tested (Phase 0) so it is ready when Phase 4 needs it.
**Why:** Using `Atomics.wait` for a JS guest that never blocks would add cost and complexity for no semantic gain. Routing through the kernel worker still preserves INV-2 (the wasm kernel makes every decision — cap checks, fd classification, VFS writes, exit codes); the program worker remains a dumb CPU. Topology note: the **kernel worker creates the program workers** (nested workers) and holds their handles, so `worker.terminate()` is available for a hard kill (INV-4/ADR-003).
**Rules out (for now):** A JS guest performing a *synchronous* blocking read (e.g. a synchronous `readFileSync` on a pipe that is not yet ready). Not needed by ordinary scripts in Phase 2; when a JS tenant needs it, it uses the same SAB path the WASI tier will.
**Revisit when:** Phase 4 wires the SAB path for WASI; reassess whether the JS tier should share it for uniformity.

### ADR-017 — Phase 3 coreutils are JS guest programs, not kernel builtins or WASI binaries · [revisit]
**Context (the fork):** Phase 3 needs `echo cat ls cp mv rm mkdir pwd env true false`. Three shapes were considered: (a) Rust builtins inside the kernel; (b) JS guest programs run as real processes; (c) Rust compiled to `wasm32-wasi` and run through the WASI host.
**Choice:** (b) — JS guest programs written against the native `sys` syscall ABI, each running in its own program worker as a real, `ps`-visible, killable process (INV-4). (Installed in `/sbin` as system binaries — see ADR-018.)
**Why:**
- (a) is wrong-shaped: a coreutil executing inside the kernel worker is not a separate process (breaks INV-4) and teaches the kernel the names `ls`/`cat`/… (breaks INV-1's small authoritative core). On real systems `/bin/ls` is userland, not the kernel.
- (c) is the right *long-term* form and the project's differentiator, but a real WASI guest's `fd_read` on a pipe must block synchronously — so it forces the WASM program-worker path **plus** the SAB synchronous-syscall path (ADR-010/-016) **plus** the WASI host to all land first. That is essentially all of Phase 4, pulled forward out of the gated order, just to run `echo`.
- The coreutils carry almost no logic: the substance (VFS, glob, path resolution, pipe semantics) is already Rust and native-tested; `echo`/`cat`/`ls` are ~15-line argv→syscall adapters. Writing them in Rust buys negligible test coverage and no correctness; the postMessage syscall hop, not the language, is the cost.
**Consequence:** "kernel Rust / userland JS" is the intended tier split, not an inconsistency. JS coreutils remain the lightweight default even after Phase 4; they coexist with dropped-in `wasm32-wasi` binaries (§5.1 tier table).
**Revisit when:** Phase 4 builds the WASI host — at which point the *marquee* demo is an **unmodified** off-the-shelf binary (`ripgrep`/`jq`), a far stronger proof of the WASI-first thesis than a hand-written `echo.rs`.

### ADR-018 — Coreutils are system binaries in `/sbin`, apart from `/bin` programs · [locked]
**Choice:** The coreutils install in **`/sbin`** (system binaries); OS/user programs like `npm` install in **`/bin`**. The command search path is `PATH=/bin:/sbin` (kernel `DEFAULT_PATH`), so bare names still resolve, and `/bin` wins so a user program can shadow a system one.
**Why:** Separating the OS internals from the general program namespace makes them read as untouchable and keeps `ls /bin` about installed programs, not plumbing. It mirrors the FHS intuition (system vs. general binaries) even though our split is by *ownership*, not by admin-vs-user.
**Future work (not yet enforced):** `/sbin` is currently only a *convention* — nothing physically prevents `rm /sbin/ls`. Real enforcement is a kernel-level **protected-prefix** check in the syscall layer (`unlink`/`rmdir`/`rename`/`write`/`open(create,truncate)` under a protected prefix → `EPERM`), plus a way to mark a VFS subtree read-only/immutable. Deferred; see PLAN Phase 7 (isolation/hardening).

### ADR-019 — One OS-programs package, not one package per program · [locked]
**Choice:** All installable `/bin` programs (`npm`, …) and the Node-compatible guest runtime live in a single package, **`@opentf/workeros-programs`** (with `./node` for the runtime), which absorbed the former `@opentf/workeros-npm` and `@opentf/workeros-node`. A small registry lists programs; the kernel worker installs the whole set at boot. Programs carry a `type` (`js` now, `wasm` later).
**Why:** Avoids a package-per-program sprawl; adding a program is one registry entry. `workeros-coreutils` stays separate as the *system* binaries (ADR-018).
**Future work:** A selectable install manifest (choose which builtins to include) — for now everything installs at boot.

### ADR-020 — Resource limits & fault isolation: the kernel accounts, the host enforces the clock · [locked]
**Context (the fork):** Nothing today bounds a guest. It can fork-bomb through `otf:spawn`, allocate until the tab OOMs, spin a synchronous loop forever (only `terminate()` can stop it), exhaust fds/pipes, or fill the VFS. Two headline use cases — **embedding in a SaaS product** and **running untrusted / AI-generated code** (§2) — make this a *safety* requirement, not a nicety. The design question is ownership: the limits fall into two families. **Accounting limits** (counts of processes, fds, bytes) are pure bookkeeping. **Temporal limits** (wall-clock CPU time, memory high-water) need a clock and the ability to `terminate()` a worker — and the wasm kernel has *neither* (no wall clock, no handle on the workers; the **kernel worker** on the JS side holds those, ADR-016).
**Choice:** Split by capability, mirroring ADR-015's dumb-byte-mover discipline — *Rust decides the numbers, the host supplies the mechanism it alone has*:
- **Kernel-authoritative (Rust, natively tested):** process-count caps (global + per-tree → `EAGAIN`, POSIX `fork` under `RLIMIT_NPROC`), open-fd caps (→ `EMFILE`), and VFS byte + inode quota (→ `ENOSPC`). A `ResourceLimits` policy object is granted at spawn alongside the `CapabilitySet` and **inherited by children** (a child's usage counts against its ancestors' budget); a `ResourceUsage` counter set is updated on every spawn / reap / fd-alloc / VFS write. All enforced at the seams that already exist — `Kernel::spawn` (the single process-creation choke point), the fd allocators, and the VFS write/create paths.
- **Host-enforced (kernel-worker JS watchdog):** wall-clock/idle time and memory high-water. The kernel worker samples each program worker (`performance.measureUserAgentSpecificMemory()`, available under the cross-origin isolation we already require per ADR-010; a liveness heartbeat for time) and on breach runs the **cooperative-then-hard** kill the `Ctrl-C` path already implements (deliver a cooperative signal, grace period, then `worker.terminate()`), records a **kill reason** on the process record, and reaps — closing pipe fds (EOF downstream) and restoring the TTY on the fault path exactly as an ordinary exit does today.
**Why:** The load-bearing DoS guards (fork-bomb, fd-bomb, disk-fill) are precisely the ones expressible as Rust bookkeeping, so they stay in the natively-testable kernel (INV-2, Phase-1 discipline) and cost almost nothing. Only the two limits that *genuinely* need a wall clock and preemption are pushed host-side, where the mechanism actually lives — and even there the host makes no *policy* decision: the kernel owns the numbers and the accounting; the host reports a breach back and asks the kernel to record the kill. Limits are the **quantitative** sibling of the `Membrane`'s **qualitative** capability denial (ADR-009); together they are the "safe sandbox" the AI-agent use case claims. Distinct kill reasons (OOM `137`, CPU-time, fault-crash vs. ordinary exit) give `ps`/`wait`/the shell an honest *why* — the observability half of the story.
**Honest surface (INV-5):** The memory ceiling is a **soft, sampled high-water mark**, not a hard allocator cap — a single synchronous huge allocation can still OOM the tab between samples. Stated openly; a hard cap arrives only with the future `Wasm`/Boa level (ADR-009). Time enforcement is **cooperative-first, not preemptive** time-slicing. Neither defends against an allocator deliberately racing the sampler (same Spectre-class honesty as ADR-009). Quotas are per-session until persistence (ADR-011) gives them a durable home.
**Rules out:** hard per-process memory sandboxing at the `Full`/`Membrane` levels; preemptive fair-share scheduling (the browser schedules workers — we cap *concurrency*, we do not time-slice).
**Revisit when:** the `Wasm` execution level (Boa) lands — a pure-Rust engine in linear memory can enforce a *hard* memory cap and cooperative fuel-based CPU metering inside the kernel, subsuming the host-side memory watchdog and moving that limit back across the ADR-015 line into Rust.
**Status (v1):** the kernel-authoritative accounting caps are **implemented and native-tested** (`workeros-kernel/limits.rs`) with recommended defaults — **128** live procs, **256** open fds/process, **256 MiB** + **100k** inodes of VFS storage — enforced in `Kernel::spawn` (`EAGAIN`), `ProcessCtx::alloc_fd` (`EMFILE`), and `MemVfs::write_at`/`alloc` (`ENOSPC`). Recommended temporal values (**30s** wall-time, **512 MiB** memory) are declared in `limits::WATCHDOG` but the host-side watchdog, the fault-path kill-reason plumbing, and the host-override API are still pending (PLAN Phase 8). Caps are hardcoded for v1; `Kernel::boot_with_limits` is the override seam.
