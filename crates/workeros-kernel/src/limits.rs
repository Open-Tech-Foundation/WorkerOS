//! Resource limits — the quantitative half of the sandbox (INV-6, ADR-020,
//! ARCHITECTURE.md §7.2).
//!
//! Isolation (`caps`) decides *which* capabilities a process holds; this decides
//! *how much* of each resource it may consume. A guest that cannot fork-bomb,
//! exhaust file descriptors, or fill the VFS is the difference between an
//! "isolated process" and a "safe sandbox" (the AI-agent / embedding use cases,
//! §2).
//!
//! # What the kernel enforces (this module)
//!
//! Only the **accounting** limits live here, because they are pure bookkeeping
//! and therefore natively `cargo test`-able (INV-2). Each is checked at the one
//! seam where the resource is handed out:
//!
//! | Limit             | Seam                          | Errno on breach |
//! |-------------------|-------------------------------|-----------------|
//! | `max_procs`       | [`crate::Kernel::spawn`]      | `EAGAIN` (`SpawnError::LimitExceeded`) |
//! | `max_open_fds`    | `ProcessCtx::alloc_fd`        | `EMFILE`        |
//! | `vfs_max_bytes`   | `MemVfs::write_at`           | `ENOSPC`        |
//! | `vfs_max_inodes`  | `MemVfs::alloc`             | `ENOSPC`        |
//!
//! # What the kernel does NOT enforce (host-side, ADR-020)
//!
//! The two **temporal** limits — wall-clock/CPU time and a memory high-water
//! ceiling — need a clock and `worker.terminate()`, which only the kernel-worker
//! (JS) has. Their *recommended* values live in [`WATCHDOG`] as the single source
//! of truth the host watchdog mirrors; enforcement is the kernel-worker's job and
//! is tracked in PLAN Phase 8. They are intentionally *not* fields of
//! [`ResourceLimits`] so this struct has no field the kernel cannot honor.
//!
//! # v1: recommended defaults, host override later
//!
//! v1 ships [`RECOMMENDED`] hardcoded. A host-facing API to override these
//! per-instance (and later per-process, inherited by children) is post-v1; the
//! shape is already here — [`Kernel`](crate::Kernel) holds a `ResourceLimits`, so
//! wiring a setter is additive.

/// The resource caps the **kernel** enforces per instance. Coarse in v1
/// (per-instance, not yet per-process-tree); the accounting is structured so a
/// per-tree budget inherited by children (ADR-020) is an additive change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimits {
    /// Maximum number of *live* (non-zombie) processes at once. The fork-bomb
    /// guard; also keeps spawns under the browser's real concurrent-worker
    /// ceiling. Breach → `SpawnError::LimitExceeded` (`EAGAIN`).
    pub max_procs: usize,
    /// Maximum concurrently-open file descriptors **per process** (including the
    /// three stdio fds), the `RLIMIT_NOFILE` analog. Breach → `EMFILE`.
    pub max_open_fds: usize,
    /// Maximum total bytes stored across all VFS files. Breach → `ENOSPC`.
    pub vfs_max_bytes: u64,
    /// Maximum total live inodes (files + directories, incl. root). Breach →
    /// `ENOSPC`.
    pub vfs_max_inodes: usize,
}

/// WorkerOS's recommended v1 caps. Chosen to never get in the way of real work
/// (a shell pipeline is a handful of procs; a moderate project with its
/// installed dependency tree fits in the byte/inode budgets) while bounding the
/// runaway cases that would take down the tab. Deliberately generous: a *safety*
/// ceiling, not a tight quota. The host will be able to raise or lower these
/// post-v1.
pub const RECOMMENDED: ResourceLimits = ResourceLimits {
    // 128 concurrent processes is far more than any real pipeline/build fan-out
    // needs, yet well under the point where spawning workers destabilizes a tab.
    max_procs: 128,
    // 256 open fds/process dwarfs what ordinary programs use; caps fd/pipe bombs.
    max_open_fds: 256,
    // 256 MiB of in-memory VFS is a large project tree while bounding a disk-fill
    // DoS against the tab heap (the in-memory VFS lives in the tab, ADR-011).
    vfs_max_bytes: 256 * 1024 * 1024,
    // 100k inodes covers a substantial dependency tree; stops an inode-exhaustion
    // fill (e.g. `while true; do mkdir …`).
    vfs_max_inodes: 100_000,
};

impl Default for ResourceLimits {
    /// The recommended v1 caps ([`RECOMMENDED`]).
    fn default() -> Self {
        RECOMMENDED
    }
}

/// Recommended values for the two **host-enforced** temporal limits (ADR-020).
/// The kernel does not act on these — the kernel-worker watchdog does (PLAN
/// Phase 8) — but they are declared here so the whole resource policy has one
/// documented home the host mirrors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogLimits {
    /// Per-process wall-clock budget in milliseconds before the watchdog escalates
    /// to a cooperative signal then `terminate()`. A generous default so ordinary
    /// long builds are unaffected; the host tightens it for untrusted code.
    pub wall_time_ms: u64,
    /// Per-process idle timeout in milliseconds (no syscall/heartbeat) before the
    /// watchdog reaps a wedged worker. `0` disables the idle check.
    pub idle_time_ms: u64,
    /// Per-process memory high-water ceiling in bytes. **Soft/sampled** (INV-5): a
    /// synchronous huge allocation can overshoot between samples; a hard cap
    /// arrives only with the future `Wasm`/Boa level (§7.1).
    pub mem_high_water_bytes: u64,
}

/// Recommended v1 watchdog values (host-enforced; see [`WatchdogLimits`]).
pub const WATCHDOG: WatchdogLimits = WatchdogLimits {
    // 30s wall-clock: comfortably covers real builds/installs; a runaway
    // synchronous loop is caught well before it looks like a hang to a user.
    wall_time_ms: 30_000,
    // Idle detection off by default (a backgrounded server legitimately idles);
    // the host opts in for batch/AI-agent runs.
    idle_time_ms: 0,
    // 512 MiB high-water per process — a heavy WASM tool (esbuild/PGlite) fits;
    // a memory runaway is terminated before it OOMs the tab.
    mem_high_water_bytes: 512 * 1024 * 1024,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_recommended() {
        assert_eq!(ResourceLimits::default(), RECOMMENDED);
    }

    #[test]
    fn recommended_caps_are_sane() {
        // Sanity: caps are non-zero and stdio (3 fds) fits comfortably.
        assert!(RECOMMENDED.max_procs >= 8);
        assert!(RECOMMENDED.max_open_fds > 3);
        assert!(RECOMMENDED.vfs_max_bytes >= 1 << 20);
        assert!(RECOMMENDED.vfs_max_inodes >= 1024);
    }
}
