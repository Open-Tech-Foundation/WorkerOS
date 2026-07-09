//! Rich `wsh` lexer — tokenizes a script, tracking quoting so `$x` / `${…}` /
//! `$(…)` / `$(( … ))` survive as word *parts* (expanded at run time), recognizing
//! operators including `2>&1`-style fd duplication, treating `#` as a comment, and
//! emitting NEWLINE tokens for the compound-command grammar.

use super::script_ast::Part;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Word { parts: Vec<Part>, globbable: bool },
    Newline,
    /// An operator: `|` `||` `&` `&&` `;` `;;` `(` `)`.
    Op(String),
    /// A redirection operator: `<` `>` `>>` `<<` `<<<` and their `&` dup variants.
    Redir(String),
    /// An IO number preceding a redirection (`2` in `2>`).
    Io(u32),
    Eof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexError(pub String);

pub fn lex(src: &str) -> Result<Vec<Token>, LexError> {
    Lexer { c: src.chars().collect(), i: 0 }.run()
}

struct Lexer {
    c: Vec<char>,
    i: usize,
}

impl Lexer {
    fn at(&self, k: usize) -> Option<char> {
        self.c.get(self.i + k).copied()
    }

    fn run(&mut self) -> Result<Vec<Token>, LexError> {
        let mut toks = Vec::new();
        while self.i < self.c.len() {
            let ch = self.c[self.i];
            match ch {
                ' ' | '\t' | '\r' => {
                    self.i += 1;
                }
                '\\' if self.at(1) == Some('\n') => {
                    self.i += 2; // line continuation
                }
                '\n' => {
                    toks.push(Token::Newline);
                    self.i += 1;
                }
                '#' => {
                    while self.i < self.c.len() && self.c[self.i] != '\n' {
                        self.i += 1;
                    }
                }
                '|' => {
                    if self.at(1) == Some('|') { toks.push(Token::Op("||".into())); self.i += 2; }
                    else { toks.push(Token::Op("|".into())); self.i += 1; }
                }
                '&' => {
                    if self.at(1) == Some('&') { toks.push(Token::Op("&&".into())); self.i += 2; }
                    else { toks.push(Token::Op("&".into())); self.i += 1; }
                }
                ';' => {
                    if self.at(1) == Some(';') { toks.push(Token::Op(";;".into())); self.i += 2; }
                    else { toks.push(Token::Op(";".into())); self.i += 1; }
                }
                '(' => { toks.push(Token::Op("(".into())); self.i += 1; }
                ')' => { toks.push(Token::Op(")".into())); self.i += 1; }
                '<' | '>' => {
                    let mut op = String::new();
                    if ch == '>' && self.at(1) == Some('>') { op.push_str(">>"); self.i += 2; }
                    else if ch == '<' && self.at(1) == Some('<') && self.at(2) == Some('<') { op.push_str("<<<"); self.i += 3; }
                    else if ch == '<' && self.at(1) == Some('<') { op.push_str("<<"); self.i += 2; }
                    else { op.push(ch); self.i += 1; }
                    if self.at(0) == Some('&') { op.push('&'); self.i += 1; }
                    toks.push(Token::Redir(op));
                }
                '0'..='9' => {
                    // IO number only if the digit run is immediately followed by < or >.
                    let mut j = self.i;
                    while j < self.c.len() && self.c[j].is_ascii_digit() { j += 1; }
                    if matches!(self.c.get(j), Some('<') | Some('>')) {
                        let n: u32 = self.c[self.i..j].iter().collect::<String>().parse().unwrap();
                        toks.push(Token::Io(n));
                        self.i = j;
                    } else {
                        let (parts, globbable) = self.read_word()?;
                        toks.push(Token::Word { parts, globbable });
                    }
                }
                _ => {
                    let (parts, globbable) = self.read_word()?;
                    if parts.is_empty() {
                        return Err(LexError(format!("unexpected character: {:?}", ch)));
                    }
                    toks.push(Token::Word { parts, globbable });
                }
            }
        }
        toks.push(Token::Eof);
        Ok(toks)
    }

    fn read_dollar(&mut self, quoted: bool) -> Result<Part, LexError> {
        self.i += 1; // past '$'
        match self.at(0) {
            Some('(') => {
                if self.at(1) == Some('(') {
                    self.i += 2;
                    let start = self.i;
                    let mut depth = 1;
                    while self.i < self.c.len() && depth > 0 {
                        match self.c[self.i] {
                            '(' => depth += 1,
                            ')' => { depth -= 1; if depth == 0 { break; } }
                            _ => {}
                        }
                        self.i += 1;
                    }
                    let inner: String = self.c[start..self.i].iter().collect();
                    if self.at(0) == Some(')') && self.at(1) == Some(')') { self.i += 2; }
                    else { return Err(LexError("unterminated $(( ))".into())); }
                    return Ok(Part::Arith { src: inner, quoted });
                }
                self.i += 1;
                let start = self.i;
                let mut depth = 1;
                while self.i < self.c.len() && depth > 0 {
                    match self.c[self.i] {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 { break; }
                    self.i += 1;
                }
                let inner: String = self.c[start..self.i].iter().collect();
                if self.at(0) != Some(')') { return Err(LexError("unterminated $( )".into())); }
                self.i += 1;
                Ok(Part::Cmdsub { src: inner, quoted })
            }
            Some('{') => {
                self.i += 1;
                let start = self.i;
                let mut depth = 1;
                while self.i < self.c.len() && depth > 0 {
                    match self.c[self.i] {
                        '{' => depth += 1,
                        '}' => { depth -= 1; if depth == 0 { break; } }
                        _ => {}
                    }
                    self.i += 1;
                }
                let inner: String = self.c[start..self.i].iter().collect();
                if self.at(0) != Some('}') { return Err(LexError("unterminated ${ }".into())); }
                self.i += 1;
                Ok(Part::Param { src: inner, quoted })
            }
            Some(ch) if "?#@*$!0123456789".contains(ch) => {
                self.i += 1;
                Ok(Part::Param { src: ch.to_string(), quoted })
            }
            Some(ch) if ch == '_' || ch.is_ascii_alphabetic() => {
                let mut name = String::new();
                while let Some(c) = self.at(0) {
                    if c == '_' || c.is_ascii_alphanumeric() { name.push(c); self.i += 1; }
                    else { break; }
                }
                Ok(Part::Param { src: name, quoted })
            }
            _ => Ok(Part::Lit { value: "$".into(), quoted }),
        }
    }

    fn read_backtick(&mut self, quoted: bool) -> Result<Part, LexError> {
        self.i += 1;
        let mut s = String::new();
        while let Some(c) = self.at(0) {
            if c == '`' { break; }
            if c == '\\' && matches!(self.at(1), Some('`') | Some('\\') | Some('$')) {
                s.push(self.at(1).unwrap());
                self.i += 2;
                continue;
            }
            s.push(c);
            self.i += 1;
        }
        if self.at(0) != Some('`') { return Err(LexError("unterminated backtick".into())); }
        self.i += 1;
        Ok(Part::Cmdsub { src: s, quoted })
    }

    fn read_double_quoted(&mut self, parts: &mut Vec<Part>) -> Result<(), LexError> {
        let mut lit = String::new();
        macro_rules! flush { () => { if !lit.is_empty() { parts.push(Part::Lit { value: std::mem::take(&mut lit), quoted: true }); } } }
        while let Some(c) = self.at(0) {
            match c {
                '"' => { self.i += 1; flush!(); return Ok(()); }
                '\\' => {
                    let nx = self.at(1);
                    if matches!(nx, Some('"') | Some('\\') | Some('`') | Some('$')) { lit.push(nx.unwrap()); self.i += 2; continue; }
                    if nx == Some('\n') { self.i += 2; continue; }
                    lit.push(c); self.i += 1;
                }
                '$' => { flush!(); let p = self.read_dollar(true)?; parts.push(p); }
                '`' => { flush!(); let p = self.read_backtick(true)?; parts.push(p); }
                _ => { lit.push(c); self.i += 1; }
            }
        }
        Err(LexError("unterminated double quote".into()))
    }

    fn read_word(&mut self) -> Result<(Vec<Part>, bool), LexError> {
        let mut parts: Vec<Part> = Vec::new();
        let mut lit = String::new();
        let mut globbable = false;
        macro_rules! flush { () => { if !lit.is_empty() { parts.push(Part::Lit { value: std::mem::take(&mut lit), quoted: false }); } } }

        while let Some(c) = self.at(0) {
            if c == ' ' || c == '\t' { break; }
            if "\n|&;<>()".contains(c) { break; }
            if c == '#' && parts.is_empty() && lit.is_empty() { break; }
            match c {
                '\\' => {
                    match self.at(1) {
                        Some('\n') => { self.i += 2; }
                        None => { lit.push('\\'); self.i += 1; break; }
                        Some(nx) => { lit.push(nx); self.i += 2; }
                    }
                }
                '\'' => {
                    self.i += 1;
                    let mut s = String::new();
                    while let Some(ch) = self.at(0) {
                        if ch == '\'' { break; }
                        s.push(ch); self.i += 1;
                    }
                    if self.at(0) != Some('\'') { return Err(LexError("unterminated single quote".into())); }
                    self.i += 1;
                    flush!();
                    parts.push(Part::Sq { value: s });
                }
                '"' => { self.i += 1; flush!(); self.read_double_quoted(&mut parts)?; }
                '$' => { flush!(); let p = self.read_dollar(false)?; parts.push(p); }
                '`' => { flush!(); let p = self.read_backtick(false)?; parts.push(p); }
                '*' | '?' | '[' => { globbable = true; lit.push(c); self.i += 1; }
                _ => { lit.push(c); self.i += 1; }
            }
        }
        flush!();
        Ok((parts, globbable))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_and_operators() {
        let t = lex("a && b || c | d; e &\nf").unwrap();
        let ops: Vec<_> = t.iter().filter_map(|x| if let Token::Op(o) = x { Some(o.as_str()) } else { None }).collect();
        assert_eq!(ops, vec!["&&", "||", "|", ";", "&"]);
        assert!(t.iter().any(|x| matches!(x, Token::Newline)));
    }

    #[test]
    fn expansion_parts() {
        let t = lex(r#"echo "hi $USER" ${x:-y} $(date)"#).unwrap();
        let words: Vec<_> = t.iter().filter(|x| matches!(x, Token::Word { .. })).collect();
        assert_eq!(words.len(), 4);
        if let Token::Word { parts, .. } = words[2] {
            assert_eq!(parts[0], Part::Param { src: "x:-y".into(), quoted: false });
        } else { panic!(); }
        if let Token::Word { parts, .. } = words[3] {
            assert_eq!(parts[0], Part::Cmdsub { src: "date".into(), quoted: false });
        } else { panic!(); }
    }

    #[test]
    fn io_number_and_dup() {
        let t = lex("cmd 2>&1 >out").unwrap();
        assert!(t.iter().any(|x| matches!(x, Token::Io(2))));
        assert!(t.iter().any(|x| matches!(x, Token::Redir(o) if o == ">&")));
    }

    #[test]
    fn comment_is_skipped() {
        let t = lex("echo a # ignored\necho b").unwrap();
        let words = t.iter().filter(|x| matches!(x, Token::Word { .. })).count();
        assert_eq!(words, 4); // echo a echo b
    }
}
