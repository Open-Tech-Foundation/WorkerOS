//! Port-keyed loopback sockets — the kernel half of the networking subsystem
//! (ADR-021). The browser forbids raw sockets (ADR-008), so this is *not* TCP:
//! it is an in-instance socket the Service-Worker injector and intra-OS clients
//! use to reach a listening process. The kernel stays not just Node-agnostic but
//! *protocol*-agnostic — it moves opaque bytes and knows nothing of HTTP; every
//! parser/framer (HTTP/1.1, WebSocket) lives in the guest `node` layer (INV-1).
//!
//! A "listening socket" is authoritative kernel state (INV-2): a `port → (pid,
//! listener)` registry, sibling to the process table and [`PipeTable`]. A
//! *connection* is nothing new — it is **two pipes** (§6.3): `c2s` carries
//! client→server bytes, `s2c` server→client. So once a connection's ends are
//! bound to fds, `fd_read`/`fd_write`/`fd_close` already stream it end to end;
//! there is no new data-path syscall. Only `listen`/`connect`/`accept` and the
//! registry are new, and they are pure bookkeeping over `PipeTable` — hence
//! natively unit-tested here without a browser (INV-2).
//!
//! Lifecycle: `net_listen` claims a port (`EADDRINUSE` if held); `net_connect`
//! (loopback) creates the two pipes, binds the *client* ends, and enqueues the
//! *server* ends on the listener's backlog (`ECONNREFUSED` if no listener);
//! `net_accept` dequeues a pending connection and binds the *server* ends,
//! returning `WouldBlock` when the backlog is empty (the kernel worker parks and
//! retries, exactly like a would-block pipe read — ADR-016). On process exit the
//! reap seam calls [`PortTable::reap_pid`] to free every port the process held.

use crate::errno::{Errno, SysResult};
use crate::process::Pid;
use crate::syscall::{Fd, PipeEnd, PipeId, PipeTable, ProcessCtx};
use std::collections::{BTreeMap, VecDeque};

/// A listening-socket identifier (the handle `net_listen` returns).
pub type ListenerId = u32;

/// A connection handed to a process: the two fds its process now owns. `rfd`
/// reads bytes from the peer; `wfd` writes bytes to the peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Connection {
    pub rfd: Fd,
    pub wfd: Fd,
}

/// Result of a `net_accept`: a ready connection, or "no pending connection yet"
/// (the caller parks and retries — symmetric to [`ReadOutcome::WouldBlock`]).
///
/// [`ReadOutcome::WouldBlock`]: crate::syscall::ReadOutcome::WouldBlock
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptOutcome {
    Ready(Connection),
    WouldBlock,
}

/// A queued, not-yet-accepted connection: the two pipes whose *server* ends are
/// still unbound (the client ends were bound at `connect`).
#[derive(Debug, Clone, Copy)]
struct Pending {
    /// client→server pipe; the server will bind its *read* end.
    c2s: PipeId,
    /// server→client pipe; the server will bind its *write* end.
    s2c: PipeId,
}

#[derive(Debug)]
struct Listener {
    port: u16,
    pid: Pid,
    backlog: VecDeque<Pending>,
}

/// The kernel's port registry: which pid listens on which port, plus each
/// listener's pending-connection backlog. Owned by the [`Kernel`](crate::Kernel)
/// alongside the [`PipeTable`].
#[derive(Debug, Default)]
pub struct PortTable {
    listeners: BTreeMap<ListenerId, Listener>,
    by_port: BTreeMap<u16, ListenerId>,
    next: ListenerId,
}

impl PortTable {
    pub fn new() -> Self {
        PortTable {
            listeners: BTreeMap::new(),
            by_port: BTreeMap::new(),
            next: 1,
        }
    }

    /// Claim `port` for `pid`. `EADDRINUSE` if another listener already holds it.
    pub fn listen(&mut self, pid: Pid, port: u16) -> SysResult<ListenerId> {
        if self.by_port.contains_key(&port) {
            return Err(Errno::Addrinuse);
        }
        let id = self.next;
        self.next += 1;
        self.listeners.insert(
            id,
            Listener {
                port,
                pid,
                backlog: VecDeque::new(),
            },
        );
        self.by_port.insert(port, id);
        Ok(id)
    }

    /// Loopback connect to whoever listens on `port`. Creates the two connection
    /// pipes, binds the *client* ends into `client`'s fd table, and enqueues the
    /// server ends on the listener's backlog. `ECONNREFUSED` if nobody listens.
    pub fn connect(
        &mut self,
        pipes: &mut PipeTable,
        client: &mut ProcessCtx,
        port: u16,
    ) -> SysResult<Connection> {
        let &id = self.by_port.get(&port).ok_or(Errno::Connrefused)?;
        let listener = self.listeners.get_mut(&id).ok_or(Errno::Connrefused)?;

        let c2s = pipes.open();
        let s2c = pipes.open();
        // Client writes into c2s, reads out of s2c. Bind both before enqueuing so
        // an EMFILE leaves no half-registered connection.
        let wfd = client.bind_pipe_fd(pipes, c2s, PipeEnd::Write)?;
        let rfd = match client.bind_pipe_fd(pipes, s2c, PipeEnd::Read) {
            Ok(fd) => fd,
            Err(e) => {
                // Roll back the first bind so the fd/pipe don't leak.
                let _ = client.close_pipe_fd(pipes, wfd);
                return Err(e);
            }
        };
        listener.backlog.push_back(Pending { c2s, s2c });
        Ok(Connection { rfd, wfd })
    }

    /// Accept the next pending connection on `listener`, binding the *server*
    /// ends into `server`'s fd table. `WouldBlock` when the backlog is empty.
    pub fn accept(
        &mut self,
        pipes: &mut PipeTable,
        server: &mut ProcessCtx,
        listener: ListenerId,
    ) -> SysResult<AcceptOutcome> {
        let l = self.listeners.get_mut(&listener).ok_or(Errno::Badf)?;
        let pending = match l.backlog.pop_front() {
            Some(p) => p,
            None => return Ok(AcceptOutcome::WouldBlock),
        };
        // Server reads out of c2s, writes into s2c — the mirror of the client.
        let rfd = server.bind_pipe_fd(pipes, pending.c2s, PipeEnd::Read)?;
        let wfd = match server.bind_pipe_fd(pipes, pending.s2c, PipeEnd::Write) {
            Ok(fd) => fd,
            Err(e) => {
                let _ = server.close_pipe_fd(pipes, rfd);
                // Put the connection back so it isn't lost to the EMFILE.
                l.backlog.push_front(pending);
                return Err(e);
            }
        };
        Ok(AcceptOutcome::Ready(Connection { rfd, wfd }))
    }

    /// Whether any listener holds `port` (for tests / `EADDRINUSE` diagnostics).
    pub fn is_listening(&self, port: u16) -> bool {
        self.by_port.contains_key(&port)
    }

    /// Free every port `pid` was listening on (called from the process-reap
    /// seam). Pending, never-accepted connections are dropped; their client-side
    /// fds still reference the pipes, so the client observes EOF on its next read
    /// once the writer count falls to zero — an honest connection-reset (INV-6).
    pub fn reap_pid(&mut self, pid: Pid) {
        let doomed: Vec<ListenerId> = self
            .listeners
            .iter()
            .filter(|(_, l)| l.pid == pid)
            .map(|(&id, _)| id)
            .collect();
        for id in doomed {
            if let Some(l) = self.listeners.remove(&id) {
                self.by_port.remove(&l.port);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caps::CapabilitySet;
    use crate::syscall::ReadOutcome;
    use crate::vfs::MemVfs;

    fn proc(pid: Pid) -> ProcessCtx {
        ProcessCtx::new(pid, vec![], vec![], "/".into(), CapabilitySet::default(), 256)
    }

    /// Read whatever is currently available on `fd` as bytes (Data/EOF → the
    /// bytes read; WouldBlock → empty), for terse assertions.
    fn read(server: &mut ProcessCtx, vfs: &MemVfs, pipes: &mut PipeTable, fd: Fd) -> Vec<u8> {
        let mut buf = [0u8; 64];
        match server.fd_read(vfs, pipes, fd, &mut buf).unwrap() {
            ReadOutcome::Data(n) => buf[..n].to_vec(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn listen_claims_port_and_rejects_duplicate() {
        let mut ports = PortTable::new();
        let _id = ports.listen(1, 5173).unwrap();
        assert!(ports.is_listening(5173));
        assert_eq!(ports.listen(2, 5173).unwrap_err(), Errno::Addrinuse);
        // A different port is free.
        assert!(ports.listen(2, 8080).is_ok());
    }

    #[test]
    fn connect_without_listener_is_refused() {
        let mut ports = PortTable::new();
        let mut pipes = PipeTable::new();
        let mut client = proc(2);
        assert_eq!(
            ports.connect(&mut pipes, &mut client, 9999).unwrap_err(),
            Errno::Connrefused
        );
    }

    #[test]
    fn accept_empty_backlog_would_block() {
        let mut ports = PortTable::new();
        let mut pipes = PipeTable::new();
        let mut server = proc(1);
        let id = ports.listen(1, 80).unwrap();
        assert_eq!(
            ports.accept(&mut pipes, &mut server, id).unwrap(),
            AcceptOutcome::WouldBlock
        );
    }

    #[test]
    fn full_duplex_connection_over_a_port() {
        let mut vfs = MemVfs::new();
        let mut ports = PortTable::new();
        let mut pipes = PipeTable::new();
        let mut server = proc(1);
        let mut client = proc(2);

        let lid = ports.listen(1, 5173).unwrap();
        // Client connects; the server hasn't accepted yet.
        let c = ports.connect(&mut pipes, &mut client, 5173).unwrap();
        // Client can send before accept — the bytes buffer in the pipe.
        client.fd_write(&mut vfs, &mut pipes, c.wfd, b"GET / HTTP/1.1").unwrap();

        // Server accepts and reads the buffered request.
        let s = match ports.accept(&mut pipes, &mut server, lid).unwrap() {
            AcceptOutcome::Ready(conn) => conn,
            other => panic!("expected Ready, got {other:?}"),
        };
        assert_eq!(read(&mut server, &vfs, &mut pipes, s.rfd), b"GET / HTTP/1.1");

        // Server responds; client reads it back — the other direction works too.
        server.fd_write(&mut vfs, &mut pipes, s.wfd, b"HTTP/1.1 200 OK").unwrap();
        assert_eq!(read(&mut client, &vfs, &mut pipes, c.rfd), b"HTTP/1.1 200 OK");
    }

    #[test]
    fn client_sees_eof_when_server_closes_its_write_end() {
        let mut vfs = MemVfs::new();
        let mut ports = PortTable::new();
        let mut pipes = PipeTable::new();
        let mut server = proc(1);
        let mut client = proc(2);

        let lid = ports.listen(1, 3000).unwrap();
        let c = ports.connect(&mut pipes, &mut client, 3000).unwrap();
        let s = match ports.accept(&mut pipes, &mut server, lid).unwrap() {
            AcceptOutcome::Ready(conn) => conn,
            other => panic!("expected Ready, got {other:?}"),
        };
        server.fd_write(&mut vfs, &mut pipes, s.wfd, b"bye").unwrap();
        server.close_all_io(&mut vfs, &mut pipes);
        // Drain the data, then observe EOF (writer gone).
        let mut buf = [0u8; 8];
        assert_eq!(client.fd_read(&vfs, &mut pipes, c.rfd, &mut buf).unwrap(), ReadOutcome::Data(3));
        assert_eq!(client.fd_read(&vfs, &mut pipes, c.rfd, &mut buf).unwrap(), ReadOutcome::Eof);
    }

    #[test]
    fn reap_frees_the_port() {
        let mut ports = PortTable::new();
        let _lid = ports.listen(7, 5173).unwrap();
        assert!(ports.is_listening(5173));
        ports.reap_pid(7);
        assert!(!ports.is_listening(5173));
        // The port can be claimed again after the listener is reaped.
        assert!(ports.listen(8, 5173).is_ok());
    }
}
