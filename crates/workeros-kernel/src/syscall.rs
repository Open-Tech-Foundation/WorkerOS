//! WASI Preview 1 syscall dispatch (ARCHITECTURE.md §6.1, ADR-005) plus the
//! kernel IPC pipe primitive that backs `otf:ipc_open` and shell pipelines
//! (§6.3, ADR-006).
//!
//! This layer implements the WASI P1 *host* against the kernel's VFS, stdio,
//! pipes, and per-process state. It presents a clean Rust API in terms of
//! already-decoded arguments (`&str` paths, `&[u8]` buffers); marshaling a
//! guest's linear-memory pointers into these is the wasm host binding's job.
//! Keeping *that* out of here is what lets the whole surface be unit-tested
//! natively (INV-2).
//!
//! A [`ProcessCtx`] holds one process's fd table, stdio, argv/env, cwd, and
//! capabilities. Filesystem calls take `&mut dyn Vfs`; pipe calls take
//! `&mut PipeTable` (pipes are shared kernel state, so they are passed in);
//! clock/randomness take `&dyn HostEnv` so time and entropy are injected.

use crate::caps::CapabilitySet;
use crate::errno::{Errno, SysResult};
use crate::process::Pid;
use crate::tty::TtyId;
use crate::vfs::{path, DirEntry, FileType, Metadata, OpenOptions, Vfs};
use std::collections::{BTreeMap, VecDeque};

/// A WASI file descriptor.
pub type Fd = u32;
/// An IPC pipe identifier.
pub type PipeId = u32;

/// Preopened stdio descriptors.
pub const FD_STDIN: Fd = 0;
pub const FD_STDOUT: Fd = 1;
pub const FD_STDERR: Fd = 2;
const FIRST_FILE_FD: Fd = 3;

/// The result of a read that can stream: enough to distinguish "no data yet, try
/// again" (a pipe with a live writer) from a genuine end-of-file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOutcome {
    /// `n` bytes were written into the caller's buffer (0 means EOF for files/stdin).
    Data(usize),
    /// End of stream: the pipe has no more data and no remaining writers.
    Eof,
    /// No data available right now, but a writer is still open; retry later.
    WouldBlock,
}

/// `whence` for [`ProcessCtx::fd_seek`], matching WASI's numbering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Whence {
    Set = 0,
    Cur = 1,
    End = 2,
}

impl Whence {
    pub fn from_raw(v: u8) -> SysResult<Whence> {
        match v {
            0 => Ok(Whence::Set),
            1 => Ok(Whence::Cur),
            2 => Ok(Whence::End),
            _ => Err(Errno::Inval),
        }
    }
}

/// Which end of a pipe an fd holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeEnd {
    Read,
    Write,
}

/// Host-provided services the kernel cannot derive from pure state. Injected so
/// they are deterministic under test.
pub trait HostEnv {
    /// Current time in nanoseconds since the Unix epoch (for `clock_time_get`).
    fn now_nanos(&self) -> u64;
    /// Fill `buf` with randomness (for `random_get`).
    fn random(&self, buf: &mut [u8]);
}

/// How many buffered bytes a pipe holds before writers block (ADR-023). Matches
/// Linux's default pipe capacity. Bounds kernel memory per pipe: a fast producer
/// feeding a slow consumer parks (host-side) instead of growing the buffer, and
/// `A | B` streams in bounded chunks exactly as on a real OS.
pub const PIPE_CAPACITY: usize = 64 * 1024;

/// The result of a write: how the descriptor absorbed the bytes. The pipe case
/// is separate because only a pipe can accept *fewer* bytes than offered (its
/// buffer is bounded, ADR-023) — the host must park and retry the remainder
/// rather than treat a short count as done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// Bytes accepted in full by a terminal stream or a VFS file.
    Wrote(usize),
    /// Bytes accepted by a pipe — possibly fewer than offered (0 when full).
    Pipe(usize),
}

/// A kernel IPC pipe: a bounded byte buffer with live reader/writer counts. When
/// the last writer closes, a drained reader observes [`ReadOutcome::Eof`]; when
/// the last reader closes, a writer gets `EPIPE` (§6.3, ADR-023).
#[derive(Debug)]
struct Pipe {
    buffer: VecDeque<u8>,
    writers: u32,
    readers: u32,
    /// Whether a writer/reader end was *ever* attached. Ends attach one spawn at
    /// a time (the shell wires the writer before the reader), so "none attached
    /// yet" must read as would-block — not EOF/EPIPE — or an eager peer races the
    /// other end's spawn. Only an end that existed and then went away is final.
    had_writer: bool,
    had_reader: bool,
}

/// The table of live pipes (kernel-owned; shared across processes).
#[derive(Debug, Default)]
pub struct PipeTable {
    pipes: BTreeMap<PipeId, Pipe>,
    next: PipeId,
}

impl PipeTable {
    pub fn new() -> Self {
        PipeTable {
            pipes: BTreeMap::new(),
            next: 1,
        }
    }

    /// Create a new pipe with no ends attached yet.
    pub fn open(&mut self) -> PipeId {
        let id = self.next;
        self.next += 1;
        self.pipes.insert(
            id,
            Pipe {
                buffer: VecDeque::new(),
                writers: 0,
                readers: 0,
                had_writer: false,
                had_reader: false,
            },
        );
        id
    }

    fn attach(&mut self, id: PipeId, end: PipeEnd) {
        if let Some(p) = self.pipes.get_mut(&id) {
            match end {
                PipeEnd::Read => {
                    p.readers += 1;
                    p.had_reader = true;
                }
                PipeEnd::Write => {
                    p.writers += 1;
                    p.had_writer = true;
                }
            }
        }
    }

    fn detach(&mut self, id: PipeId, end: PipeEnd) {
        if let Some(p) = self.pipes.get_mut(&id) {
            match end {
                PipeEnd::Read => p.readers = p.readers.saturating_sub(1),
                PipeEnd::Write => p.writers = p.writers.saturating_sub(1),
            }
            if p.writers == 0 && p.readers == 0 && p.buffer.is_empty() {
                self.pipes.remove(&id);
            }
        }
    }

    /// Write into a pipe, accepting at most the free capacity (ADR-023). Returns
    /// the bytes accepted — possibly `0`, meaning the pipe is full and the caller
    /// must retry once a reader drains it (the host parks the write). A pipe whose
    /// last read end closed is broken: `EPIPE`, never silent buffering (INV-5).
    fn write(&mut self, id: PipeId, data: &[u8]) -> SysResult<usize> {
        let p = self.pipes.get_mut(&id).ok_or(Errno::Badf)?;
        if p.had_reader && p.readers == 0 {
            return Err(Errno::Pipe);
        }
        let n = data.len().min(PIPE_CAPACITY.saturating_sub(p.buffer.len()));
        p.buffer.extend(data[..n].iter().copied());
        Ok(n)
    }

    fn read(&mut self, id: PipeId, buf: &mut [u8]) -> SysResult<ReadOutcome> {
        let p = self.pipes.get_mut(&id).ok_or(Errno::Badf)?;
        if p.buffer.is_empty() {
            return Ok(if p.had_writer && p.writers == 0 {
                ReadOutcome::Eof
            } else {
                ReadOutcome::WouldBlock
            });
        }
        let n = buf.len().min(p.buffer.len());
        for slot in buf.iter_mut().take(n) {
            *slot = p.buffer.pop_front().unwrap();
        }
        Ok(ReadOutcome::Data(n))
    }
}

/// What a file descriptor points at.
#[derive(Debug)]
enum Handle {
    Stdin,
    Stdout,
    Stderr,
    File { ino: usize, cursor: u64, path: String },
    Dir { ino: usize },
    Pipe { id: PipeId, end: PipeEnd },
}

/// One process's syscall-visible state: fd table, stdio, identity, caps.
#[derive(Debug)]
pub struct ProcessCtx {
    pub pid: Pid,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub caps: CapabilitySet,
    fds: BTreeMap<Fd, Handle>,
    next_fd: Fd,
    /// Cap on concurrently-open fds (incl. stdio), the `RLIMIT_NOFILE` analog
    /// (ADR-020). Set from the kernel's [`ResourceLimits`](crate::limits) at spawn.
    max_open_fds: usize,
    /// Bytes the guest wrote to a *terminal* stdout; the host drains these.
    pub stdout: Vec<u8>,
    /// Bytes the guest wrote to a *terminal* stderr.
    pub stderr: Vec<u8>,
    /// Bytes queued for the guest to read on a *terminal* stdin.
    pub stdin: VecDeque<u8>,
    /// The controlling terminal this process reads/writes (multi-PTY). Set at spawn
    /// (inherited from the parent, or attached to a specific terminal by the host);
    /// [`NO_TTY`](crate::tty::NO_TTY) for a process with no terminal.
    pub ctty: TtyId,
    /// Set by `proc_exit`.
    pub exit_code: Option<i32>,
}

impl ProcessCtx {
    /// Create a context with the three stdio descriptors preopened to the terminal.
    pub fn new(
        pid: Pid,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        caps: CapabilitySet,
        ctty: TtyId,
        max_open_fds: usize,
    ) -> Self {
        let mut fds = BTreeMap::new();
        fds.insert(FD_STDIN, Handle::Stdin);
        fds.insert(FD_STDOUT, Handle::Stdout);
        fds.insert(FD_STDERR, Handle::Stderr);
        ProcessCtx {
            pid,
            argv,
            env,
            cwd,
            caps,
            fds,
            next_fd: FIRST_FILE_FD,
            max_open_fds,
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdin: VecDeque::new(),
            ctty,
            exit_code: None,
        }
    }

    /// Allocate the next fd for `handle`, enforcing the per-process open-fd cap
    /// (ADR-020). Returns `EMFILE` when the process already holds `max_open_fds`
    /// descriptors (stdio included).
    fn alloc_fd(&mut self, handle: Handle) -> SysResult<Fd> {
        if self.fds.len() >= self.max_open_fds {
            return Err(Errno::Mfile);
        }
        let fd = self.next_fd;
        self.next_fd += 1;
        self.fds.insert(fd, handle);
        Ok(fd)
    }

    /// Resolve a guest path against cwd, normalize, and confine to `fs_root`.
    /// Resolve a path argument to its confined absolute form (the same rule the
    /// filesystem syscalls apply). Exposed so the kernel's `fs.watch` layer can
    /// register a watch against a confined path.
    pub fn resolve_confined(&self, path_arg: &str) -> SysResult<String> {
        self.resolve_path(path_arg)
    }

    fn resolve_path(&self, path_arg: &str) -> SysResult<String> {
        let abs = path::normalize(&self.cwd, path_arg);
        let root = &self.caps.fs_root;
        let within = root == "/"
            || abs == *root
            || abs.starts_with(&format!("{}/", root.trim_end_matches('/')));
        if !within {
            return Err(Errno::Noent);
        }
        Ok(abs)
    }

    // ---- stdio binding (used by the spawn stdio plan) ----

    /// Bind one of fd 0/1/2 to a file opened at `path` with the given mode.
    pub fn bind_stdio_file(
        &mut self,
        vfs: &mut dyn Vfs,
        fd: Fd,
        path_arg: &str,
        mode: RedirectMode,
    ) -> SysResult<()> {
        let abs = self.resolve_path(path_arg)?;
        let opts = match mode {
            RedirectMode::Read => OpenOptions::default(),
            RedirectMode::Write => OpenOptions { create: true, truncate: true, ..Default::default() },
            RedirectMode::Append => OpenOptions { create: true, ..Default::default() },
        };
        let ino = vfs.open(&abs, opts)?;
        let cursor = if matches!(mode, RedirectMode::Append) {
            vfs.size(ino)?
        } else {
            0
        };
        if matches!(mode, RedirectMode::Write | RedirectMode::Append) {
            vfs.note_event(&abs, crate::vfs::FsEventKind::Change);
        }
        self.fds.insert(fd, Handle::File { ino, cursor, path: abs });
        Ok(())
    }

    /// Bind one of fd 0/1/2 to a pipe end, attaching to the pipe.
    pub fn bind_stdio_pipe(&mut self, pipes: &mut PipeTable, fd: Fd, id: PipeId, end: PipeEnd) {
        pipes.attach(id, end);
        self.fds.insert(fd, Handle::Pipe { id, end });
    }

    /// Allocate a *fresh* fd bound to a pipe end and attach to the pipe. The
    /// dynamic sibling of [`bind_stdio_pipe`] (which targets a fixed stdio fd):
    /// used by the socket layer (`net.rs`, ADR-021) to hand a connection's two
    /// pipe ends to a server/client process. Enforces the open-fd cap (`EMFILE`).
    pub fn bind_pipe_fd(&mut self, pipes: &mut PipeTable, id: PipeId, end: PipeEnd) -> SysResult<Fd> {
        let fd = self.alloc_fd(Handle::Pipe { id, end })?;
        pipes.attach(id, end);
        Ok(fd)
    }

    /// Close a pipe fd, detaching from the pipe. A vfs-free counterpart to
    /// [`fd_close`](Self::fd_close) for the socket layer's rollback path (`net.rs`),
    /// where no `Vfs` is in hand. Errors if `fd` is not a pipe end.
    pub fn close_pipe_fd(&mut self, pipes: &mut PipeTable, fd: Fd) -> SysResult<()> {
        match self.fds.get(&fd) {
            Some(Handle::Pipe { .. }) => match self.fds.remove(&fd) {
                Some(Handle::Pipe { id, end }) => {
                    pipes.detach(id, end);
                    Ok(())
                }
                _ => unreachable!(),
            },
            Some(_) => Err(Errno::Inval),
            None => Err(Errno::Badf),
        }
    }

    // ---- filesystem ----

    pub fn path_open(&mut self, vfs: &mut dyn Vfs, path_arg: &str, opts: OpenOptions) -> SysResult<Fd> {
        let abs = self.resolve_path(path_arg)?;
        // For `fs.watch`: note whether this open creates a new path (rename) or
        // truncates an existing file (change). Only probed when a watcher exists.
        let existed = if vfs.watching() { vfs.resolve(&abs).is_ok() } else { true };
        let ino = vfs.open(&abs, opts)?;
        if vfs.watching() {
            if !existed && opts.create {
                vfs.note_event(&abs, crate::vfs::FsEventKind::Rename);
            } else if existed && opts.truncate {
                vfs.note_event(&abs, crate::vfs::FsEventKind::Change);
            }
        }
        let meta = vfs.stat(&abs)?;
        let handle = match meta.file_type {
            FileType::Dir => Handle::Dir { ino },
            // `open`/`stat` follow symlinks, so a resolved target is a file or
            // dir; a symlink type here would mean a dangling link (already an
            // error above). Treat as a file handle defensively.
            FileType::File | FileType::Symlink => Handle::File { ino, cursor: 0, path: abs },
        };
        self.alloc_fd(handle)
    }

    pub fn path_create_directory(&mut self, vfs: &mut dyn Vfs, path_arg: &str) -> SysResult<()> {
        let abs = self.resolve_path(path_arg)?;
        vfs.mkdir(&abs)?;
        vfs.note_event(&abs, crate::vfs::FsEventKind::Rename);
        Ok(())
    }

    pub fn path_unlink_file(&mut self, vfs: &mut dyn Vfs, path_arg: &str) -> SysResult<()> {
        let abs = self.resolve_path(path_arg)?;
        vfs.unlink(&abs)?;
        vfs.note_event(&abs, crate::vfs::FsEventKind::Rename);
        Ok(())
    }

    /// `path_remove_directory`.
    pub fn path_remove_directory(&mut self, vfs: &mut dyn Vfs, path_arg: &str) -> SysResult<()> {
        let abs = self.resolve_path(path_arg)?;
        vfs.rmdir(&abs)?;
        vfs.note_event(&abs, crate::vfs::FsEventKind::Rename);
        Ok(())
    }

    /// Stat a path (for coreutils / `ls`). Follows a final symlink.
    pub fn path_stat(&self, vfs: &dyn Vfs, path_arg: &str) -> SysResult<Metadata> {
        let abs = self.resolve_path(path_arg)?;
        vfs.stat(&abs)
    }

    /// `lstat`: stat a path without following a final symlink (Node `fs.lstat`).
    pub fn path_lstat(&self, vfs: &dyn Vfs, path_arg: &str) -> SysResult<Metadata> {
        let abs = self.resolve_path(path_arg)?;
        vfs.lstat(&abs)
    }

    /// Create a symlink at `link_arg` pointing at `target` (stored uninterpreted,
    /// resolved relative to the link's directory at walk time). Only the link
    /// path is confined to the process root; the target is opaque bytes.
    pub fn path_symlink(&mut self, vfs: &mut dyn Vfs, target: &str, link_arg: &str) -> SysResult<()> {
        let abs = self.resolve_path(link_arg)?;
        vfs.symlink(target, &abs)?;
        vfs.note_event(&abs, crate::vfs::FsEventKind::Rename);
        Ok(())
    }

    /// Read a symlink's target (Node `fs.readlink`).
    pub fn path_readlink(&self, vfs: &dyn Vfs, path_arg: &str) -> SysResult<String> {
        let abs = self.resolve_path(path_arg)?;
        vfs.readlink(&abs)
    }

    /// Create a hard link `new_arg` → the file `existing_arg` names (Node `fs.link`).
    pub fn path_link(&mut self, vfs: &mut dyn Vfs, existing_arg: &str, new_arg: &str) -> SysResult<()> {
        let existing = self.resolve_path(existing_arg)?;
        let newpath = self.resolve_path(new_arg)?;
        vfs.link(&existing, &newpath)?;
        vfs.note_event(&newpath, crate::vfs::FsEventKind::Rename);
        Ok(())
    }

    /// Canonicalize a path, resolving symlinks (Node `fs.realpath`).
    pub fn path_realpath(&self, vfs: &dyn Vfs, path_arg: &str) -> SysResult<String> {
        let abs = self.resolve_path(path_arg)?;
        vfs.realpath(&abs)
    }

    /// List a directory by path.
    pub fn path_readdir(&self, vfs: &dyn Vfs, path_arg: &str) -> SysResult<Vec<DirEntry>> {
        let abs = self.resolve_path(path_arg)?;
        vfs.readdir(&abs)
    }

    /// Rename within the VFS (both paths confined to the process root).
    pub fn rename(&mut self, vfs: &mut dyn Vfs, from: &str, to: &str) -> SysResult<()> {
        let from_abs = self.resolve_path(from)?;
        let to_abs = self.resolve_path(to)?;
        vfs.rename(&from_abs, &to_abs)?;
        // A move is a "rename" event on both the source and the destination.
        vfs.note_event(&from_abs, crate::vfs::FsEventKind::Rename);
        vfs.note_event(&to_abs, crate::vfs::FsEventKind::Rename);
        Ok(())
    }

    /// Set a path's times (confined to the process root). `utimes(2)`.
    pub fn utimes(&mut self, vfs: &mut dyn Vfs, path: &str, atime_ms: u64, mtime_ms: u64) -> SysResult<()> {
        let abs = self.resolve_path(path)?;
        vfs.utimes(&abs, atime_ms, mtime_ms)?;
        // A timestamp change is content-adjacent metadata — a "change" event.
        vfs.note_event(&abs, crate::vfs::FsEventKind::Change);
        Ok(())
    }

    pub fn fd_readdir(&self, vfs: &dyn Vfs, fd: Fd) -> SysResult<Vec<DirEntry>> {
        match self.fds.get(&fd) {
            Some(Handle::Dir { ino }) => vfs.readdir_ino(*ino),
            Some(_) => Err(Errno::Notdir),
            None => Err(Errno::Badf),
        }
    }

    /// `fd_write`. Terminal streams and files accept everything (or error, e.g.
    /// `ENOSPC`); a pipe accepts at most its free capacity — the [`WriteOutcome`]
    /// tells the host which case it is, so a short pipe write can be parked and
    /// retried instead of misread as a completed write (ADR-023).
    pub fn fd_write(
        &mut self,
        vfs: &mut dyn Vfs,
        pipes: &mut PipeTable,
        fd: Fd,
        data: &[u8],
    ) -> SysResult<WriteOutcome> {
        match self.fds.get_mut(&fd) {
            Some(Handle::Stdout) => {
                if !self.caps.stdout {
                    return Err(Errno::Badf);
                }
                self.stdout.extend_from_slice(data);
                Ok(WriteOutcome::Wrote(data.len()))
            }
            Some(Handle::Stderr) => {
                if !self.caps.stderr {
                    return Err(Errno::Badf);
                }
                self.stderr.extend_from_slice(data);
                Ok(WriteOutcome::Wrote(data.len()))
            }
            Some(Handle::File { ino, cursor, path }) => {
                let n = vfs.write_at(*ino, *cursor, data)?;
                *cursor += n as u64;
                if n > 0 {
                    vfs.note_event(path, crate::vfs::FsEventKind::Change);
                }
                Ok(WriteOutcome::Wrote(n))
            }
            Some(Handle::Pipe { id, end: PipeEnd::Write }) => {
                pipes.write(*id, data).map(WriteOutcome::Pipe)
            }
            Some(Handle::Pipe { end: PipeEnd::Read, .. })
            | Some(Handle::Stdin)
            | Some(Handle::Dir { .. }) => Err(Errno::Badf),
            None => Err(Errno::Badf),
        }
    }

    /// Whether `fd` is bound to the controlling terminal (not a file/pipe
    /// redirect) — the truth `isatty(fd)` reports. All three preopened stdio
    /// descriptors are terminals until redirected.
    pub fn is_terminal(&self, fd: Fd) -> bool {
        matches!(
            self.fds.get(&fd),
            Some(Handle::Stdin) | Some(Handle::Stdout) | Some(Handle::Stderr)
        )
    }

    /// Whether `fd` reads from the controlling terminal's stdin. `Ok(true)` means
    /// the caller should route the read through the kernel TTY; `Ok(false)` a
    /// normal file/pipe read; `Err(Badf)` a stdin the process may not read.
    pub fn is_terminal_stdin(&self, fd: Fd) -> SysResult<bool> {
        match self.fds.get(&fd) {
            Some(Handle::Stdin) if self.caps.stdin => Ok(true),
            Some(Handle::Stdin) => Err(Errno::Badf),
            _ => Ok(false),
        }
    }

    /// `fd_read`. See [`ReadOutcome`] for the streaming semantics.
    pub fn fd_read(
        &mut self,
        vfs: &dyn Vfs,
        pipes: &mut PipeTable,
        fd: Fd,
        buf: &mut [u8],
    ) -> SysResult<ReadOutcome> {
        match self.fds.get_mut(&fd) {
            Some(Handle::Stdin) => {
                if !self.caps.stdin {
                    return Err(Errno::Badf);
                }
                let mut n = 0;
                while n < buf.len() {
                    match self.stdin.pop_front() {
                        Some(b) => {
                            buf[n] = b;
                            n += 1;
                        }
                        None => break,
                    }
                }
                Ok(ReadOutcome::Data(n))
            }
            Some(Handle::File { ino, cursor, .. }) => {
                let n = vfs.read_at(*ino, *cursor, buf)?;
                *cursor += n as u64;
                Ok(ReadOutcome::Data(n))
            }
            Some(Handle::Pipe { id, end: PipeEnd::Read }) => pipes.read(*id, buf),
            Some(Handle::Pipe { end: PipeEnd::Write, .. })
            | Some(Handle::Stdout)
            | Some(Handle::Stderr)
            | Some(Handle::Dir { .. }) => Err(Errno::Badf),
            None => Err(Errno::Badf),
        }
    }

    pub fn fd_seek(&mut self, vfs: &dyn Vfs, fd: Fd, offset: i64, whence: Whence) -> SysResult<u64> {
        match self.fds.get_mut(&fd) {
            Some(Handle::File { ino, cursor, .. }) => {
                let base = match whence {
                    Whence::Set => 0i64,
                    Whence::Cur => *cursor as i64,
                    Whence::End => vfs.size(*ino)? as i64,
                };
                let target = base.checked_add(offset).ok_or(Errno::Inval)?;
                if target < 0 {
                    return Err(Errno::Inval);
                }
                *cursor = target as u64;
                Ok(*cursor)
            }
            Some(Handle::Stdin) | Some(Handle::Stdout) | Some(Handle::Stderr)
            | Some(Handle::Pipe { .. }) => Err(Errno::Spipe),
            Some(Handle::Dir { .. }) => Err(Errno::Isdir),
            None => Err(Errno::Badf),
        }
    }

    /// `fd_close`. Files release their VFS handle; pipe ends detach.
    pub fn fd_close(&mut self, vfs: &mut dyn Vfs, pipes: &mut PipeTable, fd: Fd) -> SysResult<()> {
        match self.fds.remove(&fd) {
            Some(Handle::File { ino, .. }) | Some(Handle::Dir { ino }) => vfs.close(ino),
            Some(Handle::Pipe { id, end }) => {
                pipes.detach(id, end);
                Ok(())
            }
            Some(handle) => {
                // Stdio to a terminal cannot be closed in v1 (honest: not silently ok).
                self.fds.insert(fd, handle);
                Err(Errno::Notsup)
            }
            None => Err(Errno::Badf),
        }
    }

    /// Close every open descriptor (files + pipe ends), e.g. on process exit, so
    /// downstream pipe readers observe EOF. Idempotent.
    pub fn close_all_io(&mut self, vfs: &mut dyn Vfs, pipes: &mut PipeTable) {
        let fds: Vec<Fd> = self.fds.keys().copied().collect();
        for fd in fds {
            match self.fds.get(&fd) {
                Some(Handle::File { .. }) | Some(Handle::Dir { .. }) | Some(Handle::Pipe { .. }) => {
                    let _ = self.fd_close(vfs, pipes, fd);
                }
                _ => {}
            }
        }
    }

    // ---- args / env ----

    pub fn args_sizes_get(&self) -> (usize, usize) {
        let bytes = self.argv.iter().map(|a| a.len() + 1).sum();
        (self.argv.len(), bytes)
    }

    pub fn args_get(&self) -> &[String] {
        &self.argv
    }

    pub fn environ_sizes_get(&self) -> (usize, usize) {
        let bytes = self.env.iter().map(|(k, v)| k.len() + 1 + v.len() + 1).sum();
        (self.env.len(), bytes)
    }

    pub fn environ_get(&self) -> Vec<String> {
        self.env.iter().map(|(k, v)| format!("{k}={v}")).collect()
    }

    // ---- clock / random / exit ----

    pub fn clock_time_get(&self, host: &dyn HostEnv) -> u64 {
        host.now_nanos()
    }

    pub fn random_get(&self, host: &dyn HostEnv, buf: &mut [u8]) {
        host.random(buf);
    }

    pub fn proc_exit(&mut self, code: i32) {
        self.exit_code = Some(code);
    }
}

/// File-open mode for a stdio redirect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirectMode {
    Read,
    Write,
    Append,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::MemVfs;

    struct FakeHost;
    impl HostEnv for FakeHost {
        fn now_nanos(&self) -> u64 {
            1_700_000_000_000_000_000
        }
        fn random(&self, buf: &mut [u8]) {
            for (i, b) in buf.iter_mut().enumerate() {
                *b = (i as u8).wrapping_mul(31).wrapping_add(7);
            }
        }
    }

    fn ctx() -> ProcessCtx {
        ProcessCtx::new(
            1,
            vec!["prog".into(), "arg1".into()],
            vec![("HOME".into(), "/home".into())],
            "/".into(),
            CapabilitySet::default(),
            crate::PRIMARY_TTY,
            crate::limits::RECOMMENDED.max_open_fds,
        )
    }

    #[test]
    fn scripted_open_write_seek_read_close_roundtrip() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();

        let fd = p
            .path_open(&mut vfs, "/notes.txt", OpenOptions { create: true, ..Default::default() })
            .unwrap();
        assert!(fd >= FIRST_FILE_FD);

        assert_eq!(p.fd_write(&mut vfs, &mut pipes, fd, b"hello world").unwrap(), WriteOutcome::Wrote(11));
        assert_eq!(p.fd_seek(&vfs, fd, 6, Whence::Set).unwrap(), 6);
        let mut buf = [0u8; 5];
        assert_eq!(p.fd_read(&vfs, &mut pipes, fd, &mut buf).unwrap(), ReadOutcome::Data(5));
        assert_eq!(&buf, b"world");
        assert_eq!(p.fd_read(&vfs, &mut pipes, fd, &mut buf).unwrap(), ReadOutcome::Data(0));
        p.fd_close(&mut vfs, &mut pipes, fd).unwrap();

        assert_eq!(vfs.stat("/notes.txt").unwrap().size, 11);
    }

    #[test]
    fn open_fd_cap_returns_emfile_and_frees_on_close() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        // Cap = 5: the three stdio fds + two files. The third open must fail.
        let mut p =
            ProcessCtx::new(1, vec![], vec![], "/".into(), CapabilitySet::default(), crate::PRIMARY_TTY, 5);
        let open = |p: &mut ProcessCtx, vfs: &mut MemVfs, name: &str| {
            p.path_open(vfs, name, OpenOptions { create: true, ..Default::default() })
        };
        let fd_a = open(&mut p, &mut vfs, "/a").unwrap();
        let _fd_b = open(&mut p, &mut vfs, "/b").unwrap();
        assert_eq!(open(&mut p, &mut vfs, "/c").unwrap_err(), Errno::Mfile);
        // Closing a descriptor frees a slot, so the next open succeeds.
        p.fd_close(&mut vfs, &mut pipes, fd_a).unwrap();
        assert!(open(&mut p, &mut vfs, "/c").is_ok());
    }

    #[test]
    fn seek_from_end_and_cur() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();
        let fd = p.path_open(&mut vfs, "/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        p.fd_write(&mut vfs, &mut pipes, fd, b"0123456789").unwrap();
        assert_eq!(p.fd_seek(&vfs, fd, -2, Whence::End).unwrap(), 8);
        let mut buf = [0u8; 2];
        assert_eq!(p.fd_read(&vfs, &mut pipes, fd, &mut buf).unwrap(), ReadOutcome::Data(2));
        assert_eq!(&buf, b"89");
        assert_eq!(p.fd_seek(&vfs, fd, -5, Whence::Cur).unwrap(), 5);
    }

    #[test]
    fn negative_seek_is_invalid() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        let fd = p.path_open(&mut vfs, "/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(p.fd_seek(&vfs, fd, -1, Whence::Set).unwrap_err(), Errno::Inval);
    }

    #[test]
    fn stdout_and_stderr_capture() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();
        assert_eq!(p.fd_write(&mut vfs, &mut pipes, FD_STDOUT, b"out").unwrap(), WriteOutcome::Wrote(3));
        assert_eq!(p.fd_write(&mut vfs, &mut pipes, FD_STDERR, b"err").unwrap(), WriteOutcome::Wrote(3));
        assert_eq!(p.stdout, b"out");
        assert_eq!(p.stderr, b"err");
    }

    #[test]
    fn stdin_reads_what_host_feeds() {
        let vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();
        p.stdin.extend(b"hi".iter().copied());
        let mut buf = [0u8; 8];
        assert_eq!(p.fd_read(&vfs, &mut pipes, FD_STDIN, &mut buf).unwrap(), ReadOutcome::Data(2));
        assert_eq!(&buf[..2], b"hi");
        assert_eq!(p.fd_read(&vfs, &mut pipes, FD_STDIN, &mut buf).unwrap(), ReadOutcome::Data(0));
    }

    #[test]
    fn pipe_streams_data_then_eof() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let id = pipes.open();

        let mut writer =
            ProcessCtx::new(1, vec![], vec![], "/".into(), CapabilitySet::default(), crate::PRIMARY_TTY, 256);
        writer.bind_stdio_pipe(&mut pipes, FD_STDOUT, id, PipeEnd::Write);
        let mut reader =
            ProcessCtx::new(2, vec![], vec![], "/".into(), CapabilitySet::default(), crate::PRIMARY_TTY, 256);
        reader.bind_stdio_pipe(&mut pipes, FD_STDIN, id, PipeEnd::Read);

        let mut buf = [0u8; 16];
        // Nothing written yet, writer still open → WouldBlock.
        assert_eq!(reader.fd_read(&vfs, &mut pipes, FD_STDIN, &mut buf).unwrap(), ReadOutcome::WouldBlock);
        // Write some, then read it.
        writer.fd_write(&mut vfs, &mut pipes, FD_STDOUT, b"pipe!").unwrap();
        assert_eq!(reader.fd_read(&vfs, &mut pipes, FD_STDIN, &mut buf).unwrap(), ReadOutcome::Data(5));
        assert_eq!(&buf[..5], b"pipe!");
        // Writer closes → drained reader gets EOF.
        writer.close_all_io(&mut vfs, &mut pipes);
        assert_eq!(reader.fd_read(&vfs, &mut pipes, FD_STDIN, &mut buf).unwrap(), ReadOutcome::Eof);
    }

    #[test]
    fn redirect_stdout_to_file() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();
        p.bind_stdio_file(&mut vfs, FD_STDOUT, "/out.txt", RedirectMode::Write).unwrap();
        assert_eq!(p.fd_write(&mut vfs, &mut pipes, FD_STDOUT, b"to-file").unwrap(), WriteOutcome::Wrote(7));
        assert!(p.stdout.is_empty(), "nothing streamed to the terminal");
        assert_eq!(vfs.stat("/out.txt").unwrap().size, 7);
    }

    #[test]
    fn append_mode_starts_at_end() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        {
            let mut p = ctx();
            p.bind_stdio_file(&mut vfs, FD_STDOUT, "/log", RedirectMode::Write).unwrap();
            p.fd_write(&mut vfs, &mut pipes, FD_STDOUT, b"one\n").unwrap();
            p.close_all_io(&mut vfs, &mut pipes);
        }
        let mut p = ctx();
        p.bind_stdio_file(&mut vfs, FD_STDOUT, "/log", RedirectMode::Append).unwrap();
        p.fd_write(&mut vfs, &mut pipes, FD_STDOUT, b"two\n").unwrap();
        let ino = vfs.resolve("/log").unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(vfs.read_at(ino, 0, &mut buf).unwrap(), 8);
        assert_eq!(&buf, b"one\ntwo\n");
    }

    #[test]
    fn stdio_is_not_seekable_or_closable() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();
        assert_eq!(p.fd_seek(&vfs, FD_STDOUT, 0, Whence::Set).unwrap_err(), Errno::Spipe);
        assert_eq!(p.fd_close(&mut vfs, &mut pipes, FD_STDOUT).unwrap_err(), Errno::Notsup);
        assert_eq!(p.fd_write(&mut vfs, &mut pipes, FD_STDOUT, b"x").unwrap(), WriteOutcome::Wrote(1));
    }

    #[test]
    fn bad_fd_errors() {
        let mut vfs = MemVfs::new();
        let mut pipes = PipeTable::new();
        let mut p = ctx();
        let mut buf = [0u8; 1];
        assert_eq!(p.fd_read(&vfs, &mut pipes, 99, &mut buf).unwrap_err(), Errno::Badf);
        assert_eq!(p.fd_write(&mut vfs, &mut pipes, 99, b"x").unwrap_err(), Errno::Badf);
        assert_eq!(p.fd_close(&mut vfs, &mut pipes, 99).unwrap_err(), Errno::Badf);
    }

    #[test]
    fn fd_readdir_lists_entries() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        p.path_create_directory(&mut vfs, "/d").unwrap();
        p.path_open(&mut vfs, "/d/a", OpenOptions { create: true, ..Default::default() }).unwrap();
        p.path_open(&mut vfs, "/d/b", OpenOptions { create: true, ..Default::default() }).unwrap();
        let dfd = p.path_open(&mut vfs, "/d", OpenOptions { directory: true, ..Default::default() }).unwrap();
        let names: Vec<_> = p.fd_readdir(&vfs, dfd).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn path_helpers_stat_readdir_rename() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        p.path_create_directory(&mut vfs, "/d").unwrap();
        p.path_open(&mut vfs, "/d/a", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(p.path_stat(&vfs, "/d").unwrap().file_type, FileType::Dir);
        assert_eq!(p.path_readdir(&vfs, "/d").unwrap().len(), 1);
        p.rename(&mut vfs, "/d/a", "/d/b").unwrap();
        let names: Vec<_> = p.path_readdir(&vfs, "/d").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["b"]);
    }

    #[test]
    fn args_and_environ() {
        let p = ctx();
        assert_eq!(p.args_sizes_get(), (2, "prog\0".len() + "arg1\0".len()));
        assert_eq!(p.args_get(), &["prog".to_string(), "arg1".to_string()]);
        assert_eq!(p.environ_sizes_get(), (1, "HOME=/home\0".len()));
        assert_eq!(p.environ_get(), vec!["HOME=/home".to_string()]);
    }

    #[test]
    fn clock_and_random_are_host_supplied() {
        let p = ctx();
        let host = FakeHost;
        assert_eq!(p.clock_time_get(&host), 1_700_000_000_000_000_000);
        let mut buf = [0u8; 4];
        p.random_get(&host, &mut buf);
        assert_eq!(buf, [7, 38, 69, 100]);
    }

    #[test]
    fn proc_exit_records_code() {
        let mut p = ctx();
        assert_eq!(p.exit_code, None);
        p.proc_exit(3);
        assert_eq!(p.exit_code, Some(3));
    }

    #[test]
    fn path_confinement_denies_escape() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/home").unwrap();
        vfs.mkdir("/home/user").unwrap();
        let caps = CapabilitySet {
            fs_root: "/home/user".into(),
            ..Default::default()
        };
        let mut p = ProcessCtx::new(1, vec![], vec![], "/home/user".into(), caps, crate::PRIMARY_TTY, 256);
        p.path_open(&mut vfs, "file", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(
            p.path_open(&mut vfs, "../../etc", OpenOptions::default()).unwrap_err(),
            Errno::Noent
        );
    }
}
