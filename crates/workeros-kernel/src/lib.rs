//! # workeros-kernel
//!
//! The Node-agnostic core of WorkerOS. This crate owns the authoritative state
//! of the system — the VFS, the process table, module resolution, scheduling,
//! and capability granting — and the WASI-shaped syscall dispatch that sits on
//! top of them (see `ARCHITECTURE.md` §4–§7, INV-2/ADR-004).
//!
//! It is deliberately free of every Node.js concept — module resolution by
//! package folder, the legacy module loader, HTTP framework globals, and so on.
//! Those all live in the guest-side `workeros-node` layer (INV-1 / ADR-007), and
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
pub mod syscall;
pub mod vfs;

use caps::CapabilitySet;
use errno::{Errno, SysResult};
use process::{Pid, ProcState, SpawnRequest};
use resolver::{ModuleGraph, ResolveError};
use std::collections::BTreeMap;
use syscall::{Fd, ProcessCtx, FD_STDERR, FD_STDOUT};
use vfs::{path, OpenOptions, Vfs};

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

/// A successful spawn: the new pid and the resolved module graph the host hands
/// to the program worker.
#[derive(Debug, Clone)]
pub struct Spawned {
    pub pid: Pid,
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
}

impl Kernel {
    /// Boot the kernel and produce the version handshake.
    pub fn boot() -> (Self, Handshake) {
        (
            Kernel {
                vfs: vfs::MemVfs::new(),
                processes: process::ProcessTable::new(),
                contexts: BTreeMap::new(),
            },
            Handshake {
                version: VERSION,
                abi: ABI,
            },
        )
    }

    /// Resolve an entry + its import graph, register a process, and create its
    /// syscall context. Does **not** start a worker — that is the host's job
    /// (`otf:spawn`), which uses the returned graph. INV-2: all resolution and
    /// process-table state is decided here.
    pub fn spawn(
        &mut self,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        start_time: u64,
        caps: CapabilitySet,
        ppid: Pid,
    ) -> Result<Spawned, SpawnError> {
        let entry = resolver::entry_path(&argv, &cwd).ok_or(SpawnError::NoEntry)?;
        let graph = resolver::resolve_graph(&self.vfs, &entry).map_err(SpawnError::Resolve)?;
        let pid = self.processes.create(SpawnRequest {
            ppid,
            argv: argv.clone(),
            env: env.clone(),
            cwd: cwd.clone(),
            start_time,
            caps: caps.clone(),
        });
        self.contexts
            .insert(pid, ProcessCtx::new(pid, argv, env, cwd, caps));
        Ok(Spawned { pid, graph })
    }

    fn ctx_mut(&mut self, pid: Pid) -> SysResult<&mut ProcessCtx> {
        self.contexts.get_mut(&pid).ok_or(Errno::Badf)
    }

    /// Dispatch an `fd_write` for a process and return the host effect.
    pub fn sys_write(&mut self, pid: Pid, fd: Fd, data: &[u8]) -> SysResult<WriteEffect> {
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        let n = ctx.fd_write(&mut self.vfs, fd, data)?;
        Ok(match fd {
            FD_STDOUT => WriteEffect::Stdout(std::mem::take(&mut ctx.stdout)),
            FD_STDERR => WriteEffect::Stderr(std::mem::take(&mut ctx.stderr)),
            _ => WriteEffect::File { nwritten: n },
        })
    }

    /// Dispatch an `fd_read` for a process (files + stdin).
    pub fn sys_read(&mut self, pid: Pid, fd: Fd, max: usize) -> SysResult<Vec<u8>> {
        let mut buf = vec![0u8; max];
        let ctx = self.contexts.get_mut(&pid).ok_or(Errno::Badf)?;
        let n = ctx.fd_read(&self.vfs, fd, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// Feed bytes to a process's stdin queue (host-driven input).
    pub fn feed_stdin(&mut self, pid: Pid, data: &[u8]) -> SysResult<()> {
        self.ctx_mut(pid)?.stdin.extend(data.iter().copied());
        Ok(())
    }

    /// Mark a process exited with `code` (normal return or `proc_exit`), moving
    /// it to `Zombie`. Returns `false` if the pid is unknown.
    pub fn mark_exited(&mut self, pid: Pid, code: i32) -> bool {
        if let Some(ctx) = self.contexts.get_mut(&pid) {
            ctx.proc_exit(code);
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
        k.spawn(argv(&["node", "main.js"]), vec![], "/".into(), 0, CapabilitySet::default(), 0)
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
            .spawn(argv(&["node", "main.js"]), vec![], "/proj".into(), 0, CapabilitySet::default(), 0)
            .unwrap();
        assert_eq!(spawned.graph.entry, "/proj/main.js");
        assert_eq!(spawned.graph.modules.len(), 2);
        assert!(k.processes.contains(spawned.pid));
    }

    #[test]
    fn spawn_missing_entry_errors() {
        let mut k = boot();
        let err = k
            .spawn(argv(&["node", "nope.js"]), vec![], "/".into(), 0, CapabilitySet::default(), 0)
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
            .spawn(argv(&["node", "main.js"]), vec![], "/".into(), 0, CapabilitySet::default(), 0)
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
}
