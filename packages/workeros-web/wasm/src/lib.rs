//! wasm-bindgen bindings for the WorkerOS kernel.
//!
//! This crate is the *only* place the Rust kernel touches the browser. It is a
//! thin translation layer: it forwards to `workeros-kernel` and marshals results
//! across the wasm boundary. No kernel logic lives here (INV-2/ADR-004) — if you
//! find yourself making a resolution, VFS, glob, or capability decision in this
//! file, it belongs in `workeros-kernel` instead.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use workeros_kernel::caps::CapabilitySet;
use workeros_kernel::errno::Errno;
use workeros_kernel::process::Pid;
use workeros_kernel::resolver::{ModuleGraph, ModuleKind};
use workeros_kernel::shell::{self, AndOrOp, RedirectOp};
use workeros_kernel::syscall::{Fd, PipeEnd, PipeId, RedirectMode};
use workeros_kernel::vfs::OpenOptions;
use workeros_kernel::{Kernel, ReadResult, SpawnError, StdioPlan, StdioTarget, WriteEffect};

/// A booted kernel handle, held by the kernel worker's JS glue.
#[wasm_bindgen]
pub struct WebKernel {
    inner: Kernel,
}

// --- serializable DTOs handed to / from the JS glue ------------------------

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
    interpreter: &'static str,
    graph: GraphDto,
}

#[derive(Serialize)]
struct WriteDto {
    /// "stdout" | "stderr" | "file"
    target: &'static str,
    nwritten: usize,
}

#[derive(Serialize)]
struct DirEntryDto {
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct StatDto {
    /// "file" | "dir"
    kind: &'static str,
    size: u64,
}

#[derive(Serialize)]
struct ProcDto {
    pid: Pid,
    ppid: Pid,
    argv: Vec<String>,
    cwd: String,
    state: &'static str,
    exit_code: Option<i32>,
    start_time: u64,
}

// Stdio plan received from the shell executor.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum StdioTargetDto {
    Inherit,
    File { path: String, mode: String },
    Pipe { id: u32, end: String },
}

#[derive(Deserialize)]
struct StdioPlanDto {
    stdin: StdioTargetDto,
    stdout: StdioTargetDto,
    stderr: StdioTargetDto,
}

#[derive(Deserialize, Default)]
struct OpenOptsDto {
    #[serde(default)]
    create: bool,
    #[serde(default)]
    truncate: bool,
    #[serde(default)]
    exclusive: bool,
    #[serde(default)]
    directory: bool,
}

// Execution plan handed to the JS shell executor (already glob-expanded).
#[derive(Serialize)]
struct PlanDto {
    statements: Vec<StmtDto>,
}
#[derive(Serialize)]
struct StmtDto {
    background: bool,
    steps: Vec<StepDto>,
}
#[derive(Serialize)]
struct StepDto {
    /// None for the first pipeline; "and"/"or" for subsequent ones.
    op: Option<&'static str>,
    commands: Vec<CmdDto>,
}
#[derive(Serialize)]
struct CmdDto {
    argv: Vec<String>,
    assignments: Vec<(String, String)>,
    redirects: Vec<RedirDto>,
}
#[derive(Serialize)]
struct RedirDto {
    fd: u32,
    /// "read" | "write" | "append"
    op: &'static str,
    target: String,
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

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsError::new(&e.to_string()))
}

fn parse_mode(s: &str) -> Result<RedirectMode, JsError> {
    match s {
        "read" => Ok(RedirectMode::Read),
        "write" => Ok(RedirectMode::Write),
        "append" => Ok(RedirectMode::Append),
        other => Err(JsError::new(&format!("bad redirect mode: {other}"))),
    }
}

fn parse_end(s: &str) -> Result<PipeEnd, JsError> {
    match s {
        "read" => Ok(PipeEnd::Read),
        "write" => Ok(PipeEnd::Write),
        other => Err(JsError::new(&format!("bad pipe end: {other}"))),
    }
}

impl StdioTargetDto {
    fn into_kernel(self) -> Result<StdioTarget, JsError> {
        Ok(match self {
            StdioTargetDto::Inherit => StdioTarget::Inherit,
            StdioTargetDto::File { path, mode } => StdioTarget::File {
                path,
                mode: parse_mode(&mode)?,
            },
            StdioTargetDto::Pipe { id, end } => StdioTarget::Pipe {
                id,
                end: parse_end(&end)?,
            },
        })
    }
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

    /// `otf:spawn` — resolve `argv`'s invocation + import graph, register the
    /// process, wire its stdio per `plan`, and return `{ pid, interpreter, graph }`.
    /// `env` is an array of `[key, value]` pairs; `plan` is the stdio wiring (or
    /// null for all-terminal). `start_time` is milliseconds since the epoch.
    #[wasm_bindgen]
    pub fn spawn(
        &mut self,
        argv: Vec<String>,
        env: JsValue,
        cwd: String,
        start_time: f64,
        ppid: u32,
        plan: JsValue,
    ) -> Result<JsValue, JsError> {
        let env: Vec<(String, String)> = if env.is_undefined() || env.is_null() {
            Vec::new()
        } else {
            serde_wasm_bindgen::from_value(env).map_err(|e| JsError::new(&e.to_string()))?
        };
        let plan = if plan.is_undefined() || plan.is_null() {
            StdioPlan::default()
        } else {
            let dto: StdioPlanDto =
                serde_wasm_bindgen::from_value(plan).map_err(|e| JsError::new(&e.to_string()))?;
            StdioPlan {
                stdin: dto.stdin.into_kernel()?,
                stdout: dto.stdout.into_kernel()?,
                stderr: dto.stderr.into_kernel()?,
            }
        };
        let spawned = self
            .inner
            .spawn(argv, env, cwd, start_time as u64, CapabilitySet::default(), ppid, plan)
            .map_err(spawn_err_to_js)?;
        to_js(&SpawnDto {
            pid: spawned.pid,
            interpreter: spawned.interpreter.as_str(),
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

    /// Dispatch `fd_read`. Returns `{ status: "data"|"eof"|"again", data? }`.
    /// `data` is a `Uint8Array`. The host parks the request on "again" (a pipe
    /// with a live writer) and retries when the pipe advances.
    #[wasm_bindgen]
    pub fn sys_read(&mut self, pid: Pid, fd: Fd, max: u32) -> Result<JsValue, JsError> {
        let result = self.inner.sys_read(pid, fd, max as usize).map_err(errno_to_js)?;
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(k), v).unwrap();
        };
        match result {
            ReadResult::Data(bytes) => {
                set("status", &JsValue::from_str("data"));
                set("data", &js_sys::Uint8Array::from(&bytes[..]));
            }
            ReadResult::Eof => set("status", &JsValue::from_str("eof")),
            ReadResult::WouldBlock => set("status", &JsValue::from_str("again")),
        }
        Ok(obj.into())
    }

    /// Feed bytes to a process's stdin queue.
    #[wasm_bindgen]
    pub fn feed_stdin(&mut self, pid: Pid, data: &[u8]) -> Result<(), JsError> {
        self.inner.feed_stdin(pid, data).map_err(errno_to_js)
    }

    /// Open an IPC pipe (`otf:ipc_open`); returns its id for a stdio plan.
    #[wasm_bindgen]
    pub fn pipe_open(&mut self) -> PipeId {
        self.inner.pipe_open()
    }

    // ---- guest file syscalls (coreutils) ----

    #[wasm_bindgen]
    pub fn sys_open(&mut self, pid: Pid, path: String, opts: JsValue) -> Result<Fd, JsError> {
        let dto: OpenOptsDto = if opts.is_undefined() || opts.is_null() {
            OpenOptsDto::default()
        } else {
            serde_wasm_bindgen::from_value(opts).map_err(|e| JsError::new(&e.to_string()))?
        };
        self.inner
            .sys_open(
                pid,
                &path,
                OpenOptions {
                    create: dto.create,
                    truncate: dto.truncate,
                    exclusive: dto.exclusive,
                    directory: dto.directory,
                },
            )
            .map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_close(&mut self, pid: Pid, fd: Fd) -> Result<(), JsError> {
        self.inner.sys_close(pid, fd).map_err(errno_to_js)
    }

    /// `fd_seek`. `offset` is passed as an f64 (JS number); the new absolute
    /// offset is returned the same way. `whence`: 0=set, 1=cur, 2=end.
    #[wasm_bindgen]
    pub fn sys_seek(&mut self, pid: Pid, fd: Fd, offset: f64, whence: u8) -> Result<f64, JsError> {
        let n = self.inner.sys_seek(pid, fd, offset as i64, whence).map_err(errno_to_js)?;
        Ok(n as f64)
    }

    #[wasm_bindgen]
    pub fn sys_readdir(&self, pid: Pid, path: String) -> Result<JsValue, JsError> {
        let entries = self.inner.sys_readdir(pid, &path).map_err(errno_to_js)?;
        let dtos: Vec<DirEntryDto> = entries
            .into_iter()
            .map(|e| DirEntryDto { name: e.name, is_dir: e.is_dir })
            .collect();
        to_js(&dtos)
    }

    #[wasm_bindgen]
    pub fn sys_stat(&self, pid: Pid, path: String) -> Result<JsValue, JsError> {
        let m = self.inner.sys_stat(pid, &path).map_err(errno_to_js)?;
        to_js(&StatDto {
            kind: match m.file_type {
                workeros_kernel::vfs::FileType::Dir => "dir",
                workeros_kernel::vfs::FileType::File => "file",
            },
            size: m.size,
        })
    }

    #[wasm_bindgen]
    pub fn sys_mkdir(&mut self, pid: Pid, path: String) -> Result<(), JsError> {
        self.inner.sys_mkdir(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_unlink(&mut self, pid: Pid, path: String) -> Result<(), JsError> {
        self.inner.sys_unlink(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_rmdir(&mut self, pid: Pid, path: String) -> Result<(), JsError> {
        self.inner.sys_rmdir(pid, &path).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn sys_rename(&mut self, pid: Pid, from: String, to: String) -> Result<(), JsError> {
        self.inner.sys_rename(pid, &from, &to).map_err(errno_to_js)
    }

    // ---- process lifecycle ----

    #[wasm_bindgen]
    pub fn mark_exited(&mut self, pid: Pid, code: i32) -> bool {
        self.inner.mark_exited(pid, code)
    }

    #[wasm_bindgen]
    pub fn kill(&mut self, pid: Pid, signal: i32) -> bool {
        self.inner.kill(pid, signal)
    }

    #[wasm_bindgen]
    pub fn wait(&self, pid: Pid) -> Option<i32> {
        self.inner.wait(pid)
    }

    #[wasm_bindgen]
    pub fn reap(&mut self, pid: Pid) -> Option<i32> {
        self.inner.reap(pid)
    }

    /// `ps` — a snapshot of the process table.
    #[wasm_bindgen]
    pub fn list_processes(&self) -> Result<JsValue, JsError> {
        let dtos: Vec<ProcDto> = self
            .inner
            .list_processes()
            .into_iter()
            .map(|p| ProcDto {
                pid: p.pid,
                ppid: p.ppid,
                argv: p.argv,
                cwd: p.cwd,
                state: p.state,
                exit_code: p.exit_code,
                start_time: p.start_time,
            })
            .collect();
        to_js(&dtos)
    }

    // ---- client fs ----

    #[wasm_bindgen]
    pub fn fs_write(&mut self, path: String, data: &[u8]) -> Result<(), JsError> {
        self.inner.fs_write(&path, data).map_err(errno_to_js)
    }

    #[wasm_bindgen]
    pub fn fs_read(&self, path: String) -> Result<Vec<u8>, JsError> {
        self.inner.fs_read(&path).map_err(errno_to_js)
    }

    // ---- shell (wsh) ----

    /// Resolve a `cd` target against `cwd`; returns the normalized directory or
    /// errors if it does not exist / is not a directory.
    #[wasm_bindgen]
    pub fn resolve_dir(&self, cwd: String, target: String) -> Result<String, JsError> {
        self.inner.resolve_dir(&cwd, &target).map_err(errno_to_js)
    }

    /// Parse + glob-expand a command line into an execution plan for the JS
    /// shell executor. Parsing and globbing stay kernel-authoritative (INV-2);
    /// the executor only drives async worker lifecycles over this plan.
    #[wasm_bindgen]
    pub fn shell_plan(&self, line: String, cwd: String) -> Result<JsValue, JsError> {
        let script = self
            .inner
            .shell_parse(&line)
            .map_err(|e| JsError::new(&format!("parse error: {e:?}")))?;
        let statements = script
            .statements
            .iter()
            .map(|st| StmtDto {
                background: st.background,
                steps: self.and_or_steps(&st.list, &cwd),
            })
            .collect();
        to_js(&PlanDto { statements })
    }
}

impl WebKernel {
    fn and_or_steps(&self, list: &shell::AndOr, cwd: &str) -> Vec<StepDto> {
        let mut steps = vec![StepDto {
            op: None,
            commands: self.pipeline_cmds(&list.first, cwd),
        }];
        for (op, pipeline) in &list.rest {
            steps.push(StepDto {
                op: Some(match op {
                    AndOrOp::And => "and",
                    AndOrOp::Or => "or",
                }),
                commands: self.pipeline_cmds(pipeline, cwd),
            });
        }
        steps
    }

    fn pipeline_cmds(&self, pipeline: &shell::Pipeline, cwd: &str) -> Vec<CmdDto> {
        pipeline
            .commands
            .iter()
            .map(|c| CmdDto {
                argv: c
                    .argv
                    .iter()
                    .flat_map(|w| self.expand_word(cwd, w))
                    .collect(),
                assignments: c
                    .assignments
                    .iter()
                    .map(|a| (a.name.clone(), a.value.clone()))
                    .collect(),
                redirects: c
                    .redirects
                    .iter()
                    .map(|r| RedirDto {
                        fd: r.fd,
                        op: match r.op {
                            RedirectOp::Read => "read",
                            RedirectOp::Write => "write",
                            RedirectOp::Append => "append",
                        },
                        // A redirect target takes the first glob match (or the literal).
                        target: self
                            .expand_word(cwd, &r.target)
                            .into_iter()
                            .next()
                            .unwrap_or_else(|| r.target.text.clone()),
                    })
                    .collect(),
            })
            .collect()
    }

    fn expand_word(&self, cwd: &str, word: &shell::Word) -> Vec<String> {
        if word.globbable {
            self.inner.glob(cwd, &word.text)
        } else {
            vec![word.text.clone()]
        }
    }
}

fn spawn_err_to_js(e: SpawnError) -> JsError {
    match e {
        SpawnError::NoEntry => JsError::new("spawn: argv names no runnable entry"),
        SpawnError::Resolve(re) => JsError::new(&format!("spawn: {re:?}")),
    }
}
