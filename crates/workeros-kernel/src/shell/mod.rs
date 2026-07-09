//! `wsh` — the WorkerOS shell (ARCHITECTURE.md §10, ADR-012).
//!
//! Bash-*flavored*, not bash. This module owns the pure, kernel-authoritative
//! parts of the shell: lexing, parsing, and `*` glob expansion against the VFS.
//! The async *execution* of a parsed line — creating program workers, wiring
//! pipes, sequencing `&&`/`||`, backgrounding — is driven by the host over these
//! results (the host cannot avoid it: process lifecycles are async), but every
//! decision it makes (resolve a command, open a pipe, bind stdio, glob a word)
//! is a call back into the kernel. INV-2 holds: the shell's *logic* is here.

pub mod ast;
pub mod lexer;
pub mod parser;

pub use ast::*;
pub use parser::{parse, ParseError};

use crate::vfs::{path, Vfs};

/// Expand a glob `pattern` against the VFS, relative to `cwd`.
///
/// Returns matches in the same relative/absolute form as the pattern, sorted.
/// If nothing matches, returns the pattern unchanged (bash's default "no
/// nullglob" behavior). Supports `*` in any path component; `*` does not match a
/// leading `.` unless the component itself starts with `.`.
pub fn glob(vfs: &dyn Vfs, cwd: &str, pattern: &str) -> Vec<String> {
    if !pattern.contains('*') {
        return vec![pattern.to_string()];
    }
    let absolute = pattern.starts_with('/');
    let comps: Vec<&str> = pattern.split('/').filter(|c| !c.is_empty()).collect();

    // Each candidate is (absolute_dir, relative_path_built_so_far).
    let base_dir = if absolute { "/".to_string() } else { cwd.to_string() };
    let mut candidates: Vec<(String, String)> = vec![(base_dir, String::new())];

    for comp in comps {
        let mut next = Vec::new();
        if comp.contains('*') {
            for (abs_dir, rel) in &candidates {
                let Ok(mut entries) = vfs.readdir(abs_dir) else { continue };
                entries.sort_by(|a, b| a.name.cmp(&b.name));
                for e in entries {
                    if e.name.starts_with('.') && !comp.starts_with('.') {
                        continue;
                    }
                    if wildcard_match(comp, &e.name) {
                        next.push((path::normalize(abs_dir, &e.name), join_rel(rel, &e.name)));
                    }
                }
            }
        } else {
            for (abs_dir, rel) in &candidates {
                let child = path::normalize(abs_dir, comp);
                if vfs.stat(&child).is_ok() {
                    next.push((child, join_rel(rel, comp)));
                }
            }
        }
        candidates = next;
    }

    if candidates.is_empty() {
        return vec![pattern.to_string()];
    }
    let mut out: Vec<String> = candidates
        .into_iter()
        .map(|(_, rel)| if absolute { format!("/{rel}") } else { rel })
        .collect();
    out.sort();
    out
}

fn join_rel(prefix: &str, comp: &str) -> String {
    if prefix.is_empty() {
        comp.to_string()
    } else {
        format!("{prefix}/{comp}")
    }
}

/// Match a single path component against a `*`-wildcard pattern.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    // Classic two-pointer wildcard match with backtracking on `*`.
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ni < n.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if pi < p.len() && p[pi] == n[ni] {
            pi += 1;
            ni += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::{MemVfs, OpenOptions};

    fn touch(vfs: &mut MemVfs, path: &str) {
        vfs.open(path, OpenOptions { create: true, ..Default::default() })
            .and_then(|ino| vfs.close(ino))
            .unwrap();
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard_match("*.rs", "main.rs"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("a*c", "abc"));
        assert!(wildcard_match("a*c", "ac"));
        assert!(wildcard_match("a*c*e", "abcde"));
        assert!(!wildcard_match("*.rs", "main.js"));
        assert!(!wildcard_match("a*c", "abd"));
        assert!(wildcard_match("foo", "foo"));
        assert!(!wildcard_match("foo", "food"));
    }

    #[test]
    fn glob_in_cwd() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/proj").unwrap();
        touch(&mut vfs, "/proj/a.rs");
        touch(&mut vfs, "/proj/b.rs");
        touch(&mut vfs, "/proj/c.js");
        assert_eq!(glob(&vfs, "/proj", "*.rs"), vec!["a.rs", "b.rs"]);
        assert_eq!(glob(&vfs, "/proj", "*.js"), vec!["c.js"]);
    }

    #[test]
    fn glob_absolute_and_nested() {
        let mut vfs = MemVfs::new();
        vfs.mkdir("/src").unwrap();
        touch(&mut vfs, "/src/x.txt");
        touch(&mut vfs, "/src/y.txt");
        assert_eq!(glob(&vfs, "/", "/src/*.txt"), vec!["/src/x.txt", "/src/y.txt"]);
        assert_eq!(glob(&vfs, "/", "src/*.txt"), vec!["src/x.txt", "src/y.txt"]);
    }

    #[test]
    fn glob_no_match_keeps_pattern() {
        let vfs = MemVfs::new();
        assert_eq!(glob(&vfs, "/", "*.none"), vec!["*.none"]);
    }

    #[test]
    fn glob_skips_hidden_unless_dotted() {
        let mut vfs = MemVfs::new();
        touch(&mut vfs, "/.hidden");
        touch(&mut vfs, "/visible");
        assert_eq!(glob(&vfs, "/", "*"), vec!["visible"]);
        assert_eq!(glob(&vfs, "/", ".*"), vec![".hidden"]);
    }

    #[test]
    fn non_glob_pattern_returned_verbatim() {
        let vfs = MemVfs::new();
        assert_eq!(glob(&vfs, "/", "plain.txt"), vec!["plain.txt"]);
    }
}
