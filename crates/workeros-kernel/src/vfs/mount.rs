//! Path-based durability policy (ADR-022).
//!
//! Persistence is not a per-file flag but a property of *where* a file lives —
//! the Unix `tmpfs`-at-`/tmp` model. A [`MountTable`] maps path prefixes to a
//! [`Durability`], and the snapshot walk (`MemVfs::snapshot`) uses it to prune
//! ephemeral subtrees so only durable paths are projected to persistent storage.
//!
//! Durability is resolved by **longest-prefix match**, so a specific ephemeral
//! carve-out (`/tmp`) overrides the persistent root (`/`), and a persistent
//! carve-out under an ephemeral prefix would override it in turn. Matching is
//! path-component-aware: `/tmp` covers `/tmp` and `/tmp/foo`, never `/tmpx`.
//!
//! The default policy persists the root workspace and treats as ephemeral both
//! `/tmp` (user scratch — scaffold a project, `npm install`, discard on close)
//! and the OS-owned trees (`/bin`, `/sbin`, `/lib`, `/etc`) which are reinstalled
//! at every boot, so persisting them is pure waste. `/etc` holds OS-shipped config
//! (e.g. the default `/etc/profile`), reshipped each boot so an upgraded default
//! reaches existing sessions; user overrides go in the persistent `~/.profile`.

/// Whether a path's contents survive across sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// Projected to persistent storage (IndexedDB) and restored on boot.
    Persist,
    /// Never persisted; discarded when the tab closes.
    Ephemeral,
}

/// The path prefixes treated as ephemeral by default (see module docs).
pub const DEFAULT_EPHEMERAL: &[&str] = &["/tmp", "/bin", "/sbin", "/lib", "/etc"];

/// A durability policy: an unordered set of `(prefix, durability)` rules plus a
/// root default. Longest matching prefix wins.
#[derive(Debug, Clone)]
pub struct MountTable {
    /// Durability of `/` — the fallback when no more specific prefix matches.
    root: Durability,
    /// Prefix rules (normalized, no trailing slash except root). Not the root.
    rules: Vec<(String, Durability)>,
}

impl Default for MountTable {
    /// The recommended v1 policy: persistent root, ephemeral `/tmp` + OS trees.
    fn default() -> Self {
        let mut t = MountTable {
            root: Durability::Persist,
            rules: Vec::new(),
        };
        for prefix in DEFAULT_EPHEMERAL {
            t.mount(prefix, Durability::Ephemeral);
        }
        t
    }
}

impl MountTable {
    /// A table with an explicit root durability and no carve-outs.
    pub fn with_root(root: Durability) -> Self {
        MountTable {
            root,
            rules: Vec::new(),
        }
    }

    /// Set the durability of a subtree. `prefix` must be an absolute path; a
    /// trailing slash is ignored. Re-mounting the same prefix replaces the rule.
    /// Mounting `/` sets the root default.
    pub fn mount(&mut self, prefix: &str, durability: Durability) {
        let key = normalize_prefix(prefix);
        if key == "/" {
            self.root = durability;
            return;
        }
        if let Some(slot) = self.rules.iter_mut().find(|(p, _)| *p == key) {
            slot.1 = durability;
        } else {
            self.rules.push((key, durability));
        }
    }

    /// The durability that applies to `path` (longest-prefix match).
    pub fn durability(&self, path: &str) -> Durability {
        let key = normalize_prefix(path);
        let mut best: Option<(usize, Durability)> = None;
        for (prefix, d) in &self.rules {
            if prefix_covers(prefix, &key) {
                let len = prefix.len();
                if best.map_or(true, |(blen, _)| len > blen) {
                    best = Some((len, *d));
                }
            }
        }
        best.map(|(_, d)| d).unwrap_or(self.root)
    }

    /// Convenience: is `path` in an ephemeral subtree?
    pub fn is_ephemeral(&self, path: &str) -> bool {
        self.durability(path) == Durability::Ephemeral
    }

    /// True if some persistent rule is nested strictly under `prefix`. The
    /// snapshot walk uses this to decide whether descending into an ephemeral
    /// directory could still find a persistent carve-out — when it can't, the
    /// whole ephemeral subtree (e.g. a `/tmp/node_modules` with 50k files) is
    /// skipped without being walked.
    pub fn has_persistent_under(&self, prefix: &str) -> bool {
        let key = normalize_prefix(prefix);
        self.rules.iter().any(|(p, d)| {
            *d == Durability::Persist && p.len() > key.len() && prefix_covers(&key, p)
        })
    }
}

/// Normalize a prefix/path for comparison: strip a trailing slash (but keep the
/// lone root `/`). Assumes an already-normalized absolute path (see `path::normalize`).
fn normalize_prefix(p: &str) -> String {
    if p.len() > 1 {
        p.trim_end_matches('/').to_string()
    } else {
        p.to_string()
    }
}

/// True if `prefix` covers `path`: equal, or `path` sits inside `prefix/`.
/// Component-aware so `/tmp` covers `/tmp/x` but not `/tmpx`.
fn prefix_covers(prefix: &str, path: &str) -> bool {
    if prefix == path {
        return true;
    }
    match path.strip_prefix(prefix) {
        Some(rest) => rest.starts_with('/'),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy() {
        let t = MountTable::default();
        // Root and ordinary user paths persist.
        assert_eq!(t.durability("/"), Durability::Persist);
        assert_eq!(t.durability("/project/main.js"), Durability::Persist);
        // /tmp and OS trees are ephemeral, including their descendants.
        assert!(t.is_ephemeral("/tmp"));
        assert!(t.is_ephemeral("/tmp/app/node_modules/x/index.js"));
        assert!(t.is_ephemeral("/bin/npm"));
        assert!(t.is_ephemeral("/sbin/ls"));
        assert!(t.is_ephemeral("/lib/workeros-node/fs.js"));
        assert!(t.is_ephemeral("/etc/profile"));
    }

    #[test]
    fn prefix_is_component_aware() {
        let t = MountTable::default();
        // /tmpx is NOT under the /tmp rule.
        assert_eq!(t.durability("/tmpx"), Durability::Persist);
        assert_eq!(t.durability("/tmpfile"), Durability::Persist);
    }

    #[test]
    fn longest_prefix_wins() {
        let mut t = MountTable::default();
        // Carve a persistent island out of an ephemeral /tmp.
        t.mount("/tmp/keep", Durability::Persist);
        assert!(t.is_ephemeral("/tmp/scratch/a"));
        assert_eq!(t.durability("/tmp/keep"), Durability::Persist);
        assert_eq!(t.durability("/tmp/keep/deep/file"), Durability::Persist);
    }

    #[test]
    fn remount_replaces_and_trailing_slash_ignored() {
        let mut t = MountTable::default();
        t.mount("/tmp/", Durability::Persist); // trailing slash, same prefix
        assert_eq!(t.durability("/tmp/x"), Durability::Persist);
        t.mount("/data", Durability::Ephemeral);
        assert!(t.is_ephemeral("/data/big"));
    }

    #[test]
    fn root_default_is_configurable() {
        let mut t = MountTable::with_root(Durability::Ephemeral);
        assert!(t.is_ephemeral("/anything"));
        t.mount("/", Durability::Persist);
        assert_eq!(t.durability("/anything"), Durability::Persist);
    }
}
