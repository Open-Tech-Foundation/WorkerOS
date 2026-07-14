//! # workeros-kernel
//!
//! The Node-agnostic core of WorkerOS. This crate owns the authoritative state
//! of the system — the VFS, the process table, module resolution, scheduling,
//! and capability granting — and the WASI-shaped syscall dispatch that sits on
//! top of them (see `ARCHITECTURE.md` §4–§7, INV-2/ADR-004).
//!
//! It is deliberately free of every Node.js concept — module resolution by
//! package folder, the legacy module loader, HTTP framework globals, and so on.
//! Those all live in the guest-side node layer (`workeros-programs/node`) (INV-1 / ADR-007), and
//! CI grep-gates this crate against the forbidden identifiers to keep it that way.
//!
//! Everything here is pure Rust with no browser dependency, so the kernel is
//! unit-tested natively with `cargo test`. The browser bindings live in the
//! separate `workeros-web` crate; the browser is for integration, not for
//! unit-testing pure logic.

pub mod caps;
pub mod errno;
pub mod hash;
pub mod limits;
pub mod net;
pub mod process;
pub mod resolver;
pub mod ringbuf;
pub mod shell;
pub mod syscall;
pub mod tty;
pub mod vfs;

use caps::CapabilitySet;
use errno::{Errno, SysResult};
use limits::ResourceLimits;
use net::{AcceptOutcome, Connection, ListenerId, PortTable};
use process::{Pid, ProcState, SpawnRequest};
use resolver::{Interpreter, ModuleGraph, ResolveError, DEFAULT_PATH};
use std::collections::BTreeMap;
use syscall::{
    Fd, PipeEnd, PipeId, PipeTable, ProcessCtx, ReadOutcome, RedirectMode, WriteOutcome,
    FD_STDERR, FD_STDOUT,
};
use tty::{Termios, Tty, TtyId, TtyInput, TtyRead, Winsize, NO_TTY};
use vfs::{path, DirEntry, Metadata, OpenOptions, Vfs};

/// The ABI version the kernel speaks: WASI Preview 1 (the floor) plus the
/// three-call `otf:*` kernel ABI (the ceiling, ADR-005/ADR-006).
pub const ABI: &str = "wasi-preview-1+otf-1";

/// The kernel's semantic version. Sourced from the crate version so the build
/// is the single source of truth.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The primary controlling terminal, present from boot. The initial interactive
/// shell and any process that inherits the boot session read/write through it;
/// additional terminals are allocated with [`Kernel::open_tty`].
pub const PRIMARY_TTY: TtyId = 1;

/// The handshake the kernel returns to the main thread on `boot()`. It is the
/// Phase 0 proof-of-life: main → kernel → main round-trip (see `PLAN.md`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    /// Kernel version string.
    pub version: &'static str,
    /// ABI identifier the kernel implements.
    pub abi: &'static str,
}

/// The effect of an `fd_write` the host must carry out. The kernel classifies
/// the descriptor and checks capabilities; the host performs the transport
/// (forwarding stream bytes to the main thread). This keeps every *decision* in
/// the kernel (INV-2) while the host stays a dumb byte mover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteEffect {
    /// Forward these bytes to the main-thread stdout stream.
    Stdout(Vec<u8>),
    /// Forward these bytes to the main-thread stderr stream.
    Stderr(Vec<u8>),
    /// Bytes were written to a file in the VFS; nothing to forward.
    File { nwritten: usize },
    /// Bytes were accepted by a pipe — `nwritten` may be *less* than offered
    /// (the pipe buffer is bounded, ADR-023). The host must park the remainder
    /// and retry as the reader drains; a guest never sees a short pipe write.
    Pipe { nwritten: usize },
}

/// A successful spawn: the new pid, the interpreter to run under, the resolved
/// module graph the host hands to the program worker, and the effective argv (a
/// `#!` shebang may have rewritten it — the host must start the worker with this,
/// not the caller's argv, so `sys.argv` inside matches what actually runs).
#[derive(Debug, Clone)]
pub struct Spawned {
    pub pid: Pid,
    pub interpreter: Interpreter,
    pub graph: ModuleGraph,
    pub argv: Vec<String>,
    /// The granted [`CapabilitySet::net_egress`] bit, echoed so the host can
    /// enforce it at the program-worker boundary without a second lookup
    /// (ADR-024). The kernel decided; the host is the mechanism.
    pub net_egress: bool,
}

/// Why a spawn failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    /// `argv` named no runnable entry.
    NoEntry,
    /// The entry or one of its imports could not be resolved.
    Resolve(ResolveError),
    /// The process-count cap ([`ResourceLimits::max_procs`]) is exhausted; the
    /// guest ABI equivalent is `EAGAIN` (POSIX `fork` under `RLIMIT_NPROC`,
    /// ADR-020).
    LimitExceeded,
}

/// Where one of a process's stdio descriptors is connected at spawn time.
#[derive(Debug, Clone)]
pub enum StdioTarget {
    /// The terminal: stdout/stderr stream to the host; stdin reads host input.
    Inherit,
    /// A file in the VFS opened with the given mode.
    File { path: String, mode: RedirectMode },
    /// One end of an existing IPC pipe (shell pipelines).
    Pipe { id: PipeId, end: PipeEnd },
}

/// The stdio wiring for a spawned process (fd 0/1/2). Defaults to the terminal.
#[derive(Debug, Clone)]
pub struct StdioPlan {
    pub stdin: StdioTarget,
    pub stdout: StdioTarget,
    pub stderr: StdioTarget,
}

impl Default for StdioPlan {
    fn default() -> Self {
        StdioPlan {
            stdin: StdioTarget::Inherit,
            stdout: StdioTarget::Inherit,
            stderr: StdioTarget::Inherit,
        }
    }
}

/// The result of a `sys_read`, distinguishing "retry later" from end-of-file so
/// the host can park a pipe read until a writer produces data or closes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadResult {
    /// Bytes read (non-empty).
    Data(Vec<u8>),
    /// End of file/stream: no more data will come.
    Eof,
    /// No data available yet, but a writer is still open; retry later.
    WouldBlock,
}

/// A read-only snapshot of a process-table entry for `ps`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: Pid,
    pub ppid: Pid,
    /// Process-group id (job control, ADR-025).
    pub pgid: Pid,
    pub argv: Vec<String>,
    pub cwd: String,
    pub state: &'static str,
    pub exit_code: Option<i32>,
    /// Why the process was killed (watchdog/limit breach) — `None` for an
    /// ordinary exit (INV-6, ADR-020).
    pub kill_reason: Option<String>,
    pub start_time: u64,
}

/// The kernel instance and the authoritative owner of system state: the VFS, the
/// process table, and each live process's syscall context (INV-2/ADR-004). The
/// host workers are dumb executors that call in here for every decision.
#[derive(Debug, Default)]
pub struct Kernel {
    /// The single-source-of-truth virtual filesystem.
    pub vfs: vfs::MemVfs,
    /// The process table.
    pub processes: process::ProcessTable,
    /// Per-process syscall context (fd table, stdio, caps), keyed by pid.
    contexts: BTreeMap<Pid, ProcessCtx>,
    /// Kernel-owned IPC pipes backing `otf:ipc_open` and shell pipelines.
    pipes: PipeTable,
    /// Port-keyed loopback sockets backing `otf:net_*` — a "server" registers a
    /// port here; a connection is a pipe pair the injector/clients drive (ADR-021).
    ports: PortTable,
    /// The controlling-terminal table (ADR-025+): several independent terminal
    /// sessions can coexist (e.g. one per desktop window), each with its own line
    /// discipline, termios, winsize, and foreground process group. A process reads
    /// terminal stdin from the terminal named by its `ctty` (see [`ProcessCtx`]).
    /// The primary terminal ([`PRIMARY_TTY`]) exists from boot.
    ttys: BTreeMap<TtyId, Tty>,
    /// Monotonic allocator for [`open_tty`](Kernel::open_tty). Starts past
    /// [`PRIMARY_TTY`]; ids are never reused within a boot.
    next_tty_id: TtyId,
    /// The resource caps this instance enforces (INV-6, ADR-020). Hardcoded to
    /// [`ResourceLimits::default`] in v1; a host-override API is post-v1.
    limits: ResourceLimits,
    /// Path-based durability policy (ADR-022): which subtrees the host persists
    /// vs. discards on close. Drives [`Kernel::manifest`].
    mounts: vfs::mount::MountTable,
    /// Active `fs.watch` registrations (per-process). The kernel matches VFS
    /// change events against these and hands the host per-watch deliveries.
    watches: Vec<Watch>,
    /// Monotonic id for the next watch registration.
    next_watch_id: u32,
}

/// One `fs.watch` registration: a process watching a path (recursively or not).
#[derive(Debug)]
struct Watch {
    id: u32,
    pid: Pid,
    /// Absolute, confined path being watched (a file or directory).
    path: String,
    recursive: bool,
}

/// A change event routed to a specific watcher (what the host delivers to the
/// owning process worker so its `fs.watch` listener fires).
pub struct WatchDelivery {
    pub pid: Pid,
    pub watch_id: u32,
    /// `"rename"` (create/delete/move) or `"change"` (content) — Node's two types.
    pub event_type: &'static str,
    /// The affected entry's name relative to the watched path (Node's `filename`).
    pub filename: String,
}

/// Does a change at `changed` fall under a watch on `watched`? Returns the
/// `filename` the watcher should see (relative to the watched path), or `None`.
fn watch_match(watched: &str, recursive: bool, changed: &str) -> Option<String> {
    if changed == watched {
        // The watched path itself changed → Node reports its basename.
        return Some(basename(watched));
    }
    let prefix = if watched == "/" { "/".to_string() } else { format!("{watched}/") };
    let rel = changed.strip_prefix(&prefix)?;
    // A non-recursive watch only sees direct children (no further separator).
    if recursive || !rel.contains('/') {
        Some(rel.to_string())
    } else {
        None
    }
}

fn basename(p: &str) -> String {
    match p.rsplit_once('/') {
        Some((_, name)) if !name.is_empty() => name.to_string(),
        _ => p.to_string(),
    }
}

impl Kernel {
    /// Boot the kernel (recommended resource caps) and produce the version
    /// handshake.
    pub fn boot() -> (Self, Handshake) {
        Self::boot_with_limits(ResourceLimits::default())
    }

    /// Boot with explicit resource caps (INV-6, ADR-020). `boot()` uses the
    /// recommended defaults; this is the seam the post-v1 host-override API will
    /// call to raise or lower the caps per instance.
    pub fn boot_with_limits(limits: ResourceLimits) -> (Self, Handshake) {
        (
            Kernel {
                vfs: vfs::MemVfs::with_limits(limits.vfs_max_bytes, limits.vfs_max_inodes),
                processes: process::ProcessTable::new(),
                contexts: BTreeMap::new(),
                pipes: PipeTable::new(),
                ports: PortTable::new(),
                ttys: BTreeMap::from([(PRIMARY_TTY, Tty::new())]),
                next_tty_id: PRIMARY_TTY + 1,
                limits,
                mounts: vfs::mount::MountTable::default(),
                watches: Vec::new(),
                next_watch_id: 1,
            },
            Handshake {
                version: VERSION,
                abi: ABI,
            },
        )
    }

    // --- Persistence (ADR-022) ---------------------------------------------

    /// The VFS mutation counter. The host re-persists whenever this advances
    /// past the value it last stored (idle → no I/O).
    pub fn fs_generation(&self) -> u64 {
        self.vfs.generation()
    }

    /// Mark a subtree ephemeral (discarded on close) or persistent. Lets an
    /// embedder adjust the durability policy beyond the built-in defaults
    /// (`/tmp` + OS trees ephemeral, everything else persistent).
    pub fn mount(&mut self, prefix: &str, ephemeral: bool) {
        let d = if ephemeral {
            vfs::mount::Durability::Ephemeral
        } else {
            vfs::mount::Durability::Persist
        };
        self.mounts.mount(prefix, d);
    }

    // --- Content-addressed persistence (ADR-022) ---------------------------

    /// The durable directory tree + metadata + file chunk-hash lists, serialized
    /// as a manifest for the host to store as the persistence root.
    pub fn manifest(&self) -> Vec<u8> {
        self.vfs.manifest(&self.mounts)
    }

    /// Hex hashes of all chunks referenced by durable files — the host ensures
    /// these are stored and treats any other stored chunk as garbage (GC).
    pub fn referenced_chunks(&self) -> Vec<String> {
        self.vfs.referenced_chunks(&self.mounts)
    }

    /// The bytes of a chunk by hex hash (the host persists the ones it lacks).
    pub fn chunk_bytes(&self, hex: &str) -> Option<Vec<u8>> {
        self.vfs.chunk_bytes_hex(hex)
    }

    /// Load a chunk's bytes into the store at boot; returns its verified hex
    /// hash so the host can detect a corrupt/misfiled block.
    pub fn load_chunk(&mut self, bytes: Vec<u8>) -> String {
        self.vfs.load_chunk(bytes)
    }

    /// Rebuild the durable tree from a manifest at boot (chunks must be loaded
    /// first via [`load_chunk`](Self::load_chunk)). `EINVAL` on a corrupt blob.
    pub fn hydrate_manifest(&mut self, bytes: &[u8]) -> SysResult<()> {
        self.vfs.hydrate_manifest(bytes)
    }

    // --- Snapshots + mark-sweep GC (ADR-022, Stage 4) ----------------------

    /// Capture a named snapshot of the durable tree, retained until destroyed.
    pub fn snapshot_create(&mut self, name: &str) -> SysResult<()> {
        self.vfs.snap_create(name, &self.mounts)
    }

    /// Push a rolling auto-snapshot (last-10 undo ring); evicts the oldest.
    pub fn snapshot_auto(&mut self) {
        self.vfs.snap_auto(&self.mounts)
    }

    /// Destroy a named snapshot, releasing its chunk holds. `ENOENT` if unknown.
    pub fn snapshot_destroy(&mut self, name: &str) -> SysResult<()> {
        self.vfs.snap_destroy(name)
    }

    /// Restore the durable tree to a snapshot (named or `auto:<id>`). `ENOENT`
    /// if unknown; the snapshot is retained.
    pub fn snapshot_restore(&mut self, name: &str) -> SysResult<()> {
        self.vfs.snap_restore(name, &self.mounts)
    }

    /// Retained snapshots as `(name, created_ms, chunk_count, is_auto)` rows.
    pub fn snapshot_list(&self) -> Vec<(String, u64, usize, bool)> {
        self.vfs
            .snap_list()
            .into_iter()
            .map(|s| (s.name, s.created, s.chunks, s.auto))
            .collect()
    }

    /// Hex hashes of every chunk the working tree **or** a retained snapshot
    /// needs — the host keeps these and sweeps all other stored chunks (GC).
    pub fn live_chunks(&self) -> Vec<String> {
        self.vfs.live_chunks(&self.mounts)
    }

    /// Serialize retained snapshots for the host to persist across reloads.
    pub fn snapshot_export(&self) -> Vec<u8> {
        self.vfs.snap_export()
    }

    /// Re-register persisted snapshots at boot (chunks must be loaded first).
    /// `EINVAL` on a corrupt blob.
    pub fn snapshot_import(&mut self, bytes: &[u8]) -> SysResult<()> {
        self.vfs.snap_import(bytes)
    }

    /// Resolve an invocation (interpreter + entry + import graph), register a
    /// process, create its syscall context, and wire its stdio per `plan`. Does
    /// **not** start a worker — that is the host's job (`otf:spawn`), which uses
    /// the returned graph. INV-2: all resolution, stdio binding, and
    /// process-table state is decided here.
    #[allow(clippy::too_many_arguments)] // a process is defined by exactly these inputs
    pub fn spawn(
        &mut self,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        start_time: u64,
        caps: Option<CapabilitySet>,
        ppid: Pid,
        pgid: Option<Pid>,
        ctty: Option<TtyId>,
        plan: StdioPlan,
    ) -> Result<Spawned, SpawnError> {
        // Fork-bomb guard (INV-6/ADR-020): refuse once the live-process cap is
        // reached, before doing any resolution work. `EAGAIN`-shaped, like POSIX
        // `fork` under `RLIMIT_NPROC`.
        if self.processes.live_count() >= self.limits.max_procs {
            return Err(SpawnError::LimitExceeded);
        }
        // Capabilities are inherited like POSIX credentials (ADR-024): `None`
        // means "the parent's set" (a denied-network guest cannot shell out to
        // regain it); an explicit set is host policy at the trust boundary. An
        // unknown/host ppid inherits the ordinary-program default.
        let caps = caps.unwrap_or_else(|| self.child_caps(ppid));
        // Process-group placement (POSIX setpgid shape, ADR-025): `None`
        // inherits the parent's group (or becomes a leader when the parent is
        // unknown); `Some(0)` becomes a leader of a new group (the pipeline
        // head); `Some(p)` joins group `p` (the rest of the pipeline).
        let pgid = match pgid {
            None => self.processes.get(ppid).map(|p| p.pgid).unwrap_or(0),
            Some(g) => g,
        };
        // Controlling terminal (multi-PTY): `None` inherits the parent's ctty (a
        // child of an interactive shell shares its terminal); `Some(id)` attaches
        // the process to terminal `id` (the host starting a shell on a new window).
        // An unknown/host parent with no ctty yields `NO_TTY`.
        let ctty = match ctty {
            None => self.contexts.get(&ppid).map(|c| c.ctty).unwrap_or(NO_TTY),
            Some(id) => id,
        };
        let inv = resolver::resolve_invocation(&self.vfs, &cwd, &argv, &env, DEFAULT_PATH)
            .map_err(SpawnError::Resolve)?;
        let graph = resolver::resolve_graph(&self.vfs, &inv.entry).map_err(SpawnError::Resolve)?;
        // A `#!` shebang rewrites argv (the interpreter + the script slide in); use
        // the invocation's argv so the process — and `sys.argv` inside it — reflect it.
        let argv = inv.argv;
        let pid = self.processes.create(SpawnRequest {
            ppid,
            pgid,
            argv: argv.clone(),
            env: env.clone(),
            cwd: cwd.clone(),
            start_time,
            caps: caps.clone(),
        });
        let mut ctx =
            ProcessCtx::new(pid, argv.clone(), env, cwd, caps, ctty, self.limits.max_open_fds);
        // Apply the stdio plan (redirects / pipe ends). A binding failure (e.g. a
        // missing input file) fails the spawn cleanly.
        if let Err(e) = Self::apply_stdio(&mut ctx, &mut self.vfs, &mut self.pipes, &plan) {
            self.processes.remove(pid);
            return Err(SpawnError::Resolve(ResolveError::Io(e)));
        }
        let net_egress = ctx.caps.net_egress;
        self.contexts.insert(pid, ctx);
        Ok(Spawned {
            pid,
            interpreter: inv.interpreter,
            graph,
            argv,
            net_egress,
        })
    }

    /// The capability set a child of `ppid` inherits when the spawn names none
    /// (ADR-024): the parent's live set, or the ordinary-program default when
    /// the parent is unknown (a host/client spawn).
    pub fn child_caps(&self, ppid: Pid) -> CapabilitySet {
        self.contexts
            .get(&ppid)
            .map(|c| c.caps.clone())
            .unwrap_or_default()
    }

    fn apply_stdio(
        ctx: &mut ProcessCtx,
        vfs: &mut vfs::MemVfs,
        pipes: &mut PipeTable,
        plan: &StdioPlan,
    ) -> SysResult<()> {
        for (fd, target) in [
            (0u32, &plan.stdin),
            (FD_STDOUT, &plan.stdout),
            (FD_STDERR, &plan.stderr),
        ] {
            match target {
                StdioTarget::Inherit => {}
                StdioTarget::File { path, mode } => {
                    ctx.bind_stdio_file(vfs, fd, path, *mode)?;
                }
                StdioTarget::Pipe { id, end } => {
                    ctx.bind_stdio_pipe(pipes, fd, *id, *end);
                }
            }
        }
        Ok(())
    }

    /// Open a fresh IPC pipe (`otf:ipc_open`); the returned id is referenced by a
    /// [`StdioPlan`] to wire two processes together.
    pub fn pipe_open(&mut self) -> PipeId {
        self.pipes.open()
    }

    /// Dispatch an `fd_write` for a process and return the host effect. A write
    /// whose target is a terminal stream yields `Stdout`/`Stderr`; a write to a
    /// file or pipe yields `File { nwritten }` (nothing to forward).
    pub fn sys_write(&mut self, pid: Pid, fd: Fd, data: &[u8]) -> SysResult<WriteEffect> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        let outcome = ctx.fd_write(&mut self.vfs, &mut self.pipes, fd, data)?;
        // A pipe write is reported as such: it is the one case that can be short
        // (bounded buffer, ADR-023) and the host parks the remainder.
        if let WriteOutcome::Pipe(nwritten) = outcome {
            return Ok(WriteEffect::Pipe { nwritten });
        }
        let WriteOutcome::Wrote(n) = outcome else { unreachable!() };
        // Only an un-redirected terminal fd streams to the host: those keep bytes
        // in the ctx stdout/stderr buffers. A redirected fd 1/2 (file/pipe) leaves
        // them empty, so classify by whether the buffer actually grew.
        Ok(if fd == FD_STDOUT && !ctx.stdout.is_empty() {
            WriteEffect::Stdout(std::mem::take(&mut ctx.stdout))
        } else if fd == FD_STDERR && !ctx.stderr.is_empty() {
            WriteEffect::Stderr(std::mem::take(&mut ctx.stderr))
        } else {
            WriteEffect::File { nwritten: n }
        })
    }

    /// Dispatch an `fd_read` for a process (files, stdin, and pipes). Returns a
    /// [`ReadResult`] so the host can park a pipe read that would block.
    pub fn sys_read(&mut self, pid: Pid, fd: Fd, max: usize) -> SysResult<ReadResult> {
        // Terminal stdin is served by the shared TTY (line discipline + blocking):
        // whoever holds the terminal reads keystrokes. Bytes injected at a specific
        // process via `feed_stdin` (the programmatic `writeStdin` API) take
        // precedence over the interactive TTY for that process.
        {
            let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
            if ctx.is_terminal_stdin(fd)? {
                if !ctx.stdin.is_empty() {
                    let n = max.min(ctx.stdin.len());
                    return Ok(ReadResult::Data(ctx.stdin.drain(..n).collect()));
                }
                // Route to the process's controlling terminal. A process with no
                // ctty (a closed session, or a context-only kernel process) sees a
                // terminal stdin as an immediate EOF, like reading a hung-up tty.
                let ctty = ctx.ctty;
                return Ok(match self.ttys.get_mut(&ctty) {
                    Some(tty) => match tty.read(max) {
                        TtyRead::Data(bytes) => ReadResult::Data(bytes),
                        TtyRead::Eof => ReadResult::Eof,
                        TtyRead::WouldBlock => ReadResult::WouldBlock,
                    },
                    None => ReadResult::Eof,
                });
            }
        }
        let mut buf = vec![0u8; max];
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        Ok(match ctx.fd_read(&self.vfs, &mut self.pipes, fd, &mut buf)? {
            ReadOutcome::Data(0) => ReadResult::Eof,
            ReadOutcome::Data(n) => {
                buf.truncate(n);
                ReadResult::Data(buf)
            }
            ReadOutcome::Eof => ReadResult::Eof,
            ReadOutcome::WouldBlock => ReadResult::WouldBlock,
        })
    }

    /// Allocate a fresh controlling terminal and return its id. Backs the host's
    /// "open another terminal window" — each gets a private line discipline,
    /// termios, winsize, and foreground process group. Free it with
    /// [`close_tty`](Kernel::close_tty) when the window closes.
    pub fn open_tty(&mut self) -> TtyId {
        let id = self.next_tty_id;
        self.next_tty_id += 1;
        self.ttys.insert(id, Tty::new());
        id
    }

    /// Release a terminal (its window closed). The primary terminal is permanent
    /// and never removed. Processes still holding it as their ctty then read EOF on
    /// terminal stdin (a hung-up tty). Returns whether a terminal was removed.
    pub fn close_tty(&mut self, id: TtyId) -> bool {
        if id == PRIMARY_TTY {
            return false;
        }
        self.ttys.remove(&id).is_some()
    }

    /// Feed host keystrokes through terminal `id`'s line discipline. Returns the
    /// [`TtyInput`] the host acts on: bytes to echo to the display and any
    /// control-key signal (Ctrl-C/Ctrl-Z) to deliver to the foreground process.
    /// This is the interactive input path for a controlling terminal (both the
    /// prompt and a program's blocking `read` draw from it). Unknown id → no-op.
    pub fn tty_input(&mut self, id: TtyId, data: &[u8]) -> TtyInput {
        match self.ttys.get_mut(&id) {
            Some(tty) => tty.input(data),
            None => TtyInput::default(),
        }
    }

    /// Inject bytes directly into a specific process's stdin queue (the
    /// programmatic `writeStdin` API — no line discipline, no echo). Read ahead of
    /// the interactive TTY by that process's terminal-stdin reads.
    pub fn feed_stdin(&mut self, pid: Pid, data: &[u8]) -> SysResult<()> {
        self.contexts.get_mut(&pid).ok_or(Errno::Badf)?.stdin.extend(data.iter().copied());
        Ok(())
    }

    /// Take the next committed input line from terminal `id` for its interactive
    /// shell prompt, or `None` if no full line is buffered (or the id is unknown).
    /// The shell is the terminal's default reader when no foreground program is
    /// consuming stdin.
    pub fn tty_read_line(&mut self, id: TtyId) -> Option<Vec<u8>> {
        self.ttys.get_mut(&id)?.read_line()
    }

    /// `isatty(fd)` for a process: whether the descriptor is the terminal rather
    /// than a redirected file or pipe.
    pub fn isatty(&self, pid: Pid, fd: Fd) -> SysResult<bool> {
        Ok(self.contexts.get(&pid).ok_or(Errno::Badf)?.is_terminal(fd))
    }

    /// The controlling terminal a process reads/writes (`0` = none). Children
    /// inherit it at spawn; the host uses it to route a program's tty operations
    /// (termios/winsize) to the right terminal.
    pub fn proc_ctty(&self, pid: Pid) -> TtyId {
        self.contexts.get(&pid).map(|c| c.ctty).unwrap_or(NO_TTY)
    }

    /// Current attributes of terminal `id` (`tcgetattr`). Defaults for an unknown id.
    pub fn tty_get_attr(&self, id: TtyId) -> Termios {
        self.ttys.get(&id).map(|t| t.termios).unwrap_or_default()
    }

    /// Set attributes of terminal `id` (`tcsetattr`) — e.g. a program entering raw
    /// mode. Unknown id → no-op.
    pub fn tty_set_attr(&mut self, id: TtyId, termios: Termios) {
        if let Some(tty) = self.ttys.get_mut(&id) {
            tty.termios = termios;
        }
    }

    /// Current window size of terminal `id` (`TIOCGWINSZ`). Defaults for unknown id.
    pub fn tty_winsize(&self, id: TtyId) -> Winsize {
        self.ttys.get(&id).map(|t| t.winsize).unwrap_or_default()
    }

    /// Update terminal `id`'s window size when the host terminal is resized. The
    /// host follows this with a `SIGWINCH` to that terminal's foreground group.
    pub fn tty_set_winsize(&mut self, id: TtyId, winsize: Winsize) {
        if let Some(tty) = self.ttys.get_mut(&id) {
            tty.winsize = winsize;
        }
    }

    // ---- process groups & the foreground pgrp (job control, ADR-025) ---------

    /// `tcsetpgrp`: make `pgid` terminal `id`'s foreground process group — the
    /// group ^C/^Z/SIGWINCH are delivered to. `0` returns the terminal to the
    /// shell (no foreground job). Unknown id → no-op.
    pub fn tty_set_foreground(&mut self, id: TtyId, pgid: Pid) {
        if let Some(tty) = self.ttys.get_mut(&id) {
            tty.foreground_pgid = pgid;
        }
    }

    /// `tcgetpgrp`: terminal `id`'s current foreground process group (`0` = none —
    /// the interactive prompt owns the terminal; also the answer for an unknown id).
    pub fn tty_foreground(&self, id: TtyId) -> Pid {
        self.ttys.get(&id).map(|t| t.foreground_pgid).unwrap_or(0)
    }

    /// The live members of process group `pgid` (signal-delivery set).
    pub fn pgrp_members(&self, pgid: Pid) -> Vec<Pid> {
        self.processes.pgrp_members(pgid)
    }

    /// The process group `pid` belongs to (`0` if unknown).
    pub fn proc_pgid(&self, pid: Pid) -> Pid {
        self.processes.get(pid).map(|p| p.pgid).unwrap_or(0)
    }

    /// Mark a process exited with `code` (normal return or `proc_exit`), moving
    /// it to `Zombie` and closing its file/pipe descriptors so downstream pipe
    /// readers observe EOF. Returns `false` if the pid is unknown.
    pub fn mark_exited(&mut self, pid: Pid, code: i32) -> bool {
        if !self.processes.contains(pid) {
            return false;
        }
        let was_live = self
            .processes
            .get(pid)
            .map(|p| p.state != ProcState::Zombie)
            .unwrap_or(false);
        if let Some(ctx) = self.contexts.get_mut(&pid) {
            ctx.proc_exit(code);
            if was_live {
                ctx.close_all_io(&mut self.vfs, &mut self.pipes);
            }
        }
        // Free any ports the process was listening on so a crashed/killed server
        // releases its port and pending clients see EOF (ADR-021, INV-6).
        self.ports.reap_pid(pid);
        self.processes.set_exited(pid, code)
    }

    /// `otf:kill`: signal a process. `SIGKILL`/`SIGTERM` mark it exited with the
    /// conventional 128+signal code; the host then `terminate()`s its worker.
    /// Returns `false` if the pid is unknown.
    pub fn kill(&mut self, pid: Pid, signal: i32) -> bool {
        if !self.processes.contains(pid) {
            return false;
        }
        self.mark_exited(pid, 128 + signal)
    }

    /// A watchdog/limit kill (INV-6, ADR-020): record the honest *why* on the
    /// process record, then mark it exited with `code`. The host follows with
    /// `worker.terminate()` exactly as for `kill`. Returns `false` if the pid
    /// is unknown.
    pub fn mark_killed(&mut self, pid: Pid, code: i32, reason: &str) -> bool {
        if !self.processes.set_kill_reason(pid, reason) {
            return false;
        }
        self.mark_exited(pid, code)
    }

    /// `wait(pid)`: the exit code if the process has exited, else `None`.
    pub fn wait(&self, pid: Pid) -> Option<i32> {
        match self.processes.get(pid) {
            Some(p) if p.state == ProcState::Zombie => p.exit_code,
            _ => None,
        }
    }

    /// Reap an exited process: drop its context and remove it from the table.
    /// Returns its exit code, or `None` if it was not a reapable zombie.
    pub fn reap(&mut self, pid: Pid) -> Option<i32> {
        let code = self.processes.reap(pid)?;
        self.contexts.remove(&pid);
        Some(code)
    }

    // ---- otf:net_* — port-keyed loopback sockets (ADR-021) --------------------

    /// `otf:net_listen`: claim `port` for `pid` (gated by `OtfCall::NetListen`),
    /// or assign a free ephemeral port when `port == 0`. `EADDRINUSE` if another
    /// process holds a requested port. Returns `(listener, bound_port)` — the
    /// handle the process passes to `net_accept`, plus the actually-bound port so
    /// the guest can report it via `server.address()`.
    pub fn net_listen(&mut self, pid: Pid, port: u16) -> SysResult<(ListenerId, u16)> {
        let ctx = self.contexts.get(&pid).ok_or(Errno::Badf)?;
        if !ctx.caps.allows(caps::OtfCall::NetListen) {
            return Err(Errno::Notsup);
        }
        self.ports.listen(pid, port)
    }

    /// `otf:net_connect`: loopback-connect `pid` to whoever listens on `port`,
    /// binding the client-side connection fds into its table. `ECONNREFUSED` if
    /// nobody listens. This is the call the host-side injector drives on behalf of
    /// an intercepted preview `fetch` (ADR-021); it is *not* outbound internet.
    pub fn net_connect(&mut self, pid: Pid, port: u16) -> SysResult<Connection> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        self.ports.connect(&mut self.pipes, ctx, port)
    }

    /// `otf:net_accept`: bind the next pending connection's server-side fds into
    /// the listening process's table. `AcceptOutcome::WouldBlock` when the backlog
    /// is empty — the kernel worker parks and retries, exactly like a would-block
    /// pipe read (ADR-016).
    pub fn net_accept(&mut self, pid: Pid, listener: ListenerId) -> SysResult<AcceptOutcome> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        self.ports.accept(&mut self.pipes, ctx, listener)
    }

    /// Register a context-only "host" process (no backing worker) for the network
    /// injector (ADR-021). It owns the client ends of injected preview
    /// connections and drives them through the ordinary `sys_read`/`sys_write`/
    /// `sys_close` path, so the injector needs no special data-path API — it is
    /// just a process the host, not a guest worker, speaks for. Not resolved from
    /// the VFS and never scheduled.
    pub fn register_host_process(&mut self) -> Pid {
        let caps = CapabilitySet::default();
        let pid = self.processes.create(SpawnRequest {
            ppid: 0,
            pgid: 0,
            argv: vec!["net-injector".into()],
            env: Vec::new(),
            cwd: "/".into(),
            start_time: 0,
            caps: caps.clone(),
        });
        self.contexts.insert(
            pid,
            ProcessCtx::new(pid, vec!["net-injector".into()], Vec::new(), "/".into(), caps, NO_TTY, self.limits.max_open_fds),
        );
        pid
    }

    /// Client `fs.write`: create parent directories as needed, then write the
    /// file (create + truncate). Convenience for seeding the VFS from the host.
    pub fn fs_write(&mut self, file_path: &str, data: &[u8]) -> SysResult<()> {
        let abs = path::normalize("/", file_path);
        self.mkdir_p_parent(&abs)?;
        let ino = self.vfs.open(
            &abs,
            OpenOptions {
                create: true,
                truncate: true,
                ..Default::default()
            },
        )?;
        self.vfs.write_at(ino, 0, data)?;
        self.vfs.close(ino)
    }

    /// Client `fs.read`: read a whole file.
    pub fn fs_read(&self, file_path: &str) -> SysResult<Vec<u8>> {
        let abs = path::normalize("/", file_path);
        let meta = self.vfs.stat(&abs)?;
        let ino = self.vfs.resolve(&abs)?;
        let mut buf = vec![0u8; meta.size as usize];
        let n = self.vfs.read_at(ino, 0, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// `mkdir -p` for the parent directory chain of an absolute file path.
    fn mkdir_p_parent(&mut self, abs_file: &str) -> SysResult<()> {
        let Some((parent, _)) = path::split(abs_file) else {
            return Ok(());
        };
        let mut cur = String::from("/");
        for comp in path::components(parent) {
            if cur.len() > 1 {
                cur.push('/');
            } else {
                // cur == "/"; avoid leading "//"
            }
            cur.push_str(comp);
            match self.vfs.mkdir(&cur) {
                Ok(_) | Err(Errno::Exist) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    // ---- guest syscall surface used by coreutils (all confined to caps.fs_root) ----

    /// `path_open` for a guest: returns a new fd.
    pub fn sys_open(&mut self, pid: Pid, path: &str, opts: OpenOptions) -> SysResult<Fd> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.path_open(&mut self.vfs, path, opts)
    }

    /// `fd_close` for a guest.
    pub fn sys_close(&mut self, pid: Pid, fd: Fd) -> SysResult<()> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.fd_close(&mut self.vfs, &mut self.pipes, fd)
    }

    /// `fd_seek` for a guest; `whence` is the raw WASI value (0=set, 1=cur, 2=end).
    /// Returns the new absolute offset.
    pub fn sys_seek(&mut self, pid: Pid, fd: Fd, offset: i64, whence: u8) -> SysResult<u64> {
        let whence = syscall::Whence::from_raw(whence)?;
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.fd_seek(&self.vfs, fd, offset, whence)
    }

    /// List a directory by path (for `ls`).
    pub fn sys_readdir(&self, pid: Pid, path: &str) -> SysResult<Vec<DirEntry>> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_readdir(&self.vfs, path)
    }

    /// Stat a path (for `ls`/`cp`). Follows a final symlink.
    pub fn sys_stat(&self, pid: Pid, path: &str) -> SysResult<Metadata> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_stat(&self.vfs, path)
    }

    /// `lstat` — stat without following a final symlink (Node `fs.lstat`).
    pub fn sys_lstat(&self, pid: Pid, path: &str) -> SysResult<Metadata> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_lstat(&self.vfs, path)
    }

    /// Create a symlink at `link` pointing at `target` (Node `fs.symlink`).
    pub fn sys_symlink(&mut self, pid: Pid, target: &str, link: &str) -> SysResult<()> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.path_symlink(&mut self.vfs, target, link)
    }

    /// Read a symlink's target (Node `fs.readlink`).
    pub fn sys_readlink(&self, pid: Pid, path: &str) -> SysResult<String> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_readlink(&self.vfs, path)
    }

    /// Create a hard link `newpath` → the file `existing` (Node `fs.link`).
    pub fn sys_link(&mut self, pid: Pid, existing: &str, newpath: &str) -> SysResult<()> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.path_link(&mut self.vfs, existing, newpath)
    }

    /// Canonicalize a path, resolving symlinks (Node `fs.realpath`).
    pub fn sys_realpath(&self, pid: Pid, path: &str) -> SysResult<String> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_realpath(&self.vfs, path)
    }

    /// Set the kernel's wall clock (ms since epoch). The kernel is clock-less
    /// (ADR-020); the host stamps this before a mutation so inode mtimes/ctimes
    /// reflect real time rather than 0.
    pub fn set_time(&mut self, now_ms: f64) {
        self.vfs.set_time(now_ms as u64);
    }

    // ---- fs.watch (filesystem change notification) ----

    /// Register a `fs.watch` on `path` for `pid` (recursively or not). Returns a
    /// watch id. `ENOENT` if the path doesn't exist / is outside the process root.
    /// The first live watch turns on change-event recording in the VFS.
    pub fn watch_add(&mut self, pid: Pid, path: &str, recursive: bool) -> SysResult<u32> {
        let ctx = self.contexts.get(&pid).ok_or(Errno::Badf)?;
        let abs = ctx.resolve_confined(path)?;
        // Must exist to watch (Node throws ENOENT otherwise).
        self.vfs.stat(&abs)?;
        let id = self.next_watch_id;
        self.next_watch_id += 1;
        self.watches.push(Watch { id, pid, path: abs, recursive });
        self.vfs.set_watching(true);
        Ok(id)
    }

    /// Stop a watch (its `FSWatcher.close()`). Turns recording off when the last
    /// watch goes away.
    pub fn watch_remove(&mut self, pid: Pid, id: u32) {
        self.watches.retain(|w| !(w.pid == pid && w.id == id));
        if self.watches.is_empty() {
            self.vfs.set_watching(false);
        }
    }

    /// Drop every watch a process held (called when it exits).
    pub fn watch_close_pid(&mut self, pid: Pid) {
        self.watches.retain(|w| w.pid != pid);
        if self.watches.is_empty() {
            self.vfs.set_watching(false);
        }
    }

    /// Drain pending VFS change events and match them against active watches,
    /// producing the per-watcher deliveries the host routes to program workers.
    pub fn drain_watch_events(&mut self) -> Vec<WatchDelivery> {
        let events = self.vfs.drain_events();
        let mut out = Vec::new();
        for (path, kind) in events {
            let event_type = match kind {
                vfs::FsEventKind::Rename => "rename",
                vfs::FsEventKind::Change => "change",
            };
            for w in &self.watches {
                if let Some(filename) = watch_match(&w.path, w.recursive, &path) {
                    out.push(WatchDelivery {
                        pid: w.pid,
                        watch_id: w.id,
                        event_type,
                        filename,
                    });
                }
            }
        }
        out
    }

    /// `mkdir` a single directory.
    pub fn sys_mkdir(&mut self, pid: Pid, path: &str) -> SysResult<()> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.path_create_directory(&mut self.vfs, path)
    }

    /// `unlink` a file.
    pub fn sys_unlink(&mut self, pid: Pid, path: &str) -> SysResult<()> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.path_unlink_file(&mut self.vfs, path)
    }

    /// `rmdir` an empty directory.
    pub fn sys_rmdir(&mut self, pid: Pid, path: &str) -> SysResult<()> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        ctx.path_remove_directory(&mut self.vfs, path)
    }

    /// `rename`/move within the VFS.
    pub fn sys_rename(&mut self, pid: Pid, from: &str, to: &str) -> SysResult<()> {
        // Split the borrow: resolve+rename need ctx (for confinement) and vfs.
        let (ctx, vfs) = match self.contexts.get_mut(&pid) {
            Some(ctx) => (ctx, &mut self.vfs),
            None => return Err(Errno::Badf),
        };
        ctx.rename(vfs, from, to)
    }

    /// `utimes` — set a path's modification time (ms since epoch).
    pub fn sys_utimes(&mut self, pid: Pid, path: &str, atime_ms: u64, mtime_ms: u64) -> SysResult<()> {
        let (ctx, vfs) = match self.contexts.get_mut(&pid) {
            Some(ctx) => (ctx, &mut self.vfs),
            None => return Err(Errno::Badf),
        };
        ctx.utimes(vfs, path, atime_ms, mtime_ms)
    }

    // ---- process introspection (`ps`) ----

    /// A snapshot of the process table for `ps`.
    pub fn list_processes(&self) -> Vec<ProcInfo> {
        self.processes
            .iter()
            .map(|p| ProcInfo {
                pid: p.pid,
                ppid: p.ppid,
                pgid: p.pgid,
                argv: p.argv.clone(),
                cwd: p.cwd.clone(),
                state: match p.state {
                    ProcState::Running => "running",
                    ProcState::Sleeping => "sleeping",
                    ProcState::Zombie => "zombie",
                },
                exit_code: p.exit_code,
                kill_reason: p.kill_reason.clone(),
                start_time: p.start_time,
            })
            .collect()
    }

    // ---- shell (wsh) parse + glob, kept kernel-authoritative ----

    /// Parse a command line into a `wsh` [`shell::Script`].
    pub fn shell_parse(&self, line: &str) -> Result<shell::Script, shell::ParseError> {
        shell::parse(line)
    }

    /// Expand a glob pattern against the VFS relative to `cwd`.
    pub fn glob(&self, cwd: &str, pattern: &str) -> Vec<String> {
        shell::glob(&self.vfs, cwd, pattern)
    }

    /// Resolve `target` against `cwd` for a `cd`: returns the normalized absolute
    /// path if it exists and is a directory, else an error.
    pub fn resolve_dir(&self, cwd: &str, target: &str) -> SysResult<String> {
        let abs = path::normalize(cwd, target);
        match self.vfs.stat(&abs)?.file_type {
            vfs::FileType::Dir => Ok(abs),
            // `stat` follows symlinks, so a symlink-to-dir already resolved to Dir.
            vfs::FileType::File | vfs::FileType::Symlink => Err(Errno::Notdir),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boot() -> Kernel {
        Kernel::boot().0
    }

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn spawn_main(k: &mut Kernel, source: &str) -> Pid {
        k.fs_write("/main.js", source.as_bytes()).unwrap();
        k.spawn(
            argv(&["js", "main.js"]),
            vec![],
            "/".into(),
            0,
            None,
            0,
            None,
            Some(crate::PRIMARY_TTY),
            StdioPlan::default(),
        )
        .unwrap()
        .pid
    }

    #[test]
    fn boot_returns_version_handshake() {
        let (_kernel, hs) = Kernel::boot();
        assert_eq!(hs.version, VERSION);
        assert_eq!(hs.abi, "wasi-preview-1+otf-1");
    }

    #[test]
    fn spawn_resolves_graph_and_registers_process() {
        let mut k = boot();
        // Programs are single self-contained modules — the kernel hands back one
        // module (the entry) and never walks an import graph.
        k.fs_write("/proj/main.js", b"console.log('x')").unwrap();
        let spawned = k
            .spawn(argv(&["js", "main.js"]), vec![], "/proj".into(), 0, None, 0, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap();
        assert_eq!(spawned.graph.entry, "/proj/main.js");
        assert_eq!(spawned.graph.modules.len(), 1);
        assert!(k.processes.contains(spawned.pid));
    }

    fn try_spawn_main(k: &mut Kernel) -> Result<Spawned, SpawnError> {
        k.spawn(
            argv(&["js", "main.js"]),
            vec![],
            "/".into(),
            0,
            None,
            0,
            None,
            Some(crate::PRIMARY_TTY),
            StdioPlan::default(),
        )
    }

    #[test]
    fn process_count_cap_refuses_forkbomb() {
        // Boot with a tiny cap so the fork-bomb guard is reachable in a unit test.
        let (mut k, _) = Kernel::boot_with_limits(limits::ResourceLimits {
            max_procs: 2,
            ..Default::default()
        });
        k.fs_write("/main.js", b"console.log('x')").unwrap();

        let p1 = try_spawn_main(&mut k).unwrap().pid;
        let _p2 = try_spawn_main(&mut k).unwrap().pid;
        // Third spawn is over the cap → EAGAIN-shaped refusal, before resolution.
        assert_eq!(try_spawn_main(&mut k).unwrap_err(), SpawnError::LimitExceeded);

        // A zombie holds no worker, so it must not count against the cap: exiting
        // p1 (now a zombie, not yet reaped) frees a slot for a new spawn.
        k.mark_exited(p1, 0);
        assert!(try_spawn_main(&mut k).is_ok(), "zombie must not count as live");
    }

    #[test]
    fn spawn_missing_entry_errors() {
        let mut k = boot();
        let err = k
            .spawn(argv(&["js", "nope.js"]), vec![], "/".into(), 0, None, 0, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap_err();
        assert!(matches!(err, SpawnError::Resolve(ResolveError::NotFound(_))));
    }

    #[test]
    fn stdout_write_produces_stream_effect() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "console.log('hi')");
        let effect = k.sys_write(pid, FD_STDOUT, b"hello\n").unwrap();
        assert_eq!(effect, WriteEffect::Stdout(b"hello\n".to_vec()));
        // Each write drains cleanly (no accumulation across calls).
        let effect2 = k.sys_write(pid, FD_STDOUT, b"more").unwrap();
        assert_eq!(effect2, WriteEffect::Stdout(b"more".to_vec()));
    }

    #[test]
    fn stderr_write_produces_stream_effect() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        assert_eq!(
            k.sys_write(pid, FD_STDERR, b"boom").unwrap(),
            WriteEffect::Stderr(b"boom".to_vec())
        );
    }

    #[test]
    fn host_processes_talk_over_a_port_via_kernel_net() {
        // Drives the wasm-facing Kernel net API (ADR-021) end to end using two
        // context-only host processes — the same path the injector uses.
        let mut k = boot();
        let server = k.register_host_process();
        let client = k.register_host_process();
        let (lid, port) = k.net_listen(server, 5173).unwrap();
        assert_eq!(port, 5173, "an explicit port is bound as-is");
        // Client connects and sends before the server accepts (bytes buffer).
        let c = k.net_connect(client, 5173).unwrap();
        k.sys_write(client, c.wfd, b"ping").unwrap();
        let a = match k.net_accept(server, lid).unwrap() {
            AcceptOutcome::Ready(conn) => conn,
            other => panic!("expected Ready, got {other:?}"),
        };
        // Server reads the request and replies; client reads the reply.
        assert_eq!(k.sys_read(server, a.rfd, 64).unwrap(), ReadResult::Data(b"ping".to_vec()));
        k.sys_write(server, a.wfd, b"pong").unwrap();
        assert_eq!(k.sys_read(client, c.rfd, 64).unwrap(), ReadResult::Data(b"pong".to_vec()));
        // The port is held while the server lives.
        assert_eq!(k.net_listen(client, 5173).unwrap_err(), Errno::Addrinuse);
        // Server exits → its write end closes (client sees EOF) and the port frees.
        k.mark_exited(server, 0);
        assert_eq!(k.sys_read(client, c.rfd, 64).unwrap(), ReadResult::Eof);
        assert!(k.net_listen(client, 5173).is_ok(), "port freed on server exit");
    }

    #[test]
    fn net_connect_to_dead_port_is_refused() {
        let mut k = boot();
        let client = k.register_host_process();
        assert_eq!(k.net_connect(client, 9999).unwrap_err(), Errno::Connrefused);
    }

    #[test]
    fn exit_wait_reap_lifecycle() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        assert_eq!(k.wait(pid), None, "still running");
        assert!(k.mark_exited(pid, 0));
        assert_eq!(k.wait(pid), Some(0));
        assert_eq!(k.reap(pid), Some(0));
        assert!(!k.processes.contains(pid));
        // Context dropped: further syscalls fail.
        assert_eq!(k.sys_write(pid, FD_STDOUT, b"x").unwrap_err(), Errno::Badf);
    }

    #[test]
    fn kill_marks_exited_with_signal_code() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "while(true){}");
        assert!(k.kill(pid, 9));
        assert_eq!(k.wait(pid), Some(137)); // 128 + SIGKILL
        assert!(!k.kill(9999, 9), "unknown pid");
    }

    #[test]
    fn two_processes_have_independent_contexts() {
        let mut k = boot();
        let a = spawn_main(&mut k, "");
        let b = k
            .spawn(argv(&["js", "main.js"]), vec![], "/".into(), 0, None, 0, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap()
            .pid;
        assert_ne!(a, b);
        assert_eq!(k.sys_write(a, FD_STDOUT, b"A").unwrap(), WriteEffect::Stdout(b"A".to_vec()));
        assert_eq!(k.sys_write(b, FD_STDOUT, b"B").unwrap(), WriteEffect::Stdout(b"B".to_vec()));
    }

    #[test]
    fn fs_write_creates_parents_and_reads_back() {
        let mut k = boot();
        k.fs_write("/a/b/c/file.txt", b"deep").unwrap();
        assert_eq!(k.fs_read("/a/b/c/file.txt").unwrap(), b"deep");
        assert_eq!(k.vfs.stat("/a/b/c").unwrap().file_type, vfs::FileType::Dir);
    }

    #[test]
    fn fd_write_to_file_reports_bytes_not_stream() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        k.fs_write("/data.txt", b"").unwrap();
        // Open a file through the process context to get a file fd.
        let ctx = k.contexts.get_mut(&pid).unwrap();
        let fd = ctx
            .path_open(&mut k.vfs, "/data.txt", OpenOptions { truncate: true, ..Default::default() })
            .unwrap();
        assert_eq!(k.sys_write(pid, fd, b"abc").unwrap(), WriteEffect::File { nwritten: 3 });
        assert_eq!(k.fs_read("/data.txt").unwrap(), b"abc");
    }

    fn spawn_with(k: &mut Kernel, name: &str, plan: StdioPlan) -> Pid {
        k.fs_write(&format!("/{name}"), b"").unwrap();
        k.spawn(argv(&["js", name]), vec![], "/".into(), 0, None, 0, None, Some(crate::PRIMARY_TTY), plan)
            .unwrap()
            .pid
    }

    #[test]
    fn pipe_wires_two_processes_with_eof_on_writer_exit() {
        let mut k = boot();
        let id = k.pipe_open();
        let w = spawn_with(
            &mut k,
            "w.js",
            StdioPlan { stdout: StdioTarget::Pipe { id, end: PipeEnd::Write }, ..Default::default() },
        );
        let r = spawn_with(
            &mut k,
            "r.js",
            StdioPlan { stdin: StdioTarget::Pipe { id, end: PipeEnd::Read }, ..Default::default() },
        );

        // Writing to the pipe is a Pipe effect (nothing streams to the terminal).
        assert_eq!(k.sys_write(w, FD_STDOUT, b"hello").unwrap(), WriteEffect::Pipe { nwritten: 5 });
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::Data(b"hello".to_vec()));
        // Drained, writer still alive → would block.
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::WouldBlock);
        // Writer exits → reader sees EOF.
        k.mark_exited(w, 0);
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::Eof);
    }

    #[test]
    fn process_groups_follow_posix_placement_rules() {
        let mut k = boot();
        for f in ["a.js", "b.js", "c.js", "d.js"] {
            k.fs_write(&format!("/{f}"), b"").unwrap();
        }
        // Pipeline shape: the head becomes a leader (Some(0)); the rest join it.
        let head = k
            .spawn(argv(&["js", "a.js"]), vec![], "/".into(), 0, None, 0, Some(0), Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap()
            .pid;
        assert_eq!(k.proc_pgid(head), head, "Some(0) makes a new group, leader = self");
        let stage2 = k
            .spawn(argv(&["js", "b.js"]), vec![], "/".into(), 0, None, 0, Some(head), Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap()
            .pid;
        assert_eq!(k.proc_pgid(stage2), head, "Some(p) joins group p");
        // A child spawned with None inherits its parent's group (an exec'd
        // grandchild lands in the pipeline's group → foreground ^C reaches it).
        let grandchild = k
            .spawn(argv(&["js", "c.js"]), vec![], "/".into(), 0, None, stage2, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap()
            .pid;
        assert_eq!(k.proc_pgid(grandchild), head, "None inherits the parent's group");
        // No known parent + None → its own leader.
        let solo = k
            .spawn(argv(&["js", "d.js"]), vec![], "/".into(), 0, None, 0, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap()
            .pid;
        assert_eq!(k.proc_pgid(solo), solo);

        // The delivery set is the live members; zombies drop out.
        let mut members = k.pgrp_members(head);
        members.sort();
        assert_eq!(members, vec![head, stage2, grandchild]);
        k.mark_exited(stage2, 0);
        let mut members = k.pgrp_members(head);
        members.sort();
        assert_eq!(members, vec![head, grandchild]);

        // tcsetpgrp/tcgetpgrp round-trip; 0 = the shell owns the terminal.
        assert_eq!(k.tty_foreground(crate::PRIMARY_TTY), 0);
        k.tty_set_foreground(crate::PRIMARY_TTY, head);
        assert_eq!(k.tty_foreground(crate::PRIMARY_TTY), head);
        k.tty_set_foreground(crate::PRIMARY_TTY, 0);
        assert_eq!(k.tty_foreground(crate::PRIMARY_TTY), 0);
    }

    #[test]
    fn capabilities_inherit_from_the_parent_unless_overridden() {
        let mut k = boot();
        k.fs_write("/agent.js", b"").unwrap();
        k.fs_write("/child.js", b"").unwrap();
        // Host policy denies network to the agent at the trust boundary…
        let denied = CapabilitySet { net_egress: false, ..CapabilitySet::default() };
        let agent = k
            .spawn(argv(&["js", "agent.js"]), vec![], "/".into(), 0, Some(denied), 0, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap();
        assert!(!agent.net_egress);
        // …and the agent cannot shell out to regain it: a child spawned with no
        // explicit set inherits the parent's (ADR-024).
        let child = k
            .spawn(argv(&["js", "child.js"]), vec![], "/".into(), 0, None, agent.pid, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap();
        assert!(!child.net_egress, "a denied parent's child must not regain egress");
        // A child of an unknown/host ppid gets the ordinary default (allowed).
        let fresh = k
            .spawn(argv(&["js", "child.js"]), vec![], "/".into(), 0, None, 0, None, Some(crate::PRIMARY_TTY), StdioPlan::default())
            .unwrap();
        assert!(fresh.net_egress);
    }

    #[test]
    fn mark_killed_records_the_reason_on_the_zombie() {
        let mut k = boot();
        let pid = spawn_with(&mut k, "hog.js", StdioPlan::default());
        assert!(k.mark_killed(pid, 137, "out of memory"));
        let info = k
            .list_processes()
            .into_iter()
            .find(|p| p.pid == pid)
            .expect("zombie still listed until reaped");
        assert_eq!(info.state, "zombie");
        assert_eq!(info.exit_code, Some(137));
        assert_eq!(info.kill_reason.as_deref(), Some("out of memory"));
        // An ordinary exit carries no reason.
        let pid2 = spawn_with(&mut k, "ok.js", StdioPlan::default());
        k.mark_exited(pid2, 0);
        let info2 = k.list_processes().into_iter().find(|p| p.pid == pid2).unwrap();
        assert_eq!(info2.kill_reason, None);
        // Unknown pid: refused.
        assert!(!k.mark_killed(9999, 152, "CPU time"));
    }

    #[test]
    fn pipe_write_blocks_at_capacity_and_resumes_as_reader_drains() {
        use syscall::PIPE_CAPACITY;
        let mut k = boot();
        let id = k.pipe_open();
        let w = spawn_with(
            &mut k,
            "w.js",
            StdioPlan { stdout: StdioTarget::Pipe { id, end: PipeEnd::Write }, ..Default::default() },
        );
        let r = spawn_with(
            &mut k,
            "r.js",
            StdioPlan { stdin: StdioTarget::Pipe { id, end: PipeEnd::Read }, ..Default::default() },
        );

        // Fill to capacity in one go; a further write is accepted as 0 bytes
        // ("park me"), never buffered beyond the cap (ADR-023).
        let big = vec![b'x'; PIPE_CAPACITY + 1];
        assert_eq!(
            k.sys_write(w, FD_STDOUT, &big).unwrap(),
            WriteEffect::Pipe { nwritten: PIPE_CAPACITY }
        );
        assert_eq!(k.sys_write(w, FD_STDOUT, b"y").unwrap(), WriteEffect::Pipe { nwritten: 0 });

        // A reader draining frees exactly that much capacity for the retry.
        assert_eq!(k.sys_read(r, 0, 1000).unwrap(), ReadResult::Data(vec![b'x'; 1000]));
        assert_eq!(
            k.sys_write(w, FD_STDOUT, &big).unwrap(),
            WriteEffect::Pipe { nwritten: 1000 }
        );
    }

    #[test]
    fn pipe_write_is_epipe_after_the_last_reader_departs() {
        let mut k = boot();
        let id = k.pipe_open();
        let w = spawn_with(
            &mut k,
            "w.js",
            StdioPlan { stdout: StdioTarget::Pipe { id, end: PipeEnd::Write }, ..Default::default() },
        );
        let r = spawn_with(
            &mut k,
            "r.js",
            StdioPlan { stdin: StdioTarget::Pipe { id, end: PipeEnd::Read }, ..Default::default() },
        );

        assert_eq!(k.sys_write(w, FD_STDOUT, b"early").unwrap(), WriteEffect::Pipe { nwritten: 5 });
        // The reader exits (its fds close) → the pipe is broken for the writer:
        // EPIPE, exactly the `yes | head -1` shape (ADR-023). Buffered bytes the
        // reader never consumed do not resurrect the pipe.
        k.mark_exited(r, 0);
        assert_eq!(k.sys_write(w, FD_STDOUT, b"late"), Err(Errno::Pipe));
    }

    #[test]
    fn pipe_ends_not_yet_attached_park_rather_than_finalize() {
        // The shell wires pipeline ends one spawn at a time, so an eager peer
        // must see would-block — not EOF (read side) or EPIPE (write side) —
        // until the other end has *ever* attached.
        let mut k = boot();

        // Reader first, writer not attached yet: WouldBlock, not EOF.
        let id = k.pipe_open();
        let r = spawn_with(
            &mut k,
            "r.js",
            StdioPlan { stdin: StdioTarget::Pipe { id, end: PipeEnd::Read }, ..Default::default() },
        );
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::WouldBlock);

        // Writer first, reader not attached yet: buffered, not EPIPE.
        let id2 = k.pipe_open();
        let w = spawn_with(
            &mut k,
            "w.js",
            StdioPlan { stdout: StdioTarget::Pipe { id: id2, end: PipeEnd::Write }, ..Default::default() },
        );
        assert_eq!(k.sys_write(w, FD_STDOUT, b"eager").unwrap(), WriteEffect::Pipe { nwritten: 5 });
        let r2 = spawn_with(
            &mut k,
            "r2.js",
            StdioPlan { stdin: StdioTarget::Pipe { id: id2, end: PipeEnd::Read }, ..Default::default() },
        );
        assert_eq!(k.sys_read(r2, 0, 16).unwrap(), ReadResult::Data(b"eager".to_vec()));
    }

    #[test]
    fn redirect_stdout_to_file_via_plan() {
        let mut k = boot();
        let pid = spawn_with(
            &mut k,
            "app.js",
            StdioPlan {
                stdout: StdioTarget::File { path: "/out.txt".into(), mode: RedirectMode::Write },
                ..Default::default()
            },
        );
        // fd 1 is a file now: the write goes to the VFS, not the terminal stream.
        assert_eq!(k.sys_write(pid, FD_STDOUT, b"hi\n").unwrap(), WriteEffect::File { nwritten: 3 });
        k.mark_exited(pid, 0);
        assert_eq!(k.fs_read("/out.txt").unwrap(), b"hi\n");
    }

    #[test]
    fn list_processes_reports_the_table() {
        let mut k = boot();
        let a = spawn_main(&mut k, "");
        let procs = k.list_processes();
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, a);
        assert_eq!(procs[0].state, "running");
        k.mark_exited(a, 5);
        let procs = k.list_processes();
        assert_eq!(procs[0].state, "zombie");
        assert_eq!(procs[0].exit_code, Some(5));
    }

    #[test]
    fn terminal_stdin_reads_through_the_tty_line_discipline() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        // fd 0 is the terminal: blocks until the host feeds a committed line.
        assert_eq!(k.sys_read(pid, 0, 64).unwrap(), ReadResult::WouldBlock);
        let echo = k.tty_input(crate::PRIMARY_TTY, b"hi\r");
        assert_eq!(echo.echo, b"hi\r\n".to_vec());
        assert_eq!(k.sys_read(pid, 0, 64).unwrap(), ReadResult::Data(b"hi\n".to_vec()));
        assert_eq!(k.sys_read(pid, 0, 64).unwrap(), ReadResult::WouldBlock);
    }

    #[test]
    fn isatty_true_for_terminal_false_for_redirect() {
        let mut k = boot();
        let term = spawn_main(&mut k, "");
        assert!(k.isatty(term, 0).unwrap());
        assert!(k.isatty(term, 1).unwrap());
        let redirected = spawn_with(
            &mut k,
            "r.js",
            StdioPlan {
                stdout: StdioTarget::File { path: "/o.txt".into(), mode: RedirectMode::Write },
                ..Default::default()
            },
        );
        assert!(k.isatty(redirected, 0).unwrap(), "stdin still the terminal");
        assert!(!k.isatty(redirected, 1).unwrap(), "stdout redirected to a file");
    }

    #[test]
    fn raw_mode_stdin_delivers_bytes_without_waiting_for_a_line() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        let mut t = k.tty_get_attr(crate::PRIMARY_TTY);
        t.canonical = false;
        k.tty_set_attr(crate::PRIMARY_TTY, t);
        k.tty_input(crate::PRIMARY_TTY, b"a");
        assert_eq!(k.sys_read(pid, 0, 64).unwrap(), ReadResult::Data(b"a".to_vec()));
    }

    // Spawn `main.js` attached to a specific controlling terminal (multi-PTY).
    fn spawn_main_on(k: &mut Kernel, ctty: TtyId) -> Pid {
        k.fs_write("/main.js", b"").unwrap();
        k.spawn(argv(&["js", "main.js"]), vec![], "/".into(), 0, None, 0, None, Some(ctty), StdioPlan::default())
            .unwrap()
            .pid
    }

    #[test]
    fn separate_terminals_have_independent_input_queues() {
        let mut k = boot();
        let t2 = k.open_tty();
        assert_ne!(t2, PRIMARY_TTY);
        let a = spawn_main_on(&mut k, PRIMARY_TTY);
        let b = spawn_main_on(&mut k, t2);
        // Feed different lines to each terminal.
        k.tty_input(PRIMARY_TTY, b"alpha\r");
        k.tty_input(t2, b"beta\r");
        // Each process reads only from its own controlling terminal — no cross-talk.
        assert_eq!(k.sys_read(a, 0, 64).unwrap(), ReadResult::Data(b"alpha\n".to_vec()));
        assert_eq!(k.sys_read(b, 0, 64).unwrap(), ReadResult::Data(b"beta\n".to_vec()));
        assert_eq!(k.sys_read(a, 0, 64).unwrap(), ReadResult::WouldBlock);
        assert_eq!(k.sys_read(b, 0, 64).unwrap(), ReadResult::WouldBlock);
    }

    #[test]
    fn terminals_have_independent_foreground_groups_and_winsize() {
        let mut k = boot();
        let t2 = k.open_tty();
        k.tty_set_foreground(PRIMARY_TTY, 7);
        k.tty_set_foreground(t2, 9);
        assert_eq!(k.tty_foreground(PRIMARY_TTY), 7);
        assert_eq!(k.tty_foreground(t2), 9);
        k.tty_set_winsize(t2, Winsize { rows: 50, cols: 132 });
        assert_eq!(k.tty_winsize(t2), Winsize { rows: 50, cols: 132 });
        assert_eq!(k.tty_winsize(PRIMARY_TTY), Winsize::default());
    }

    #[test]
    fn children_inherit_the_parents_controlling_terminal() {
        let mut k = boot();
        let t2 = k.open_tty();
        let parent = spawn_main_on(&mut k, t2);
        assert_eq!(k.proc_ctty(parent), t2);
        // A child spawned with ctty=None inherits the parent's terminal.
        k.fs_write("/child.js", b"").unwrap();
        let child = k
            .spawn(argv(&["js", "child.js"]), vec![], "/".into(), 0, None, parent, None, None, StdioPlan::default())
            .unwrap()
            .pid;
        assert_eq!(k.proc_ctty(child), t2);
    }

    #[test]
    fn closing_a_terminal_makes_its_stdin_read_eof() {
        let mut k = boot();
        let t2 = k.open_tty();
        let pid = spawn_main_on(&mut k, t2);
        assert_eq!(k.sys_read(pid, 0, 64).unwrap(), ReadResult::WouldBlock);
        assert!(k.close_tty(t2));
        // A hung-up terminal reads EOF, not a block, so the reader unwinds.
        assert_eq!(k.sys_read(pid, 0, 64).unwrap(), ReadResult::Eof);
        // The primary terminal is permanent.
        assert!(!k.close_tty(PRIMARY_TTY));
    }

    #[test]
    fn shell_parse_and_glob_through_kernel() {
        let mut k = boot();
        k.fs_write("/proj/a.rs", b"").unwrap();
        k.fs_write("/proj/b.rs", b"").unwrap();
        let script = k.shell_parse("echo hi | cat > f").unwrap();
        assert_eq!(script.statements.len(), 1);
        assert_eq!(k.glob("/proj", "*.rs"), vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn coreutil_syscalls_operate_on_vfs() {
        // Exercise the guest syscall surface a coreutil would use.
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        k.sys_mkdir(pid, "/work").unwrap();
        let fd = k.sys_open(pid, "/work/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(k.sys_write(pid, fd, b"data").unwrap(), WriteEffect::File { nwritten: 4 });
        k.sys_close(pid, fd).unwrap();
        assert_eq!(k.sys_stat(pid, "/work/f").unwrap().size, 4);
        assert_eq!(k.sys_readdir(pid, "/work").unwrap().len(), 1);
        k.sys_rename(pid, "/work/f", "/work/g").unwrap();
        assert_eq!(k.sys_readdir(pid, "/work").unwrap()[0].name, "g");
        k.sys_unlink(pid, "/work/g").unwrap();
        k.sys_rmdir(pid, "/work").unwrap();
        assert_eq!(k.sys_stat(pid, "/work").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn fs_watch_reports_rename_then_change() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        k.sys_mkdir(pid, "/w").unwrap(); // before the watch → no event recorded
        let id = k.watch_add(pid, "/w", false).unwrap();

        // Create + write a file: a "rename" (appeared) then a "change" (content).
        let fd = k.sys_open(pid, "/w/a.txt", OpenOptions { create: true, ..Default::default() }).unwrap();
        k.sys_write(pid, fd, b"hi").unwrap();
        k.sys_close(pid, fd).unwrap();

        let evs = k.drain_watch_events();
        assert!(evs.iter().any(|e| e.watch_id == id && e.event_type == "rename" && e.filename == "a.txt"));
        assert!(evs.iter().any(|e| e.watch_id == id && e.event_type == "change" && e.filename == "a.txt"));
        // Draining consumed the queue; a fresh mutation yields exactly one event.
        k.sys_mkdir(pid, "/w/sub").unwrap();
        let evs2 = k.drain_watch_events();
        assert_eq!(evs2.len(), 1);
        assert_eq!((evs2[0].event_type, evs2[0].filename.as_str()), ("rename", "sub"));
    }

    #[test]
    fn fs_watch_recursive_vs_flat_scope() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        k.sys_mkdir(pid, "/r").unwrap();
        k.sys_mkdir(pid, "/r/sub").unwrap();
        let flat = k.watch_add(pid, "/r", false).unwrap();
        let deep = k.watch_add(pid, "/r", true).unwrap();

        let fd = k.sys_open(pid, "/r/sub/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        k.sys_close(pid, fd).unwrap();

        let evs = k.drain_watch_events();
        // The recursive watch sees the grandchild (relative "sub/f"); the flat one doesn't.
        assert!(evs.iter().any(|e| e.watch_id == deep && e.filename == "sub/f"));
        assert!(!evs.iter().any(|e| e.watch_id == flat));
    }

    #[test]
    fn fs_watch_close_stops_events_and_missing_path_is_enoent() {
        let mut k = boot();
        let pid = spawn_main(&mut k, "");
        let id = k.watch_add(pid, "/", false).unwrap();
        k.watch_remove(pid, id);
        // No live watchers → mutations record nothing.
        k.sys_mkdir(pid, "/x").unwrap();
        assert!(k.drain_watch_events().is_empty());
        // Watching a nonexistent path is ENOENT (Node's contract).
        assert_eq!(k.watch_add(pid, "/nope", false).unwrap_err(), Errno::Noent);
    }
}
