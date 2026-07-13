//! WASI Preview 1 error numbers.
//!
//! We use WASI's *exact* numeric values (INV-3): the kernel is a WASI host, so an
//! unmodified `wasm32-wasi` guest must see the errno it expects. Only the subset
//! the kernel actually returns is enumerated here; add variants as syscalls grow.
//! Reference: WASI Preview 1 `errno` enum.

/// A WASI errno. `Success` is 0; the rest match the WASI ABI numbering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum Errno {
    /// No error occurred.
    Success = 0,
    /// Address already in use — a `net_listen` on a port another process holds
    /// (ADR-021).
    Addrinuse = 3,
    /// Resource temporarily unavailable — e.g. a spawn refused by the
    /// process-count cap (POSIX `fork` under `RLIMIT_NPROC`). (ADR-020)
    Again = 6,
    /// Bad file descriptor.
    Badf = 8,
    /// Connection refused — a `net_connect` to a port with no live listener
    /// (ADR-021).
    Connrefused = 14,
    /// File exists.
    Exist = 20,
    /// Invalid argument.
    Inval = 28,
    /// Is a directory.
    Isdir = 31,
    /// Too many levels of symbolic links (ELOOP) — symlink resolution exceeded
    /// the depth cap or formed a cycle.
    Loop = 32,
    /// Too many open files (`EMFILE`) — the per-process fd cap. (ADR-020)
    Mfile = 33,
    /// Filename too long.
    Nametoolong = 37,
    /// Broken pipe (`EPIPE`) — a write to a pipe whose last read end is closed.
    /// The host applies the POSIX default disposition (SIGPIPE → kill) unless the
    /// process catches SIGPIPE. (ADR-023)
    Pipe = 64,
    /// No such file or directory.
    Noent = 44,
    /// No space left on device — the VFS byte or inode quota is exhausted. (ADR-020)
    Nospc = 51,
    /// Not a directory or a symbolic link to a directory.
    Notdir = 54,
    /// Directory not empty.
    Notempty = 55,
    /// Not supported.
    Notsup = 58,
    /// Invalid seek.
    Spipe = 70,
}

impl Errno {
    /// The raw ABI value a guest observes.
    pub fn raw(self) -> u16 {
        self as u16
    }
}

/// Result of a kernel operation that can fail with a WASI errno.
pub type SysResult<T> = Result<T, Errno>;

#[cfg(test)]
mod tests {
    use super::*;

    /// The raw values ARE the WASI Preview 1 ABI (INV-3): an unmodified
    /// `wasm32-wasip1` binary maps them back through wasi-libc, so a wrong number
    /// here surfaces as the wrong `errno` in a real guest. Pin every variant.
    /// (Historical bug this guards against: `Mfile` was 41 — WASI's `nfile` —
    /// so a guest saw `ENFILE` where POSIX promises `EMFILE`.)
    #[test]
    fn raw_values_match_the_wasi_p1_abi() {
        for (e, raw) in [
            (Errno::Success, 0),
            (Errno::Addrinuse, 3),
            (Errno::Again, 6),
            (Errno::Badf, 8),
            (Errno::Connrefused, 14),
            (Errno::Exist, 20),
            (Errno::Inval, 28),
            (Errno::Isdir, 31),
            (Errno::Loop, 32),
            (Errno::Mfile, 33),
            (Errno::Nametoolong, 37),
            (Errno::Noent, 44),
            (Errno::Nospc, 51),
            (Errno::Notdir, 54),
            (Errno::Notempty, 55),
            (Errno::Notsup, 58),
            (Errno::Pipe, 64),
            (Errno::Spipe, 70),
        ] {
            assert_eq!(e.raw(), raw, "{e:?} must carry its WASI P1 value");
        }
    }
}
