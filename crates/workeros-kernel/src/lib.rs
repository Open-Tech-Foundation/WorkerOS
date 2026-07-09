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

pub mod ringbuf;

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

/// The kernel instance. In Phase 0 it holds no state beyond identity; Phase 1
/// grows it a VFS and a process table.
#[derive(Debug, Default)]
pub struct Kernel {}

impl Kernel {
    /// Boot the kernel and produce the version handshake.
    pub fn boot() -> (Self, Handshake) {
        (
            Kernel::default(),
            Handshake {
                version: VERSION,
                abi: ABI,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_returns_version_handshake() {
        let (_kernel, hs) = Kernel::boot();
        assert_eq!(hs.version, VERSION);
        assert_eq!(hs.abi, "wasi-preview-1+otf-1");
    }
}
