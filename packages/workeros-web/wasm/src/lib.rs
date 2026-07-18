//! wasm-bindgen bindings for the WorkerOS kernel.
//!
//! This crate is the *only* place the Rust kernel touches the browser. It is a
//! thin translation layer: it forwards to `workeros-kernel` and marshals results
//! across the wasm boundary. No kernel logic lives here (INV-2/ADR-004) — if you
//! find yourself making a resolution, VFS, glob, or capability decision in this
//! file, it belongs in `workeros-kernel` instead.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use workeros_kernel::errno::Errno;
use workeros_kernel::net::{AcceptOutcome, ListenerId};
use workeros_kernel::process::Pid;
use workeros_kernel::resolver::{ModuleGraph, ModuleKind};
use workeros_kernel::shell::{self, AndOrOp, RedirectOp};
use workeros_kernel::syscall::{Fd, PipeEnd, PipeId, RedirectMode};
use workeros_kernel::vfs::OpenOptions;
use workeros_kernel::tty::{Termios, TtyId, TtySignal, Winsize};
use workeros_kernel::{Kernel, ReadResult, SpawnError, StdioPlan, StdioTarget, WriteEffect};

/// A booted kernel handle, held by the kernel worker's JS glue.
#[wasm_bindgen]
pub struct WebKernel {
    inner: Kernel,
}

// --- serializable DTOs handed to / from the JS glue ------------------------

#[derive(Serialize)]
struct ModuleDto {
    path: String,
    source: String,
}

#[derive(Serialize)]
struct GraphDto {
    entry: String,
    kind: &'static str,
    modules: Vec<ModuleDto>,
}

#[derive(Serialize)]
struct SpawnDto {
    pid: Pid,
    interpreter: &'static str,
    graph: GraphDto,
    /// The effective argv (a `#!` shebang may have rewritten the caller's argv).
    /// The host starts the worker with this so `sys.argv` matches what runs.
    argv: Vec<String>,
    /// The granted net-egress capability (ADR-024): the kernel decided; the
    /// host enforces it at the program-worker boundary (strip fetch/WebSocket/…).
    net_egress: bool,
}

/// A partial capability override for `spawn` (ADR-024); absent fields inherit.
#[derive(Deserialize)]
struct CapsDto {
    #[serde(default, rename = "netEgress")]
    net_egress: Option<bool>,
}

/// A partial resource-cap override for `bootWithLimits` (ADR-020); absent fields
/// inherit the recommended defaults. Camel-cased to match the JS boot options.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LimitsDto {
    #[serde(default)]
    max_procs: Option<usize>,
    #[serde(default)]
    max_open_fds: Option<usize>,
    #[serde(default)]
    vfs_max_bytes: Option<u64>,
    #[serde(default)]
    vfs_max_inodes: Option<usize>,
}

#[derive(Serialize)]
struct WriteDto {
    /// "stdout" | "stderr" | "file" | "pipe" — "pipe" may carry a *short*
    /// `nwritten` (bounded buffer, ADR-023); the host parks the remainder.
    target: &'static str,
    nwritten: usize,
}

#[derive(Serialize)]
struct DirEntryDto {
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct StatDto {
    /// "file" | "dir" | "symlink"
    kind: &'static str,
    size: u64,
    /// Timestamps (ms since epoch) + hard-link count.
    mtime: f64,
    ctime: f64,
    btime: f64,
    nlink: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchDto {
    pid: u32,
    watch_id: u32,
    event_type: &'static str,
    filename: String,
}

fn stat_dto(m: &workeros_kernel::vfs::Metadata) -> StatDto {
    StatDto {
        kind: match m.file_type {
            workeros_kernel::vfs::FileType::Dir => "dir",
            workeros_kernel::vfs::FileType::File => "file",
            workeros_kernel::vfs::FileType::Symlink => "symlink",
        },
        size: m.size,
        mtime: m.mtime as f64,
        ctime: m.ctime as f64,
        btime: m.btime as f64,
        nlink: m.nlink,
    }
}

#[derive(Serialize)]
struct SnapDto {
    name: String,
    created: f64,
    chunks: u32,
    auto: bool,
}

#[derive(Serialize)]
struct ProcDto {
    pid: Pid,
    ppid: Pid,
    /// Process-group id (job control, ADR-025).
    pgid: Pid,
    argv: Vec<String>,
    cwd: String,
    state: &'static str,
    exit_code: Option<i32>,
    /// Why the process was killed (watchdog/limit breach, ADR-020); null for an
    /// ordinary exit.
    kill_reason: Option<String>,
    start_time: u64,
}

// Stdio plan received from the shell executor.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum StdioTargetDto {
    Inherit,
    File { path: String, mode: String },
    Pipe { id: u32, end: String },
}

#[derive(Deserialize)]
struct StdioPlanDto {
    stdin: StdioTargetDto,
    stdout: StdioTargetDto,
    stderr: StdioTargetDto,
}

#[derive(Deserialize, Default)]
struct OpenOptsDto {
    #[serde(default)]
    create: bool,
    #[serde(default)]
    truncate: bool,
    #[serde(default)]
    exclusive: bool,
    #[serde(default)]
    directory: bool,
}

// Execution plan handed to the JS shell executor (already glob-expanded).
#[derive(Serialize)]
struct PlanDto {
    statements: Vec<StmtDto>,
}
#[derive(Serialize)]
struct StmtDto {
    background: bool,
    steps: Vec<StepDto>,
}
#[derive(Serialize)]
struct StepDto {
    /// None for the first pipeline; "and"/"or" for subsequent ones.
    op: Option<&'static str>,
    commands: Vec<CmdDto>,
}
#[derive(Serialize)]
struct CmdDto {
    argv: Vec<String>,
    assignments: Vec<(String, String)>,
    redirects: Vec<RedirDto>,
}
#[derive(Serialize)]
struct RedirDto {
    fd: u32,
    /// "read" | "write" | "append"
    op: &'static str,
    target: String,
}

impl From<&ModuleGraph> for GraphDto {
    fn from(g: &ModuleGraph) -> Self {
        GraphDto {
            entry: g.entry.clone(),
            kind: match g.kind {
                ModuleKind::Js => "js",
                ModuleKind::Wasm => "wasm",
            },
            modules: g
                .modules
                .iter()
                .map(|m| ModuleDto {
                    path: m.path.clone(),
                    source: m.source.clone(),
                })
                .collect(),
        }
    }
}

fn termios_to_js(t: Termios) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: bool| {
        js_sys::Reflect::set(&obj, &JsValue::from_str(k), &JsValue::from_bool(v)).unwrap();
    };
    set("canonical", t.canonical);
    set("echo", t.echo);
    set("isig", t.isig);
    obj.into()
}

fn errno_to_js(e: Errno) -> JsError {
    JsError::new(&format!("errno {:?} ({})", e, e.raw()))
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsError::new(&e.to_string()))
}

fn parse_mode(s: &str) -> Result<RedirectMode, JsError> {
    match s {
        "read" => Ok(RedirectMode::Read),
        "write" => Ok(RedirectMode::Write),
        "append" => Ok(RedirectMode::Append),
        other => Err(JsError::new(&format!("bad redirect mode: {other}"))),
    }
}

fn parse_end(s: &str) -> Result<PipeEnd, JsError> {
    match s {
        "read" => Ok(PipeEnd::Read),
        "write" => Ok(PipeEnd::Write),
        other => Err(JsError::new(&format!("bad pipe end: {other}"))),
    }
}

impl StdioTargetDto {
    fn into_kernel(self) -> Result<StdioTarget, JsError> {
        Ok(match self {
            StdioTargetDto::Inherit => StdioTarget::Inherit,
            StdioTargetDto::File { path, mode } => StdioTarget::File {
                path,
                mode: parse_mode(&mode)?,
            },
            StdioTargetDto::Pipe { id, end } => StdioTarget::Pipe {
                id,
                end: parse_end(&end)?,
            },
        })
    }
}

#[wasm_bindgen]
impl WebKernel {
    /// Boot the kernel with the recommended resource caps. The JS glue calls
    /// this once when the kernel worker starts and posts the handshake
    /// (version/abi) back to the main thread.
    #[wasm_bindgen(js_name = boot)]
    pub fn boot() -> WebKernel {
        let (inner, _handshake) = Kernel::boot();
        WebKernel { inner }
    }

    /// Boot with a partial resource-cap override (INV-6, ADR-020). `limits` is a
    /// `{ vfsMaxBytes?, vfsMaxInodes?, maxProcs?, maxOpenFds? }` object; absent
    /// fields inherit the recommended defaults (`limits.rs` `RECOMMENDED`). This
    /// is the host seam for raising the VFS ceiling (a big project tree) or
    /// tightening it for untrusted/AI-agent code, per instance.
    #[wasm_bindgen(js_name = bootWithLimits)]
    pub fn boot_with_limits(limits: JsValue) -> Result<WebKernel, JsError> {
        let base = workeros_kernel::limits::ResourceLimits::default();
        let dto: LimitsDto = if limits.is_undefined() || limits.is_null() {
            LimitsDto::default()
        } else {
            serde_wasm_bindgen::from_value(limits).map_err(|e| JsError::new(&e.to_string()))?
        };
        let merged = workeros_kernel::limits::ResourceLimits {
            max_procs: dto.max_procs.unwrap_or(base.max_procs),
            max_open_fds: dto.max_open_fds.unwrap_or(base.max_open_fds),
            vfs_max_bytes: dto.vfs_max_bytes.unwrap_or(base.vfs_max_bytes),
            vfs_max_inodes: dto.vfs_max_inodes.unwrap_or(base.vfs_max_inodes),
        };
        let (inner, _handshake) = Kernel::boot_with_limits(merged);
        Ok(WebKernel { inner })
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        workeros_kernel::VERSION.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn abi(&self) -> String {
        workeros_kernel::ABI.to_string()
    }

    // --- Persistence (ADR-022) ---------------------------------------------

    /// The VFS mutation counter. The host debounces a persist whenever this
    /// advances past the value it last stored to IndexedDB.
    #[wasm_bindgen(js_name = fsGeneration)]
    pub fn fs_generation(&self) -> f64 {
        self.inner.fs_generation() as f64
    }

    /// Mark a subtree ephemeral (discarded on close) or persistent.
    #[wasm_bindgen]
    pub fn mount(&mut self, prefix: String, ephemeral: bool) {
        self.inner.mount(&prefix, ephemeral);
    }

    // --- Content-addressed persistence (ADR-022) ---------------------------

    /// The durable tree + metadata + file chunk-hash lists, as a manifest blob.
    #[wasm_bindgen]
    pub fn manifest(&self) -> Vec<u8> {
        self.inner.manifest()
    }

    /// Hex hashes of all chunks referenced by durable files.
    #[wasm_bindgen(js_name = referencedChunks)]
    pub fn referenced_chunks(&self) -> Vec<String> {
        self.inner.referenced_chunks()
    }

    /// The bytes of a chunk by hex hash, or `undefined` if absent.
    #[wasm_bindgen(js_name = chunkBytes)]
    pub fn chunk_bytes(&self, hex: String) -> Option<Vec<u8>> {
        self.inner.chunk_bytes(&hex)
    }

    /// Load a chunk's bytes into the store at boot; returns its verified hex hash.
    #[wasm_bindgen(js_name = loadChunk)]
    pub fn load_chunk(&mut self, bytes: Vec<u8>) -> String {
        self.inner.load_chunk(bytes)
    }

    /// Rebuild the durable tree from a manifest at boot (chunks loaded first).
    #[wasm_bindgen(js_name = hydrateManifest)]
    pub fn hydrate_manifest(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.hydrate_manifest(bytes).map_err(errno_to_js)
    }

    // --- Snapshots + mark-sweep GC (ADR-022, Stage 4) ----------------------

    /// Capture a named snapshot of the durable tree (retained until destroyed).
    #[wasm_bindgen(js_name = snapshotCreate)]
    pub fn snapshot_create(&mut self, name: String) -> Result<(), JsError> {
        self.inner.snapshot_create(&name).map_err(errno_to_js)
    }

    /// Push a rolling auto-snapshot (last-10 undo ring); evicts the oldest.
    #[wasm_bindgen(js_name = snapshotAuto)]
    pub fn snapshot_auto(&mut self) {
        self.inner.snapshot_auto()
    }

    /// Destroy a named snapshot, releasing its chunk holds.
    #[wasm_bindgen(js_name = snapshotDestroy)]
    pub fn snapshot_destroy(&mut self, name: String) -> Result<(), JsError> {
        self.inner.snapshot_destroy(&name).map_err(errno_to_js)
    }

    /// Restore the durable tree to a snapshot (named or `auto:<id>`).
    #[wasm_bindgen(js_name = snapshotRestore)]
    pub fn snapshot_restore(&mut self, name: String) -> Result<(), JsError> {
        self.inner.snapshot_restore(&name).map_err(errno_to_js)
    }

    /// Retained snapshots as `[{ name, created, chunks, auto }]`.
    #[wasm_bindgen(js_name = snapshotList)]
    pub fn snapshot_list(&self) -> Result<JsValue, JsError> {
        let dtos: Vec<SnapDto> = self
            .inner
            .snapshot_list()
            .into_iter()
            .map(|(name, created, chunks, auto)| SnapDto {
                name,
                created: created as f64,
                chunks: chunks as u32,
                auto,
            })
            .collect();
        to_js(&dtos)
    }

    /// Hex hashes of every chunk the working tree or a retained snapshot needs —
    /// the host keeps these and sweeps all other stored chunks (GC).
    #[wasm_bindgen(js_name = liveChunks)]
    pub fn live_chunks(&self) -> Vec<String> {
        self.inner.live_chunks()
    }

    /// Serialize retained snapshots for the host to persist across reloads.
    #[wasm_bindgen(js_name = snapshotExport)]
    pub fn snapshot_export(&self) -> Vec<u8> {
        self.inner.snapshot_export()
    }

    /// Re-register persisted snapshots at boot (chunks loaded first).
    #[wasm_bindgen(js_name = snapshotImport)]
    pub fn snapshot_import(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.snapshot_import(bytes).map_err(errno_to_js)
    }

    /// `otf:spawn` — resolve `argv`'s invocation + import graph, register the
    /// process, wire its stdio per `plan`, and return `{ pid, interpreter, graph }`.
    /// `env` is an array of `[key, value]` pairs; `plan` is the stdio wiring (or
    /// null for all-terminal). `start_time` is milliseconds since the epoch.
    /// `caps` is null to inherit the parent's capability set (ADR-024), or a
    /// partial override — `{ netEgress?: bool }` — applied on top of it.
    #[wasm_bindgen]
    pub fn spawn(
        &mut self,
        argv: Vec<String>,
        env: JsValue,
        cwd: String,
        start_time: f64,
        ppid: u32,
        plan: JsValue,
        caps: JsValue,
        pgid: Option<u32>,
        ctty: Option<TtyId>,
    ) -> Result<JsValue, JsError> {
        let env: Vec<(String, String)> = if env.is_undefined() || env.is_null() {
            Vec::new()
        } else {
            serde_wasm_bindgen::from_value(env).map_err(|e| JsError::new(&e.to_string()))?
        };
        let caps = if caps.is_undefined() || caps.is_null() {
            None // inherit from ppid (kernel rule)
        } else {
            let dto: CapsDto =
                serde_wasm_bindgen::from_value(caps).map_err(|e| JsError::new(&e.to_string()))?;
            let mut set = self.inner.child_caps(ppid);
            if let Some(net) = dto.net_egress {
                set.net_egress = net;
            }
            Some(set)
        };
        let plan = if plan.is_undefined() || plan.is_null() {
            StdioPlan::default()
        } else {
            let dto: StdioPlanDto =
                serde_wasm_bindgen::from_value(plan).map_err(|e| JsError::new(&e.to_string()))?;
            StdioPlan {
                stdin: dto.stdin.into_kernel()?,
                stdout: dto.stdout.into_kernel()?,
                stderr: dto.stderr.into_kernel()?,
            }
        };
        let spawned = self
            .inner
            .spawn(argv, env, cwd, start_time as u64, caps, ppid, pgid, ctty, plan)
            .map_err(spawn_err_to_js)?;
        to_js(&SpawnDto {
            pid: spawned.pid,
            interpreter: spawned.interpreter.as_str(),
            graph: GraphDto::from(&spawned.graph),
            argv: spawned.argv,
            net_egress: spawned.net_egress,
        })
    }

    /// Dispatch `fd_write`. Returns `{ target, nwritten }`; on a stdout/stderr
    /// target the host forwards the same bytes it passed in to the main thread.
    #[wasm_bindgen]
    pub fn sys_write(&mut self, pid: Pid, fd: Fd, data: &[u8]) -> Result<JsValue, JsError> {
        let effect = self.inner.sys_write(pid, fd, data).map_err(errno_to_js)?;
        let dto = match effect {
            WriteEffect::Stdout(b) => WriteDto { target: "stdout", nwritten: b.len() },
            WriteEffect::Stderr(b) => WriteDto { target: "stderr", nwritten: b.len() },
            WriteEffect::File { nwritten } => WriteDto { target: "file", nwritten },
            WriteEffect::Pipe { nwritten } => WriteDto { target: "pipe", nwritten },
        };
        to_js(&dto)
    }

    /// Dispatch `fd_read`. Returns `{ status: "data"|"eof"|"again", data? }`.
    /// `data` is a `Uint8Array`. The host parks the request on "again" (a pipe
    /// with a live writer) and retries when the pipe advances.
    #[wasm_bindgen]
    pub fn sys_read(&mut self, pid: Pid, fd: Fd, max: u32) -> Result<JsValue, JsError> {
        let result = self.inner.sys_read(pid, fd, max as usize).map_err(errno_to_js)?;
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(k), v).unwrap();
        };
        match result {
            ReadResult::Data(bytes) => {
                set("status", &JsValue::from_str("data"));
                set("data", &js_sys::Uint8Array::from(&bytes[..]));
            }
            ReadResult::Eof => set("status", &JsValue::from_str("eof")),
            ReadResult::WouldBlock => set("status", &JsValue::from_str("again")),
        }
        Ok(obj.into())
    }

    /// Allocate a fresh controlling terminal (multi-PTY) and return its id. Backs
    /// the host opening another terminal window; free it with `tty_close`.
    #[wasm_bindgen]
    pub fn tty_open(&mut self) -> TtyId {
        self.inner.open_tty()
    }

    /// Release terminal `tty_id` (its window closed). The primary terminal is
    /// permanent. Returns whether a terminal was removed.
    #[wasm_bindgen]
    pub fn tty_close(&mut self, tty_id: TtyId) -> bool {
        self.inner.close_tty(tty_id)
    }

    /// The controlling terminal a process reads/writes (`0` = none).
    #[wasm_bindgen]
    pub fn proc_ctty(&self, pid: Pid) -> TtyId {
        self.inner.proc_ctty(pid)
    }

    /// Feed host keystrokes through terminal `tty_id`'s line discipline. Returns
    /// `{ echo: Uint8Array, signal?: "int"|"susp" }` — the bytes the host writes
    /// back to the terminal display, and any control-key signal to deliver to the
    /// foreground process.
    #[wasm_bindgen]
    pub fn tty_input(&mut self, tty_id: TtyId, data: &[u8]) -> JsValue {
        let out = self.inner.tty_input(tty_id, data);
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(k), v).unwrap();
        };
        set("echo", &js_sys::Uint8Array::from(&out.echo[..]));
        if let Some(sig) = out.signal {
            let name = match sig {
                TtySignal::Int => "int",
                TtySignal::Susp => "susp",
            };
            set("signal", &JsValue::from_str(name));
        }
        obj.into()
    }

    /// Take the next committed input line from terminal `tty_id` for its shell
    /// prompt as a `Uint8Array`, or `null` if no full line is buffered yet.
    #[wasm_bindgen]
    pub fn tty_read_line(&mut self, tty_id: TtyId) -> JsValue {
        match self.inner.tty_read_line(tty_id) {
            Some(line) => js_sys::Uint8Array::from(&line[..]).into(),
            None => JsValue::NULL,
        }
    }

    /// `isatty(fd)` for a process: true when the descriptor is the terminal, not
    /// a redirected file or pipe.
    #[wasm_bindgen]
    pub fn isatty(&self, pid: Pid, fd: Fd) -> Result<bool, JsError> {
        self.inner.isatty(pid, fd).map_err(errno_to_js)
    }

    /// Inject bytes into a process's stdin queue (the programmatic `writeStdin`
    /// API): no line discipline, no echo, delivered to that process's next read.
    #[wasm_bindgen]
    pub fn feed_stdin(&mut self, pid: Pid, data: &[u8]) -> Result<(), JsError> {
        self.inner.feed_stdin(pid, data).map_err(errno_to_js)
    }

    /// `tcgetattr` — terminal `tty_id`'s current line-discipline flags.
    #[wasm_bindgen]
    pub fn tty_get_attr(&self, tty_id: TtyId) -> JsValue {
        termios_to_js(self.inner.tty_get_attr(tty_id))
    }

    /// `tcsetattr` — set terminal `tty_id`'s line-discipline flags (e.g. a program
    /// going raw). Accepts `{ canonical, echo, isig }`; missing keys keep current.
    #[wasm_bindgen]
    pub fn tty_set_attr(&mut self, tty_id: TtyId, attr: JsValue) -> Result<(), JsError> {
        let mut t = self.inner.tty_get_attr(tty_id);
        let get = |k: &str| js_sys::Reflect::get(&attr, &JsValue::from_str(k)).ok();
        if let Some(v) = get("canonical").filter(|v| !v.is_undefined()) {
            t.canonical = v.is_truthy();
        }
        if let Some(v) = get("echo").filter(|v| !v.is_undefined()) {
            t.echo = v.is_truthy();
        }
        if let Some(v) = get("isig").filter(|v| !v.is_undefined()) {
            t.isig = v.is_truthy();
        }
        self.inner.tty_set_attr(tty_id, t);
        Ok(())
    }

    /// `TIOCGWINSZ` — terminal `tty_id`'s window size as `{ rows, cols }`.
    #[wasm_bindgen]
    pub fn tty_get_winsize(&self, tty_id: TtyId) -> JsValue {
        let ws = self.inner.tty_winsize(tty_id);
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &JsValue::from_str("rows"), &JsValue::from_f64(ws.rows as f64)).unwrap();
        js_sys::Reflect::set(&obj, &JsValue::from_str("cols"), &JsValue::from_f64(ws.cols as f64)).unwrap();
        obj.into()
    }

    /// Update terminal `tty_id`'s window size after a host resize. The host then
    /// signals `SIGWINCH` to that terminal's foreground process group.
    #[wasm_bindgen]
    pub fn tty_set_winsize(&mut self, tty_id: TtyId, rows: u16, cols: u16) {
        self.inner.tty_set_winsize(tty_id, Winsize { rows, cols });
    }

    /// Open an IPC pipe (`otf:ipc_open`); returns its id for a stdio plan.
    #[wasm_bindgen]
    pub fn pipe_open(&mut self) -> PipeId {
        self.inner.pipe_open()
    }

    // ---- otf:net_* — port-keyed loopback sockets (ADR-021) ----

    /// Register the host-side network injector's pseudo-process; returns its pid.
    /// The kernel worker calls this once at boot, then drives preview connections
    /// through the ordinary `net_connect`/`sys_write`/`sys_read` path on this pid.
    #[wasm_bindgen]
    pub fn register_host_process(&mut self) -> Pid {
        self.inner.register_host_process()
    }

    /// `otf:net_listen(port)`: claim `port` for `pid`, or a free ephemeral port
    /// when `port == 0`. Returns `{ listener, port }` where `port` is the actually
    /// bound port (for `server.address()`); `EADDRINUSE` if held, `ENOTSUP` if the
    /// process lacks the capability.
    #[wasm_bindgen]
    pub fn net_listen(&mut self, pid: Pid, port: u16) -> Result<JsValue, JsError> {
        let (listener, bound) = self.inner.net_listen(pid, port).map_err(errno_to_js)?;
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &JsValue::from_str("listener"), &JsValue::from_f64(listener as f64)).unwrap();
        js_sys::Reflect::set(&obj, &JsValue::from_str("port"), &JsValue::from_f64(bound as f64)).unwrap();
        Ok(obj.into())
    }

    /// `otf:net_close(listener)`: release a listener `pid` owns, freeing its port at
    /// once (the in-process `server.close()` path, so a probe-then-rebind on the same
    /// port — Vite's dev server — doesn't hit `EADDRINUSE`). No-op for an unknown
    /// handle; `EBADF` if another process owns it.
    #[wasm_bindgen]
    pub fn net_close(&mut self, pid: Pid, listener: ListenerId) -> Result<(), JsError> {
        self.inner.net_close(pid, listener).map_err(errno_to_js)
    }

    /// `otf:net_connect(port)`: loopback-connect `pid` to the listener on `port`,
    /// binding the client connection fds. Returns `{ rfd, wfd }`; `ECONNREFUSED`
    /// if nobody listens. This is the call the host injector drives for a preview
    /// `fetch` — not outbound internet (ADR-021).
    #[wasm_bindgen]
    pub fn net_connect(&mut self, pid: Pid, port: u16) -> Result<JsValue, JsError> {
        let c = self.inner.net_connect(pid, port).map_err(errno_to_js)?;
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &JsValue::from_str("rfd"), &JsValue::from_f64(c.rfd as f64)).unwrap();
        js_sys::Reflect::set(&obj, &JsValue::from_str("wfd"), &JsValue::from_f64(c.wfd as f64)).unwrap();
        Ok(obj.into())
    }

    /// `otf:net_accept(listener)`: bind the next pending connection's server fds.
    /// Returns `{ status: "ready", rfd, wfd }`, or `{ status: "again" }` when the
    /// backlog is empty (the host parks and retries, like a would-block read).
    #[wasm_bindgen]
    pub fn net_accept(&mut self, pid: Pid, listener: ListenerId) -> Result<JsValue, JsError> {
        let outcome = self.inner.net_accept(pid, listener).map_err(errno_to_js)?;
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(k), v).unwrap();
        };
        match outcome {
            AcceptOutcome::Ready(c) => {
                set("status", &JsValue::from_str("ready"));
                set("rfd", &JsValue::from_f64(c.rfd as f64));
                set("wfd", &JsValue::from_f64(c.wfd as f64));
            }
            AcceptOutcome::WouldBlock => set("status", &JsValue::from_str("again")),
        }
        Ok(obj.into())
    }

    // ---- guest file syscalls (coreutils) ----

    #[wasm_bindgen]
    pub fn sys_open(&mut self, pid: Pid, path: String, opts: JsValue) -> Result<Fd, JsError> {
        let dto: OpenOptsDto = if opts.is_undefined() || opts.is_null() {
            OpenOptsDto::default()
        } else {
            serde_wasm_bindgen::from_value(opts).map_err(|e| JsError::new(&e.to_string()))?
        };
        self.inner
            .sys_open(
                pid,
                &path,
                OpenOptions {
                    create: dto.create,
                    truncate: dto.truncate,
                    exclusive: dto.exclusive,
                    directory: dto.directory,
                },
            )
            .map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_close(&mut self, pid: Pid, fd: Fd) -> Result<(), JsError> {
        self.inner.sys_close(pid, fd).map_err(errno_to_js)
    }

    /// `fd_seek`. `offset` is passed as an f64 (JS number); the new absolute
    /// offset is returned the same way. `whence`: 0=set, 1=cur, 2=end.
    #[wasm_bindgen]
    pub fn sys_seek(&mut self, pid: Pid, fd: Fd, offset: f64, whence: u8) -> Result<f64, JsError> {
        let n = self.inner.sys_seek(pid, fd, offset as i64, whence).map_err(errno_to_js)?;
        Ok(n as f64)
    }

    #[wasm_bindgen]
    pub fn sys_readdir(&self, pid: Pid, path: String) -> Result<JsValue, JsError> {
        let entries = self.inner.sys_readdir(pid, &path).map_err(errno_to_js)?;
        let dtos: Vec<DirEntryDto> = entries
            .into_iter()
            .map(|e| DirEntryDto { name: e.name, is_dir: e.is_dir })
            .collect();
        to_js(&dtos)
    }

    #[wasm_bindgen]
    pub fn sys_stat(&self, pid: Pid, path: String) -> Result<JsValue, JsError> {
        let m = self.inner.sys_stat(pid, &path).map_err(errno_to_js)?;
        to_js(&stat_dto(&m))
    }

    #[wasm_bindgen]
    pub fn sys_lstat(&self, pid: Pid, path: String) -> Result<JsValue, JsError> {
        let m = self.inner.sys_lstat(pid, &path).map_err(errno_to_js)?;
        to_js(&stat_dto(&m))
    }

    #[wasm_bindgen]
    pub fn sys_symlink(&mut self, pid: Pid, target: String, link: String) -> Result<(), JsError> {
        self.inner.sys_symlink(pid, &target, &link).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_readlink(&self, pid: Pid, path: String) -> Result<String, JsError> {
        self.inner.sys_readlink(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_link(&mut self, pid: Pid, existing: String, newpath: String) -> Result<(), JsError> {
        self.inner.sys_link(pid, &existing, &newpath).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_realpath(&self, pid: Pid, path: String) -> Result<String, JsError> {
        self.inner.sys_realpath(pid, &path).map_err(errno_to_js)
    }

    /// Stamp the kernel wall clock (ms) before a mutation so mtimes are real.
    #[wasm_bindgen(js_name = setTime)]
    pub fn set_time(&mut self, now_ms: f64) {
        self.inner.set_time(now_ms);
    }

    // --- fs.watch ---------------------------------------------------------

    /// Register a `fs.watch` for `pid` on `path` (recursively or not); returns a
    /// watch id. `ENOENT` if the path is missing or outside the process root.
    #[wasm_bindgen(js_name = watchAdd)]
    pub fn watch_add(&mut self, pid: Pid, path: String, recursive: bool) -> Result<u32, JsError> {
        self.inner.watch_add(pid, &path, recursive).map_err(errno_to_js)
    }

    /// Stop a watch (its `FSWatcher.close()`).
    #[wasm_bindgen(js_name = watchRemove)]
    pub fn watch_remove(&mut self, pid: Pid, id: u32) {
        self.inner.watch_remove(pid, id);
    }

    /// Drop every watch a process held (called when it exits).
    #[wasm_bindgen(js_name = watchClosePid)]
    pub fn watch_close_pid(&mut self, pid: Pid) {
        self.inner.watch_close_pid(pid);
    }

    /// Drain pending watch deliveries as `[{ pid, watchId, eventType, filename }]`.
    #[wasm_bindgen(js_name = drainWatchEvents)]
    pub fn drain_watch_events(&mut self) -> Result<JsValue, JsError> {
        let dtos: Vec<WatchDto> = self
            .inner
            .drain_watch_events()
            .into_iter()
            .map(|d| WatchDto {
                pid: d.pid,
                watch_id: d.watch_id,
                event_type: d.event_type,
                filename: d.filename,
            })
            .collect();
        to_js(&dtos)
    }

    #[wasm_bindgen]
    pub fn sys_mkdir(&mut self, pid: Pid, path: String) -> Result<(), JsError> {
        self.inner.sys_mkdir(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_unlink(&mut self, pid: Pid, path: String) -> Result<(), JsError> {
        self.inner.sys_unlink(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_rmdir(&mut self, pid: Pid, path: String) -> Result<(), JsError> {
        self.inner.sys_rmdir(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_rename(&mut self, pid: Pid, from: String, to: String) -> Result<(), JsError> {
        self.inner.sys_rename(pid, &from, &to).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_utimes(&mut self, pid: Pid, path: String, atime_ms: f64, mtime_ms: f64) -> Result<(), JsError> {
        self.inner
            .sys_utimes(pid, &path, atime_ms as u64, mtime_ms as u64)
            .map_err(errno_to_js)
    }

    // ---- process lifecycle ----

    #[wasm_bindgen]
    pub fn mark_exited(&mut self, pid: Pid, code: i32) -> bool {
        self.inner.mark_exited(pid, code)
    }

    #[wasm_bindgen]
    pub fn kill(&mut self, pid: Pid, signal: i32) -> bool {
        self.inner.kill(pid, signal)
    }

    #[wasm_bindgen]
    pub fn wait(&self, pid: Pid) -> Option<i32> {
        self.inner.wait(pid)
    }

    #[wasm_bindgen]
    pub fn reap(&mut self, pid: Pid) -> Option<i32> {
        self.inner.reap(pid)
    }

    /// `ps` — a snapshot of the process table.
    #[wasm_bindgen]
    pub fn list_processes(&self) -> Result<JsValue, JsError> {
        let dtos: Vec<ProcDto> = self
            .inner
            .list_processes()
            .into_iter()
            .map(|p| ProcDto {
                pid: p.pid,
                ppid: p.ppid,
                pgid: p.pgid,
                argv: p.argv,
                cwd: p.cwd,
                state: p.state,
                exit_code: p.exit_code,
                kill_reason: p.kill_reason,
                start_time: p.start_time,
            })
            .collect();
        to_js(&dtos)
    }

    /// A watchdog/limit kill (INV-6, ADR-020): record the reason on the process
    /// record, then mark it exited; the host follows with `worker.terminate()`.
    #[wasm_bindgen]
    pub fn mark_killed(&mut self, pid: Pid, code: i32, reason: &str) -> bool {
        self.inner.mark_killed(pid, code, reason)
    }

    /// `tcsetpgrp`: set terminal `tty_id`'s foreground process group (0 = the shell).
    #[wasm_bindgen]
    pub fn tty_set_foreground(&mut self, tty_id: TtyId, pgid: Pid) {
        self.inner.tty_set_foreground(tty_id, pgid)
    }

    /// `tcgetpgrp`: terminal `tty_id`'s foreground process group (0 = none).
    #[wasm_bindgen]
    pub fn tty_get_foreground(&self, tty_id: TtyId) -> Pid {
        self.inner.tty_foreground(tty_id)
    }

    /// Live members of a process group — the delivery set for a group signal.
    #[wasm_bindgen]
    pub fn pgrp_members(&self, pgid: Pid) -> Vec<Pid> {
        self.inner.pgrp_members(pgid)
    }

    /// The process group `pid` belongs to (0 if unknown).
    #[wasm_bindgen]
    pub fn proc_pgid(&self, pid: Pid) -> Pid {
        self.inner.proc_pgid(pid)
    }

    // ---- client fs ----

    #[wasm_bindgen]
    pub fn fs_write(&mut self, path: String, data: &[u8]) -> Result<(), JsError> {
        self.inner.fs_write(&path, data).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn fs_read(&self, path: String) -> Result<Vec<u8>, JsError> {
        self.inner.fs_read(&path).map_err(errno_to_js)
    }

    // ---- shell (wsh) ----

    /// Resolve a `cd` target against `cwd`; returns the normalized directory or
    /// errors if it does not exist / is not a directory.
    #[wasm_bindgen]
    pub fn resolve_dir(&self, cwd: String, target: String) -> Result<String, JsError> {
        self.inner.resolve_dir(&cwd, &target).map_err(errno_to_js)
    }

    /// Parse + glob-expand a command line into an execution plan for the JS
    /// shell executor. Parsing and globbing stay kernel-authoritative (INV-2);
    /// the executor only drives async worker lifecycles over this plan.
    #[wasm_bindgen]
    pub fn shell_plan(&self, line: String, cwd: String) -> Result<JsValue, JsError> {
        let script = self
            .inner
            .shell_parse(&line)
            .map_err(|e| JsError::new(&format!("parse error: {e:?}")))?;
        let statements = script
            .statements
            .iter()
            .map(|st| StmtDto {
                background: st.background,
                steps: self.and_or_steps(&st.list, &cwd),
            })
            .collect();
        to_js(&PlanDto { statements })
    }

    /// Parse a whole script into the rich (bash-subset) AST the JS interpreter
    /// walks, returned as a JSON string (the kernel is dependency-free, so it
    /// serializes itself; JS does `JSON.parse`). Grammar stays kernel-owned and
    /// native-tested (ADR-012); the host only drives async execution over it.
    #[wasm_bindgen]
    pub fn shell_parse(&self, src: String) -> Result<String, JsError> {
        shell::parse_script(&src)
            .map(|ast| ast.to_json())
            .map_err(|e| JsError::new(&e.0))
    }
}

impl WebKernel {
    fn and_or_steps(&self, list: &shell::AndOr, cwd: &str) -> Vec<StepDto> {
        let mut steps = vec![StepDto {
            op: None,
            commands: self.pipeline_cmds(&list.first, cwd),
        }];
        for (op, pipeline) in &list.rest {
            steps.push(StepDto {
                op: Some(match op {
                    AndOrOp::And => "and",
                    AndOrOp::Or => "or",
                }),
                commands: self.pipeline_cmds(pipeline, cwd),
            });
        }
        steps
    }

    fn pipeline_cmds(&self, pipeline: &shell::Pipeline, cwd: &str) -> Vec<CmdDto> {
        pipeline
            .commands
            .iter()
            .map(|c| CmdDto {
                argv: c
                    .argv
                    .iter()
                    .flat_map(|w| self.expand_word(cwd, w))
                    .collect(),
                assignments: c
                    .assignments
                    .iter()
                    .map(|a| (a.name.clone(), a.value.clone()))
                    .collect(),
                redirects: c
                    .redirects
                    .iter()
                    .map(|r| RedirDto {
                        fd: r.fd,
                        op: match r.op {
                            RedirectOp::Read => "read",
                            RedirectOp::Write => "write",
                            RedirectOp::Append => "append",
                        },
                        // A redirect target takes the first glob match (or the literal).
                        target: self
                            .expand_word(cwd, &r.target)
                            .into_iter()
                            .next()
                            .unwrap_or_else(|| r.target.text.clone()),
                    })
                    .collect(),
            })
            .collect()
    }

    fn expand_word(&self, cwd: &str, word: &shell::Word) -> Vec<String> {
        if word.globbable {
            self.inner.glob(cwd, &word.text)
        } else {
            vec![word.text.clone()]
        }
    }
}

fn spawn_err_to_js(e: SpawnError) -> JsError {
    match e {
        SpawnError::NoEntry => JsError::new("spawn: argv names no runnable entry"),
        SpawnError::Resolve(re) => JsError::new(&format!("spawn: {re:?}")),
        // EAGAIN (6): the process-count cap is exhausted (ADR-020).
        SpawnError::LimitExceeded => {
            JsError::new("spawn: resource limit reached (errno EAGAIN (6))")
        }
    }
}
