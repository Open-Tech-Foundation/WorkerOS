//! The `wsh` abstract syntax tree (ARCHITECTURE.md §10, ADR-012).
//!
//! `wsh` is bash-*flavored*, not bash. It covers the subset real project scripts
//! use: words with quoting and `*` globs, env assignments, pipelines, the three
//! redirects, the `&&`/`||`/`;` operators, and background `&`. It deliberately
//! omits subshells, functions, `[[ ]]`, arrays, and parameter expansion — those
//! are documented non-goals, not oversights.

/// A parsed command line: a sequence of statements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Script {
    pub statements: Vec<Statement>,
}

/// One statement: an and-or list, optionally backgrounded (`&`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub list: AndOr,
    /// True when the statement ended with `&` (run in the background).
    pub background: bool,
}

/// A chain of pipelines joined by `&&` / `||`, evaluated left to right with the
/// usual short-circuit semantics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndOr {
    pub first: Pipeline,
    pub rest: Vec<(AndOrOp, Pipeline)>,
}

/// The connector between two pipelines in an and-or list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndOrOp {
    /// `&&` — run the next only if the previous succeeded (exit 0).
    And,
    /// `||` — run the next only if the previous failed (exit != 0).
    Or,
}

/// One or more commands connected by `|`; all run concurrently with stdout→stdin
/// wired between neighbors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pipeline {
    pub commands: Vec<Command>,
}

/// A simple command: leading `NAME=value` assignments, an argv of words, and
/// redirects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub assignments: Vec<Assignment>,
    pub argv: Vec<Word>,
    pub redirects: Vec<Redirect>,
}

/// A `NAME=value` assignment prefixing a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub name: String,
    pub value: String,
}

/// A shell word after lexing: its literal text (quotes removed) plus whether it
/// contained an *unquoted* `*` and is therefore a glob pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub text: String,
    /// True if the word has an unquoted `*` (subject to glob expansion).
    pub globbable: bool,
}

impl Word {
    /// A plain literal word (no glob).
    pub fn literal(text: impl Into<String>) -> Word {
        Word {
            text: text.into(),
            globbable: false,
        }
    }
}

/// A redirection attached to a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    /// The affected fd. Defaults follow the operator (`<`→0, `>`/`>>`→1) when the
    /// source omits an explicit number.
    pub fd: u32,
    pub op: RedirectOp,
    /// The redirection target (a filename word).
    pub target: Word,
}

/// The kind of redirection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirectOp {
    /// `<` — open the target for reading on the fd.
    Read,
    /// `>` — truncate/create the target for writing on the fd.
    Write,
    /// `>>` — append to the target on the fd.
    Append,
}
