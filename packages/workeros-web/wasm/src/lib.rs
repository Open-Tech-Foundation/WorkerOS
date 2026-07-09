//! wasm-bindgen bindings for the WorkerOS kernel.
//!
//! This crate is the *only* place the Rust kernel touches the browser. It is a
//! thin translation layer: it forwards to `workeros-kernel` and marshals results
//! across the wasm boundary. No kernel logic lives here (INV-2/ADR-004) — if you
//! find yourself making a resolution, VFS, or capability decision in this file,
//! it belongs in `workeros-kernel` instead.

use serde::Serialize;
use wasm_bindgen::prelude::*;
use workeros_kernel::caps::CapabilitySet;
use workeros_kernel::errno::Errno;
use workeros_kernel::process::Pid;
use workeros_kernel::resolver::{ModuleGraph, ModuleKind};
use workeros_kernel::syscall::Fd;
use workeros_kernel::{Kernel, SpawnError, WriteEffect};

/// A booted kernel handle, held by the kernel worker's JS glue.
#[wasm_bindgen]
pub struct WebKernel {
    inner: Kernel,
}

// --- serializable DTOs handed to the JS glue -------------------------------

#[derive(Serialize)]
struct ImportDto {
    specifier: String,
    resolved: String,
}

#[derive(Serialize)]
struct ModuleDto {
    path: String,
    source: String,
    imports: Vec<ImportDto>,
}

#[derive(Serialize)]
struct GraphDto {
    entry: String,
    kind: &'static str,
    modules: Vec<ModuleDto>,
}

#[derive(Serialize)]
struct SpawnDto {
    pid: Pid,
    graph: GraphDto,
}

#[derive(Serialize)]
struct WriteDto {
    /// "stdout" | "stderr" | "file"
    target: &'static str,
    nwritten: usize,
}

impl From<&ModuleGraph> for GraphDto {
    fn from(g: &ModuleGraph) -> Self {
        GraphDto {
            entry: g.entry.clone(),
            kind: match g.kind {
                ModuleKind::Js => "js",
                ModuleKind::Wasm => "wasm",
            },
            modules: g
                .modules
                .iter()
                .map(|m| ModuleDto {
                    path: m.path.clone(),
                    source: m.source.clone(),
                    imports: m
                        .imports
                        .iter()
                        .map(|e| ImportDto {
                            specifier: e.specifier.clone(),
                            resolved: e.resolved.clone(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

fn errno_to_js(e: Errno) -> JsError {
    JsError::new(&format!("errno {:?} ({})", e, e.raw()))
}

fn spawn_err_to_js(e: SpawnError) -> JsError {
    match e {
        SpawnError::NoEntry => JsError::new("spawn: argv names no runnable entry"),
        SpawnError::Resolve(re) => JsError::new(&format!("spawn: resolve error: {re:?}")),
    }
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
impl WebKernel {
    /// Boot the kernel. The JS glue calls this once when the kernel worker
    /// starts and posts the handshake (version/abi) back to the main thread.
    #[wasm_bindgen(js_name = boot)]
    pub fn boot() -> WebKernel {
        let (inner, _handshake) = Kernel::boot();
        WebKernel { inner }
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        workeros_kernel::VERSION.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn abi(&self) -> String {
        workeros_kernel::ABI.to_string()
    }

    /// `otf:spawn` — resolve `argv`'s entry + import graph, register the process,
    /// and return `{ pid, graph }`. `env` is an array of `[key, value]` pairs;
    /// `start_time` is milliseconds since the epoch. The host uses the returned
    /// graph to boot a program worker.
    #[wasm_bindgen]
    pub fn spawn(
        &mut self,
        argv: Vec<String>,
        env: JsValue,
        cwd: String,
        start_time: f64,
        ppid: u32,
    ) -> Result<JsValue, JsError> {
        let env: Vec<(String, String)> = if env.is_undefined() || env.is_null() {
            Vec::new()
        } else {
            serde_wasm_bindgen::from_value(env).map_err(|e| JsError::new(&e.to_string()))?
        };
        let spawned = self
            .inner
            .spawn(argv, env, cwd, start_time as u64, CapabilitySet::default(), ppid)
            .map_err(spawn_err_to_js)?;
        to_js(&SpawnDto {
            pid: spawned.pid,
            graph: GraphDto::from(&spawned.graph),
        })
    }

    /// Dispatch `fd_write`. Returns `{ target, nwritten }`; on a stdout/stderr
    /// target the host forwards the same bytes it passed in to the main thread.
    #[wasm_bindgen]
    pub fn sys_write(&mut self, pid: Pid, fd: Fd, data: &[u8]) -> Result<JsValue, JsError> {
        let effect = self.inner.sys_write(pid, fd, data).map_err(errno_to_js)?;
        let dto = match effect {
            WriteEffect::Stdout(b) => WriteDto { target: "stdout", nwritten: b.len() },
            WriteEffect::Stderr(b) => WriteDto { target: "stderr", nwritten: b.len() },
            WriteEffect::File { nwritten } => WriteDto { target: "file", nwritten },
        };
        to_js(&dto)
    }

    /// Dispatch `fd_read` (files + stdin). Returns the bytes read as a `Uint8Array`.
    #[wasm_bindgen]
    pub fn sys_read(&mut self, pid: Pid, fd: Fd, max: u32) -> Result<Vec<u8>, JsError> {
        self.inner.sys_read(pid, fd, max as usize).map_err(errno_to_js)
    }

    /// Feed bytes to a process's stdin queue.
    #[wasm_bindgen]
    pub fn feed_stdin(&mut self, pid: Pid, data: &[u8]) -> Result<(), JsError> {
        self.inner.feed_stdin(pid, data).map_err(errno_to_js)
    }

    /// Mark a process exited (normal return or guest `process.exit`).
    #[wasm_bindgen]
    pub fn mark_exited(&mut self, pid: Pid, code: i32) -> bool {
        self.inner.mark_exited(pid, code)
    }

    /// `otf:kill` — signal a process; the host then `terminate()`s its worker.
    #[wasm_bindgen]
    pub fn kill(&mut self, pid: Pid, signal: i32) -> bool {
        self.inner.kill(pid, signal)
    }

    /// `wait(pid)` — the exit code if exited, else `undefined`.
    #[wasm_bindgen]
    pub fn wait(&self, pid: Pid) -> Option<i32> {
        self.inner.wait(pid)
    }

    /// Reap an exited process; returns its exit code or `undefined`.
    #[wasm_bindgen]
    pub fn reap(&mut self, pid: Pid) -> Option<i32> {
        self.inner.reap(pid)
    }

    /// Client `fs.write` — create parents as needed, then write the file.
    #[wasm_bindgen]
    pub fn fs_write(&mut self, path: String, data: &[u8]) -> Result<(), JsError> {
        self.inner.fs_write(&path, data).map_err(errno_to_js)
    }

    /// Client `fs.read` — read a whole file as a `Uint8Array`.
    #[wasm_bindgen]
    pub fn fs_read(&self, path: String) -> Result<Vec<u8>, JsError> {
        self.inner.fs_read(&path).map_err(errno_to_js)
    }
}
