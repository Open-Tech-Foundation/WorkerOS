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
pub mod process;
pub mod resolver;
pub mod ringbuf;
pub mod shell;
pub mod syscall;
pub mod vfs;

use caps::CapabilitySet;
use errno::{Errno, SysResult};
use process::{Pid, ProcState, SpawnRequest};
use resolver::{Interpreter, ModuleGraph, ResolveError, DEFAULT_PATH};
use std::collections::BTreeMap;
use syscall::{
    Fd, PipeEnd, PipeId, PipeTable, ProcessCtx, ReadOutcome, RedirectMode, FD_STDERR, FD_STDOUT,
};
use vfs::{path, DirEntry, Metadata, OpenOptions, Vfs};

/// The ABI version the kernel speaks: WASI Preview 1 (the floor) plus the
/// three-call `otf:*` kernel ABI (the ceiling, ADR-005/ADR-006).
pub const ABI: &str = "wasi-preview-1+otf-1";

/// The kernel's semantic version. Sourced from the crate version so the build
/// is the single source of truth.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

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
}

/// A successful spawn: the new pid, the interpreter to run under, and the
/// resolved module graph the host hands to the program worker.
#[derive(Debug, Clone)]
pub struct Spawned {
    pub pid: Pid,
    pub interpreter: Interpreter,
    pub graph: ModuleGraph,
}

/// Why a spawn failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    /// `argv` named no runnable entry.
    NoEntry,
    /// The entry or one of its imports could not be resolved.
    Resolve(ResolveError),
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
    pub argv: Vec<String>,
    pub cwd: String,
    pub state: &'static str,
    pub exit_code: Option<i32>,
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
}

impl Kernel {
    /// Boot the kernel and produce the version handshake.
    pub fn boot() -> (Self, Handshake) {
        (
            Kernel {
                vfs: vfs::MemVfs::new(),
                processes: process::ProcessTable::new(),
                contexts: BTreeMap::new(),
                pipes: PipeTable::new(),
            },
            Handshake {
                version: VERSION,
                abi: ABI,
            },
        )
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
        caps: CapabilitySet,
        ppid: Pid,
        plan: StdioPlan,
    ) -> Result<Spawned, SpawnError> {
        let inv = resolver::resolve_invocation(&self.vfs, &cwd, &argv, DEFAULT_PATH)
            .map_err(SpawnError::Resolve)?;
        let graph = resolver::resolve_graph(&self.vfs, &inv.entry).map_err(SpawnError::Resolve)?;
        let pid = self.processes.create(SpawnRequest {
            ppid,
            argv: argv.clone(),
            env: env.clone(),
            cwd: cwd.clone(),
            start_time,
            caps: caps.clone(),
        });
        let mut ctx = ProcessCtx::new(pid, argv, env, cwd, caps);
        // Apply the stdio plan (redirects / pipe ends). A binding failure (e.g. a
        // missing input file) fails the spawn cleanly.
        if let Err(e) = Self::apply_stdio(&mut ctx, &mut self.vfs, &mut self.pipes, &plan) {
            self.processes.remove(pid);
            return Err(SpawnError::Resolve(ResolveError::Io(e)));
        }
        self.contexts.insert(pid, ctx);
        Ok(Spawned {
            pid,
            interpreter: inv.interpreter,
            graph,
        })
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

    fn ctx_mut(&mut self, pid: Pid) -> SysResult<&mut ProcessCtx> {
        self.contexts.get_mut(&pid).ok_or(Errno::Badf)
    }

    /// Dispatch an `fd_write` for a process and return the host effect. A write
    /// whose target is a terminal stream yields `Stdout`/`Stderr`; a write to a
    /// file or pipe yields `File { nwritten }` (nothing to forward).
    pub fn sys_write(&mut self, pid: Pid, fd: Fd, data: &[u8]) -> SysResult<WriteEffect> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        let n = ctx.fd_write(&mut self.vfs, &mut self.pipes, fd, data)?;
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

    /// Feed bytes to a process's stdin queue (host-driven terminal input).
    pub fn feed_stdin(&mut self, pid: Pid, data: &[u8]) -> SysResult<()> {
        self.ctx_mut(pid)?.stdin.extend(data.iter().copied());
        Ok(())
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

    /// List a directory by path (for `ls`).
    pub fn sys_readdir(&self, pid: Pid, path: &str) -> SysResult<Vec<DirEntry>> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_readdir(&self.vfs, path)
    }

    /// Stat a path (for `ls`/`cp`).
    pub fn sys_stat(&self, pid: Pid, path: &str) -> SysResult<Metadata> {
        self.contexts.get(&pid).ok_or(Errno::Badf)?.path_stat(&self.vfs, path)
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

    // ---- process introspection (`ps`) ----

    /// A snapshot of the process table for `ps`.
    pub fn list_processes(&self) -> Vec<ProcInfo> {
        self.processes
            .iter()
            .map(|p| ProcInfo {
                pid: p.pid,
                ppid: p.ppid,
                argv: p.argv.clone(),
                cwd: p.cwd.clone(),
                state: match p.state {
                    ProcState::Running => "running",
                    ProcState::Sleeping => "sleeping",
                    ProcState::Zombie => "zombie",
                },
                exit_code: p.exit_code,
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
            vfs::FileType::File => Err(Errno::Notdir),
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
            argv(&["node", "main.js"]),
            vec![],
            "/".into(),
            0,
            CapabilitySet::default(),
            0,
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
        k.fs_write("/proj/main.js", b"import './util.js'; console.log('x')").unwrap();
        k.fs_write("/proj/util.js", b"export const u = 1;").unwrap();
        let spawned = k
            .spawn(argv(&["node", "main.js"]), vec![], "/proj".into(), 0, CapabilitySet::default(), 0, StdioPlan::default())
            .unwrap();
        assert_eq!(spawned.graph.entry, "/proj/main.js");
        assert_eq!(spawned.graph.modules.len(), 2);
        assert!(k.processes.contains(spawned.pid));
    }

    #[test]
    fn spawn_missing_entry_errors() {
        let mut k = boot();
        let err = k
            .spawn(argv(&["node", "nope.js"]), vec![], "/".into(), 0, CapabilitySet::default(), 0, StdioPlan::default())
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
            .spawn(argv(&["node", "main.js"]), vec![], "/".into(), 0, CapabilitySet::default(), 0, StdioPlan::default())
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
        k.spawn(argv(&["node", name]), vec![], "/".into(), 0, CapabilitySet::default(), 0, plan)
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

        // Writing to the pipe is a File effect (nothing streams to the terminal).
        assert_eq!(k.sys_write(w, FD_STDOUT, b"hello").unwrap(), WriteEffect::File { nwritten: 5 });
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::Data(b"hello".to_vec()));
        // Drained, writer still alive → would block.
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::WouldBlock);
        // Writer exits → reader sees EOF.
        k.mark_exited(w, 0);
        assert_eq!(k.sys_read(r, 0, 16).unwrap(), ReadResult::Eof);
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
}
