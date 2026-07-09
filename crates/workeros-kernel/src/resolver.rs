//! The module resolver — authoritative entrypoint and `import` resolution
//! (ARCHITECTURE.md §7, INV-2/ADR-004).
//!
//! When a program is spawned, the kernel (not the program-worker shim) locates
//! the entry file against the VFS, reads it, determines its kind (JS source vs
//! WASM module), and — for JS — walks its `import` graph, resolving each relative
//! specifier against the VFS. The shim receives a fully-resolved graph and only
//! *stitches* it (blob URLs); it never decides what a specifier points at. That
//! division is the whole point of INV-2.
//!
//! Scope (Phase 2): **relative** specifiers only (`./`, `../`, `/`). Bare
//! specifiers (`import "foo"`) need the package-folder resolution walk, which is
//! a guest-side `workeros-programs/node` concern for Phase 5 — here they are an explicit,
//! honest error, never a silent stub (INV-5).
//!
//! The import scanner recognizes static `import`/`export … from "spec"`,
//! side-effect `import "spec"`, and dynamic `import("spec")` with string-literal
//! specifiers, skipping comments and strings. It is deliberately not a full JS
//! parser (computed dynamic imports are not resolved ahead of time); this is
//! documented rather than hidden.

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

/// One import edge inside a module: the specifier as written, and the absolute
/// VFS path the kernel resolved it to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEdge {
    pub specifier: String,
    pub resolved: String,
}

/// One node in the resolved module graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleRecord {
    /// Absolute VFS path of the module.
    pub path: String,
    /// The module's source text (JS).
    pub source: String,
    /// Its resolved import edges.
    pub imports: Vec<ImportEdge>,
}

/// A fully-resolved module graph handed to the program worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleGraph {
    /// Absolute path of the entry module.
    pub entry: String,
    /// Executable kind of the entry.
    pub kind: ModuleKind,
    /// Every module in the graph, entry first (reverse-topological is *not*
    /// guaranteed; the shim orders by dependency when stitching blobs).
    pub modules: Vec<ModuleRecord>,
}

/// Why resolution failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// A file (entry or import target) does not exist.
    NotFound(String),
    /// A bare/unsupported specifier was imported (needs the Phase 5 node layer).
    Unsupported(String),
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

/// A resolved invocation: the interpreter to run under and the entry file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub interpreter: Interpreter,
    pub entry: String,
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
/// asks the kernel to resolve the script's graph ([`Kernel::resolve_graph`]) and
/// evaluates it itself — the kernel has no `node` concept.
pub fn resolve_invocation(
    vfs: &dyn Vfs,
    cwd: &str,
    argv: &[String],
    path_dirs: &[&str],
) -> Result<Invocation, ResolveError> {
    match argv.first().map(String::as_str) {
        None => Err(ResolveError::NotFound(String::new())),
        Some("js") => {
            let script = argv.get(1).ok_or(ResolveError::NotFound("<script>".into()))?;
            Ok(Invocation {
                interpreter: Interpreter::Js,
                entry: path::normalize(cwd, script),
            })
        }
        Some(name) => {
            let entry = resolve_command(vfs, cwd, name, path_dirs)
                .ok_or_else(|| ResolveError::NotFound(name.to_string()))?;
            Ok(Invocation {
                interpreter: Interpreter::Js,
                entry,
            })
        }
    }
}

/// Resolve the full JS module graph rooted at `entry` (an absolute VFS path).
pub fn resolve_graph(vfs: &dyn Vfs, entry: &str) -> Result<ModuleGraph, ResolveError> {
    // Classify by extension first, then by content: a program installed at an
    // extensionless path (e.g. `/bin/grep`) is still wasm if the file starts with
    // the wasm magic header. wasm is opaque to the JS import scanner, so a wasm
    // entry resolves to a single-node graph.
    let bytes = read_file(vfs, entry)?;
    if ModuleKind::from_path(entry) == ModuleKind::Wasm || is_wasm_bytes(&bytes) {
        return Ok(ModuleGraph {
            entry: entry.to_string(),
            kind: ModuleKind::Wasm,
            modules: Vec::new(),
        });
    }
    let kind = ModuleKind::from_path(entry);
    let mut modules: Vec<ModuleRecord> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut queue: Vec<String> = vec![entry.to_string()];

    while let Some(path_abs) = queue.pop() {
        if seen.contains(&path_abs) {
            continue;
        }
        seen.push(path_abs.clone());

        // WASM modules are opaque to the JS import scanner.
        if ModuleKind::from_path(&path_abs) == ModuleKind::Wasm {
            read_file(vfs, &path_abs)?; // existence check
            continue;
        }

        let source = read_text(vfs, &path_abs)?;
        let parent = path::split(&path_abs).map(|(p, _)| p).unwrap_or("/");
        let mut imports = Vec::new();
        for specifier in scan_imports(&source) {
            if !is_relative(&specifier) {
                return Err(ResolveError::Unsupported(specifier));
            }
            let resolved = path::normalize(parent, &specifier);
            match vfs.stat(&resolved) {
                Ok(meta) if meta.file_type == FileType::File => {}
                _ => return Err(ResolveError::NotFound(resolved.clone())),
            }
            if !seen.contains(&resolved) {
                queue.push(resolved.clone());
            }
            imports.push(ImportEdge {
                specifier,
                resolved,
            });
        }
        modules.push(ModuleRecord {
            path: path_abs,
            source,
            imports,
        });
    }

    // Ensure the entry is first for a stable, predictable graph.
    if let Some(pos) = modules.iter().position(|m| m.path == entry) {
        modules.swap(0, pos);
    }

    Ok(ModuleGraph {
        entry: entry.to_string(),
        kind,
        modules,
    })
}

fn is_relative(specifier: &str) -> bool {
    specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/')
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

fn read_text(vfs: &dyn Vfs, path_abs: &str) -> Result<String, ResolveError> {
    let bytes = read_file(vfs, path_abs)?;
    String::from_utf8(bytes).map_err(|_| ResolveError::Io(Errno::Inval))
}

/// A minimal ES-module token stream: identifiers, string literals, and single
/// punctuation, with comments and string internals skipped.
#[derive(Debug, PartialEq, Eq)]
enum Tok {
    Ident(String),
    Str(String),
    Punct(char),
}

fn tokenize(src: &str) -> Vec<Tok> {
    let b = src.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            // Line comment.
            b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                i += 2;
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            // Block comment.
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            // String literal (single, double, or template — no interpolation parsing).
            b'"' | b'\'' | b'`' => {
                let quote = c;
                i += 1;
                let start = i;
                while i < b.len() && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                let content = String::from_utf8_lossy(&b[start..i.min(b.len())]).into_owned();
                toks.push(Tok::Str(content));
                i += 1; // closing quote
            }
            // Identifier / keyword.
            _ if c.is_ascii_alphabetic() || c == b'_' || c == b'$' => {
                let start = i;
                while i < b.len()
                    && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$')
                {
                    i += 1;
                }
                toks.push(Tok::Ident(String::from_utf8_lossy(&b[start..i]).into_owned()));
            }
            // Whitespace.
            _ if c.is_ascii_whitespace() => {
                i += 1;
            }
            // A punctuation char we might care about (`(`), everything else ignored.
            _ => {
                toks.push(Tok::Punct(c as char));
                i += 1;
            }
        }
    }
    toks
}

/// Extract module specifiers from source: `from "x"`, `import "x"`, `import("x")`.
fn scan_imports(src: &str) -> Vec<String> {
    let toks = tokenize(src);
    let mut specs = Vec::new();
    for (k, tok) in toks.iter().enumerate() {
        let Tok::Str(content) = tok else { continue };
        // What immediately precedes this string literal?
        match toks.get(k.wrapping_sub(1)) {
            Some(Tok::Ident(id)) if id == "from" || id == "import" => {
                specs.push(content.clone());
            }
            Some(Tok::Punct('(')) => {
                // Dynamic import: `import ( "x" )`.
                if matches!(toks.get(k.wrapping_sub(2)), Some(Tok::Ident(id)) if id == "import") {
                    specs.push(content.clone());
                }
            }
            _ => {}
        }
    }
    specs
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
            resolve_invocation(&vfs, "/proj", &["js".into(), "main.js".into()], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/proj/main.js".into() }
        );
        // `node` is just a user program: it resolves through PATH to /bin/node and
        // runs in place. Loading `main.js` is /bin/node's own job at runtime.
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["node".into(), "main.js".into()], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/bin/node".into() }
        );
        // Any other bare program runs in place under the native surface too.
        assert_eq!(
            resolve_invocation(&vfs, "/proj", &["ls".into(), "-a".into()], DEFAULT_PATH).unwrap(),
            Invocation { interpreter: Interpreter::Js, entry: "/bin/ls".into() }
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
    fn scan_various_import_forms() {
        let src = r#"
            import a from "./a.js";
            import { b } from './b.js';
            import "./side.js";
            export { c } from "./c.js";
            const d = await import("./d.js");
            // import "./comment.js" should be ignored
            const s = "not an ./import.js";
        "#;
        let mut specs = scan_imports(src);
        specs.sort();
        assert_eq!(
            specs,
            vec!["./a.js", "./b.js", "./c.js", "./d.js", "./side.js"]
        );
    }

    #[test]
    fn resolve_single_file() {
        let mut vfs = MemVfs::new();
        write(&mut vfs, "/main.js", "console.log('hi')");
        let g = resolve_graph(&vfs, "/main.js").unwrap();
        assert_eq!(g.entry, "/main.js");
        assert_eq!(g.kind, ModuleKind::Js);
        assert_eq!(g.modules.len(), 1);
        assert!(g.modules[0].imports.is_empty());
    }

    #[test]
    fn resolve_relative_import_graph() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/proj").unwrap();
        vfs.mkdir("/proj/lib").unwrap();
        write(&mut vfs, "/proj/main.js", "import { u } from './lib/util.js'; u();");
        write(&mut vfs, "/proj/lib/util.js", "export const u = () => {};");
        let g = resolve_graph(&vfs, "/proj/main.js").unwrap();
        assert_eq!(g.modules.len(), 2);
        assert_eq!(g.modules[0].path, "/proj/main.js");
        assert_eq!(
            g.modules[0].imports,
            vec![ImportEdge {
                specifier: "./lib/util.js".into(),
                resolved: "/proj/lib/util.js".into()
            }]
        );
    }

    #[test]
    fn dotdot_import_resolves_against_module_dir() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/proj").unwrap();
        vfs.mkdir("/proj/src").unwrap();
        write(&mut vfs, "/proj/src/main.js", "import '../shared.js';");
        write(&mut vfs, "/proj/shared.js", "");
        let g = resolve_graph(&vfs, "/proj/src/main.js").unwrap();
        assert_eq!(g.modules[0].imports[0].resolved, "/proj/shared.js");
    }

    #[test]
    fn missing_import_is_not_found() {
        let mut vfs = MemVfs::new();
        write(&mut vfs, "/main.js", "import './gone.js';");
        assert_eq!(
            resolve_graph(&vfs, "/main.js").unwrap_err(),
            ResolveError::NotFound("/gone.js".into())
        );
    }

    #[test]
    fn bare_specifier_is_unsupported() {
        let mut vfs = MemVfs::new();
        write(&mut vfs, "/main.js", "import _ from 'lodash';");
        assert_eq!(
            resolve_graph(&vfs, "/main.js").unwrap_err(),
            ResolveError::Unsupported("lodash".into())
        );
    }

    #[test]
    fn missing_entry_is_not_found() {
        let vfs = MemVfs::new();
        assert_eq!(
            resolve_graph(&vfs, "/nope.js").unwrap_err(),
            ResolveError::NotFound("/nope.js".into())
        );
    }

    #[test]
    fn shared_dependency_deduped() {
        let mut vfs = MemVfs::new();
        write(&mut vfs, "/a.js", "import './c.js'; import './b.js';");
        write(&mut vfs, "/b.js", "import './c.js';");
        write(&mut vfs, "/c.js", "");
        let g = resolve_graph(&vfs, "/a.js").unwrap();
        // a, b, c — c only once.
        assert_eq!(g.modules.len(), 3);
        let paths: Vec<_> = g.modules.iter().map(|m| m.path.clone()).collect();
        assert_eq!(paths.iter().filter(|p| *p == "/c.js").count(), 1);
        assert_eq!(g.modules[0].path, "/a.js", "entry first");
    }
}
