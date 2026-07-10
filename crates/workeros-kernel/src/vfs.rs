//! The virtual filesystem: a `Vfs` trait and an in-memory inode-tree
//! implementation (ARCHITECTURE.md §9, ADR-011).
//!
//! This is the single source of truth all WASI `path_*`/`fd_*` calls and the
//! (guest-side) Node `fs` shim bottom out at. v1 is in-memory; a later
//! IndexedDB-backed implementation of the same trait adds persistence with no
//! call-site changes — hence the trait boundary.
//!
//! # Model
//!
//! An arena of inodes indexed by inode number ([`Ino`]). Inode 0 is the root
//! directory. A directory holds a `name -> Ino` map of its children; a file
//! holds its bytes. File descriptors are *not* modeled here — they are a process
//! concept and live in the syscall layer ([`crate::syscall`]). The VFS instead
//! tracks an `open_count` per inode so an inode unlinked while still open is kept
//! alive until the last handle closes (POSIX-shaped, honest — INV-5).

use crate::errno::{Errno, SysResult};
use std::collections::BTreeMap;

pub mod path;

/// An inode number. Stable for the lifetime of the inode.
pub type Ino = usize;

/// The root directory's inode number.
pub const ROOT_INO: Ino = 0;

/// What an inode is.
#[derive(Debug)]
enum Kind {
    File { data: Vec<u8> },
    Dir { entries: BTreeMap<String, Ino> },
}

#[derive(Debug)]
struct Inode {
    kind: Kind,
    /// Directory-entry link count. Reaches 0 on unlink.
    nlink: u32,
    /// Number of open file descriptors referencing this inode.
    open_count: u32,
}

impl Inode {
    fn new_dir() -> Self {
        Inode {
            kind: Kind::Dir {
                entries: BTreeMap::new(),
            },
            nlink: 1,
            open_count: 0,
        }
    }
    fn new_file() -> Self {
        Inode {
            kind: Kind::File { data: Vec::new() },
            nlink: 1,
            open_count: 0,
        }
    }
    fn is_dir(&self) -> bool {
        matches!(self.kind, Kind::Dir { .. })
    }
}

/// One entry returned by [`Vfs::readdir`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    /// Entry name (single path component, no slashes).
    pub name: String,
    /// The entry's inode number.
    pub ino: Ino,
    /// Whether the entry is a directory.
    pub is_dir: bool,
}

/// File type reported by [`Vfs::stat`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    File,
    Dir,
}

/// Metadata for an inode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Metadata {
    pub ino: Ino,
    pub file_type: FileType,
    pub size: u64,
}

/// The authoritative filesystem interface. All paths are absolute, normalized
/// POSIX paths (see [`path::normalize`]); callers resolve relative paths against
/// a cwd *before* calling in.
pub trait Vfs {
    /// Look up the inode at an absolute normalized path.
    fn resolve(&self, path: &str) -> SysResult<Ino>;
    /// Metadata for an existing path.
    fn stat(&self, path: &str) -> SysResult<Metadata>;
    /// Create a directory. Parent must exist; errors if the path exists.
    fn mkdir(&mut self, path: &str) -> SysResult<Ino>;
    /// List a directory's entries by path (excludes `.`/`..`).
    fn readdir(&self, path: &str) -> SysResult<Vec<DirEntry>>;
    /// List a directory's entries by inode (used by fd-based `fd_readdir`).
    fn readdir_ino(&self, ino: Ino) -> SysResult<Vec<DirEntry>>;
    /// Remove a file (not a directory) link. The inode persists while open.
    fn unlink(&mut self, path: &str) -> SysResult<()>;
    /// Remove an empty directory.
    fn rmdir(&mut self, path: &str) -> SysResult<()>;
    /// Rename/move an entry from `from` to `to` within the same VFS. Overwrites
    /// an existing regular file at `to`; refuses to overwrite a directory.
    fn rename(&mut self, from: &str, to: &str) -> SysResult<()>;

    /// Open a file, optionally creating it. Returns its inode and bumps the
    /// open count; the caller must later [`Vfs::close`] it exactly once.
    fn open(&mut self, path: &str, opts: OpenOptions) -> SysResult<Ino>;
    /// Drop one open reference. Frees the inode if it is unlinked and now unused.
    fn close(&mut self, ino: Ino) -> SysResult<()>;

    /// Read from a file inode at `offset`; returns bytes copied into `buf`.
    fn read_at(&self, ino: Ino, offset: u64, buf: &mut [u8]) -> SysResult<usize>;
    /// Write to a file inode at `offset`, extending as needed; returns bytes written.
    fn write_at(&mut self, ino: Ino, offset: u64, data: &[u8]) -> SysResult<usize>;
    /// Current size of a file inode in bytes.
    fn size(&self, ino: Ino) -> SysResult<u64>;
}

/// Options for [`Vfs::open`].
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenOptions {
    /// Create the file if it does not exist.
    pub create: bool,
    /// Fail if the file already exists (with `create`).
    pub exclusive: bool,
    /// Truncate the file to zero length on open.
    pub truncate: bool,
    /// The target must be a directory.
    pub directory: bool,
}

/// In-memory `Vfs` implementation: an arena of inodes rooted at [`ROOT_INO`].
#[derive(Debug)]
pub struct MemVfs {
    slots: Vec<Option<Inode>>,
    free: Vec<Ino>,
    /// Total bytes stored across all files (the `vfs_max_bytes` accounting, ADR-020).
    used_bytes: u64,
    /// Live inode count (files + dirs, incl. root) — the `vfs_max_inodes` accounting.
    inode_count: usize,
    /// Storage quota: byte and inode ceilings. Breach → `ENOSPC`.
    max_bytes: u64,
    max_inodes: usize,
}

impl Default for MemVfs {
    fn default() -> Self {
        Self::new()
    }
}

impl MemVfs {
    /// A fresh filesystem containing only the root directory `/`, under the
    /// recommended storage quota ([`crate::limits::RECOMMENDED`]).
    pub fn new() -> Self {
        let r = crate::limits::RECOMMENDED;
        Self::with_limits(r.vfs_max_bytes, r.vfs_max_inodes)
    }

    /// A fresh filesystem with explicit storage caps (ADR-020). The host-override
    /// path (post-v1) constructs the VFS through here.
    pub fn with_limits(max_bytes: u64, max_inodes: usize) -> Self {
        MemVfs {
            // Root is inode 0 and counts against the inode budget.
            slots: vec![Some(Inode::new_dir())],
            free: Vec::new(),
            used_bytes: 0,
            inode_count: 1,
            max_bytes,
            max_inodes,
        }
    }

    fn get(&self, ino: Ino) -> SysResult<&Inode> {
        self.slots
            .get(ino)
            .and_then(|s| s.as_ref())
            .ok_or(Errno::Badf)
    }
    fn get_mut(&mut self, ino: Ino) -> SysResult<&mut Inode> {
        self.slots
            .get_mut(ino)
            .and_then(|s| s.as_mut())
            .ok_or(Errno::Badf)
    }

    /// Allocate an inode, enforcing the inode quota (ADR-020). Returns `ENOSPC`
    /// when the filesystem already holds `max_inodes` live inodes.
    fn alloc(&mut self, inode: Inode) -> SysResult<Ino> {
        if self.inode_count >= self.max_inodes {
            return Err(Errno::Nospc);
        }
        self.inode_count += 1;
        let ino = if let Some(ino) = self.free.pop() {
            self.slots[ino] = Some(inode);
            ino
        } else {
            self.slots.push(Some(inode));
            self.slots.len() - 1
        };
        Ok(ino)
    }

    /// Resolve a normalized absolute path to an inode, walking from root.
    fn resolve_ino(&self, path: &str) -> SysResult<Ino> {
        let mut cur = ROOT_INO;
        for comp in path::components(path) {
            let inode = self.get(cur)?;
            match &inode.kind {
                Kind::Dir { entries } => {
                    cur = *entries.get(comp).ok_or(Errno::Noent)?;
                }
                Kind::File { .. } => return Err(Errno::Notdir),
            }
        }
        Ok(cur)
    }

    /// Resolve the parent directory of `path`, returning (parent_ino, last_component).
    fn resolve_parent<'a>(&self, path: &'a str) -> SysResult<(Ino, &'a str)> {
        let (parent, name) = path::split(path).ok_or(Errno::Inval)?;
        let parent_ino = self.resolve_ino(parent)?;
        if !self.get(parent_ino)?.is_dir() {
            return Err(Errno::Notdir);
        }
        Ok((parent_ino, name))
    }

    fn dir_entries(&self, ino: Ino) -> SysResult<&BTreeMap<String, Ino>> {
        match &self.get(ino)?.kind {
            Kind::Dir { entries } => Ok(entries),
            Kind::File { .. } => Err(Errno::Notdir),
        }
    }

    /// Drop a link to `ino`; free the inode if it is now fully unreferenced.
    fn unlink_ino(&mut self, ino: Ino) -> SysResult<()> {
        let inode = self.get_mut(ino)?;
        inode.nlink = inode.nlink.saturating_sub(1);
        self.maybe_reap(ino);
        Ok(())
    }

    fn maybe_reap(&mut self, ino: Ino) {
        if let Some(Some(inode)) = self.slots.get(ino) {
            if inode.nlink == 0 && inode.open_count == 0 && ino != ROOT_INO {
                // Release this inode's storage from the quota accounting.
                if let Kind::File { data } = &inode.kind {
                    self.used_bytes = self.used_bytes.saturating_sub(data.len() as u64);
                }
                self.inode_count = self.inode_count.saturating_sub(1);
                self.slots[ino] = None;
                self.free.push(ino);
            }
        }
    }
}

impl Vfs for MemVfs {
    fn resolve(&self, path: &str) -> SysResult<Ino> {
        self.resolve_ino(path)
    }

    fn stat(&self, path: &str) -> SysResult<Metadata> {
        let ino = self.resolve_ino(path)?;
        let inode = self.get(ino)?;
        let (file_type, size) = match &inode.kind {
            Kind::File { data } => (FileType::File, data.len() as u64),
            Kind::Dir { .. } => (FileType::Dir, 0),
        };
        Ok(Metadata {
            ino,
            file_type,
            size,
        })
    }

    fn mkdir(&mut self, path: &str) -> SysResult<Ino> {
        let (parent_ino, name) = self.resolve_parent(path)?;
        path::validate_component(name)?;
        if self.dir_entries(parent_ino)?.contains_key(name) {
            return Err(Errno::Exist);
        }
        let ino = self.alloc(Inode::new_dir())?;
        match &mut self.get_mut(parent_ino)?.kind {
            Kind::Dir { entries } => {
                entries.insert(name.to_string(), ino);
            }
            Kind::File { .. } => unreachable!("checked above"),
        }
        Ok(ino)
    }

    fn readdir(&self, path: &str) -> SysResult<Vec<DirEntry>> {
        let ino = self.resolve_ino(path)?;
        self.readdir_ino(ino)
    }

    fn readdir_ino(&self, ino: Ino) -> SysResult<Vec<DirEntry>> {
        let entries = self.dir_entries(ino)?;
        let mut out = Vec::with_capacity(entries.len());
        for (name, &child) in entries {
            out.push(DirEntry {
                name: name.clone(),
                ino: child,
                is_dir: self.get(child)?.is_dir(),
            });
        }
        Ok(out)
    }

    fn unlink(&mut self, path: &str) -> SysResult<()> {
        let (parent_ino, name) = self.resolve_parent(path)?;
        let child = *self
            .dir_entries(parent_ino)?
            .get(name)
            .ok_or(Errno::Noent)?;
        if self.get(child)?.is_dir() {
            return Err(Errno::Isdir);
        }
        if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
            entries.remove(name);
        }
        self.unlink_ino(child)
    }

    fn rmdir(&mut self, path: &str) -> SysResult<()> {
        let (parent_ino, name) = self.resolve_parent(path)?;
        let child = *self
            .dir_entries(parent_ino)?
            .get(name)
            .ok_or(Errno::Noent)?;
        match &self.get(child)?.kind {
            Kind::File { .. } => return Err(Errno::Notdir),
            Kind::Dir { entries } => {
                if !entries.is_empty() {
                    return Err(Errno::Notempty);
                }
            }
        }
        if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
            entries.remove(name);
        }
        self.unlink_ino(child)
    }

    fn rename(&mut self, from: &str, to: &str) -> SysResult<()> {
        let (from_parent, from_name) = self.resolve_parent(from)?;
        let child = *self
            .dir_entries(from_parent)?
            .get(from_name)
            .ok_or(Errno::Noent)?;
        let (to_parent, to_name) = self.resolve_parent(to)?;
        path::validate_component(to_name)?;
        // If the destination exists, it must be a regular file we can replace.
        if let Some(&existing) = self.dir_entries(to_parent)?.get(to_name) {
            if existing == child {
                return Ok(()); // renaming onto itself
            }
            if self.get(existing)?.is_dir() {
                return Err(Errno::Isdir);
            }
            if let Kind::Dir { entries } = &mut self.get_mut(to_parent)?.kind {
                entries.remove(to_name);
            }
            self.unlink_ino(existing)?;
        }
        // Detach from source, attach at destination.
        if let Kind::Dir { entries } = &mut self.get_mut(from_parent)?.kind {
            entries.remove(from_name);
        }
        if let Kind::Dir { entries } = &mut self.get_mut(to_parent)?.kind {
            entries.insert(to_name.to_string(), child);
        }
        Ok(())
    }

    fn open(&mut self, path: &str, opts: OpenOptions) -> SysResult<Ino> {
        let ino = match self.resolve_ino(path) {
            Ok(ino) => {
                if opts.create && opts.exclusive {
                    return Err(Errno::Exist);
                }
                ino
            }
            Err(Errno::Noent) if opts.create => {
                let (parent_ino, name) = self.resolve_parent(path)?;
                path::validate_component(name)?;
                let ino = self.alloc(Inode::new_file())?;
                if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
                    entries.insert(name.to_string(), ino);
                }
                ino
            }
            Err(e) => return Err(e),
        };

        let inode = self.get_mut(ino)?;
        if opts.directory && !inode.is_dir() {
            return Err(Errno::Notdir);
        }
        let mut freed = 0u64;
        if opts.truncate {
            if let Kind::File { data } = &mut inode.kind {
                freed = data.len() as u64;
                data.clear();
            }
        }
        inode.open_count += 1;
        // Borrow of `inode` ends here; release the truncated bytes from the quota.
        self.used_bytes = self.used_bytes.saturating_sub(freed);
        Ok(ino)
    }

    fn close(&mut self, ino: Ino) -> SysResult<()> {
        let inode = self.get_mut(ino)?;
        inode.open_count = inode.open_count.saturating_sub(1);
        self.maybe_reap(ino);
        Ok(())
    }

    fn read_at(&self, ino: Ino, offset: u64, buf: &mut [u8]) -> SysResult<usize> {
        match &self.get(ino)?.kind {
            Kind::File { data } => {
                let start = (offset as usize).min(data.len());
                let n = buf.len().min(data.len() - start);
                buf[..n].copy_from_slice(&data[start..start + n]);
                Ok(n)
            }
            Kind::Dir { .. } => Err(Errno::Isdir),
        }
    }

    fn write_at(&mut self, ino: Ino, offset: u64, src: &[u8]) -> SysResult<usize> {
        let used = self.used_bytes;
        let max = self.max_bytes;
        // Do the sized write inside a scope so the inode borrow ends before we
        // update the byte accounting (ADR-020). A write that would push total
        // storage past the quota is refused whole with `ENOSPC`.
        let growth = {
            match &mut self.get_mut(ino)?.kind {
                Kind::File { data } => {
                    let start = offset as usize;
                    let end = start + src.len();
                    let growth = (end as u64).saturating_sub(data.len() as u64);
                    if used + growth > max {
                        return Err(Errno::Nospc);
                    }
                    if data.len() < end {
                        data.resize(end, 0);
                    }
                    data[start..end].copy_from_slice(src);
                    growth
                }
                Kind::Dir { .. } => return Err(Errno::Isdir),
            }
        };
        self.used_bytes += growth;
        Ok(src.len())
    }

    fn size(&self, ino: Ino) -> SysResult<u64> {
        match &self.get(ino)?.kind {
            Kind::File { data } => Ok(data.len() as u64),
            Kind::Dir { .. } => Err(Errno::Isdir),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs() -> MemVfs {
        MemVfs::new()
    }

    #[test]
    fn root_exists_and_is_empty() {
        let vfs = fs();
        assert_eq!(vfs.resolve("/").unwrap(), ROOT_INO);
        assert_eq!(vfs.stat("/").unwrap().file_type, FileType::Dir);
        assert!(vfs.readdir("/").unwrap().is_empty());
    }

    #[test]
    fn create_write_read_file() {
        let mut vfs = fs();
        let ino = vfs
            .open("/hello.txt", OpenOptions { create: true, ..Default::default() })
            .unwrap();
        assert_eq!(vfs.write_at(ino, 0, b"hello world").unwrap(), 11);
        assert_eq!(vfs.size(ino).unwrap(), 11);
        let mut buf = [0u8; 5];
        assert_eq!(vfs.read_at(ino, 6, &mut buf).unwrap(), 5);
        assert_eq!(&buf, b"world");
        vfs.close(ino).unwrap();
        // Still present after close (it was linked).
        assert!(vfs.resolve("/hello.txt").is_ok());
    }

    #[test]
    fn write_past_end_extends_with_zeros() {
        let mut vfs = fs();
        let ino = vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(vfs.write_at(ino, 4, b"AB").unwrap(), 2);
        let mut buf = [0xFFu8; 6];
        assert_eq!(vfs.read_at(ino, 0, &mut buf).unwrap(), 6);
        assert_eq!(&buf, &[0, 0, 0, 0, b'A', b'B']);
    }

    #[test]
    fn byte_quota_returns_nospc_and_frees_on_unlink() {
        let mut vfs = MemVfs::with_limits(10, 1000);
        let ino = vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        // Exactly the quota fits.
        assert_eq!(vfs.write_at(ino, 0, b"0123456789").unwrap(), 10);
        // One more byte would exceed it — the whole write is refused.
        assert_eq!(vfs.write_at(ino, 10, b"x").unwrap_err(), Errno::Nospc);
        // Deleting the file releases its bytes back to the budget.
        vfs.close(ino).unwrap();
        vfs.unlink("/f").unwrap();
        let ino2 = vfs.open("/g", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(vfs.write_at(ino2, 0, b"abcde").unwrap(), 5);
    }

    #[test]
    fn truncate_releases_bytes_to_quota() {
        let mut vfs = MemVfs::with_limits(10, 1000);
        let ino = vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        vfs.write_at(ino, 0, b"0123456789").unwrap(); // fills the quota
        vfs.close(ino).unwrap();
        // Re-open truncating frees the 10 bytes, so a fresh full write fits again.
        let ino = vfs.open("/f", OpenOptions { create: true, truncate: true, ..Default::default() }).unwrap();
        assert_eq!(vfs.write_at(ino, 0, b"ABCDEFGHIJ").unwrap(), 10);
    }

    #[test]
    fn inode_quota_returns_nospc_and_frees_on_rmdir() {
        // Root already holds 1 inode; a cap of 2 leaves room for exactly one more.
        let mut vfs = MemVfs::with_limits(1 << 20, 2);
        vfs.mkdir("/a").unwrap();
        assert_eq!(vfs.mkdir("/b").unwrap_err(), Errno::Nospc);
        // open(create) allocates an inode too, so it hits the same cap.
        let err = vfs
            .open("/f", OpenOptions { create: true, ..Default::default() })
            .unwrap_err();
        assert_eq!(err, Errno::Nospc);
        // Freeing an inode makes room again.
        vfs.rmdir("/a").unwrap();
        assert!(vfs.mkdir("/b").is_ok());
    }

    #[test]
    fn truncate_on_open() {
        let mut vfs = fs();
        let ino = vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        vfs.write_at(ino, 0, b"content").unwrap();
        vfs.close(ino).unwrap();
        let ino2 = vfs.open("/f", OpenOptions { truncate: true, ..Default::default() }).unwrap();
        assert_eq!(vfs.size(ino2).unwrap(), 0);
    }

    #[test]
    fn exclusive_create_conflicts() {
        let mut vfs = fs();
        vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        let err = vfs
            .open("/f", OpenOptions { create: true, exclusive: true, ..Default::default() })
            .unwrap_err();
        assert_eq!(err, Errno::Exist);
    }

    #[test]
    fn nested_directories_and_readdir() {
        let mut vfs = fs();
        vfs.mkdir("/a").unwrap();
        vfs.mkdir("/a/b").unwrap();
        vfs.open("/a/b/file", OpenOptions { create: true, ..Default::default() }).unwrap();
        let mut names: Vec<_> = vfs.readdir("/a/b").unwrap().into_iter().map(|e| e.name).collect();
        names.sort();
        assert_eq!(names, vec!["file"]);
        let top: Vec<_> = vfs.readdir("/a").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(top, vec!["b"]);
    }

    #[test]
    fn readdir_is_sorted_and_typed() {
        let mut vfs = fs();
        vfs.mkdir("/d").unwrap();
        vfs.open("/d/z", OpenOptions { create: true, ..Default::default() }).unwrap();
        vfs.mkdir("/d/a").unwrap();
        let entries = vfs.readdir("/d").unwrap();
        // BTreeMap ordering => sorted by name.
        assert_eq!(entries[0].name, "a");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, "z");
        assert!(!entries[1].is_dir);
    }

    #[test]
    fn mkdir_existing_fails() {
        let mut vfs = fs();
        vfs.mkdir("/a").unwrap();
        assert_eq!(vfs.mkdir("/a").unwrap_err(), Errno::Exist);
    }

    #[test]
    fn mkdir_missing_parent_fails() {
        let mut vfs = fs();
        assert_eq!(vfs.mkdir("/a/b").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn unlink_removes_file() {
        let mut vfs = fs();
        vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        vfs.close(vfs.resolve("/f").unwrap()).unwrap();
        vfs.unlink("/f").unwrap();
        assert_eq!(vfs.resolve("/f").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn unlink_directory_fails() {
        let mut vfs = fs();
        vfs.mkdir("/d").unwrap();
        assert_eq!(vfs.unlink("/d").unwrap_err(), Errno::Isdir);
    }

    #[test]
    fn rmdir_nonempty_fails() {
        let mut vfs = fs();
        vfs.mkdir("/d").unwrap();
        vfs.open("/d/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(vfs.rmdir("/d").unwrap_err(), Errno::Notempty);
    }

    #[test]
    fn open_unlinked_file_stays_readable_until_close() {
        // POSIX-shaped: unlink while open keeps the inode alive.
        let mut vfs = fs();
        let ino = vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        vfs.write_at(ino, 0, b"data").unwrap();
        vfs.unlink("/f").unwrap();
        assert_eq!(vfs.resolve("/f").unwrap_err(), Errno::Noent, "name is gone");
        let mut buf = [0u8; 4];
        assert_eq!(vfs.read_at(ino, 0, &mut buf).unwrap(), 4, "data still readable");
        assert_eq!(&buf, b"data");
        vfs.close(ino).unwrap();
        // Inode now reaped; the slot is reused by the next allocation.
        let ino2 = vfs.open("/g", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(ino2, ino, "freed inode slot is recycled");
    }

    #[test]
    fn rename_moves_and_overwrites_file() {
        let mut vfs = fs();
        let a = vfs.open("/a", OpenOptions { create: true, ..Default::default() }).unwrap();
        vfs.write_at(a, 0, b"content-a").unwrap();
        vfs.close(a).unwrap();
        vfs.open("/b", OpenOptions { create: true, ..Default::default() })
            .and_then(|i| vfs.close(i))
            .unwrap();
        // Move /a to /b, overwriting the existing /b.
        vfs.rename("/a", "/b").unwrap();
        assert_eq!(vfs.resolve("/a").unwrap_err(), Errno::Noent);
        let b = vfs.resolve("/b").unwrap();
        let mut buf = [0u8; 9];
        assert_eq!(vfs.read_at(b, 0, &mut buf).unwrap(), 9);
        assert_eq!(&buf, b"content-a");
    }

    #[test]
    fn rename_into_directory_across_dirs() {
        let mut vfs = fs();
        vfs.mkdir("/src").unwrap();
        vfs.mkdir("/dst").unwrap();
        vfs.open("/src/f", OpenOptions { create: true, ..Default::default() })
            .and_then(|i| vfs.close(i))
            .unwrap();
        vfs.rename("/src/f", "/dst/g").unwrap();
        assert_eq!(vfs.resolve("/src/f").unwrap_err(), Errno::Noent);
        assert!(vfs.resolve("/dst/g").is_ok());
    }

    #[test]
    fn rename_onto_directory_fails() {
        let mut vfs = fs();
        vfs.open("/f", OpenOptions { create: true, ..Default::default() })
            .and_then(|i| vfs.close(i))
            .unwrap();
        vfs.mkdir("/d").unwrap();
        assert_eq!(vfs.rename("/f", "/d").unwrap_err(), Errno::Isdir);
    }

    #[test]
    fn descend_into_file_is_notdir() {
        let mut vfs = fs();
        vfs.open("/f", OpenOptions { create: true, ..Default::default() }).unwrap();
        assert_eq!(vfs.resolve("/f/x").unwrap_err(), Errno::Notdir);
    }
}
