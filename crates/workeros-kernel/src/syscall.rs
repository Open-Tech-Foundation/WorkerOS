//! WASI Preview 1 syscall dispatch (ARCHITECTURE.md §6.1, ADR-005).
//!
//! This layer implements the WASI P1 *host* against the kernel's VFS, stdio, and
//! per-process state. It presents a clean Rust API in terms of already-decoded
//! arguments (`&str` paths, `&[u8]` buffers). The separate job of marshaling a
//! guest's linear-memory pointers/iovecs into these arguments belongs to the
//! wasm host binding (Phase 2/4) — keeping *that* out of here is what lets the
//! whole syscall surface be unit-tested natively (INV-2, Phase 1 exit criterion).
//!
//! A [`ProcessCtx`] holds one process's file-descriptor table, stdio, argv/env,
//! cwd, and capabilities. Filesystem-touching calls take a `&mut dyn Vfs`; clock
//! and randomness take a `&dyn HostEnv` so time and entropy are injected (and
//! therefore deterministic in tests) rather than pulled ambiently.

use crate::caps::CapabilitySet;
use crate::errno::{Errno, SysResult};
use crate::process::Pid;
use crate::vfs::{path, DirEntry, OpenOptions, Vfs};
use std::collections::{BTreeMap, VecDeque};

/// A WASI file descriptor.
pub type Fd = u32;

/// Preopened stdio descriptors.
pub const FD_STDIN: Fd = 0;
pub const FD_STDOUT: Fd = 1;
pub const FD_STDERR: Fd = 2;
const FIRST_FILE_FD: Fd = 3;

/// `whence` for [`ProcessCtx::fd_seek`], matching WASI's numbering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Whence {
    /// Seek from the start of the file.
    Set = 0,
    /// Seek from the current cursor.
    Cur = 1,
    /// Seek from the end of the file.
    End = 2,
}

impl Whence {
    /// Decode the raw WASI `whence` byte.
    pub fn from_raw(v: u8) -> SysResult<Whence> {
        match v {
            0 => Ok(Whence::Set),
            1 => Ok(Whence::Cur),
            2 => Ok(Whence::End),
            _ => Err(Errno::Inval),
        }
    }
}

/// Host-provided services that the kernel cannot derive from pure state:
/// wall-clock time and entropy. Injected so they are deterministic under test.
pub trait HostEnv {
    /// Current time in nanoseconds since the Unix epoch (for `clock_time_get`).
    fn now_nanos(&self) -> u64;
    /// Fill `buf` with cryptographic randomness (for `random_get`).
    fn random(&self, buf: &mut [u8]);
}

/// What a file descriptor points at.
#[derive(Debug)]
enum Handle {
    Stdin,
    Stdout,
    Stderr,
    /// A regular file, with a read/write cursor.
    File { ino: usize, cursor: u64 },
    /// An open directory (for `fd_readdir`).
    Dir { ino: usize },
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
    /// Bytes the guest wrote to stdout; the host drains these to the stdout stream.
    pub stdout: Vec<u8>,
    /// Bytes the guest wrote to stderr.
    pub stderr: Vec<u8>,
    /// Bytes queued for the guest to read on stdin; the host feeds these.
    pub stdin: VecDeque<u8>,
    /// Set by `proc_exit`; `Some(code)` means the process has requested exit.
    pub exit_code: Option<i32>,
}

impl ProcessCtx {
    /// Create a context with the three stdio descriptors preopened.
    pub fn new(pid: Pid, argv: Vec<String>, env: Vec<(String, String)>, cwd: String, caps: CapabilitySet) -> Self {
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
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdin: VecDeque::new(),
            exit_code: None,
        }
    }

    fn alloc_fd(&mut self, handle: Handle) -> Fd {
        let fd = self.next_fd;
        self.next_fd += 1;
        self.fds.insert(fd, handle);
        fd
    }

    /// Resolve a guest path against cwd, normalize, and confine to `fs_root`.
    fn resolve_path(&self, path_arg: &str) -> SysResult<String> {
        let abs = path::normalize(&self.cwd, path_arg);
        let root = &self.caps.fs_root;
        // Confinement: the resolved path must lie within the granted root.
        let within = root == "/"
            || abs == *root
            || abs.starts_with(&format!("{}/", root.trim_end_matches('/')));
        if !within {
            return Err(Errno::Noent);
        }
        Ok(abs)
    }

    // ---- filesystem ----

    /// `path_open`: open (optionally create) a file or directory, returning a new fd.
    pub fn path_open(&mut self, vfs: &mut dyn Vfs, path_arg: &str, opts: OpenOptions) -> SysResult<Fd> {
        let abs = self.resolve_path(path_arg)?;
        let ino = vfs.open(&abs, opts)?;
        let meta = vfs.stat(&abs)?;
        let handle = match meta.file_type {
            crate::vfs::FileType::Dir => Handle::Dir { ino },
            crate::vfs::FileType::File => Handle::File { ino, cursor: 0 },
        };
        Ok(self.alloc_fd(handle))
    }

    /// `path_create_directory`.
    pub fn path_create_directory(&mut self, vfs: &mut dyn Vfs, path_arg: &str) -> SysResult<()> {
        let abs = self.resolve_path(path_arg)?;
        vfs.mkdir(&abs).map(|_| ())
    }

    /// `path_unlink_file`.
    pub fn path_unlink_file(&mut self, vfs: &mut dyn Vfs, path_arg: &str) -> SysResult<()> {
        let abs = self.resolve_path(path_arg)?;
        vfs.unlink(&abs)
    }

    /// `fd_readdir`: list a directory fd's entries.
    pub fn fd_readdir(&self, vfs: &dyn Vfs, fd: Fd) -> SysResult<Vec<DirEntry>> {
        match self.fds.get(&fd) {
            Some(Handle::Dir { ino }) => vfs.readdir_ino(*ino),
            Some(_) => Err(Errno::Notdir),
            None => Err(Errno::Badf),
        }
    }

    /// `fd_write`: write `data`, advancing the cursor for files. Returns bytes written.
    pub fn fd_write(&mut self, vfs: &mut dyn Vfs, fd: Fd, data: &[u8]) -> SysResult<usize> {
        match self.fds.get_mut(&fd) {
            Some(Handle::Stdout) => {
                if !self.caps.stdout {
                    return Err(Errno::Badf);
                }
                self.stdout.extend_from_slice(data);
                Ok(data.len())
            }
            Some(Handle::Stderr) => {
                if !self.caps.stderr {
                    return Err(Errno::Badf);
                }
                self.stderr.extend_from_slice(data);
                Ok(data.len())
            }
            Some(Handle::File { ino, cursor }) => {
                let n = vfs.write_at(*ino, *cursor, data)?;
                *cursor += n as u64;
                Ok(n)
            }
            Some(Handle::Stdin) | Some(Handle::Dir { .. }) => Err(Errno::Badf),
            None => Err(Errno::Badf),
        }
    }

    /// `fd_read`: read up to `buf.len()` bytes, advancing the cursor for files.
    /// Returns bytes read (0 at EOF / empty stdin).
    pub fn fd_read(&mut self, vfs: &dyn Vfs, fd: Fd, buf: &mut [u8]) -> SysResult<usize> {
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
                Ok(n)
            }
            Some(Handle::File { ino, cursor }) => {
                let n = vfs.read_at(*ino, *cursor, buf)?;
                *cursor += n as u64;
                Ok(n)
            }
            Some(Handle::Stdout) | Some(Handle::Stderr) | Some(Handle::Dir { .. }) => Err(Errno::Badf),
            None => Err(Errno::Badf),
        }
    }

    /// `fd_seek`: reposition a file cursor. Returns the new absolute offset.
    pub fn fd_seek(&mut self, vfs: &dyn Vfs, fd: Fd, offset: i64, whence: Whence) -> SysResult<u64> {
        match self.fds.get_mut(&fd) {
            Some(Handle::File { ino, cursor }) => {
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
            // Streams are not seekable.
            Some(Handle::Stdin) | Some(Handle::Stdout) | Some(Handle::Stderr) => Err(Errno::Spipe),
            Some(Handle::Dir { .. }) => Err(Errno::Isdir),
            None => Err(Errno::Badf),
        }
    }

    /// `fd_close`: close a descriptor. Stdio descriptors cannot be closed in v1.
    pub fn fd_close(&mut self, vfs: &mut dyn Vfs, fd: Fd) -> SysResult<()> {
        match self.fds.remove(&fd) {
            Some(Handle::File { ino, .. }) | Some(Handle::Dir { ino }) => vfs.close(ino),
            Some(handle) => {
                // Re-insert stdio; closing it is unsupported (honest: not silently ok).
                self.fds.insert(fd, handle);
                Err(Errno::Notsup)
            }
            None => Err(Errno::Badf),
        }
    }

    // ---- args / env ----

    /// `args_sizes_get`: (argc, total bytes incl. NUL terminators).
    pub fn args_sizes_get(&self) -> (usize, usize) {
        let bytes = self.argv.iter().map(|a| a.len() + 1).sum();
        (self.argv.len(), bytes)
    }

    /// `args_get`: the argv strings (host encodes them into guest memory).
    pub fn args_get(&self) -> &[String] {
        &self.argv
    }

    /// `environ_sizes_get`: (count, total bytes of `KEY=VALUE\0` entries).
    pub fn environ_sizes_get(&self) -> (usize, usize) {
        let bytes = self.env.iter().map(|(k, v)| k.len() + 1 + v.len() + 1).sum();
        (self.env.len(), bytes)
    }

    /// `environ_get`: `KEY=VALUE` entries.
    pub fn environ_get(&self) -> Vec<String> {
        self.env.iter().map(|(k, v)| format!("{k}={v}")).collect()
    }

    // ---- clock / random / exit ----

    /// `clock_time_get`: current time in nanoseconds (host-supplied).
    pub fn clock_time_get(&self, host: &dyn HostEnv) -> u64 {
        host.now_nanos()
    }

    /// `random_get`: fill `buf` with host entropy.
    pub fn random_get(&self, host: &dyn HostEnv, buf: &mut [u8]) {
        host.random(buf);
    }

    /// `proc_exit`: record the exit code. The host then tears the process down.
    pub fn proc_exit(&mut self, code: i32) {
        self.exit_code = Some(code);
    }
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
            // Deterministic "randomness" for tests.
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
        )
    }

    #[test]
    fn scripted_open_write_seek_read_close_roundtrip() {
        // Phase 1 exit criterion: a scripted WASI sequence through the dispatch
        // layer, asserting VFS state.
        let mut vfs = MemVfs::new();
        let mut p = ctx();

        let fd = p
            .path_open(&mut vfs, "/notes.txt", OpenOptions { create: true, ..Default::default() })
            .unwrap();
        assert!(fd >= FIRST_FILE_FD);

        assert_eq!(p.fd_write(&mut vfs, fd, b"hello world").unwrap(), 11);
        // Seek back to offset 6 ("world") and read it.
        assert_eq!(p.fd_seek(&vfs, fd, 6, Whence::Set).unwrap(), 6);
        let mut buf = [0u8; 5];
        assert_eq!(p.fd_read(&vfs, fd, &mut buf).unwrap(), 5);
        assert_eq!(&buf, b"world");
        // Cursor advanced to EOF; another read yields 0.
        assert_eq!(p.fd_read(&vfs, fd, &mut buf).unwrap(), 0);
        p.fd_close(&mut vfs, fd).unwrap();

        // VFS state is what the syscalls produced.
        let meta = vfs.stat("/notes.txt").unwrap();
        assert_eq!(meta.size, 11);
    }

    #[test]
    fn seek_from_end_and_cur() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        let fd = p.path_open(&mut vfs, "/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        p.fd_write(&mut vfs, fd, b"0123456789").unwrap();
        assert_eq!(p.fd_seek(&vfs, fd, -2, Whence::End).unwrap(), 8);
        let mut buf = [0u8; 2];
        assert_eq!(p.fd_read(&vfs, fd, &mut buf).unwrap(), 2);
        assert_eq!(&buf, b"89");
        // Cursor now at 10; move back 5 with Cur.
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
        let mut p = ctx();
        assert_eq!(p.fd_write(&mut vfs, FD_STDOUT, b"out").unwrap(), 3);
        assert_eq!(p.fd_write(&mut vfs, FD_STDERR, b"err").unwrap(), 3);
        assert_eq!(p.stdout, b"out");
        assert_eq!(p.stderr, b"err");
    }

    #[test]
    fn stdin_reads_what_host_feeds() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        p.stdin.extend(b"hi".iter().copied());
        let mut buf = [0u8; 8];
        assert_eq!(p.fd_read(&vfs, FD_STDIN, &mut buf).unwrap(), 2);
        assert_eq!(&buf[..2], b"hi");
        assert_eq!(p.fd_read(&vfs, FD_STDIN, &mut buf).unwrap(), 0, "empty stdin => 0");
    }

    #[test]
    fn stdio_is_not_seekable_or_closable() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        assert_eq!(p.fd_seek(&vfs, FD_STDOUT, 0, Whence::Set).unwrap_err(), Errno::Spipe);
        assert_eq!(p.fd_close(&mut vfs, FD_STDOUT).unwrap_err(), Errno::Notsup);
        // Still usable after the failed close.
        assert_eq!(p.fd_write(&mut vfs, FD_STDOUT, b"x").unwrap(), 1);
    }

    #[test]
    fn bad_fd_errors() {
        let mut vfs = MemVfs::new();
        let mut p = ctx();
        let mut buf = [0u8; 1];
        assert_eq!(p.fd_read(&vfs, 99, &mut buf).unwrap_err(), Errno::Badf);
        assert_eq!(p.fd_write(&mut vfs, 99, b"x").unwrap_err(), Errno::Badf);
        assert_eq!(p.fd_close(&mut vfs, 99).unwrap_err(), Errno::Badf);
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
        let mut caps = CapabilitySet::default();
        caps.fs_root = "/home/user".into();
        let mut p = ProcessCtx::new(1, vec![], vec![], "/home/user".into(), caps);
        // Inside the root: ok.
        p.path_open(&mut vfs, "file", OpenOptions { create: true, ..Default::default() }).unwrap();
        // Escape attempt via `..`: denied.
        assert_eq!(
            p.path_open(&mut vfs, "../../etc", OpenOptions::default()).unwrap_err(),
            Errno::Noent
        );
    }
}
