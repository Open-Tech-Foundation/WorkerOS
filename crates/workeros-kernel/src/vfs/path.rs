//! POSIX-shaped path handling for the VFS.
//!
//! Paths are absolute, `/`-separated, with no symlinks (v1). [`normalize`]
//! resolves a possibly-relative path against a cwd into a canonical absolute
//! path with `.`/`..`/`//` collapsed; the VFS only ever sees normalized paths.

use crate::errno::{Errno, SysResult};

/// Maximum length of a single path component.
const MAX_COMPONENT: usize = 255;

/// Iterate the non-empty components of an absolute normalized path.
///
/// For `"/"` this yields nothing; for `"/a/b"` it yields `["a", "b"]`.
pub fn components(path: &str) -> impl Iterator<Item = &str> {
    path.split('/').filter(|c| !c.is_empty())
}

/// Split an absolute normalized path into (parent, last_component).
///
/// Returns `None` for the root (`"/"`), which has no parent/name. For `"/a"`
/// this is `("/", "a")`; for `"/a/b"` it is `("/a", "b")`.
pub fn split(path: &str) -> Option<(&str, &str)> {
    if path == "/" {
        return None;
    }
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    match trimmed.rfind('/') {
        Some(0) => Some(("/", &trimmed[1..])),
        Some(idx) => Some((&trimmed[..idx], &trimmed[idx + 1..])),
        None => None,
    }
}

/// Reject empty, over-long, or slash-bearing names, plus `.`/`..`.
pub fn validate_component(name: &str) -> SysResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(Errno::Inval);
    }
    if name.len() > MAX_COMPONENT {
        return Err(Errno::Nametoolong);
    }
    Ok(())
}

/// Normalize `path` (possibly relative) against absolute `cwd` into a canonical
/// absolute path. Collapses `.`/`..`/empty components; `..` at the root is a
/// no-op (cannot escape `/`). `cwd` must itself be absolute.
pub fn normalize(cwd: &str, path: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();

    // Seed with cwd components when the path is relative.
    if !path.starts_with('/') {
        for comp in components(cwd) {
            // cwd is trusted-absolute; still honor `.`/`..` defensively.
            match comp {
                "." => {}
                ".." => {
                    stack.pop();
                }
                c => stack.push(c),
            }
        }
    }

    for comp in components(path) {
        match comp {
            "." => {}
            ".." => {
                stack.pop();
            }
            c => stack.push(c),
        }
    }

    if stack.is_empty() {
        "/".to_string()
    } else {
        let mut out = String::new();
        for c in stack {
            out.push('/');
            out.push_str(c);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_of_root_is_empty() {
        assert_eq!(components("/").count(), 0);
        assert_eq!(components("/a/b").collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(components("/a//b/").collect::<Vec<_>>(), vec!["a", "b"]);
    }

    #[test]
    fn split_cases() {
        assert_eq!(split("/"), None);
        assert_eq!(split("/a"), Some(("/", "a")));
        assert_eq!(split("/a/b"), Some(("/a", "b")));
        assert_eq!(split("/a/b/"), Some(("/a", "b")));
    }

    #[test]
    fn normalize_absolute_collapses() {
        assert_eq!(normalize("/", "/a/b/../c"), "/a/c");
        assert_eq!(normalize("/", "/a/./b"), "/a/b");
        assert_eq!(normalize("/", "/a//b///c"), "/a/b/c");
        assert_eq!(normalize("/", "/a/b/"), "/a/b");
    }

    #[test]
    fn normalize_relative_against_cwd() {
        assert_eq!(normalize("/home/user", "file.txt"), "/home/user/file.txt");
        assert_eq!(normalize("/home/user", "./file.txt"), "/home/user/file.txt");
        assert_eq!(normalize("/home/user", "../other"), "/home/other");
        assert_eq!(normalize("/home/user", "../../x"), "/x");
    }

    #[test]
    fn dotdot_cannot_escape_root() {
        assert_eq!(normalize("/", "/../../.."), "/");
        assert_eq!(normalize("/", ".."), "/");
        assert_eq!(normalize("/a", "../../../b"), "/b");
    }

    #[test]
    fn normalize_root_and_empty() {
        assert_eq!(normalize("/", "/"), "/");
        assert_eq!(normalize("/x", "."), "/x");
        assert_eq!(normalize("/x/y", "../.."), "/");
    }

    #[test]
    fn validate_component_rejects_bad_names() {
        assert!(validate_component("ok").is_ok());
        assert_eq!(validate_component("").unwrap_err(), Errno::Inval);
        assert_eq!(validate_component(".").unwrap_err(), Errno::Inval);
        assert_eq!(validate_component("..").unwrap_err(), Errno::Inval);
        assert_eq!(validate_component("a/b").unwrap_err(), Errno::Inval);
        assert_eq!(validate_component(&"x".repeat(256)).unwrap_err(), Errno::Nametoolong);
    }
}
