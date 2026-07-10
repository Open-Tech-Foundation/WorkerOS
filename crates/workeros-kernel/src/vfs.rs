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

pub mod mount;
pub mod path;

use mount::MountTable;

/// An inode number. Stable for the lifetime of the inode.
pub type Ino = usize;

/// The root directory's inode number.
pub const ROOT_INO: Ino = 0;

/// Maximum symlink-follow depth before returning `ELOOP` (POSIX `SYMLOOP_MAX`).
const MAX_SYMLINK_DEPTH: u32 = 40;

/// What an inode is.
#[derive(Debug)]
enum Kind {
    File { data: Vec<u8> },
    Dir { entries: BTreeMap<String, Ino> },
    /// A symbolic link. `target` is the (uninterpreted) path it points at —
    /// resolved lazily during path walks, relative to the link's directory.
    Symlink { target: String },
}

#[derive(Debug)]
struct Inode {
    kind: Kind,
    /// Directory-entry link count. Reaches 0 on unlink.
    nlink: u32,
    /// Number of open file descriptors referencing this inode.
    open_count: u32,
    /// Last content/target modification time (ms since epoch, host-supplied).
    mtime: u64,
    /// Last metadata change time (ms) — link count, rename, times.
    ctime: u64,
    /// Creation ("birth") time (ms).
    btime: u64,
}

impl Inode {
    fn new_dir(now: u64) -> Self {
        Inode {
            kind: Kind::Dir {
                entries: BTreeMap::new(),
            },
            nlink: 1,
            open_count: 0,
            mtime: now,
            ctime: now,
            btime: now,
        }
    }
    fn new_file(now: u64) -> Self {
        Inode {
            kind: Kind::File { data: Vec::new() },
            nlink: 1,
            open_count: 0,
            mtime: now,
            ctime: now,
            btime: now,
        }
    }
    fn new_symlink(target: String, now: u64) -> Self {
        Inode {
            kind: Kind::Symlink { target },
            nlink: 1,
            open_count: 0,
            mtime: now,
            ctime: now,
            btime: now,
        }
    }
    fn is_dir(&self) -> bool {
        matches!(self.kind, Kind::Dir { .. })
    }
    fn is_symlink(&self) -> bool {
        matches!(self.kind, Kind::Symlink { .. })
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

/// File type reported by [`Vfs::stat`]/[`Vfs::lstat`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    File,
    Dir,
    Symlink,
}

/// Metadata for an inode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Metadata {
    pub ino: Ino,
    pub file_type: FileType,
    pub size: u64,
    /// Modification / change / birth times (ms since epoch).
    pub mtime: u64,
    pub ctime: u64,
    pub btime: u64,
    /// Hard-link count.
    pub nlink: u32,
}

/// The authoritative filesystem interface. All paths are absolute, normalized
/// POSIX paths (see [`path::normalize`]); callers resolve relative paths against
/// a cwd *before* calling in.
pub trait Vfs {
    /// Set the wall clock (ms since epoch) the VFS stamps into inode times. The
    /// kernel is clock-less (ADR-020); the host supplies time before mutations.
    fn set_time(&mut self, now_ms: u64);
    /// Look up the inode at an absolute normalized path, following symlinks.
    fn resolve(&self, path: &str) -> SysResult<Ino>;
    /// Metadata for an existing path, following a final symlink (`stat`).
    fn stat(&self, path: &str) -> SysResult<Metadata>;
    /// Metadata for a path *without* following a final symlink (`lstat`).
    fn lstat(&self, path: &str) -> SysResult<Metadata>;
    /// Create a symbolic link at `linkpath` pointing at `target` (uninterpreted).
    fn symlink(&mut self, target: &str, linkpath: &str) -> SysResult<Ino>;
    /// Read a symbolic link's target. Errors with `EINVAL` if not a symlink.
    fn readlink(&self, path: &str) -> SysResult<String>;
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
    /// Monotonic mutation counter (ADR-022). Bumped on every content/structure
    /// change so the host write-behind layer knows when a re-snapshot is due.
    /// A dumb "something changed" signal — it does not distinguish persistent
    /// from ephemeral changes (the snapshot walk prunes ephemeral paths anyway).
    generation: u64,
    /// The wall clock (ms since epoch) stamped into inode times, set by the host
    /// before mutations (the kernel has no clock of its own — ADR-020).
    now: u64,
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
            slots: vec![Some(Inode::new_dir(0))],
            free: Vec::new(),
            used_bytes: 0,
            inode_count: 1,
            max_bytes,
            max_inodes,
            generation: 0,
            now: 0,
        }
    }

    /// The current mutation counter (ADR-022). The host persists a fresh
    /// snapshot whenever this advances past the last-persisted value.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Record a structural or content mutation.
    fn bump(&mut self) {
        self.generation = self.generation.wrapping_add(1);
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

    /// Resolve a normalized absolute path to an inode, following symlinks
    /// (including a final one) — `stat`/`open` semantics.
    fn resolve_ino(&self, path: &str) -> SysResult<Ino> {
        self.walk_path(path, true, &mut 0)
    }

    /// Resolve a path but do **not** follow a final symlink — `lstat`/`readlink`
    /// and the create/remove family (which act on the link itself).
    fn resolve_ino_nofollow(&self, path: &str) -> SysResult<Ino> {
        self.walk_path(path, false, &mut 0)
    }

    /// Walk `path` from root, following intermediate symlinks (and the final one
    /// iff `follow_final`). A relative symlink target is normalized against the
    /// link's own directory; `..`/`.` are handled by [`path::normalize`]. Cycles
    /// and excessive nesting bottom out at `ELOOP` via the shared `depth`.
    fn walk_path(&self, path: &str, follow_final: bool, depth: &mut u32) -> SysResult<Ino> {
        let comps: Vec<&str> = path::components(path).collect();
        let mut cur = ROOT_INO;
        // Absolute path of `cur` — tracked so a relative symlink target resolves
        // against the directory the link lives in.
        let mut cur_dir = String::from("/");
        for (i, comp) in comps.iter().enumerate() {
            let is_final = i + 1 == comps.len();
            let child = match &self.get(cur)?.kind {
                Kind::Dir { entries } => *entries.get(*comp).ok_or(Errno::Noent)?,
                _ => return Err(Errno::Notdir),
            };
            if self.get(child)?.is_symlink() && (!is_final || follow_final) {
                *depth += 1;
                if *depth > MAX_SYMLINK_DEPTH {
                    return Err(Errno::Loop);
                }
                let target = match &self.get(child)?.kind {
                    Kind::Symlink { target } => target.clone(),
                    _ => unreachable!("checked is_symlink"),
                };
                let abs = if target.starts_with('/') {
                    path::normalize("/", &target)
                } else {
                    path::normalize(&cur_dir, &target)
                };
                cur = self.walk_path(&abs, true, depth)?;
                cur_dir = abs;
            } else {
                cur = child;
                cur_dir = path::normalize(&cur_dir, comp);
            }
        }
        Ok(cur)
    }

    /// Resolve the parent directory of `path` (following symlinks in the parent
    /// portion), returning (parent_ino, last_component).
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
            _ => Err(Errno::Notdir),
        }
    }

    /// Build a [`Metadata`] for an inode (shared by `stat`/`lstat`).
    fn metadata_of(&self, ino: Ino) -> SysResult<Metadata> {
        let inode = self.get(ino)?;
        let (file_type, size) = match &inode.kind {
            Kind::File { data } => (FileType::File, data.len() as u64),
            Kind::Dir { .. } => (FileType::Dir, 0),
            Kind::Symlink { target } => (FileType::Symlink, target.len() as u64),
        };
        Ok(Metadata {
            ino,
            file_type,
            size,
            mtime: inode.mtime,
            ctime: inode.ctime,
            btime: inode.btime,
            nlink: inode.nlink,
        })
    }

    /// Stamp `ino`'s mtime+ctime to the current clock (content/target change).
    fn touch_mtime(&mut self, ino: Ino) {
        let now = self.now;
        if let Ok(inode) = self.get_mut(ino) {
            inode.mtime = now;
            inode.ctime = now;
        }
    }

    /// Stamp `ino`'s ctime only (metadata change: link count, rename).
    fn touch_ctime(&mut self, ino: Ino) {
        let now = self.now;
        if let Ok(inode) = self.get_mut(ino) {
            inode.ctime = now;
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

// --- Persistence: snapshot / hydrate (ADR-022) ------------------------------
//
// The authoritative filesystem is this in-memory tree; persistence is a
// *projection* of it. `snapshot` serializes only the durable paths (pruning
// ephemeral subtrees via the mount policy) into a compact, dependency-free byte
// blob the host stores in IndexedDB; `hydrate` replays such a blob into a fresh
// tree at boot. The kernel never touches IndexedDB — it moves bytes, the host
// supplies the async storage mechanism (the ADR-015/-020 discipline).
//
// Wire format: `b"WOFS"` + version byte, then a sequence of records:
//   file: 0x01, u32 path_len (LE), path (UTF-8), u32 data_len (LE), data
//   dir:  0x00, u32 path_len (LE), path (UTF-8)          (empty dirs only)
// Non-empty directories are implied by their file entries' parents, which
// `hydrate` creates on demand — only *empty* durable directories need a record.

const SNAPSHOT_MAGIC: &[u8; 4] = b"WOFS";
const SNAPSHOT_VERSION: u8 = 1;

impl MemVfs {
    /// Serialize the durable portion of the tree to a byte blob (ADR-022).
    /// Ephemeral subtrees (per `mounts`) are excluded and, when they contain no
    /// persistent carve-out, not even walked.
    pub fn snapshot(&self, mounts: &MountTable) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.push(SNAPSHOT_VERSION);
        self.snapshot_walk("/", ROOT_INO, mounts, &mut out);
        out
    }

    fn snapshot_walk(&self, dir_path: &str, dir_ino: Ino, mounts: &MountTable, out: &mut Vec<u8>) {
        let entries = match self.slots.get(dir_ino).and_then(|s| s.as_ref()) {
            Some(Inode { kind: Kind::Dir { entries }, .. }) => entries,
            _ => return,
        };
        for (name, &child) in entries {
            let child_path = join_path(dir_path, name);
            let inode = match self.slots.get(child).and_then(|s| s.as_ref()) {
                Some(i) => i,
                None => continue,
            };
            let ephemeral = mounts.is_ephemeral(&child_path);
            match &inode.kind {
                Kind::File { data } => {
                    if !ephemeral {
                        out.push(1);
                        put_bytes(out, child_path.as_bytes());
                        put_bytes(out, data);
                    }
                }
                Kind::Symlink { target } => {
                    if !ephemeral {
                        out.push(2);
                        put_bytes(out, child_path.as_bytes());
                        put_bytes(out, target.as_bytes());
                    }
                }
                Kind::Dir { entries: sub } => {
                    if !ephemeral && sub.is_empty() {
                        out.push(0);
                        put_bytes(out, child_path.as_bytes());
                    }
                    // Descend unless this ephemeral subtree can hold no carve-out.
                    if !ephemeral || mounts.has_persistent_under(&child_path) {
                        self.snapshot_walk(&child_path, child, mounts, out);
                    }
                }
            }
        }
    }

    /// Replay a [`snapshot`](Self::snapshot) blob into this filesystem (ADR-022).
    /// Intended to run once on a freshly booted tree, before serving syscalls.
    /// Malformed input returns `EINVAL` rather than panicking (the blob comes
    /// from browser storage and may be truncated/corrupt).
    pub fn hydrate(&mut self, bytes: &[u8]) -> SysResult<()> {
        if bytes.len() < 5 || &bytes[0..4] != SNAPSHOT_MAGIC || bytes[4] != SNAPSHOT_VERSION {
            return Err(Errno::Inval);
        }
        let mut p = 5usize;
        while p < bytes.len() {
            let kind = bytes[p];
            p += 1;
            let path = std::str::from_utf8(take_bytes(bytes, &mut p)?)
                .map_err(|_| Errno::Inval)?
                .to_string();
            match kind {
                0 => {
                    self.mkdir_p(&path)?;
                }
                1 => {
                    let data = take_bytes(bytes, &mut p)?.to_vec();
                    if let Some((parent, _)) = path::split(&path) {
                        self.mkdir_p(parent)?;
                    }
                    let opts = OpenOptions {
                        create: true,
                        exclusive: false,
                        truncate: true,
                        directory: false,
                    };
                    let ino = self.open(&path, opts)?;
                    self.write_at(ino, 0, &data)?;
                    self.close(ino)?;
                }
                2 => {
                    let target = std::str::from_utf8(take_bytes(bytes, &mut p)?)
                        .map_err(|_| Errno::Inval)?
                        .to_string();
                    if let Some((parent, _)) = path::split(&path) {
                        self.mkdir_p(parent)?;
                    }
                    self.symlink(&target, &path)?;
                }
                _ => return Err(Errno::Inval),
            }
        }
        Ok(())
    }

    /// `mkdir -p`: create every missing component of an absolute path.
    fn mkdir_p(&mut self, path: &str) -> SysResult<()> {
        let mut cur = String::new();
        for comp in path::components(path) {
            cur.push('/');
            cur.push_str(comp);
            match self.mkdir(&cur) {
                Ok(_) | Err(Errno::Exist) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// Join a directory path and a single component (the parent is normalized).
fn join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Append a `u32` length-prefixed byte string (little-endian length).
fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_le_bytes());
    out.extend_from_slice(b);
}

/// Read a `u32` length-prefixed byte string at `*p`, advancing `*p`. Bounds- and
/// overflow-checked so corrupt input yields `EINVAL` instead of a panic.
fn take_bytes<'a>(bytes: &'a [u8], p: &mut usize) -> SysResult<&'a [u8]> {
    if *p + 4 > bytes.len() {
        return Err(Errno::Inval);
    }
    let len = u32::from_le_bytes(bytes[*p..*p + 4].try_into().unwrap()) as usize;
    *p += 4;
    let end = p.checked_add(len).ok_or(Errno::Inval)?;
    if end > bytes.len() {
        return Err(Errno::Inval);
    }
    let slice = &bytes[*p..end];
    *p = end;
    Ok(slice)
}

impl Vfs for MemVfs {
    fn set_time(&mut self, now_ms: u64) {
        self.now = now_ms;
    }

    fn resolve(&self, path: &str) -> SysResult<Ino> {
        self.resolve_ino(path)
    }

    fn stat(&self, path: &str) -> SysResult<Metadata> {
        let ino = self.resolve_ino(path)?;
        self.metadata_of(ino)
    }

    fn lstat(&self, path: &str) -> SysResult<Metadata> {
        let ino = self.resolve_ino_nofollow(path)?;
        self.metadata_of(ino)
    }

    fn symlink(&mut self, target: &str, linkpath: &str) -> SysResult<Ino> {
        let (parent_ino, name) = self.resolve_parent(linkpath)?;
        path::validate_component(name)?;
        if self.dir_entries(parent_ino)?.contains_key(name) {
            return Err(Errno::Exist);
        }
        let now = self.now;
        let ino = self.alloc(Inode::new_symlink(target.to_string(), now))?;
        if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
            entries.insert(name.to_string(), ino);
        }
        self.touch_mtime(parent_ino);
        self.bump();
        Ok(ino)
    }

    fn readlink(&self, path: &str) -> SysResult<String> {
        let ino = self.resolve_ino_nofollow(path)?;
        match &self.get(ino)?.kind {
            Kind::Symlink { target } => Ok(target.clone()),
            _ => Err(Errno::Inval),
        }
    }

    fn mkdir(&mut self, path: &str) -> SysResult<Ino> {
        let (parent_ino, name) = self.resolve_parent(path)?;
        path::validate_component(name)?;
        if self.dir_entries(parent_ino)?.contains_key(name) {
            return Err(Errno::Exist);
        }
        let now = self.now;
        let ino = self.alloc(Inode::new_dir(now))?;
        match &mut self.get_mut(parent_ino)?.kind {
            Kind::Dir { entries } => {
                entries.insert(name.to_string(), ino);
            }
            _ => unreachable!("checked above"),
        }
        self.touch_mtime(parent_ino);
        self.bump();
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
        self.touch_ctime(child);
        self.unlink_ino(child)?;
        self.touch_mtime(parent_ino);
        self.bump();
        Ok(())
    }

    fn rmdir(&mut self, path: &str) -> SysResult<()> {
        let (parent_ino, name) = self.resolve_parent(path)?;
        let child = *self
            .dir_entries(parent_ino)?
            .get(name)
            .ok_or(Errno::Noent)?;
        match &self.get(child)?.kind {
            Kind::File { .. } | Kind::Symlink { .. } => return Err(Errno::Notdir),
            Kind::Dir { entries } => {
                if !entries.is_empty() {
                    return Err(Errno::Notempty);
                }
            }
        }
        if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
            entries.remove(name);
        }
        self.unlink_ino(child)?;
        self.touch_mtime(parent_ino);
        self.bump();
        Ok(())
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
        self.touch_mtime(from_parent);
        self.touch_mtime(to_parent);
        self.touch_ctime(child);
        self.bump();
        Ok(())
    }

    fn open(&mut self, path: &str, opts: OpenOptions) -> SysResult<Ino> {
        let mut changed = false;
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
                let now = self.now;
                let ino = self.alloc(Inode::new_file(now))?;
                if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
                    entries.insert(name.to_string(), ino);
                }
                self.touch_mtime(parent_ino);
                changed = true;
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
        if freed > 0 {
            self.touch_mtime(ino);
        }
        if changed || freed > 0 {
            self.bump();
        }
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
            Kind::Symlink { .. } => Err(Errno::Inval),
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
                Kind::Symlink { .. } => return Err(Errno::Inval),
            }
        };
        self.used_bytes += growth;
        self.touch_mtime(ino);
        self.bump();
        Ok(src.len())
    }

    fn size(&self, ino: Ino) -> SysResult<u64> {
        match &self.get(ino)?.kind {
            Kind::File { data } => Ok(data.len() as u64),
            Kind::Dir { .. } => Err(Errno::Isdir),
            Kind::Symlink { target } => Ok(target.len() as u64),
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

    // --- Persistence: snapshot / hydrate (ADR-022) --------------------------

    /// Create `path` (with parents) holding `data`.
    fn write_file(vfs: &mut MemVfs, path: &str, data: &[u8]) {
        // Create parent dirs.
        if let Some((parent, _)) = path::split(path) {
            let mut cur = String::new();
            for comp in path::components(parent) {
                cur.push('/');
                cur.push_str(comp);
                let _ = vfs.mkdir(&cur);
            }
        }
        let ino = vfs
            .open(path, OpenOptions { create: true, truncate: true, ..Default::default() })
            .unwrap();
        vfs.write_at(ino, 0, data).unwrap();
        vfs.close(ino).unwrap();
    }

    fn read_file(vfs: &MemVfs, path: &str) -> Vec<u8> {
        let ino = vfs.resolve(path).unwrap();
        let size = vfs.size(ino).unwrap() as usize;
        let mut buf = vec![0u8; size];
        let n = vfs.read_at(ino, 0, &mut buf).unwrap();
        buf.truncate(n);
        buf
    }

    #[test]
    fn snapshot_round_trips_persistent_tree() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        write_file(&mut vfs, "/project/main.js", b"console.log(1)");
        write_file(&mut vfs, "/project/src/util.js", b"export const x = 2");
        write_file(&mut vfs, "/notes.txt", b"hello");
        vfs.mkdir("/emptydir").unwrap();

        let blob = vfs.snapshot(&mounts);

        // Replay into a fresh filesystem.
        let mut restored = fs();
        restored.hydrate(&blob).unwrap();
        assert_eq!(read_file(&restored, "/project/main.js"), b"console.log(1)");
        assert_eq!(read_file(&restored, "/project/src/util.js"), b"export const x = 2");
        assert_eq!(read_file(&restored, "/notes.txt"), b"hello");
        // Empty persistent dir is preserved.
        assert_eq!(restored.stat("/emptydir").unwrap().file_type, FileType::Dir);
    }

    #[test]
    fn snapshot_excludes_ephemeral_paths() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        write_file(&mut vfs, "/keep.js", b"durable");
        // /tmp and OS trees are ephemeral by default.
        write_file(&mut vfs, "/tmp/app/index.js", b"scratch");
        write_file(&mut vfs, "/tmp/app/node_modules/dep/index.js", b"dep");
        write_file(&mut vfs, "/bin/mytool", b"binary");

        let mut restored = fs();
        restored.hydrate(&vfs.snapshot(&mounts)).unwrap();

        assert_eq!(read_file(&restored, "/keep.js"), b"durable");
        assert_eq!(restored.resolve("/tmp/app/index.js").unwrap_err(), Errno::Noent);
        assert_eq!(
            restored.resolve("/tmp/app/node_modules/dep/index.js").unwrap_err(),
            Errno::Noent
        );
        assert_eq!(restored.resolve("/bin/mytool").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn snapshot_keeps_persistent_carveout_under_ephemeral() {
        let mut mounts = mount::MountTable::default();
        mounts.mount("/tmp/keep", mount::Durability::Persist);
        let mut vfs = fs();
        write_file(&mut vfs, "/tmp/scratch.js", b"gone");
        write_file(&mut vfs, "/tmp/keep/data.json", b"{\"a\":1}");

        let mut restored = fs();
        restored.hydrate(&vfs.snapshot(&mounts)).unwrap();

        assert_eq!(read_file(&restored, "/tmp/keep/data.json"), b"{\"a\":1}");
        assert_eq!(restored.resolve("/tmp/scratch.js").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn generation_advances_on_mutation_only() {
        let mut vfs = fs();
        let g0 = vfs.generation();
        let ino = vfs
            .open("/f", OpenOptions { create: true, ..Default::default() })
            .unwrap();
        let g1 = vfs.generation();
        assert!(g1 > g0, "create bumps generation");
        vfs.write_at(ino, 0, b"data").unwrap();
        assert!(vfs.generation() > g1, "write bumps generation");
        // A pure read does not.
        let g2 = vfs.generation();
        let mut buf = [0u8; 4];
        vfs.read_at(ino, 0, &mut buf).unwrap();
        assert_eq!(vfs.generation(), g2, "read leaves generation unchanged");
    }

    // --- Symlinks -----------------------------------------------------------

    #[test]
    fn symlink_create_and_readlink() {
        let mut vfs = fs();
        write_file(&mut vfs, "/target.txt", b"payload");
        vfs.symlink("/target.txt", "/link").unwrap();
        assert_eq!(vfs.readlink("/link").unwrap(), "/target.txt");
        // lstat sees the link; stat follows to the target.
        assert_eq!(vfs.lstat("/link").unwrap().file_type, FileType::Symlink);
        assert_eq!(vfs.stat("/link").unwrap().file_type, FileType::File);
        // Reading through the link opens the target's bytes.
        assert_eq!(read_file(&vfs, "/link"), b"payload");
    }

    #[test]
    fn symlink_size_is_target_length() {
        let mut vfs = fs();
        vfs.symlink("/a/b/c", "/l").unwrap();
        assert_eq!(vfs.lstat("/l").unwrap().size, "/a/b/c".len() as u64);
    }

    #[test]
    fn relative_symlink_resolves_against_link_dir() {
        let mut vfs = fs();
        write_file(&mut vfs, "/dir/data.txt", b"rel");
        // /dir/link -> data.txt  (relative to /dir)
        vfs.symlink("data.txt", "/dir/link").unwrap();
        assert_eq!(read_file(&vfs, "/dir/link"), b"rel");
    }

    #[test]
    fn symlink_target_with_dotdot() {
        let mut vfs = fs();
        write_file(&mut vfs, "/top.txt", b"up");
        vfs.mkdir("/dir").unwrap();
        // /dir/link -> ../top.txt
        vfs.symlink("../top.txt", "/dir/link").unwrap();
        assert_eq!(read_file(&vfs, "/dir/link"), b"up");
    }

    #[test]
    fn symlink_to_directory_is_traversable() {
        let mut vfs = fs();
        write_file(&mut vfs, "/real/inner.txt", b"deep");
        vfs.symlink("/real", "/aliased").unwrap();
        // Walk *through* the symlink to a file beneath the target dir.
        assert_eq!(read_file(&vfs, "/aliased/inner.txt"), b"deep");
        assert_eq!(vfs.stat("/aliased").unwrap().file_type, FileType::Dir);
    }

    #[test]
    fn dangling_symlink_errors_on_follow_but_not_lstat() {
        let mut vfs = fs();
        vfs.symlink("/nowhere", "/link").unwrap();
        assert_eq!(vfs.resolve("/link").unwrap_err(), Errno::Noent);
        assert_eq!(vfs.lstat("/link").unwrap().file_type, FileType::Symlink);
        assert_eq!(vfs.readlink("/link").unwrap(), "/nowhere");
    }

    #[test]
    fn symlink_cycle_is_eloop() {
        let mut vfs = fs();
        vfs.symlink("/b", "/a").unwrap();
        vfs.symlink("/a", "/b").unwrap();
        assert_eq!(vfs.resolve("/a").unwrap_err(), Errno::Loop);
    }

    #[test]
    fn unlink_removes_symlink_not_target() {
        let mut vfs = fs();
        write_file(&mut vfs, "/target.txt", b"keep");
        vfs.symlink("/target.txt", "/link").unwrap();
        vfs.unlink("/link").unwrap();
        assert_eq!(vfs.resolve("/link").unwrap_err(), Errno::Noent);
        // Target survives.
        assert_eq!(read_file(&vfs, "/target.txt"), b"keep");
    }

    #[test]
    fn readlink_on_non_symlink_is_einval() {
        let mut vfs = fs();
        write_file(&mut vfs, "/f", b"x");
        assert_eq!(vfs.readlink("/f").unwrap_err(), Errno::Inval);
    }

    // --- Timestamps ---------------------------------------------------------

    #[test]
    fn create_and_write_stamp_mtime_from_host_clock() {
        let mut vfs = fs();
        vfs.set_time(1000);
        let ino = vfs
            .open("/f", OpenOptions { create: true, ..Default::default() })
            .unwrap();
        let m0 = vfs.stat("/f").unwrap();
        assert_eq!(m0.btime, 1000);
        assert_eq!(m0.mtime, 1000);
        // A later write advances mtime to the new clock.
        vfs.set_time(2000);
        vfs.write_at(ino, 0, b"data").unwrap();
        let m1 = vfs.stat("/f").unwrap();
        assert_eq!(m1.mtime, 2000);
        assert_eq!(m1.btime, 1000, "btime is stable");
    }

    #[test]
    fn rename_updates_ctime_not_btime() {
        let mut vfs = fs();
        vfs.set_time(500);
        write_file(&mut vfs, "/a", b"x");
        vfs.set_time(900);
        vfs.rename("/a", "/b").unwrap();
        let m = vfs.lstat("/b").unwrap();
        assert_eq!(m.ctime, 900, "rename bumps ctime");
        assert_eq!(m.btime, 500, "btime unchanged by rename");
    }

    #[test]
    fn mkdir_updates_parent_mtime() {
        let mut vfs = fs();
        vfs.set_time(100);
        vfs.mkdir("/d").unwrap();
        let root0 = vfs.stat("/").unwrap().mtime;
        assert_eq!(root0, 100);
        vfs.set_time(200);
        vfs.mkdir("/d2").unwrap();
        assert_eq!(vfs.stat("/").unwrap().mtime, 200, "new entry bumps dir mtime");
    }

    #[test]
    fn hydrate_rejects_corrupt_blob() {
        let mut vfs = fs();
        assert_eq!(vfs.hydrate(b"nope").unwrap_err(), Errno::Inval);
        // Valid header, truncated record.
        let mut bad = Vec::from(&b"WOFS"[..]);
        bad.push(1); // version
        bad.push(1); // file record
        bad.extend_from_slice(&99u32.to_le_bytes()); // claims 99-byte path, absent
        assert_eq!(vfs.hydrate(&bad).unwrap_err(), Errno::Inval);
    }
}
