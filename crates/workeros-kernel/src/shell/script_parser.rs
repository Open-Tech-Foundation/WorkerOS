//! Rich `wsh` parser — recursive descent over the lexer's tokens into the
//! [`super::script_ast`] AST: and-or lists, pipelines, redirections, and the
//! compound commands `if`/`for`/`while`/`until`/`case`, brace groups, subshells,
//! and function definitions. Expansion is left to the host evaluator.

use super::script_ast::*;
use super::script_lexer::{lex, LexError, Token};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl From<LexError> for ParseError {
    fn from(e: LexError) -> Self {
        ParseError(e.0)
    }
}

const RESERVED: &[&str] = &[
    "if", "then", "elif", "else", "fi", "for", "in", "do", "done", "while",
    "until", "case", "esac", "function", "{", "}", "!", "[[", "]]",
];

/// Parse a whole script into the AST.
pub fn parse_script(src: &str) -> Result<Script, ParseError> {
    let toks = lex(src)?;
    let mut p = Parser { toks, pos: 0 };
    let prog = p.parse_program()?;
    if !matches!(p.peek(), Token::Eof) {
        return Err(ParseError(format!("wsh: syntax error: unexpected token: {:?}", p.peek())));
    }
    Ok(prog)
}

struct Parser {
    toks: Vec<Token>,
    pos: usize,
}

/// The literal text of a WORD token if it is a single unquoted literal segment.
fn literal(tok: &Token) -> Option<&str> {
    if let Token::Word { parts, .. } = tok {
        if parts.len() == 1 {
            if let Part::Lit { value, quoted: false } = &parts[0] {
                return Some(value);
            }
        }
    }
    None
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.toks[self.pos]
    }
    fn is_op(&self, op: &str) -> bool {
        matches!(self.peek(), Token::Op(o) if o == op)
    }
    fn at_word(&self, w: &str) -> bool {
        literal(self.peek()) == Some(w)
    }
    fn eof(&self) -> bool {
        matches!(self.peek(), Token::Eof)
    }
    fn err(&self, msg: &str) -> ParseError {
        ParseError(format!("wsh: syntax error: {msg}"))
    }

    fn skip_separators(&mut self) {
        while matches!(self.peek(), Token::Newline) || self.is_op(";") {
            self.pos += 1;
        }
    }
    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Token::Newline) {
            self.pos += 1;
        }
    }

    fn parse_program(&mut self) -> Result<List, ParseError> {
        let mut items = Vec::new();
        self.skip_separators();
        while !self.eof() {
            let mut ao = match self.parse_and_or()? {
                Some(a) => a,
                None => break,
            };
            if self.is_op("&") {
                ao.background = true;
                self.pos += 1;
            }
            items.push(ao);
            self.skip_separators();
        }
        Ok(List { items })
    }

    /// A compound list terminated by one of `terminators` (reserved words / `;;` / `}`).
    fn parse_list_until(&mut self, terminators: &[&str]) -> Result<List, ParseError> {
        let mut items = Vec::new();
        self.skip_separators();
        while !self.eof() {
            if let Some(w) = literal(self.peek()) {
                if terminators.contains(&w) {
                    break;
                }
            }
            if self.is_op(";;") && terminators.contains(&";;") {
                break;
            }
            if self.is_op("}") && terminators.contains(&"}") {
                break;
            }
            let mut ao = match self.parse_and_or()? {
                Some(a) => a,
                None => break,
            };
            if self.is_op("&") {
                ao.background = true;
                self.pos += 1;
            }
            items.push(ao);
            if matches!(self.peek(), Token::Newline) || self.is_op(";") {
                self.skip_separators();
            } else {
                break;
            }
        }
        Ok(List { items })
    }

    fn parse_and_or(&mut self) -> Result<Option<AndOr>, ParseError> {
        self.skip_newlines();
        let first = match self.parse_pipeline()? {
            Some(p) => p,
            None => return Ok(None),
        };
        let mut pipelines = vec![(None, first)];
        loop {
            let op = if self.is_op("&&") {
                Some(AndOrOp::And)
            } else if self.is_op("||") {
                Some(AndOrOp::Or)
            } else {
                None
            };
            let Some(op) = op else { break };
            self.pos += 1;
            self.skip_newlines();
            let p = self.parse_pipeline()?.ok_or_else(|| self.err("expected command after && / ||"))?;
            pipelines.push((Some(op), p));
        }
        Ok(Some(AndOr { pipelines, background: false }))
    }

    fn parse_pipeline(&mut self) -> Result<Option<Pipeline>, ParseError> {
        let mut negate = false;
        if self.at_word("!") {
            negate = true;
            self.pos += 1;
        }
        let first = match self.parse_command()? {
            Some(c) => c,
            None => return Ok(None),
        };
        let mut commands = vec![first];
        while self.is_op("|") {
            self.pos += 1;
            self.skip_newlines();
            let c = self.parse_command()?.ok_or_else(|| self.err("expected command after |"))?;
            commands.push(c);
        }
        Ok(Some(Pipeline { commands, negate }))
    }

    fn parse_command(&mut self) -> Result<Option<Command>, ParseError> {
        if self.eof() {
            return Ok(None);
        }
        let w = literal(self.peek()).map(|s| s.to_string());
        match w.as_deref() {
            Some("if") => return self.parse_if().map(Some),
            Some("for") => return self.parse_for().map(Some),
            Some("while") => return self.parse_while(false).map(Some),
            Some("until") => return self.parse_while(true).map(Some),
            Some("case") => return self.parse_case().map(Some),
            Some("{") => return self.parse_brace_group().map(Some),
            Some("function") => {
                self.pos += 1;
                return self.parse_function_rest().map(Some);
            }
            _ => {}
        }
        if self.is_op("(") {
            return self.parse_subshell().map(Some);
        }
        // `name ()` function definition.
        if let Some(name) = &w {
            if !RESERVED.contains(&name.as_str())
                && matches!(self.toks.get(self.pos + 1), Some(Token::Op(o)) if o == "(")
            {
                self.pos += 2; // name (
                if !self.is_op(")") {
                    return Err(self.err("expected ) in function definition"));
                }
                self.pos += 1;
                self.skip_newlines();
                let body = self.parse_command()?.ok_or_else(|| self.err("expected function body"))?;
                return Ok(Some(Command::Func { name: name.clone(), body: Box::new(body) }));
            }
        }
        self.parse_simple()
    }

    fn parse_function_rest(&mut self) -> Result<Command, ParseError> {
        let name = literal(self.peek()).ok_or_else(|| self.err("expected function name"))?.to_string();
        self.pos += 1;
        if self.is_op("(") {
            self.pos += 1;
            if !self.is_op(")") {
                return Err(self.err("expected )"));
            }
            self.pos += 1;
        }
        self.skip_newlines();
        let body = self.parse_command()?.ok_or_else(|| self.err("expected function body"))?;
        Ok(Command::Func { name, body: Box::new(body) })
    }

    fn expect_word(&mut self, w: &str) -> Result<(), ParseError> {
        if !self.at_word(w) {
            return Err(self.err(&format!("expected '{w}'")));
        }
        self.pos += 1;
        Ok(())
    }

    fn parse_if(&mut self) -> Result<Command, ParseError> {
        self.pos += 1; // if
        let mut clauses = Vec::new();
        let cond = self.parse_list_until(&["then"])?;
        self.expect_word("then")?;
        let body = self.parse_list_until(&["elif", "else", "fi"])?;
        clauses.push(IfClause { cond, body });
        while self.at_word("elif") {
            self.pos += 1;
            let c = self.parse_list_until(&["then"])?;
            self.expect_word("then")?;
            let b = self.parse_list_until(&["elif", "else", "fi"])?;
            clauses.push(IfClause { cond: c, body: b });
        }
        let else_body = if self.at_word("else") {
            self.pos += 1;
            Some(self.parse_list_until(&["fi"])?)
        } else {
            None
        };
        self.expect_word("fi")?;
        let redirects = self.parse_redirects()?;
        Ok(Command::If { clauses, else_body, redirects })
    }

    fn parse_for(&mut self) -> Result<Command, ParseError> {
        self.pos += 1; // for
        let var = literal(self.peek()).ok_or_else(|| self.err("expected variable name after for"))?.to_string();
        self.pos += 1;
        let mut words = None;
        self.skip_newlines();
        if self.at_word("in") {
            self.pos += 1;
            let mut ws = Vec::new();
            while let Token::Word { parts, globbable } = self.peek() {
                ws.push(Word { parts: parts.clone(), globbable: *globbable });
                self.pos += 1;
            }
            words = Some(ws);
        }
        if self.is_op(";") {
            self.pos += 1;
        }
        self.skip_newlines();
        self.expect_word("do")?;
        let body = self.parse_list_until(&["done"])?;
        self.expect_word("done")?;
        let redirects = self.parse_redirects()?;
        Ok(Command::For { var, words, body, redirects })
    }

    fn parse_while(&mut self, until: bool) -> Result<Command, ParseError> {
        self.pos += 1; // while/until
        let cond = self.parse_list_until(&["do"])?;
        self.expect_word("do")?;
        let body = self.parse_list_until(&["done"])?;
        self.expect_word("done")?;
        let redirects = self.parse_redirects()?;
        Ok(Command::While { cond, body, until, redirects })
    }

    fn parse_case(&mut self) -> Result<Command, ParseError> {
        self.pos += 1; // case
        let word = match self.peek() {
            Token::Word { parts, globbable } => Word { parts: parts.clone(), globbable: *globbable },
            _ => return Err(self.err("expected word after case")),
        };
        self.pos += 1;
        self.skip_newlines();
        self.expect_word("in")?;
        self.skip_separators();
        let mut items = Vec::new();
        while !self.at_word("esac") && !self.eof() {
            if self.is_op("(") {
                self.pos += 1;
            }
            let mut patterns = Vec::new();
            loop {
                match self.peek() {
                    Token::Word { parts, globbable } => {
                        patterns.push(Word { parts: parts.clone(), globbable: *globbable });
                        self.pos += 1;
                    }
                    _ => return Err(self.err("expected pattern in case")),
                }
                if self.is_op("|") {
                    self.pos += 1;
                    continue;
                }
                break;
            }
            if !self.is_op(")") {
                return Err(self.err("expected ) after case pattern"));
            }
            self.pos += 1;
            let body = self.parse_list_until(&[";;", "esac"])?;
            items.push(CaseItem { patterns, body });
            if self.is_op(";;") {
                self.pos += 1;
                self.skip_separators();
            } else {
                break;
            }
        }
        self.expect_word("esac")?;
        let redirects = self.parse_redirects()?;
        Ok(Command::Case { word, items, redirects })
    }

    fn parse_brace_group(&mut self) -> Result<Command, ParseError> {
        self.pos += 1; // {
        let body = self.parse_list_until(&["}"])?;
        self.expect_word("}")?;
        let redirects = self.parse_redirects()?;
        Ok(Command::Group { body, redirects })
    }

    fn parse_subshell(&mut self) -> Result<Command, ParseError> {
        self.pos += 1; // (
        let body = self.parse_list_until(&[")"])?;
        if !self.is_op(")") {
            return Err(self.err("expected ) to close subshell"));
        }
        self.pos += 1;
        let redirects = self.parse_redirects()?;
        Ok(Command::Subshell { body, redirects })
    }

    fn parse_simple(&mut self) -> Result<Option<Command>, ParseError> {
        let mut assigns = Vec::new();
        let mut words = Vec::new();
        let mut redirects = Vec::new();

        loop {
            match self.assignment(self.peek()) {
                Some(a) => { assigns.push(a); self.pos += 1; }
                None => break,
            }
        }
        loop {
            if let Token::Word { parts, globbable } = self.peek() {
                words.push(Word { parts: parts.clone(), globbable: *globbable });
                self.pos += 1;
                continue;
            }
            if let Some(r) = self.try_redirect()? {
                redirects.push(r);
                continue;
            }
            break;
        }
        if assigns.is_empty() && words.is_empty() && redirects.is_empty() {
            return Ok(None);
        }
        Ok(Some(Command::Simple { assigns, words, redirects }))
    }

    /// A leading `NAME=…` assignment (the first part must begin `NAME=`).
    fn assignment(&self, tok: &Token) -> Option<Assign> {
        let Token::Word { parts, globbable } = tok else { return None };
        let first = parts.first()?;
        let Part::Lit { value, .. } = first else { return None };
        let eq = value.find('=')?;
        if eq == 0 {
            return None;
        }
        let name = &value[..eq];
        let ok = name.chars().enumerate().all(|(i, c)| {
            if i == 0 { c == '_' || c.is_ascii_alphabetic() } else { c == '_' || c.is_ascii_alphanumeric() }
        });
        if !ok {
            return None;
        }
        let mut vparts = vec![Part::Lit { value: value[eq + 1..].to_string(), quoted: false }];
        vparts.extend(parts[1..].iter().cloned());
        Some(Assign {
            name: name.to_string(),
            word: Word { parts: vparts, globbable: *globbable },
        })
    }

    fn parse_redirects(&mut self) -> Result<Vec<Redirect>, ParseError> {
        let mut rs = Vec::new();
        while let Some(r) = self.try_redirect()? {
            rs.push(r);
        }
        Ok(rs)
    }

    fn try_redirect(&mut self) -> Result<Option<Redirect>, ParseError> {
        let save = self.pos;
        let mut fd = None;
        if let Token::Io(n) = self.peek() {
            fd = Some(*n);
            self.pos += 1;
        }
        if let Token::Redir(op) = self.peek() {
            let op = op.clone();
            self.pos += 1;
            let target = match self.peek() {
                Token::Word { parts, globbable } => Word { parts: parts.clone(), globbable: *globbable },
                _ => return Err(self.err(&format!("expected target after {op}"))),
            };
            self.pos += 1;
            return Ok(Some(Redirect { fd, op, target }));
        }
        self.pos = save;
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd0(list: &List) -> &Command {
        &list.items[0].pipelines[0].1.commands[0]
    }

    #[test]
    fn simple_and_assignments() {
        let s = parse_script("x=1 y=2 cmd arg").unwrap();
        if let Command::Simple { assigns, words, .. } = cmd0(&s) {
            assert_eq!(assigns.len(), 2);
            assert_eq!(words.len(), 2);
        } else { panic!() }
    }

    #[test]
    fn control_flow() {
        assert!(matches!(cmd0(&parse_script("if true; then echo hi; fi").unwrap()), Command::If { .. }));
        assert!(matches!(cmd0(&parse_script("for x in a b; do echo $x; done").unwrap()), Command::For { .. }));
        assert!(matches!(cmd0(&parse_script("while true; do :; done").unwrap()), Command::While { .. }));
        assert!(matches!(cmd0(&parse_script("case $x in a) echo a;; esac").unwrap()), Command::Case { .. }));
        assert!(matches!(cmd0(&parse_script("f() { echo hi; }").unwrap()), Command::Func { .. }));
    }

    #[test]
    fn case_alternatives() {
        let s = parse_script("case $f in *.zip) echo z;; *.tgz|*.tar.gz) echo t;; esac").unwrap();
        if let Command::Case { items, .. } = cmd0(&s) {
            assert_eq!(items.len(), 2);
            assert_eq!(items[1].patterns.len(), 2);
        } else { panic!() }
    }

    #[test]
    fn json_shape_roundtrips_fields() {
        let s = parse_script("echo $x").unwrap();
        let j = s.to_json();
        assert!(j.contains("\"type\":\"list\""));
        assert!(j.contains("\"type\":\"simple\""));
        assert!(j.contains("\"kind\":\"param\""));
        assert!(j.contains("\"src\":\"x\""));
    }
}
