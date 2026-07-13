//! Capability sets — what a process is allowed to do.
//!
//! The kernel is the sole authority for capability granting (INV-2). A process
//! receives a [`CapabilitySet`] at spawn time; every syscall is checked against
//! it. v1 grants are coarse (stdio + a filesystem root + which `otf:*` calls are
//! permitted); finer-grained per-fd rights can be added without changing the
//! call sites.

/// The three-call `otf:*` kernel ABI (ADR-006). A process must hold the matching
/// capability to invoke each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtfCall {
    /// `otf:spawn` — create a new process.
    Spawn,
    /// `otf:kill` — signal / terminate a process.
    Kill,
    /// `otf:ipc_open` — open an IPC channel fd.
    IpcOpen,
    /// `otf:net_listen` — claim a port and accept loopback connections (ADR-021).
    /// (`net_connect` is loopback-only and ungated in v1; `net_listen` is the
    /// capability a "server" needs.)
    NetListen,
}

/// The set of capabilities granted to a process.
#[derive(Debug, Clone)]
pub struct CapabilitySet {
    /// Absolute, normalized filesystem root the process is confined to. Path
    /// arguments are resolved within this root. `/` grants the whole VFS.
    pub fs_root: String,
    /// May read stdin (fd 0).
    pub stdin: bool,
    /// May write stdout (fd 1).
    pub stdout: bool,
    /// May write stderr (fd 2).
    pub stderr: bool,
    /// May use the host's ambient *outbound* network (browser `fetch` — the
    /// only egress that exists, ADR-008). Loopback `otf:net_*` sockets are
    /// separate (`NetListen`; in-instance connects are ungated). The kernel
    /// decides this bit; the program worker enforces it by removing the egress
    /// globals (`fetch`, `WebSocket`, …) before any guest code runs — coarse,
    /// same-realm, pre-`Membrane` enforcement, stated honestly (ADR-024).
    pub net_egress: bool,
    /// Which `otf:*` calls are permitted.
    pub otf: Vec<OtfCall>,
}

impl CapabilitySet {
    /// Whether a given `otf:*` call is permitted.
    pub fn allows(&self, call: OtfCall) -> bool {
        self.otf.contains(&call)
    }
}

impl Default for CapabilitySet {
    /// A reasonable default for an ordinary program: full VFS, all stdio, and
    /// all three `otf:*` calls. Tighten per-process as policy requires.
    fn default() -> Self {
        CapabilitySet {
            fs_root: "/".to_string(),
            stdin: true,
            stdout: true,
            stderr: true,
            // Ambient outbound `fetch` is the npm-install model (ADR-008), so
            // the ordinary-program default allows it; deny per spawn for
            // untrusted/AI-agent runs (ADR-024).
            net_egress: true,
            otf: vec![OtfCall::Spawn, OtfCall::Kill, OtfCall::IpcOpen, OtfCall::NetListen],
        }
    }
}
