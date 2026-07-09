//! The `wsh` parser: tokens → [`Script`] AST.
//!
//! Recursive descent over the grammar:
//!
//! ```text
//! script   := (and_or (';' | '&'))* and_or?
//! and_or   := pipeline (('&&' | '||') pipeline)*
//! pipeline := command ('|' command)*
//! command  := assignment* (word | redirect)+
//! redirect := [IoNumber] ('<' | '>' | '>>') word
//! ```

use super::ast::*;
use super::lexer::{lex, LexError, Token};

/// A parse error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Lex(LexError),
    /// A word was expected (e.g. a redirect target or command) but not found.
    ExpectedWord,
    /// An operator appeared with no command on one side.
    EmptyCommand,
    /// A pipeline/list ended unexpectedly.
    UnexpectedEnd,
}

impl From<LexError> for ParseError {
    fn from(e: LexError) -> Self {
        ParseError::Lex(e)
    }
}

/// Parse a command line into a [`Script`].
pub fn parse(input: &str) -> Result<Script, ParseError> {
    let tokens = lex(input)?;
    Parser::new(tokens).parse_script()
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Parser { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn bump(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn parse_script(&mut self) -> Result<Script, ParseError> {
        let mut statements = Vec::new();
        while self.peek().is_some() {
            // Skip stray separators.
            if matches!(self.peek(), Some(Token::Semi)) {
                self.bump();
                continue;
            }
            let list = self.parse_and_or()?;
            let background = match self.peek() {
                Some(Token::Amp) => {
                    self.bump();
                    true
                }
                Some(Token::Semi) => {
                    self.bump();
                    false
                }
                _ => false,
            };
            statements.push(Statement { list, background });
        }
        Ok(Script { statements })
    }

    fn parse_and_or(&mut self) -> Result<AndOr, ParseError> {
        let first = self.parse_pipeline()?;
        let mut rest = Vec::new();
        loop {
            let op = match self.peek() {
                Some(Token::AndIf) => AndOrOp::And,
                Some(Token::OrIf) => AndOrOp::Or,
                _ => break,
            };
            self.bump();
            let pipeline = self.parse_pipeline()?;
            rest.push((op, pipeline));
        }
        Ok(AndOr { first, rest })
    }

    fn parse_pipeline(&mut self) -> Result<Pipeline, ParseError> {
        let mut commands = vec![self.parse_command()?];
        while matches!(self.peek(), Some(Token::Pipe)) {
            self.bump();
            commands.push(self.parse_command()?);
        }
        Ok(Pipeline { commands })
    }

    fn parse_command(&mut self) -> Result<Command, ParseError> {
        let mut assignments = Vec::new();
        let mut argv = Vec::new();
        let mut redirects = Vec::new();
        // Leading assignments only until the first non-assignment word.
        let mut in_prefix = true;

        loop {
            match self.peek() {
                Some(Token::Word { .. }) => {
                    let Some(Token::Word { text, globbable }) = self.bump() else {
                        unreachable!()
                    };
                    if in_prefix && !globbable {
                        if let Some(assign) = as_assignment(&text) {
                            assignments.push(assign);
                            continue;
                        }
                    }
                    in_prefix = false;
                    argv.push(Word { text, globbable });
                }
                Some(Token::IoNumber(_)) | Some(Token::Less) | Some(Token::Great)
                | Some(Token::DGreat) => {
                    in_prefix = false;
                    redirects.push(self.parse_redirect()?);
                }
                _ => break,
            }
        }

        if argv.is_empty() && redirects.is_empty() && assignments.is_empty() {
            return Err(ParseError::EmptyCommand);
        }
        Ok(Command {
            assignments,
            argv,
            redirects,
        })
    }

    fn parse_redirect(&mut self) -> Result<Redirect, ParseError> {
        let explicit_fd = if let Some(Token::IoNumber(n)) = self.peek() {
            let n = *n;
            self.bump();
            Some(n)
        } else {
            None
        };
        let (op, default_fd) = match self.bump() {
            Some(Token::Less) => (RedirectOp::Read, 0),
            Some(Token::Great) => (RedirectOp::Write, 1),
            Some(Token::DGreat) => (RedirectOp::Append, 1),
            _ => return Err(ParseError::UnexpectedEnd),
        };
        let target = match self.bump() {
            Some(Token::Word { text, globbable }) => Word { text, globbable },
            _ => return Err(ParseError::ExpectedWord),
        };
        Ok(Redirect {
            fd: explicit_fd.unwrap_or(default_fd),
            op,
            target,
        })
    }
}

/// If `text` is `NAME=VALUE` with a valid identifier `NAME`, return the assignment.
fn as_assignment(text: &str) -> Option<Assignment> {
    let eq = text.find('=')?;
    let (name, rest) = (&text[..eq], &text[eq + 1..]);
    if name.is_empty() {
        return None;
    }
    let mut chars = name.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(Assignment {
        name: name.to_string(),
        value: rest.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv_of(cmd: &Command) -> Vec<String> {
        cmd.argv.iter().map(|w| w.text.clone()).collect()
    }

    #[test]
    fn single_command() {
        let s = parse("echo hello world").unwrap();
        assert_eq!(s.statements.len(), 1);
        let cmd = &s.statements[0].list.first.commands[0];
        assert_eq!(argv_of(cmd), vec!["echo", "hello", "world"]);
        assert!(!s.statements[0].background);
    }

    #[test]
    fn pipeline() {
        let s = parse("echo hi | cat | wc").unwrap();
        let pipe = &s.statements[0].list.first;
        assert_eq!(pipe.commands.len(), 3);
        assert_eq!(argv_of(&pipe.commands[0]), vec!["echo", "hi"]);
        assert_eq!(argv_of(&pipe.commands[2]), vec!["wc"]);
    }

    #[test]
    fn and_or_chain() {
        let s = parse("a && b || c").unwrap();
        let list = &s.statements[0].list;
        assert_eq!(list.rest.len(), 2);
        assert_eq!(list.rest[0].0, AndOrOp::And);
        assert_eq!(list.rest[1].0, AndOrOp::Or);
    }

    #[test]
    fn redirects_out_append_in() {
        let s = parse("cmd > out >> log < in").unwrap();
        let cmd = &s.statements[0].list.first.commands[0];
        assert_eq!(cmd.redirects.len(), 3);
        assert_eq!(cmd.redirects[0], Redirect { fd: 1, op: RedirectOp::Write, target: Word::literal("out") });
        assert_eq!(cmd.redirects[1], Redirect { fd: 1, op: RedirectOp::Append, target: Word::literal("log") });
        assert_eq!(cmd.redirects[2], Redirect { fd: 0, op: RedirectOp::Read, target: Word::literal("in") });
    }

    #[test]
    fn explicit_fd_redirect() {
        let s = parse("cmd 2> err").unwrap();
        let cmd = &s.statements[0].list.first.commands[0];
        assert_eq!(cmd.redirects[0].fd, 2);
        assert_eq!(cmd.redirects[0].op, RedirectOp::Write);
    }

    #[test]
    fn assignments_prefix_command() {
        let s = parse("FOO=bar BAZ=qux cmd arg").unwrap();
        let cmd = &s.statements[0].list.first.commands[0];
        assert_eq!(cmd.assignments.len(), 2);
        assert_eq!(cmd.assignments[0], Assignment { name: "FOO".into(), value: "bar".into() });
        assert_eq!(argv_of(cmd), vec!["cmd", "arg"]);
    }

    #[test]
    fn equals_after_command_is_an_argument() {
        // Only *leading* NAME=VALUE words are assignments.
        let s = parse("cmd FOO=bar").unwrap();
        let cmd = &s.statements[0].list.first.commands[0];
        assert!(cmd.assignments.is_empty());
        assert_eq!(argv_of(cmd), vec!["cmd", "FOO=bar"]);
    }

    #[test]
    fn background_and_sequence() {
        let s = parse("a & b ; c").unwrap();
        assert_eq!(s.statements.len(), 3);
        assert!(s.statements[0].background);
        assert!(!s.statements[1].background);
        assert!(!s.statements[2].background);
    }

    #[test]
    fn the_exit_criterion_line_parses() {
        // echo hi | cat > f && cat f
        let s = parse("echo hi | cat > f && cat f").unwrap();
        assert_eq!(s.statements.len(), 1);
        let list = &s.statements[0].list;
        // pipeline: echo hi | cat > f
        assert_eq!(list.first.commands.len(), 2);
        assert_eq!(argv_of(&list.first.commands[0]), vec!["echo", "hi"]);
        let cat = &list.first.commands[1];
        assert_eq!(argv_of(cat), vec!["cat"]);
        assert_eq!(cat.redirects[0].target, Word::literal("f"));
        // && cat f
        assert_eq!(list.rest.len(), 1);
        assert_eq!(list.rest[0].0, AndOrOp::And);
        assert_eq!(argv_of(&list.rest[0].1.commands[0]), vec!["cat", "f"]);
    }

    #[test]
    fn globbable_word_flag_survives() {
        let s = parse("ls *.rs").unwrap();
        let cmd = &s.statements[0].list.first.commands[0];
        assert!(cmd.argv[1].globbable);
    }

    #[test]
    fn empty_input_is_empty_script() {
        assert_eq!(parse("").unwrap().statements.len(), 0);
        assert_eq!(parse("   ").unwrap().statements.len(), 0);
    }
}
