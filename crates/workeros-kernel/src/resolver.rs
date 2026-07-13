//! The module resolver — the authoritative entrypoint resolver
//! (ARCHITECTURE.md §7, INV-2/ADR-004).
//!
//! When a program is spawned, the kernel (not the program-worker shim) locates
//! the entry file against the VFS, reads it, and determines its kind (JS source
//! vs WASM module). OS programs are **single self-contained modules**: every
//! `/bin` js program is esbuild-bundled and the `/sbin` coreutils inline their
//! helpers, all at build time — so the kernel never walks an `import` graph. It
//! hands the shim one module, which stitches it into a blob URL to execute; the
//! kernel never decides what a specifier points at. That is the point of INV-2.
//!
//! Runtime multi-file resolution (arbitrary user code, `node_modules`,
//! `package.json` `exports`, `node:` builtins) is `/bin/node`'s job, not the
//! kernel's (INV-1): `node` has synchronous `fs` and resolves for itself.

use crate::errno::Errno;
use crate::vfs::{path, FileType, Vfs};

/// The executable kind of a resolved module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleKind {
    /// JavaScript source, evaluated on the host engine.
    Js,
    /// A WebAssembly module (Phase 4 execution path).
    Wasm,
}

impl ModuleKind {
    /// Infer kind from a path's extension. Unknown extensions default to JS.
    pub fn from_path(p: &str) -> ModuleKind {
        if p.ends_with(".wasm") {
            ModuleKind::Wasm
        } else {
            ModuleKind::Js
        }
    }
}

/// One node in the resolved module graph. Programs are single self-contained
/// modules, so this is always the entry itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleRecord {
    /// Absolute VFS path of the module.
    pub path: String,
    /// The module's source text (JS).
    pub source: String,
}

/// A fully-resolved module graph handed to the program worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleGraph {
    /// Absolute path of the entry module.
    pub entry: String,
    /// Executable kind of the entry.
    pub kind: ModuleKind,
    /// The program's modules: exactly one (the entry) for a JS program, since a
    /// program is a single self-contained module; empty for a WASM entry.
    pub modules: Vec<ModuleRecord>,
}

/// Why resolution failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// The entry file does not exist.
    NotFound(String),
    /// A VFS error while reading.
    Io(Errno),
}

/// Which global surface a program worker installs for a guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interpreter {
    /// Node tenant layer: `process`/`console` on top of `sys`.
    Node,
    /// WorkerOS-native: `sys` only (coreutils, plain programs).
    Js,
}

impl Interpreter {
    pub fn as_str(self) -> &'static str {
        match self {
            Interpreter::Node => "node",
            Interpreter::Js => "js",
        }
    }
}

/// The directories searched for a bare command name, in order: `/bin` (OS and
/// user programs, e.g. `npm` and `node`) then `/sbin` (system binaries — the coreutils,
/// kept apart so they read as untouchable OS internals).
pub const DEFAULT_PATH: &[&str] = &["/bin", "/sbin"];

/// A resolved invocation: the interpreter surface, the entry file to load, and
/// the argv the process runs with. `argv` normally equals the caller's argv, but a
/// `#!` shebang rewrites it — the entry becomes the named interpreter and the
/// script slides in as its first argument (exactly like `node <script>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub interpreter: Interpreter,
    pub entry: String,
    pub argv: Vec<String>,
}

/// The basename of a (possibly absolute) path — the part after the last `/`.
fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Parse a `#!` interpreter line from a program's leading bytes into the command
/// words to run it under. Generic exec(2) behavior — no language policy: the
/// interpreter is reduced to its basename so both `#!/usr/bin/env node` and an
/// absolute `#!/usr/bin/node` resolve to whatever `node` is on `$PATH`, and the
/// `env` wrapper is unwrapped. `None` when there is no shebang.
fn parse_shebang(bytes: &[u8]) -> Option<Vec<String>> {
    if !bytes.starts_with(b"#!") {
        return None;
    }
    let end = bytes.iter().position(|&b| b == b'\n').unwrap_or(bytes.len());
    let line = std::str::from_utf8(bytes.get(2..end)?).ok()?.trim();
    let mut toks: Vec<String> = line.split_whitespace().map(str::to_string).collect();
    if !toks.is_empty() && basename(&toks[0]) == "env" {
        toks.remove(0); // `/usr/bin/env CMD …` → CMD is the interpreter
    }
    if toks.is_empty() {
        return None;
    }
    toks[0] = basename(&toks[0]).to_string(); // resolve the interpreter via $PATH
    Some(toks)
}

/// Resolve a bare command `name` to an existing program file: a path containing
/// `/` is taken relative to `cwd`; otherwise each `path_dirs` entry is searched.
pub fn resolve_command(vfs: &dyn Vfs, cwd: &str, name: &str, path_dirs: &[&str]) -> Option<String> {
    let exists_file = |p: &str| matches!(vfs.stat(p), Ok(m) if m.file_type == FileType::File);
    if name.contains('/') {
        let abs = path::normalize(cwd, name);
        return exists_file(&abs).then_some(abs);
    }
    for dir in path_dirs {
        let candidate = path::normalize(dir, name);
        if exists_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Resolve a full invocation (interpreter + entry) from `argv`.
///
/// `js` is the kernel's native execution keyword: `js foo.js` runs `foo.js` with
/// the bare `sys` surface — the JS execution core the kernel owns. Every other
/// leading word is a command resolved through `path_dirs` and run in place under
/// that same native surface. Node.js compatibility is not special here: `node` is
/// an ordinary user program (`/bin/node`) that, when it needs to run a script,
/// resolves and evaluates it itself (it has synchronous `fs`) — the kernel has
/// no `node` concept.
pub fn resolve_invocation(
    vfs: &dyn Vfs,
    cwd: &str,
    argv: &[String],
    env: &[(String, String)],
    default_path: &[&str],
) -> Result<Invocation, ResolveError> {
    match argv.first().map(String::as_str) {
        None => Err(ResolveError::NotFound(String::new())),
        Some("js") => {
            let script = argv.get(1).ok_or(ResolveError::NotFound("<script>".into()))?;
            Ok(Invocation {
                interpreter: Interpreter::Js,
                entry: path::normalize(cwd, script),
                argv: argv.to_vec(),
            })
        }
        Some(name) => {
            // Resolve a bare command against `$PATH` from the environment (a plain
            // colon-separated dir list), falling back to the system default when
            // unset. The kernel knows nothing of `node_modules`: any ecosystem
            // convention (npm's `node_modules/.bin`) is just a directory the shell
            // or `npm run` put on `PATH` (INV-1). A name with a slash is a path,
            // handled inside `resolve_command`.
            let path_val = env
                .iter()
                .find(|(k, _)| k == "PATH")
                .map(|(_, v)| v.as_str())
                .filter(|v| !v.is_empty());
            let dirs: Vec<&str> = match path_val {
                Some(v) => v.split(':').filter(|s| !s.is_empty()).collect(),
                None => default_path.to_vec(),
            };
            let entry = resolve_command(vfs, cwd, name, &dirs)
                .ok_or_else(|| ResolveError::NotFound(name.to_string()))?;
            // Honor a `#!` shebang (generic exec(2)): if the resolved program is a
            // script naming an interpreter, run *that* interpreter with the script as
            // its first argument — so a `#!/usr/bin/env node` bin (e.g. the real npm's
            // symlinked `node_modules/.bin/*`) runs under /bin/node instead of the bare
            // `sys` surface. One level only; the interpreter must resolve to a *different*
            // file (guards against a program shebang-pointing at itself).
            if let Ok(bytes) = read_file(vfs, &entry) {
                if let Some(interp) = parse_shebang(&bytes) {
                    if let Some(interp_entry) = resolve_command(vfs, cwd, &interp[0], &dirs) {
                        if interp_entry != entry {
                            let mut new_argv = interp;
                            new_argv.push(entry);
                            new_argv.extend(argv.iter().skip(1).cloned());
                            return Ok(Invocation {
                                interpreter: Interpreter::Js,
                                entry: interp_entry,
                                argv: new_argv,
                            });
                        }
                    }
                }
            }
            Ok(Invocation {
                interpreter: Interpreter::Js,
                entry,
                argv: argv.to_vec(),
            })
        }
    }
}

/// Resolve the entry `entry` (an absolute VFS path) into a single-module graph.
///
/// OS programs are self-contained — bundled (`/bin`) or inlined (`/sbin`) at
/// build time — so there is no import graph to walk. A JS entry yields one module
/// holding its own source; a WASM entry yields an empty module list (its bytes
/// are read directly at spawn).
pub fn resolve_graph(vfs: &dyn Vfs, entry: &str) -> Result<ModuleGraph, ResolveError> {
    // Classify by extension first, then by content: a program installed at an
    // extensionless path (e.g. `/bin/grep`) is still wasm if the file starts with
    // the wasm magic header.
    let bytes = read_file(vfs, entry)?;
    if ModuleKind::from_path(entry) == ModuleKind::Wasm || is_wasm_bytes(&bytes) {
        return Ok(ModuleGraph {
            entry: entry.to_string(),
            kind: ModuleKind::Wasm,
            modules: Vec::new(),
        });
    }
    let source = String::from_utf8(bytes).map_err(|_| ResolveError::Io(Errno::Inval))?;
    Ok(ModuleGraph {
        entry: entry.to_string(),
        kind: ModuleKind::Js,
        modules: vec![ModuleRecord {
            path: entry.to_string(),
            source,
        }],
    })
}

/// True if `bytes` begins with the WebAssembly magic header (`\0asm`).
fn is_wasm_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[..4] == [0x00, 0x61, 0x73, 0x6d]
}

fn read_file(vfs: &dyn Vfs, path_abs: &str) -> Result<Vec<u8>, ResolveError> {
    let meta = match vfs.stat(path_abs) {
        Ok(m) => m,
        Err(Errno::Noent) | Err(Errno::Notdir) => {
            return Err(ResolveError::NotFound(path_abs.to_string()))
        }
        Err(e) => return Err(ResolveError::Io(e)),
    };
    if meta.file_type != FileType::File {
        return Err(ResolveError::NotFound(path_abs.to_string()));
    }
    let ino = vfs.resolve(path_abs).map_err(ResolveError::Io)?;
    let mut buf = vec![0u8; meta.size as usize];
    vfs.read_at(ino, 0, &mut buf).map_err(ResolveError::Io)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::{MemVfs, OpenOptions};

    fn write(vfs: &mut MemVfs, path: &str, src: &str) {
        let ino = vfs
            .open(path, OpenOptions { create: true, truncate: true, ..Default::default() })
            .unwrap();
        vfs.write_at(ino, 0, src.as_bytes()).unwrap();
        vfs.close(ino).unwrap();
    }

    #[test]
    fn resolve_command_uses_path_then_relative() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/bin").unwrap();
        vfs.mkdir("/proj").unwrap();
        write(&mut vfs, "/bin/echo", "");
        write(&mut vfs, "/proj/tool.js", "");
        // bare name → PATH
        assert_eq!(resolve_command(&vfs, "/proj", "echo", DEFAULT_PATH), Some("/bin/echo".into()));
        // name with slash → relative to cwd
        assert_eq!(resolve_command(&vfs, "/proj", "./tool.js", DEFAULT_PATH), Some("/proj/tool.js".into()));
        // missing
        assert_eq!(resolve_command(&vfs, "/proj", "nope", DEFAULT_PATH), None);
    }

    #[test]
    fn resolve_invocation_variants() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/bin").unwrap();
        vfs.mkdir("/proj").unwrap();
        write(&mut vfs, "/bin/ls", "");
        write(&mut vfs, "/bin/node", "");
        write(&mut vfs, "/proj/main.js", "");
        // `js` is the kernel's native execution keyword: run argv[1] directly.
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["js".into(), "main.js".into()], &[], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/proj/main.js".into(), argv: vec!["js".into(), "main.js".into()] }
        );
        // `node` is just a user program: it resolves through PATH to /bin/node and
        // runs in place. Loading `main.js` is /bin/node's own job at runtime.
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["node".into(), "main.js".into()], &[], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/bin/node".into(), argv: vec!["node".into(), "main.js".into()] }
        );
        // Any other bare program runs in place under the native surface too.
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["ls".into(), "-a".into()], &[], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/bin/ls".into(), argv: vec!["ls".into(), "-a".into()] }
        );
    }

    #[test]
    fn shebang_runs_a_script_through_its_interpreter() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/bin").unwrap();
        vfs.mkdir("/nm").unwrap();
        vfs.mkdir("/nm/.bin").unwrap();
        write(&mut vfs, "/bin/node", "var x=1;"); // the interpreter (no shebang)
        write(&mut vfs, "/nm/.bin/tool", "#!/usr/bin/env node\nimport './dist/x.js'\n");
        // A `#!/usr/bin/env node` bin on PATH runs under /bin/node, with itself as
        // argv[1] and the caller's args following — exactly like `node <script>`.
        assert_eq!(
            resolve_invocation(&vfs, "/", &["tool".into(), "--yes".into()], &[("PATH".into(), "/nm/.bin:/bin".into())], DEFAULT_PATH).unwrap(),
            Invocation {
                interpreter: Interpreter::Js,
                entry: "/bin/node".into(),
                argv: vec!["node".into(), "/nm/.bin/tool".into(), "--yes".into()],
            }
        );
        // A program without a shebang still runs in place (no rewrite).
        write(&mut vfs, "/bin/plain", "console.log(1)");
        assert_eq!(
            resolve_invocation(&vfs, "/", &["plain".into()], &[], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/bin/plain".into(), argv: vec!["plain".into()] }
        );
    }

    #[test]
    fn command_resolution_is_driven_by_path_env() {
        // The kernel searches `$PATH` and nothing more — no `node_modules`
        // knowledge (INV-1). A shell / `npm run` that wants npm's `.bin`
        // convention just puts those dirs on `PATH`; here the *test* constructs
        // that string, proving the policy lives outside the kernel.
        let mut vfs = MemVfs::new();
        vfs.mkdir("/bin").unwrap();
        vfs.mkdir("/proj").unwrap();
        for d in ["/proj/node_modules", "/proj/node_modules/.bin"] {
            vfs.mkdir(d).unwrap();
        }
        write(&mut vfs, "/bin/esbuild", "// on the system PATH");
        write(&mut vfs, "/proj/node_modules/.bin/esbuild", "// an installed launcher");

        // No PATH in env → the system default (/bin:/sbin) is used.
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["esbuild".into()], &[], DEFAULT_PATH).unwrap().entry,
            "/bin/esbuild"
        );
        // PATH set (as the shell does) → its dirs are searched in listed order.
        let env = vec![("PATH".into(), "/proj/node_modules/.bin:/bin:/sbin".into())];
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["esbuild".into()], &env, DEFAULT_PATH).unwrap().entry,
            "/proj/node_modules/.bin/esbuild"
        );
        // An entry that doesn't exist is skipped; resolution continues down PATH.
        let env2 = vec![("PATH".into(), "/nope/.bin:/bin".into())];
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["esbuild".into()], &env2, DEFAULT_PATH).unwrap().entry,
            "/bin/esbuild"
        );
    }

    #[test]
    fn wasm_magic_detection() {
        assert!(is_wasm_bytes(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00]));
        assert!(!is_wasm_bytes(b"console.log(1)"));
        assert!(!is_wasm_bytes(b"\0as")); // too short
    }

    #[test]
    fn kind_from_extension() {
        assert_eq!(ModuleKind::from_path("/a.js"), ModuleKind::Js);
        assert_eq!(ModuleKind::from_path("/a.mjs"), ModuleKind::Js);
        assert_eq!(ModuleKind::from_path("/a.wasm"), ModuleKind::Wasm);
    }

    #[test]
    fn resolve_single_file() {
        let mut vfs = MemVfs::new();
        write(&mut vfs, "/main.js", "console.log('hi')");
        let g = resolve_graph(&vfs, "/main.js").unwrap();
        assert_eq!(g.entry, "/main.js");
        assert_eq!(g.kind, ModuleKind::Js);
        assert_eq!(g.modules.len(), 1);
        assert_eq!(g.modules[0].source, "console.log('hi')");
    }

    #[test]
    fn missing_entry_is_not_found() {
        let vfs = MemVfs::new();
        assert_eq!(
            resolve_graph(&vfs, "/nope.js").unwrap_err(),
            ResolveError::NotFound("/nope.js".into())
        );
    }
}
