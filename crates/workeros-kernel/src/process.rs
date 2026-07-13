//! The process table (ARCHITECTURE.md §5).
//!
//! A POSIX-shaped table of process records. This module is *data and
//! bookkeeping only* (Phase 1): allocation, lookup, state transitions, and
//! reaping. The backing program worker — the thing that makes a process real and
//! killable (INV-4) — is wired in Phase 2 on the host side; the kernel refers to
//! it only through the opaque [`Pid`].

use crate::caps::CapabilitySet;
use std::collections::BTreeMap;

/// A process identifier. Monotonically allocated; never reused within a session.
pub type Pid = u32;

/// The first pid handed out. Pid 0 is reserved (kernel/idle), matching POSIX
/// intuition that user processes start at 1.
pub const INIT_PID: Pid = 1;

/// Process lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcState {
    /// Runnable / running on its worker.
    Running,
    /// Blocked waiting on a syscall (e.g. `fd_read` with no data).
    Sleeping,
    /// Exited but not yet reaped; `exit_code` is set.
    Zombie,
}

/// One process-table entry.
#[derive(Debug, Clone)]
pub struct Process {
    pub pid: Pid,
    pub ppid: Pid,
    /// Process-group id (POSIX job control, ADR-025). A pipeline shares one
    /// group (leader = first stage); signals from the controlling terminal
    /// (^C/^Z/SIGWINCH) are delivered to the foreground *group*, so they reach
    /// exec'd grandchildren too. Children inherit their parent's group unless
    /// the spawn says otherwise.
    pub pgid: Pid,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub state: ProcState,
    pub exit_code: Option<i32>,
    /// Why the process was killed, when the exit was a watchdog/limit kill
    /// rather than an ordinary exit — e.g. `"CPU time"` / `"out of memory"`
    /// (INV-6, ADR-020). `None` for a normal exit. Gives `ps`/`wait`/the shell
    /// an honest *why*.
    pub kill_reason: Option<String>,
    /// Wall-clock start time in milliseconds since the epoch (host-supplied).
    pub start_time: u64,
    pub caps: CapabilitySet,
}

/// Parameters to create a process record.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub ppid: Pid,
    /// The resolved process-group id (the kernel computes it from the caller's
    /// `Option<Pid>` — see `Kernel::spawn` — before the record is created).
    pub pgid: Pid,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub start_time: u64,
    pub caps: CapabilitySet,
}

/// The process table.
#[derive(Debug)]
pub struct ProcessTable {
    procs: BTreeMap<Pid, Process>,
    next_pid: Pid,
}

impl Default for ProcessTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessTable {
    /// An empty table.
    pub fn new() -> Self {
        ProcessTable {
            procs: BTreeMap::new(),
            next_pid: INIT_PID,
        }
    }

    /// Allocate a pid and insert a `Running` process. Returns its pid.
    pub fn create(&mut self, req: SpawnRequest) -> Pid {
        let pid = self.next_pid;
        self.next_pid += 1;
        self.procs.insert(
            pid,
            Process {
                pid,
                ppid: req.ppid,
                // pgid 0 means "become a group leader": the group id is the pid.
                pgid: if req.pgid == 0 { pid } else { req.pgid },
                argv: req.argv,
                env: req.env,
                cwd: req.cwd,
                state: ProcState::Running,
                exit_code: None,
                kill_reason: None,
                start_time: req.start_time,
                caps: req.caps,
            },
        );
        pid
    }

    /// Look up a process.
    pub fn get(&self, pid: Pid) -> Option<&Process> {
        self.procs.get(&pid)
    }

    /// Look up a process mutably.
    pub fn get_mut(&mut self, pid: Pid) -> Option<&mut Process> {
        self.procs.get_mut(&pid)
    }

    /// Whether a process exists.
    pub fn contains(&self, pid: Pid) -> bool {
        self.procs.contains_key(&pid)
    }

    /// All processes, ordered by pid (what `ps` reads).
    pub fn iter(&self) -> impl Iterator<Item = &Process> {
        self.procs.values()
    }

    /// Number of live entries (including zombies not yet reaped).
    pub fn len(&self) -> usize {
        self.procs.len()
    }

    /// Number of *live* (non-zombie) processes — the figure the process-count cap
    /// checks (ADR-020). A zombie awaiting reap holds no worker, so it does not
    /// count against the fork-bomb budget.
    pub fn live_count(&self) -> usize {
        self.procs
            .values()
            .filter(|p| p.state != ProcState::Zombie)
            .count()
    }

    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.procs.is_empty()
    }

    /// The *live* (non-zombie) members of process group `pgid` — the set a
    /// group-directed signal (^C to the foreground pipeline) is delivered to.
    pub fn pgrp_members(&self, pgid: Pid) -> Vec<Pid> {
        self.procs
            .values()
            .filter(|p| p.pgid == pgid && p.state != ProcState::Zombie)
            .map(|p| p.pid)
            .collect()
    }

    /// Direct children of `pid`.
    pub fn children(&self, pid: Pid) -> impl Iterator<Item = &Process> {
        self.procs.values().filter(move |p| p.ppid == pid)
    }

    /// Mark a process exited: record its code and move it to `Zombie`.
    /// Returns `false` if the pid is unknown.
    pub fn set_exited(&mut self, pid: Pid, exit_code: i32) -> bool {
        match self.procs.get_mut(&pid) {
            Some(p) => {
                p.state = ProcState::Zombie;
                p.exit_code = Some(exit_code);
                true
            }
            None => false,
        }
    }

    /// Record why a process is being killed (a watchdog/limit breach — INV-6,
    /// ADR-020). Set before the exit so the zombie carries the reason. Returns
    /// `false` if the pid is unknown.
    pub fn set_kill_reason(&mut self, pid: Pid, reason: &str) -> bool {
        match self.procs.get_mut(&pid) {
            Some(p) => {
                p.kill_reason = Some(reason.to_string());
                true
            }
            None => false,
        }
    }

    /// Transition a process to `Sleeping`/`Running` (blocking on a syscall).
    pub fn set_state(&mut self, pid: Pid, state: ProcState) -> bool {
        match self.procs.get_mut(&pid) {
            Some(p) => {
                p.state = state;
                true
            }
            None => false,
        }
    }

    /// Remove a process unconditionally (e.g. to roll back a failed spawn).
    pub fn remove(&mut self, pid: Pid) -> Option<Process> {
        self.procs.remove(&pid)
    }

    /// Reap a zombie, removing it and returning its exit code. Returns `None` if
    /// the pid is unknown or not yet a zombie.
    pub fn reap(&mut self, pid: Pid) -> Option<i32> {
        match self.procs.get(&pid) {
            Some(p) if p.state == ProcState::Zombie => {
                let code = p.exit_code;
                self.procs.remove(&pid);
                code
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(ppid: Pid, argv: &[&str]) -> SpawnRequest {
        SpawnRequest {
            ppid,
            pgid: 0,
            argv: argv.iter().map(|s| s.to_string()).collect(),
            env: vec![],
            cwd: "/".to_string(),
            start_time: 0,
            caps: CapabilitySet::default(),
        }
    }

    #[test]
    fn pids_are_monotonic_and_start_at_init() {
        let mut t = ProcessTable::new();
        let a = t.create(req(0, &["a"]));
        let b = t.create(req(a, &["b"]));
        assert_eq!(a, INIT_PID);
        assert_eq!(b, INIT_PID + 1);
        assert_eq!(t.get(a).unwrap().argv, vec!["a"]);
        assert_eq!(t.get(b).unwrap().ppid, a);
    }

    #[test]
    fn lifecycle_running_zombie_reaped() {
        let mut t = ProcessTable::new();
        let p = t.create(req(0, &["prog"]));
        assert_eq!(t.get(p).unwrap().state, ProcState::Running);
        assert!(t.set_exited(p, 42));
        assert_eq!(t.get(p).unwrap().state, ProcState::Zombie);
        assert_eq!(t.get(p).unwrap().exit_code, Some(42));
        assert_eq!(t.reap(p), Some(42));
        assert!(!t.contains(p));
    }

    #[test]
    fn reap_requires_zombie() {
        let mut t = ProcessTable::new();
        let p = t.create(req(0, &["prog"]));
        assert_eq!(t.reap(p), None, "cannot reap a running process");
        assert!(t.contains(p));
    }

    #[test]
    fn children_lookup() {
        let mut t = ProcessTable::new();
        let parent = t.create(req(0, &["p"]));
        let c1 = t.create(req(parent, &["c1"]));
        let _c2 = t.create(req(parent, &["c2"]));
        let _other = t.create(req(999, &["x"]));
        let mut kids: Vec<_> = t.children(parent).map(|p| p.pid).collect();
        kids.sort();
        assert_eq!(kids, vec![c1, c1 + 1]);
    }

    #[test]
    fn pid_not_reused_after_reap() {
        let mut t = ProcessTable::new();
        let a = t.create(req(0, &["a"]));
        t.set_exited(a, 0);
        t.reap(a);
        let b = t.create(req(0, &["b"]));
        assert_ne!(a, b, "reaped pid must not be reused within a session");
    }
}
