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
use crate::hash::{sha256, Hash};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub mod mount;
pub mod path;

use mount::MountTable;

/// Content-addressed chunk size (ADR-022). Files are split into chunks of this
/// size (the last may be shorter); each chunk is stored once by its SHA-256.
/// 64 KiB keeps most source files to a single chunk while giving large-file
/// edits sub-file delta granularity.
const CHUNK_SIZE: usize = 64 * 1024;

/// A refcounted, deduplicating store of content-addressed data chunks (ADR-022).
///
/// A chunk's identity is the SHA-256 of its bytes, so identical chunks — across
/// files, and across snapshots — are stored exactly once. Refcounts track how
/// many file/snapshot references hold each chunk so its bytes can be dropped when
/// the last reference goes away (the in-kernel half of copy-on-write; the
/// persistent block store and GC mirror this host-side in later stages).
#[derive(Debug, Default)]
struct ChunkStore {
    chunks: BTreeMap<Hash, ChunkEntry>,
}

#[derive(Debug)]
struct ChunkEntry {
    bytes: Vec<u8>,
    refs: u32,
}

impl ChunkStore {
    /// Store `bytes`, or bump the refcount if an identical chunk already exists;
    /// returns the chunk's content hash.
    fn put(&mut self, bytes: Vec<u8>) -> Hash {
        let h = sha256(&bytes);
        match self.chunks.get_mut(&h) {
            Some(e) => e.refs += 1,
            None => {
                self.chunks.insert(h, ChunkEntry { bytes, refs: 1 });
            }
        }
        h
    }

    fn get(&self, h: &Hash) -> Option<&[u8]> {
        self.chunks.get(h).map(|e| e.bytes.as_slice())
    }

    /// Make a chunk's bytes available without adding a reference (refcount 0 if
    /// new, unchanged if present) — used at rehydration, before the manifest's
    /// file entries incref the chunks they reference. Returns the content hash.
    fn insert_raw(&mut self, bytes: Vec<u8>) -> Hash {
        let h = sha256(&bytes);
        self.chunks.entry(h).or_insert(ChunkEntry { bytes, refs: 0 });
        h
    }

    /// Add one reference to an already-present chunk (no-op if absent).
    fn incref(&mut self, h: &Hash) {
        if let Some(e) = self.chunks.get_mut(h) {
            e.refs += 1;
        }
    }

    /// Drop one reference; free the chunk's bytes when the last one goes.
    fn decref(&mut self, h: &Hash) {
        if let Some(e) = self.chunks.get_mut(h) {
            e.refs = e.refs.saturating_sub(1);
            if e.refs == 0 {
                self.chunks.remove(h);
            }
        }
    }
}

/// A retained point-in-time capture of the durable tree (ADR-022, ZFS-style).
///
/// A snapshot is just the serialized manifest at capture time plus the flat set
/// of chunk hashes it references. Creating one **increfs** every referenced
/// chunk so a later working-tree edit or delete cannot free bytes the snapshot
/// still needs; destroying (or ring-evicting) it decrefs them. Snapshots share
/// chunks with the working tree and each other — a snapshot of an unchanged tree
/// costs only its manifest.
#[derive(Debug, Clone)]
struct Snapshot {
    /// The durable tree serialized in the `WOM1` manifest shape at capture time.
    manifest: Vec<u8>,
    /// Every chunk hash the manifest references, held (increffed) while retained.
    chunks: Vec<Hash>,
    /// Capture time (ms since epoch, host clock).
    created: u64,
}

/// How many rolling auto-snapshots to retain (the approved last-10 undo ring).
const AUTO_RING: usize = 10;

/// One row of [`MemVfs::snap_list`]: a retained snapshot's identity + size.
#[derive(Debug, Clone)]
pub struct SnapInfo {
    /// Named snapshots carry the user's name; auto-snapshots are `"auto:<seq>"`.
    pub name: String,
    /// Capture time (ms since epoch).
    pub created: u64,
    /// Distinct chunks the snapshot references (its content footprint).
    pub chunks: usize,
    /// `true` for the rolling auto-ring, `false` for named snapshots.
    pub auto: bool,
}

/// An inode number. Stable for the lifetime of the inode.
pub type Ino = usize;

/// The root directory's inode number.
pub const ROOT_INO: Ino = 0;

/// Maximum symlink-follow depth before returning `ELOOP` (POSIX `SYMLOOP_MAX`).
const MAX_SYMLINK_DEPTH: u32 = 40;

/// What an inode is.
#[derive(Debug)]
enum Kind {
    /// A regular file: an ordered list of content-addressed chunk hashes plus
    /// the logical byte length (the last chunk may be shorter than `CHUNK_SIZE`).
    File { chunks: Vec<Hash>, size: u64 },
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
            kind: Kind::File {
                chunks: Vec::new(),
                size: 0,
            },
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
    /// The content-addressed chunk store backing file data (ADR-022).
    store: ChunkStore,
    /// Named snapshots, retained until explicitly destroyed (ADR-022).
    snapshots: BTreeMap<String, Snapshot>,
    /// The rolling auto-snapshot ring (oldest at front); capped at [`AUTO_RING`].
    auto: VecDeque<(u64, Snapshot)>,
    /// Monotonic id stamped onto each auto-snapshot (its `auto:<seq>` name).
    snap_seq: u64,
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
            store: ChunkStore::default(),
            snapshots: BTreeMap::new(),
            auto: VecDeque::new(),
            snap_seq: 0,
        }
    }

    /// Materialize a file's bytes by concatenating its chunks (ADR-022).
    fn materialize(&self, chunks: &[Hash], size: u64) -> Vec<u8> {
        let mut out = Vec::with_capacity(size as usize);
        for h in chunks {
            out.extend_from_slice(self.store.get(h).unwrap_or(&[]));
        }
        out.truncate(size as usize);
        out
    }

    /// Split `data` into content-addressed chunks, storing each (incrementing
    /// refcounts / deduping) and returning the ordered hash list.
    fn rechunk(&mut self, data: &[u8]) -> Vec<Hash> {
        if data.is_empty() {
            return Vec::new();
        }
        data.chunks(CHUNK_SIZE)
            .map(|c| self.store.put(c.to_vec()))
            .collect()
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

    /// Number of distinct content chunks currently stored — the deduplication
    /// metric (identical chunks across files/snapshots count once).
    pub fn chunk_count(&self) -> usize {
        self.store.chunks.len()
    }

    /// Physical bytes held by the chunk store after dedup (before host-side
    /// compression). Contrast with the logical `used_bytes` quota.
    pub fn physical_bytes(&self) -> u64 {
        self.store.chunks.values().map(|e| e.bytes.len() as u64).sum()
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
            Kind::File { size, .. } => (FileType::File, *size),
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
        let reap = matches!(self.slots.get(ino), Some(Some(i)) if i.nlink == 0 && i.open_count == 0)
            && ino != ROOT_INO;
        if !reap {
            return;
        }
        // Release this inode's chunks (decref, freeing bytes at the last ref) and
        // its logical size from the quota accounting.
        let released = match self.slots.get(ino) {
            Some(Some(inode)) => match &inode.kind {
                Kind::File { chunks, size } => Some((chunks.clone(), *size)),
                _ => None,
            },
            _ => None,
        };
        if let Some((chunks, size)) = released {
            for h in &chunks {
                self.store.decref(h);
            }
            self.used_bytes = self.used_bytes.saturating_sub(size);
        }
        self.inode_count = self.inode_count.saturating_sub(1);
        self.slots[ino] = None;
        self.free.push(ino);
    }
}

// --- Content-addressed persistence: manifest + chunk access (ADR-022) -------
//
// The durable filesystem persists as a *content-addressed store* (the ZFS/git
// model): file data lives as compressed chunks keyed by SHA-256 in the host's
// IndexedDB, and a `manifest` — the durable directory tree, inode metadata
// (times), symlink targets, and each file's ordered chunk-hash list — is the
// root that ties them together. Because chunks are addressed by content, the
// host persists only *new* chunk hashes on each flush (delta writes), identical
// chunks are stored once (dedup), and snapshots (Stage 4) are just retained
// manifests sharing chunks by reference (copy-on-write). The kernel owns all of
// this (INV-2); the host is a dumb block store that compresses and stores bytes
// by key. See ADR-022.
//
// Manifest wire format: `b"WOM1"` + version, then a pre-order sequence of entry
// records. Each: u8 type (0=dir,1=file,2=symlink), u32+path, u64 mtime/ctime/
// btime, then per type — file: u64 size, u32 nchunks, nchunks×32-byte hash;
// symlink: u32+target; dir: nothing.

const MANIFEST_MAGIC: &[u8; 4] = b"WOM1";
const MANIFEST_VERSION: u8 = 1;

/// Snapshot-set wire format (ADR-022, Stage 4): `b"WOSN"` + version, then a
/// `u64 snap_seq`, a `u32` count, and that many records — `u8 kind` (0=named:
/// `u32+name`; 1=auto: `u64 id`), `u64 created`, `u32+manifest` (a `WOM1` blob).
const SNAPSET_MAGIC: &[u8; 4] = b"WOSN";
const SNAPSET_VERSION: u8 = 1;

impl MemVfs {
    /// Serialize the durable directory tree + metadata + file chunk-hash lists
    /// to a manifest blob (ADR-022). Ephemeral subtrees (per `mounts`) are
    /// excluded. Does **not** include chunk bytes — those persist separately in
    /// the host block store, keyed by hash.
    pub fn manifest(&self, mounts: &MountTable) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MANIFEST_MAGIC);
        out.push(MANIFEST_VERSION);
        self.manifest_walk("/", ROOT_INO, mounts, &mut out);
        out
    }

    fn manifest_walk(&self, dir_path: &str, dir_ino: Ino, mounts: &MountTable, out: &mut Vec<u8>) {
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
                Kind::File { chunks, size } => {
                    if !ephemeral {
                        out.push(1);
                        put_bytes(out, child_path.as_bytes());
                        put_times(out, inode);
                        put_u64(out, *size);
                        out.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
                        for h in chunks {
                            out.extend_from_slice(h);
                        }
                    }
                }
                Kind::Symlink { target } => {
                    if !ephemeral {
                        out.push(2);
                        put_bytes(out, child_path.as_bytes());
                        put_times(out, inode);
                        put_bytes(out, target.as_bytes());
                    }
                }
                Kind::Dir { entries: sub } => {
                    if !ephemeral && sub.is_empty() {
                        out.push(0);
                        put_bytes(out, child_path.as_bytes());
                        put_times(out, inode);
                    }
                    if !ephemeral || mounts.has_persistent_under(&child_path) {
                        self.manifest_walk(&child_path, child, mounts, out);
                    }
                }
            }
        }
    }

    /// The set of chunk hashes referenced by durable files (ADR-022), as hex —
    /// the host uses these to know which chunks to ensure-persisted and which
    /// stored chunks are now garbage (Stage 4 GC).
    pub fn referenced_chunks(&self, mounts: &MountTable) -> Vec<String> {
        let mut set = std::collections::BTreeSet::new();
        self.collect_chunks("/", ROOT_INO, mounts, &mut set);
        set.iter().map(crate::hash::to_hex).collect()
    }

    fn collect_chunks(
        &self,
        dir_path: &str,
        dir_ino: Ino,
        mounts: &MountTable,
        set: &mut std::collections::BTreeSet<Hash>,
    ) {
        let entries = match self.slots.get(dir_ino).and_then(|s| s.as_ref()) {
            Some(Inode { kind: Kind::Dir { entries }, .. }) => entries,
            _ => return,
        };
        for (name, &child) in entries {
            let child_path = join_path(dir_path, name);
            if mounts.is_ephemeral(&child_path) {
                if let Some(Inode { kind: Kind::Dir { .. }, .. }) =
                    self.slots.get(child).and_then(|s| s.as_ref())
                {
                    if mounts.has_persistent_under(&child_path) {
                        self.collect_chunks(&child_path, child, mounts, set);
                    }
                }
                continue;
            }
            match self.slots.get(child).and_then(|s| s.as_ref()).map(|i| &i.kind) {
                Some(Kind::File { chunks, .. }) => {
                    for h in chunks {
                        set.insert(*h);
                    }
                }
                Some(Kind::Dir { .. }) => self.collect_chunks(&child_path, child, mounts, set),
                _ => {}
            }
        }
    }

    /// Fetch a chunk's bytes by hex hash — the host reads the ones it hasn't yet
    /// persisted and stores them (compressed) by key.
    pub fn chunk_bytes_hex(&self, hex: &str) -> Option<Vec<u8>> {
        let h = crate::hash::from_hex(hex)?;
        self.store.get(&h).map(|b| b.to_vec())
    }

    /// Load a chunk's bytes into the store at boot (refcount stays 0 until the
    /// manifest's file entries reference it). Verifies + returns the content
    /// hash (hex) so the host can detect a corrupt/misfiled block.
    pub fn load_chunk(&mut self, bytes: Vec<u8>) -> String {
        crate::hash::to_hex(&self.store.insert_raw(bytes))
    }

    /// Rebuild the durable tree from a [`manifest`](Self::manifest) blob at boot.
    /// Chunks referenced by file entries must already be loaded via
    /// [`load_chunk`](Self::load_chunk); each reference increfs its chunk.
    /// Malformed input returns `EINVAL` (the blob comes from browser storage).
    pub fn hydrate_manifest(&mut self, bytes: &[u8]) -> SysResult<()> {
        if bytes.len() < 5 || &bytes[0..4] != MANIFEST_MAGIC || bytes[4] != MANIFEST_VERSION {
            return Err(Errno::Inval);
        }
        let mut p = 5usize;
        while p < bytes.len() {
            let kind = take_byte(bytes, &mut p)?;
            let path = std::str::from_utf8(take_bytes(bytes, &mut p)?)
                .map_err(|_| Errno::Inval)?
                .to_string();
            let (mtime, ctime, btime) = take_times(bytes, &mut p)?;
            match kind {
                0 => {
                    let ino = self.ensure_dir(&path)?;
                    self.set_times(ino, mtime, ctime, btime);
                }
                1 => {
                    let size = take_u64(bytes, &mut p)?;
                    let nchunks = take_u32(bytes, &mut p)? as usize;
                    let mut chunks = Vec::with_capacity(nchunks);
                    for _ in 0..nchunks {
                        let h = take_hash(bytes, &mut p)?;
                        self.store.incref(&h);
                        chunks.push(h);
                    }
                    if let Some((parent, _)) = path::split(&path) {
                        self.ensure_dir(parent)?;
                    }
                    let (parent_ino, name) = self.resolve_parent(&path)?;
                    let mut inode = Inode::new_file(mtime);
                    inode.kind = Kind::File { chunks, size };
                    inode.ctime = ctime;
                    inode.btime = btime;
                    let ino = self.alloc(inode)?;
                    if let Kind::Dir { entries } = &mut self.get_mut(parent_ino)?.kind {
                        entries.insert(name.to_string(), ino);
                    }
                    self.used_bytes += size;
                }
                2 => {
                    let target = std::str::from_utf8(take_bytes(bytes, &mut p)?)
                        .map_err(|_| Errno::Inval)?
                        .to_string();
                    if let Some((parent, _)) = path::split(&path) {
                        self.ensure_dir(parent)?;
                    }
                    let ino = self.symlink(&target, &path)?;
                    self.set_times(ino, mtime, ctime, btime);
                }
                _ => return Err(Errno::Inval),
            }
        }
        Ok(())
    }

    /// `mkdir -p` returning the final directory's inode (existing or created).
    fn ensure_dir(&mut self, path: &str) -> SysResult<Ino> {
        let mut cur = String::new();
        let mut ino = ROOT_INO;
        for comp in path::components(path) {
            cur.push('/');
            cur.push_str(comp);
            ino = match self.mkdir(&cur) {
                Ok(ino) => ino,
                Err(Errno::Exist) => self.resolve_ino(&cur)?,
                Err(e) => return Err(e),
            };
        }
        Ok(ino)
    }

    fn set_times(&mut self, ino: Ino, mtime: u64, ctime: u64, btime: u64) {
        if let Ok(inode) = self.get_mut(ino) {
            inode.mtime = mtime;
            inode.ctime = ctime;
            inode.btime = btime;
        }
    }

    // --- Snapshots + mark-sweep GC (ADR-022, Stage 4) ----------------------

    /// The flat, deduplicated set of chunk hashes the durable working tree
    /// currently references (a snapshot's content footprint at capture time).
    fn working_chunks(&self, mounts: &MountTable) -> Vec<Hash> {
        let mut set = BTreeSet::new();
        self.collect_chunks("/", ROOT_INO, mounts, &mut set);
        set.into_iter().collect()
    }

    /// Create (or replace) a named snapshot of the current durable tree. Every
    /// chunk it references is increffed so a later working-tree edit or delete
    /// cannot free bytes the snapshot still needs; a same-name replace releases
    /// the previous capture's holds.
    pub fn snap_create(&mut self, name: &str, mounts: &MountTable) -> SysResult<()> {
        let manifest = self.manifest(mounts);
        let chunks = self.working_chunks(mounts);
        for h in &chunks {
            self.store.incref(h);
        }
        let snap = Snapshot { manifest, chunks, created: self.now };
        if let Some(old) = self.snapshots.insert(name.to_string(), snap) {
            for h in &old.chunks {
                self.store.decref(h);
            }
        }
        self.generation += 1;
        Ok(())
    }

    /// Push a rolling auto-snapshot of the durable tree, evicting the oldest once
    /// the ring exceeds [`AUTO_RING`] (the approved last-10 undo history). Does
    /// not bump the generation — the host takes these *during* a flush, so the
    /// same flush persists them.
    pub fn snap_auto(&mut self, mounts: &MountTable) {
        let manifest = self.manifest(mounts);
        let chunks = self.working_chunks(mounts);
        for h in &chunks {
            self.store.incref(h);
        }
        let id = self.snap_seq;
        self.snap_seq += 1;
        self.auto.push_back((id, Snapshot { manifest, chunks, created: self.now }));
        while self.auto.len() > AUTO_RING {
            if let Some((_, old)) = self.auto.pop_front() {
                for h in &old.chunks {
                    self.store.decref(h);
                }
            }
        }
    }

    /// Destroy a named snapshot, releasing its chunk holds (bytes freed at the
    /// last reference). `ENOENT` if no such name.
    pub fn snap_destroy(&mut self, name: &str) -> SysResult<()> {
        match self.snapshots.remove(name) {
            Some(s) => {
                for h in &s.chunks {
                    self.store.decref(h);
                }
                self.generation += 1;
                Ok(())
            }
            None => Err(Errno::Noent),
        }
    }

    /// List retained snapshots: named (sorted) first, then the auto ring from
    /// oldest to newest.
    pub fn snap_list(&self) -> Vec<SnapInfo> {
        let mut out: Vec<SnapInfo> = self
            .snapshots
            .iter()
            .map(|(name, s)| SnapInfo {
                name: name.clone(),
                created: s.created,
                chunks: s.chunks.len(),
                auto: false,
            })
            .collect();
        for (id, s) in &self.auto {
            out.push(SnapInfo {
                name: format!("auto:{id}"),
                created: s.created,
                chunks: s.chunks.len(),
                auto: true,
            });
        }
        out
    }

    fn find_snapshot(&self, name: &str) -> Option<&Snapshot> {
        if let Some(s) = self.snapshots.get(name) {
            return Some(s);
        }
        let id = name.strip_prefix("auto:").and_then(|n| n.parse::<u64>().ok())?;
        self.auto.iter().find(|(i, _)| *i == id).map(|(_, s)| s)
    }

    /// Restore the durable tree to a snapshot's captured state: the persistent
    /// working tree is wiped and rebuilt from the snapshot's manifest, while
    /// ephemeral subtrees (e.g. `/tmp`) are left untouched. The snapshot itself
    /// is retained (restore is non-destructive to history). `ENOENT` if unknown.
    pub fn snap_restore(&mut self, name: &str, mounts: &MountTable) -> SysResult<()> {
        let manifest = match self.find_snapshot(name) {
            Some(s) => s.manifest.clone(),
            None => return Err(Errno::Noent),
        };
        self.clear_persistent(mounts);
        self.hydrate_manifest(&manifest)?;
        self.generation += 1;
        Ok(())
    }

    /// The chunk hashes (hex) that must survive garbage collection: every chunk
    /// referenced by the durable working tree **or** any retained snapshot. The
    /// host deletes any stored chunk whose key is absent here (mark-sweep GC).
    pub fn live_chunks(&self, mounts: &MountTable) -> Vec<String> {
        let mut set = BTreeSet::new();
        self.collect_chunks("/", ROOT_INO, mounts, &mut set);
        for s in self.snapshots.values() {
            set.extend(s.chunks.iter().copied());
        }
        for (_, s) in &self.auto {
            set.extend(s.chunks.iter().copied());
        }
        set.iter().map(crate::hash::to_hex).collect()
    }

    /// Remove every persistent entry from the tree (decref-ing file chunks and
    /// reclaiming quota), leaving ephemeral subtrees intact — the pre-step of a
    /// snapshot restore.
    fn clear_persistent(&mut self, mounts: &MountTable) {
        self.clear_dir("/", ROOT_INO, mounts);
    }

    fn clear_dir(&mut self, dir_path: &str, dir_ino: Ino, mounts: &MountTable) {
        let children: Vec<(String, Ino)> = match self.slots.get(dir_ino).and_then(|s| s.as_ref()) {
            Some(Inode { kind: Kind::Dir { entries }, .. }) => {
                entries.iter().map(|(n, &i)| (n.clone(), i)).collect()
            }
            _ => return,
        };
        for (name, child) in children {
            let child_path = join_path(dir_path, &name);
            if mounts.is_ephemeral(&child_path) {
                // Keep the ephemeral entry, but descend to reach a persistent carve-out.
                let is_dir = matches!(
                    self.slots.get(child).and_then(|s| s.as_ref()),
                    Some(Inode { kind: Kind::Dir { .. }, .. })
                );
                if is_dir && mounts.has_persistent_under(&child_path) {
                    self.clear_dir(&child_path, child, mounts);
                }
            } else {
                self.remove_subtree(child);
                if let Ok(inode) = self.get_mut(dir_ino) {
                    if let Kind::Dir { entries } = &mut inode.kind {
                        entries.remove(&name);
                    }
                }
            }
        }
    }

    /// Recursively free an inode subtree (children first, then the node), using
    /// the reap path so file chunks are decreffed and quota reclaimed.
    fn remove_subtree(&mut self, ino: Ino) {
        let kids: Vec<Ino> = match self.slots.get(ino).and_then(|s| s.as_ref()) {
            Some(Inode { kind: Kind::Dir { entries }, .. }) => entries.values().copied().collect(),
            _ => Vec::new(),
        };
        for k in kids {
            self.remove_subtree(k);
        }
        if let Ok(inode) = self.get_mut(ino) {
            inode.nlink = 0;
            inode.open_count = 0;
        }
        self.maybe_reap(ino);
    }

    /// Serialize all retained snapshots (named + auto ring) to a blob the host
    /// stores so they outlive a reload. Chunk *bytes* are not included — they
    /// live in the shared block store, referenced by the embedded manifests.
    pub fn snap_export(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(SNAPSET_MAGIC);
        out.push(SNAPSET_VERSION);
        put_u64(&mut out, self.snap_seq);
        let total = (self.snapshots.len() + self.auto.len()) as u32;
        out.extend_from_slice(&total.to_le_bytes());
        for (name, s) in &self.snapshots {
            out.push(0); // named
            put_bytes(&mut out, name.as_bytes());
            put_u64(&mut out, s.created);
            put_bytes(&mut out, &s.manifest);
        }
        for (id, s) in &self.auto {
            out.push(1); // auto
            put_u64(&mut out, *id);
            put_u64(&mut out, s.created);
            put_bytes(&mut out, &s.manifest);
        }
        out
    }

    /// Re-register snapshots from a [`snap_export`](Self::snap_export) blob at
    /// boot, increffing the chunks each manifest references (which must already
    /// be loaded via [`load_chunk`](Self::load_chunk)). `EINVAL` on a corrupt blob.
    pub fn snap_import(&mut self, bytes: &[u8]) -> SysResult<()> {
        if bytes.len() < 5 || &bytes[0..4] != SNAPSET_MAGIC || bytes[4] != SNAPSET_VERSION {
            return Err(Errno::Inval);
        }
        let mut p = 5usize;
        self.snap_seq = self.snap_seq.max(take_u64(bytes, &mut p)?);
        let count = take_u32(bytes, &mut p)?;
        for _ in 0..count {
            let kind = take_byte(bytes, &mut p)?;
            let (name, id, is_auto) = match kind {
                0 => {
                    let name = std::str::from_utf8(take_bytes(bytes, &mut p)?)
                        .map_err(|_| Errno::Inval)?
                        .to_string();
                    (Some(name), 0, false)
                }
                1 => (None, take_u64(bytes, &mut p)?, true),
                _ => return Err(Errno::Inval),
            };
            let created = take_u64(bytes, &mut p)?;
            let manifest = take_bytes(bytes, &mut p)?.to_vec();
            let chunks = parse_manifest_chunks(&manifest)?;
            for h in &chunks {
                self.store.incref(h);
            }
            let snap = Snapshot { manifest, chunks, created };
            if is_auto {
                self.auto.push_back((id, snap));
            } else if let Some(name) = name {
                self.snapshots.insert(name, snap);
            }
        }
        Ok(())
    }
}

/// Append a `u64` (little-endian).
fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Append an inode's mtime/ctime/btime.
fn put_times(out: &mut Vec<u8>, inode: &Inode) {
    put_u64(out, inode.mtime);
    put_u64(out, inode.ctime);
    put_u64(out, inode.btime);
}

fn take_byte(bytes: &[u8], p: &mut usize) -> SysResult<u8> {
    let b = *bytes.get(*p).ok_or(Errno::Inval)?;
    *p += 1;
    Ok(b)
}

fn take_u32(bytes: &[u8], p: &mut usize) -> SysResult<u32> {
    if *p + 4 > bytes.len() {
        return Err(Errno::Inval);
    }
    let v = u32::from_le_bytes(bytes[*p..*p + 4].try_into().unwrap());
    *p += 4;
    Ok(v)
}

fn take_u64(bytes: &[u8], p: &mut usize) -> SysResult<u64> {
    if *p + 8 > bytes.len() {
        return Err(Errno::Inval);
    }
    let v = u64::from_le_bytes(bytes[*p..*p + 8].try_into().unwrap());
    *p += 8;
    Ok(v)
}

fn take_times(bytes: &[u8], p: &mut usize) -> SysResult<(u64, u64, u64)> {
    Ok((
        take_u64(bytes, p)?,
        take_u64(bytes, p)?,
        take_u64(bytes, p)?,
    ))
}

fn take_hash(bytes: &[u8], p: &mut usize) -> SysResult<Hash> {
    if *p + 32 > bytes.len() {
        return Err(Errno::Inval);
    }
    let mut h = [0u8; 32];
    h.copy_from_slice(&bytes[*p..*p + 32]);
    *p += 32;
    Ok(h)
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

/// Collect the deduplicated chunk hashes a `WOM1` manifest references — used to
/// re-hold a snapshot's chunks on import without re-walking a live tree. Mirrors
/// the record grammar of [`MemVfs::hydrate_manifest`]; `EINVAL` on corruption.
fn parse_manifest_chunks(bytes: &[u8]) -> SysResult<Vec<Hash>> {
    if bytes.len() < 5 || &bytes[0..4] != MANIFEST_MAGIC || bytes[4] != MANIFEST_VERSION {
        return Err(Errno::Inval);
    }
    let mut set = BTreeSet::new();
    let mut p = 5usize;
    while p < bytes.len() {
        let kind = take_byte(bytes, &mut p)?;
        let _path = take_bytes(bytes, &mut p)?;
        let _times = take_times(bytes, &mut p)?;
        match kind {
            0 => {}
            1 => {
                let _size = take_u64(bytes, &mut p)?;
                let n = take_u32(bytes, &mut p)? as usize;
                for _ in 0..n {
                    set.insert(take_hash(bytes, &mut p)?);
                }
            }
            2 => {
                let _target = take_bytes(bytes, &mut p)?;
            }
            _ => return Err(Errno::Inval),
        }
    }
    Ok(set.into_iter().collect())
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

        if opts.directory && !self.get(ino)?.is_dir() {
            return Err(Errno::Notdir);
        }
        let mut freed = 0u64;
        if opts.truncate {
            // Release the file's chunks and clear it to zero length.
            let old = match &self.get(ino)?.kind {
                Kind::File { chunks, size } => Some((chunks.clone(), *size)),
                _ => None,
            };
            if let Some((chunks, size)) = old {
                for h in &chunks {
                    self.store.decref(h);
                }
                if let Kind::File { chunks: c, size: s } = &mut self.get_mut(ino)?.kind {
                    c.clear();
                    *s = 0;
                }
                freed = size;
            }
        }
        self.get_mut(ino)?.open_count += 1;
        // Release the truncated bytes from the quota accounting.
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
        let (chunks, size) = match &self.get(ino)?.kind {
            Kind::File { chunks, size } => (chunks, *size),
            Kind::Dir { .. } => return Err(Errno::Isdir),
            Kind::Symlink { .. } => return Err(Errno::Inval),
        };
        if offset >= size {
            return Ok(0);
        }
        let end = (offset + buf.len() as u64).min(size) as usize;
        let mut pos = offset as usize;
        let mut written = 0;
        while pos < end {
            let chunk = self.store.get(&chunks[pos / CHUNK_SIZE]).unwrap_or(&[]);
            let within = pos % CHUNK_SIZE;
            let n = chunk.len().saturating_sub(within).min(end - pos);
            if n == 0 {
                break; // defensive: chunk shorter than expected
            }
            buf[written..written + n].copy_from_slice(&chunk[within..within + n]);
            written += n;
            pos += n;
        }
        Ok(written)
    }

    fn write_at(&mut self, ino: Ino, offset: u64, src: &[u8]) -> SysResult<usize> {
        // Snapshot the file's current chunk list + size (cheap: 32-byte hashes).
        let (old_chunks, old_size) = match &self.get(ino)?.kind {
            Kind::File { chunks, size } => (chunks.clone(), *size),
            Kind::Dir { .. } => return Err(Errno::Isdir),
            Kind::Symlink { .. } => return Err(Errno::Inval),
        };
        let start = offset as usize;
        let new_size = old_size.max(offset + src.len() as u64);
        // Quota (ADR-020) is on *logical* size (what the guest sees), so dedup
        // never lets a guest exceed its byte budget. A write past quota is
        // refused whole with `ENOSPC`.
        let growth = new_size - old_size;
        if self.used_bytes + growth > self.max_bytes {
            return Err(Errno::Nospc);
        }
        // Read-modify-rechunk. Materializing then re-chunking the whole file is
        // simple and correct; because identical regions re-hash to the same
        // chunks, dedup keeps the *physical* delta (and the persisted delta,
        // Stage 3) to just the changed chunks. `rechunk` increfs the new chunks
        // before we decref the old, so a chunk shared across the edit never
        // transiently drops to zero.
        let mut data = self.materialize(&old_chunks, old_size);
        if data.len() < new_size as usize {
            data.resize(new_size as usize, 0);
        }
        data[start..start + src.len()].copy_from_slice(src);
        let new_chunks = self.rechunk(&data);
        for h in &old_chunks {
            self.store.decref(h);
        }
        if let Kind::File { chunks, size } = &mut self.get_mut(ino)?.kind {
            *chunks = new_chunks;
            *size = new_size;
        }
        self.used_bytes += growth;
        self.touch_mtime(ino);
        self.bump();
        Ok(src.len())
    }

    fn size(&self, ino: Ino) -> SysResult<u64> {
        match &self.get(ino)?.kind {
            Kind::File { size, .. } => Ok(*size),
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

    // --- Content-addressed storage (dedup / delta / COW, ADR-022) -----------

    // --- Content-addressed persistence: manifest round-trip (ADR-022) -------

    /// Round-trip a VFS through the content-addressed persistence path, the way
    /// the host does: serialize the manifest, copy the referenced chunks into a
    /// simulated block store, then rebuild a fresh VFS from them.
    fn persist_and_restore(src: &MemVfs, mounts: &mount::MountTable) -> MemVfs {
        let manifest = src.manifest(mounts);
        // Host block store: hex hash -> chunk bytes (only the referenced ones).
        let block_store: Vec<(String, Vec<u8>)> = src
            .referenced_chunks(mounts)
            .into_iter()
            .map(|hex| {
                let bytes = src.chunk_bytes_hex(&hex).expect("referenced chunk present");
                (hex, bytes)
            })
            .collect();
        let mut dst = fs();
        for (hex, bytes) in &block_store {
            let got = dst.load_chunk(bytes.clone());
            assert_eq!(&got, hex, "chunk hash must match its key (integrity)");
        }
        dst.hydrate_manifest(&manifest).unwrap();
        dst
    }

    #[test]
    fn manifest_round_trip_preserves_files_dedup_and_metadata() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        vfs.set_time(1234);
        write_file(&mut vfs, "/proj/a.js", b"shared body");
        write_file(&mut vfs, "/proj/b.js", b"shared body"); // dedup with a.js
        write_file(&mut vfs, "/proj/src/big.bin", &(0..100_000u32).map(|i| i as u8).collect::<Vec<_>>());
        vfs.symlink("/proj/a.js", "/proj/link").unwrap();
        vfs.mkdir("/proj/emptydir").unwrap();
        write_file(&mut vfs, "/tmp/scratch", b"ephemeral"); // excluded

        let restored = persist_and_restore(&vfs, &mounts);

        // File contents survive.
        assert_eq!(read_file(&restored, "/proj/a.js"), b"shared body");
        assert_eq!(read_file(&restored, "/proj/b.js"), b"shared body");
        assert_eq!(read_file(&restored, "/proj/src/big.bin").len(), 100_000);
        // Dedup is preserved across persistence: the restored store holds exactly
        // the durable unique chunks (a.js/b.js share one; big.bin is two), and no
        // ephemeral /tmp chunk came along.
        assert_eq!(restored.chunk_count(), vfs.referenced_chunks(&mounts).len());
        assert_eq!(restored.chunk_count(), 3);
        // Symlink + empty dir survive; /tmp is gone.
        assert_eq!(restored.readlink("/proj/link").unwrap(), "/proj/a.js");
        assert_eq!(restored.stat("/proj/emptydir").unwrap().file_type, FileType::Dir);
        assert_eq!(restored.resolve("/tmp/scratch").unwrap_err(), Errno::Noent);
        // Timestamps survive.
        assert_eq!(restored.lstat("/proj/a.js").unwrap().mtime, 1234);
    }

    #[test]
    fn manifest_refcounts_survive_so_unlink_frees_correctly() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        write_file(&mut vfs, "/a", b"dup");
        write_file(&mut vfs, "/b", b"dup");
        let mut restored = persist_and_restore(&vfs, &mounts);
        assert_eq!(restored.chunk_count(), 1);
        // Refcount must be 2 after hydrate: unlinking one keeps the chunk.
        restored.unlink("/a").unwrap();
        assert_eq!(restored.chunk_count(), 1, "still referenced by /b");
        restored.unlink("/b").unwrap();
        assert_eq!(restored.chunk_count(), 0, "last reference gone");
    }

    #[test]
    fn hydrate_manifest_rejects_corrupt_blob() {
        let mut vfs = fs();
        assert_eq!(vfs.hydrate_manifest(b"XX").unwrap_err(), Errno::Inval);
        assert_eq!(vfs.hydrate_manifest(b"WOM1\x01\x09").unwrap_err(), Errno::Inval);
    }

    // --- Snapshots + mark-sweep GC (ADR-022, Stage 4) -----------------------

    /// Simulate a full reload the way the host does with snapshots: the block
    /// store carries every *live* chunk (working tree ∪ snapshots), and the
    /// snapshot set is exported/re-imported alongside the working manifest.
    fn reload_with_snapshots(src: &MemVfs, mounts: &mount::MountTable) -> MemVfs {
        let manifest = src.manifest(mounts);
        let snapset = src.snap_export();
        let block: Vec<(String, Vec<u8>)> = src
            .live_chunks(mounts)
            .into_iter()
            .map(|hex| {
                let bytes = src.chunk_bytes_hex(&hex).expect("live chunk present");
                (hex, bytes)
            })
            .collect();
        let mut dst = fs();
        for (hex, bytes) in &block {
            assert_eq!(&dst.load_chunk(bytes.clone()), hex, "chunk integrity");
        }
        dst.hydrate_manifest(&manifest).unwrap();
        dst.snap_import(&snapset).unwrap();
        dst
    }

    #[test]
    fn snapshot_retains_chunks_after_working_delete_and_restores() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        vfs.set_time(100);
        write_file(&mut vfs, "/keep.txt", b"v1");
        vfs.snap_create("s1", &mounts).unwrap();
        assert_eq!(vfs.snap_list().len(), 1);

        // Delete from the working tree — the snapshot's incref keeps the bytes.
        vfs.unlink("/keep.txt").unwrap();
        assert!(vfs.resolve("/keep.txt").is_err());
        assert_eq!(vfs.chunk_count(), 1, "chunk held by the snapshot");
        assert_eq!(vfs.live_chunks(&mounts).len(), 1);

        // Restore brings the file back byte-for-byte.
        vfs.snap_restore("s1", &mounts).unwrap();
        assert_eq!(read_file(&vfs, "/keep.txt"), b"v1");
    }

    #[test]
    fn snapshot_destroy_releases_chunks() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        write_file(&mut vfs, "/f", b"data");
        vfs.snap_create("s", &mounts).unwrap();
        vfs.unlink("/f").unwrap();
        assert_eq!(vfs.chunk_count(), 1, "held by the snapshot");
        vfs.snap_destroy("s").unwrap();
        assert_eq!(vfs.chunk_count(), 0, "last reference gone");
        assert_eq!(vfs.snap_destroy("s").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn auto_ring_keeps_last_ten() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        for i in 0..12 {
            write_file(&mut vfs, &format!("/f{i}"), format!("body{i}").as_bytes());
            vfs.snap_auto(&mounts);
        }
        let autos: Vec<_> = vfs.snap_list().into_iter().filter(|s| s.auto).collect();
        assert_eq!(autos.len(), AUTO_RING);
        // The two oldest (auto:0, auto:1) rolled off; the ring is [auto:2..auto:11].
        assert_eq!(autos.first().unwrap().name, "auto:2");
        assert_eq!(autos.last().unwrap().name, "auto:11");
    }

    #[test]
    fn auto_ring_eviction_frees_orphaned_chunks() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        // A file captured only by the oldest auto-snapshot, then deleted.
        write_file(&mut vfs, "/ghost", b"unique-ghost-bytes");
        vfs.snap_auto(&mounts); // auto:0 holds the ghost chunk
        vfs.unlink("/ghost").unwrap();
        assert_eq!(vfs.chunk_count(), 1, "held only by auto:0");
        // Push AUTO_RING more auto-snapshots to roll auto:0 off the ring.
        for _ in 0..AUTO_RING {
            vfs.snap_auto(&mounts);
        }
        assert_eq!(vfs.chunk_count(), 0, "auto:0 evicted → ghost chunk freed");
    }

    #[test]
    fn restore_replaces_working_tree_but_keeps_ephemeral() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        vfs.set_time(1);
        write_file(&mut vfs, "/proj/a", b"A1");
        vfs.snap_create("base", &mounts).unwrap();

        // Mutate the persistent tree and scribble in ephemeral /tmp.
        write_file(&mut vfs, "/proj/a", b"A2-modified-and-longer");
        write_file(&mut vfs, "/proj/b", b"added-after-snapshot");
        write_file(&mut vfs, "/tmp/scratch", b"temp");

        vfs.snap_restore("base", &mounts).unwrap();
        assert_eq!(read_file(&vfs, "/proj/a"), b"A1", "reverted");
        assert_eq!(vfs.resolve("/proj/b").unwrap_err(), Errno::Noent, "post-snap add removed");
        assert_eq!(read_file(&vfs, "/tmp/scratch"), b"temp", "ephemeral untouched");
    }

    #[test]
    fn live_chunks_is_working_union_snapshots() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        write_file(&mut vfs, "/a", b"alpha");
        vfs.snap_create("s", &mounts).unwrap();
        write_file(&mut vfs, "/b", b"beta");
        vfs.unlink("/a").unwrap(); // alpha now held only by the snapshot

        assert_eq!(vfs.live_chunks(&mounts).len(), 2, "beta (working) + alpha (snapshot)");
        vfs.snap_destroy("s").unwrap();
        assert_eq!(vfs.live_chunks(&mounts).len(), 1, "only beta remains live");
        assert_eq!(vfs.chunk_count(), 1, "alpha's bytes were swept");
    }

    #[test]
    fn snapshots_survive_reload_and_restore_afterwards() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        vfs.set_time(7);
        write_file(&mut vfs, "/keep", b"persisted");
        vfs.snap_create("release-1", &mounts).unwrap();
        vfs.unlink("/keep").unwrap(); // only the snapshot holds it now

        let mut reloaded = reload_with_snapshots(&vfs, &mounts);
        let listed = reloaded.snap_list();
        let s = listed.iter().find(|s| s.name == "release-1").expect("snapshot survived");
        assert!(!s.auto);
        assert_eq!(s.created, 7, "capture time survived");

        // The snapshot-only chunk rode across the reload via the live set, so a
        // post-reload restore rebuilds the file byte-for-byte.
        reloaded.snap_restore("release-1", &mounts).unwrap();
        assert_eq!(read_file(&reloaded, "/keep"), b"persisted");
    }

    #[test]
    fn snap_import_rejects_corrupt_blob() {
        let mut vfs = fs();
        assert_eq!(vfs.snap_import(b"XX").unwrap_err(), Errno::Inval);
        assert_eq!(vfs.snap_import(b"WOSN\x02").unwrap_err(), Errno::Inval);
    }

    #[test]
    fn identical_files_share_one_chunk() {
        let mut vfs = fs();
        write_file(&mut vfs, "/a.txt", b"the same content");
        write_file(&mut vfs, "/b.txt", b"the same content");
        // Dedup: one physical chunk, but the logical quota counts both files.
        assert_eq!(vfs.chunk_count(), 1);
        assert_eq!(vfs.physical_bytes(), "the same content".len() as u64);
        assert_eq!(vfs.used_bytes, 2 * "the same content".len() as u64);
        // Both read back correctly.
        assert_eq!(read_file(&vfs, "/a.txt"), b"the same content");
        assert_eq!(read_file(&vfs, "/b.txt"), b"the same content");
    }

    #[test]
    fn large_file_splits_into_chunks_and_reads_back() {
        let mut vfs = fs();
        // 150 KiB → 3 chunks (64 + 64 + 22 KiB).
        let data: Vec<u8> = (0..150 * 1024).map(|i| (i % 251) as u8).collect();
        write_file(&mut vfs, "/big", &data);
        assert_eq!(vfs.chunk_count(), 3);
        assert_eq!(read_file(&vfs, "/big"), data);
        // A partial read across a chunk boundary is correct.
        let ino = vfs.resolve("/big").unwrap();
        let mut buf = vec![0u8; 100];
        let n = vfs.read_at(ino, 64 * 1024 - 50, &mut buf).unwrap();
        assert_eq!(n, 100);
        assert_eq!(buf, &data[64 * 1024 - 50..64 * 1024 + 50]);
    }

    #[test]
    fn editing_one_chunk_shares_the_rest() {
        let mut vfs = fs();
        let data: Vec<u8> = (0..150 * 1024).map(|i| (i % 251) as u8).collect();
        write_file(&mut vfs, "/a", &data);
        write_file(&mut vfs, "/b", &data); // identical → 3 shared chunks
        assert_eq!(vfs.chunk_count(), 3);
        // Overwrite the first 10 bytes of /b: only its first chunk diverges; the
        // trailing two chunks stay shared with /a. So 4 chunks total, not 6.
        let ino = vfs.resolve("/b").unwrap();
        vfs.write_at(ino, 0, b"XXXXXXXXXX").unwrap();
        assert_eq!(vfs.chunk_count(), 4, "only the edited chunk diverges");
        // Both files still read correctly.
        assert_eq!(read_file(&vfs, "/a"), data);
        let mut expected = data.clone();
        expected[..10].copy_from_slice(b"XXXXXXXXXX");
        assert_eq!(read_file(&vfs, "/b"), expected);
    }

    #[test]
    fn chunk_freed_only_when_last_reference_drops() {
        let mut vfs = fs();
        write_file(&mut vfs, "/a", b"shared");
        write_file(&mut vfs, "/b", b"shared");
        assert_eq!(vfs.chunk_count(), 1);
        vfs.unlink("/a").unwrap();
        assert_eq!(vfs.chunk_count(), 1, "still referenced by /b");
        vfs.unlink("/b").unwrap();
        assert_eq!(vfs.chunk_count(), 0, "last reference gone → chunk freed");
        assert_eq!(vfs.physical_bytes(), 0);
    }

    #[test]
    fn truncate_releases_chunks() {
        let mut vfs = fs();
        let data: Vec<u8> = (0..100 * 1024).map(|i| i as u8).collect();
        write_file(&mut vfs, "/f", &data);
        assert!(vfs.chunk_count() >= 2);
        // Re-open with truncate.
        let ino = vfs
            .open("/f", OpenOptions { create: false, truncate: true, ..Default::default() })
            .unwrap();
        vfs.close(ino).unwrap();
        assert_eq!(vfs.chunk_count(), 0);
        assert_eq!(vfs.size(ino).unwrap_or(0), 0);
    }

    #[test]
    fn persistence_excludes_ephemeral_paths() {
        let mounts = mount::MountTable::default();
        let mut vfs = fs();
        write_file(&mut vfs, "/keep.js", b"durable");
        // /tmp and OS trees are ephemeral by default.
        write_file(&mut vfs, "/tmp/app/index.js", b"scratch");
        write_file(&mut vfs, "/tmp/app/node_modules/dep/index.js", b"dep");
        write_file(&mut vfs, "/bin/mytool", b"binary");

        let restored = persist_and_restore(&vfs, &mounts);

        assert_eq!(read_file(&restored, "/keep.js"), b"durable");
        assert_eq!(restored.resolve("/tmp/app/index.js").unwrap_err(), Errno::Noent);
        assert_eq!(
            restored.resolve("/tmp/app/node_modules/dep/index.js").unwrap_err(),
            Errno::Noent
        );
        assert_eq!(restored.resolve("/bin/mytool").unwrap_err(), Errno::Noent);
    }

    #[test]
    fn persistence_keeps_persistent_carveout_under_ephemeral() {
        let mut mounts = mount::MountTable::default();
        mounts.mount("/tmp/keep", mount::Durability::Persist);
        let mut vfs = fs();
        write_file(&mut vfs, "/tmp/scratch.js", b"gone");
        write_file(&mut vfs, "/tmp/keep/data.json", b"{\"a\":1}");

        let restored = persist_and_restore(&vfs, &mounts);

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
}
