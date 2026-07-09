//! The rich `wsh` AST (ADR-012) — the bash-subset grammar a real script uses:
//! and-or lists, pipelines, redirections, the compound commands
//! (`if`/`for`/`while`/`until`/`case`, brace groups, subshells), and function
//! definitions. Words keep their *unexpanded* parts (`$x`, `${…}`, `$(…)`,
//! `$(( … ))`, quotes) so the host evaluator can expand them at run time with the
//! right field-splitting/globbing rules.
//!
//! The kernel crate is dependency-free (no serde), so the AST serializes itself to
//! a JSON string via [`Script::to_json`]; the wasm layer hands that to the JS
//! evaluator with `JSON.parse`. The shape matches what `shell/interp.js` consumes.

/// One segment of a word, carrying whether it was quoted (quoted expansions are
/// not field-split or globbed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    /// Literal text (unquoted or double-quoted run).
    Lit { value: String, quoted: bool },
    /// Single-quoted literal (always "quoted": no expansion, no splitting).
    Sq { value: String },
    /// `$name` / `${…}` — `src` is the inside (e.g. `x:-default`).
    Param { src: String, quoted: bool },
    /// `$(…)` / backtick — `src` is the sub-script.
    Cmdsub { src: String, quoted: bool },
    /// `$(( … ))` — `src` is the arithmetic expression.
    Arith { src: String, quoted: bool },
}

/// A shell word: an ordered list of parts plus whether it carried an unquoted
/// glob metacharacter (`*` `?` `[`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub parts: Vec<Part>,
    pub globbable: bool,
}

/// A redirection: optional fd, operator string (`<` `>` `>>` `>&` `<&` …), target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    pub fd: Option<u32>,
    pub op: String,
    pub target: Word,
}

/// A leading `NAME=value` assignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assign {
    pub name: String,
    pub word: Word,
}

/// An `if` clause: a condition list and the body run when it succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IfClause {
    pub cond: List,
    pub body: List,
}

/// One `case` item: its patterns and the body run on a match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseItem {
    pub patterns: Vec<Word>,
    pub body: List,
}

/// A command: a simple command or one of the compound forms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Simple {
        assigns: Vec<Assign>,
        words: Vec<Word>,
        redirects: Vec<Redirect>,
    },
    If {
        clauses: Vec<IfClause>,
        else_body: Option<List>,
        redirects: Vec<Redirect>,
    },
    For {
        var: String,
        /// `None` => iterate over the positional parameters (`for x; do`).
        words: Option<Vec<Word>>,
        body: List,
        redirects: Vec<Redirect>,
    },
    While {
        cond: List,
        body: List,
        until: bool,
        redirects: Vec<Redirect>,
    },
    Case {
        word: Word,
        items: Vec<CaseItem>,
        redirects: Vec<Redirect>,
    },
    Group {
        body: List,
        redirects: Vec<Redirect>,
    },
    Subshell {
        body: List,
        redirects: Vec<Redirect>,
    },
    Func {
        name: String,
        body: Box<Command>,
    },
}

/// One or more commands joined by `|`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pipeline {
    pub commands: Vec<Command>,
    pub negate: bool,
}

/// The connector between pipelines in an and-or list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndOrOp {
    And,
    Or,
}

/// A chain of pipelines joined by `&&` / `||`, optionally backgrounded (`&`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndOr {
    /// Each entry is `(connector-before-this-pipeline, pipeline)`; the first
    /// connector is `None`.
    pub pipelines: Vec<(Option<AndOrOp>, Pipeline)>,
    pub background: bool,
}

/// A compound list: a sequence of and-or lists (statement separators consumed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct List {
    pub items: Vec<AndOr>,
}

// ---- JSON serialization (hand-rolled; keeps the kernel crate dependency-free) --

fn esc(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn bool_json(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

impl Part {
    fn write_json(&self, o: &mut String) {
        match self {
            Part::Lit { value, quoted } => {
                o.push_str("{\"kind\":\"lit\",\"value\":");
                esc(value, o);
                o.push_str(",\"quoted\":");
                o.push_str(bool_json(*quoted));
                o.push('}');
            }
            Part::Sq { value } => {
                o.push_str("{\"kind\":\"sq\",\"value\":");
                esc(value, o);
                o.push_str(",\"quoted\":true}");
            }
            Part::Param { src, quoted } => write_srcpart(o, "param", src, *quoted),
            Part::Cmdsub { src, quoted } => write_srcpart(o, "cmdsub", src, *quoted),
            Part::Arith { src, quoted } => write_srcpart(o, "arith", src, *quoted),
        }
    }
}

fn write_srcpart(o: &mut String, kind: &str, src: &str, quoted: bool) {
    o.push_str("{\"kind\":\"");
    o.push_str(kind);
    o.push_str("\",\"src\":");
    esc(src, o);
    o.push_str(",\"quoted\":");
    o.push_str(bool_json(quoted));
    o.push('}');
}

fn write_list<T>(o: &mut String, items: &[T], mut f: impl FnMut(&mut String, &T)) {
    o.push('[');
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        f(o, it);
    }
    o.push(']');
}

impl Word {
    fn write_json(&self, o: &mut String) {
        o.push_str("{\"parts\":");
        write_list(o, &self.parts, |o, p| p.write_json(o));
        o.push_str(",\"globbable\":");
        o.push_str(bool_json(self.globbable));
        o.push('}');
    }
}

impl Redirect {
    fn write_json(&self, o: &mut String) {
        o.push_str("{\"fd\":");
        match self.fd {
            Some(n) => o.push_str(&n.to_string()),
            None => o.push_str("null"),
        }
        o.push_str(",\"op\":");
        esc(&self.op, o);
        o.push_str(",\"target\":");
        self.target.write_json(o);
        o.push('}');
    }
}

fn write_redirects(o: &mut String, rs: &[Redirect]) {
    o.push_str(",\"redirects\":");
    write_list(o, rs, |o, r| r.write_json(o));
}

impl List {
    fn write_json(&self, o: &mut String) {
        o.push_str("{\"type\":\"list\",\"items\":");
        write_list(o, &self.items, |o, a| a.write_json(o));
        o.push('}');
    }
}

impl AndOr {
    fn write_json(&self, o: &mut String) {
        o.push_str("{\"type\":\"andor\",\"background\":");
        o.push_str(bool_json(self.background));
        o.push_str(",\"pipelines\":");
        write_list(o, &self.pipelines, |o, (op, p)| {
            o.push_str("{\"op\":");
            match op {
                None => o.push_str("null"),
                Some(AndOrOp::And) => o.push_str("\"&&\""),
                Some(AndOrOp::Or) => o.push_str("\"||\""),
            }
            o.push_str(",\"pipeline\":");
            p.write_json(o);
            o.push('}');
        });
        o.push('}');
    }
}

impl Pipeline {
    fn write_json(&self, o: &mut String) {
        o.push_str("{\"type\":\"pipeline\",\"negate\":");
        o.push_str(bool_json(self.negate));
        o.push_str(",\"commands\":");
        write_list(o, &self.commands, |o, c| c.write_json(o));
        o.push('}');
    }
}

impl Command {
    pub fn write_json(&self, o: &mut String) {
        match self {
            Command::Simple { assigns, words, redirects } => {
                o.push_str("{\"type\":\"simple\",\"assigns\":");
                write_list(o, assigns, |o, a| {
                    o.push_str("{\"name\":");
                    esc(&a.name, o);
                    o.push_str(",\"word\":");
                    a.word.write_json(o);
                    o.push('}');
                });
                o.push_str(",\"words\":");
                write_list(o, words, |o, w| w.write_json(o));
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::If { clauses, else_body, redirects } => {
                o.push_str("{\"type\":\"if\",\"clauses\":");
                write_list(o, clauses, |o, c| {
                    o.push_str("{\"cond\":");
                    c.cond.write_json(o);
                    o.push_str(",\"body\":");
                    c.body.write_json(o);
                    o.push('}');
                });
                o.push_str(",\"elseBody\":");
                match else_body {
                    Some(l) => l.write_json(o),
                    None => o.push_str("null"),
                }
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::For { var, words, body, redirects } => {
                o.push_str("{\"type\":\"for\",\"var\":");
                esc(var, o);
                o.push_str(",\"words\":");
                match words {
                    Some(ws) => write_list(o, ws, |o, w| w.write_json(o)),
                    None => o.push_str("null"),
                }
                o.push_str(",\"body\":");
                body.write_json(o);
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::While { cond, body, until, redirects } => {
                o.push_str("{\"type\":\"while\",\"until\":");
                o.push_str(bool_json(*until));
                o.push_str(",\"cond\":");
                cond.write_json(o);
                o.push_str(",\"body\":");
                body.write_json(o);
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::Case { word, items, redirects } => {
                o.push_str("{\"type\":\"case\",\"word\":");
                word.write_json(o);
                o.push_str(",\"items\":");
                write_list(o, items, |o, it| {
                    o.push_str("{\"patterns\":");
                    write_list(o, &it.patterns, |o, w| w.write_json(o));
                    o.push_str(",\"body\":");
                    it.body.write_json(o);
                    o.push('}');
                });
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::Group { body, redirects } => {
                o.push_str("{\"type\":\"group\",\"body\":");
                body.write_json(o);
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::Subshell { body, redirects } => {
                o.push_str("{\"type\":\"subshell\",\"body\":");
                body.write_json(o);
                write_redirects(o, redirects);
                o.push('}');
            }
            Command::Func { name, body } => {
                o.push_str("{\"type\":\"func\",\"name\":");
                esc(name, o);
                o.push_str(",\"body\":");
                body.write_json(o);
                o.push('}');
            }
        }
    }
}

/// The parsed program.
pub type Script = List;

impl Script {
    /// Serialize to a JSON string matching `shell/interp.js`'s expected AST shape.
    pub fn to_json(&self) -> String {
        let mut o = String::new();
        self.write_json(&mut o);
        o
    }
}
