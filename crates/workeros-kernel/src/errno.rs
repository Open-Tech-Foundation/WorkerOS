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
    /// Bad file descriptor.
    Badf = 8,
    /// File exists.
    Exist = 20,
    /// Invalid argument.
    Inval = 28,
    /// Is a directory.
    Isdir = 31,
    /// Too many open files.
    Mfile = 41,
    /// Filename too long.
    Nametoolong = 37,
    /// No such file or directory.
    Noent = 44,
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
