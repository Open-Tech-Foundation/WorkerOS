//! The `wsh` lexer: turns a command line into tokens.
//!
//! Quoting is bash-flavored but simplified (ADR-012): single and double quotes
//! both make their contents literal — there is no `$VAR` / `$(...)` expansion, so
//! the two quote styles differ only in which quote character they use. An
//! unquoted `*` marks the word as globbable; a quoted `*` is a literal asterisk.

/// A lexical token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// A word (already unquoted), with a flag for an unquoted `*`.
    Word { text: String, globbable: bool },
    /// A run of digits immediately preceding a redirect operator (`2>`, `0<`).
    IoNumber(u32),
    /// `|`
    Pipe,
    /// `&&`
    AndIf,
    /// `||`
    OrIf,
    /// `;`
    Semi,
    /// `&`
    Amp,
    /// `<`
    Less,
    /// `>`
    Great,
    /// `>>`
    DGreat,
}

/// A lexing error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LexError {
    /// A quote was opened but never closed.
    UnterminatedQuote(char),
    /// A trailing backslash with nothing to escape.
    DanglingEscape,
}

/// Tokenize a command line.
pub fn lex(input: &str) -> Result<Vec<Token>, LexError> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => {
                i += 1;
            }
            '|' => {
                if chars.get(i + 1) == Some(&'|') {
                    tokens.push(Token::OrIf);
                    i += 2;
                } else {
                    tokens.push(Token::Pipe);
                    i += 1;
                }
            }
            '&' => {
                if chars.get(i + 1) == Some(&'&') {
                    tokens.push(Token::AndIf);
                    i += 2;
                } else {
                    tokens.push(Token::Amp);
                    i += 1;
                }
            }
            ';' => {
                tokens.push(Token::Semi);
                i += 1;
            }
            '<' => {
                tokens.push(Token::Less);
                i += 1;
            }
            '>' => {
                if chars.get(i + 1) == Some(&'>') {
                    tokens.push(Token::DGreat);
                    i += 2;
                } else {
                    tokens.push(Token::Great);
                    i += 1;
                }
            }
            _ => {
                // An unbroken run of digits immediately followed by a redirect
                // operator is an IO-number (`2>`, `0<`), not a word.
                if let Some(next) = try_io_number(&chars, i) {
                    let digits: String = chars[i..next].iter().collect();
                    tokens.push(Token::IoNumber(digits.parse().unwrap()));
                    i = next;
                } else {
                    let (word, next) = lex_word(&chars, i)?;
                    tokens.push(word);
                    i = next;
                }
            }
        }
    }

    Ok(tokens)
}

/// If `start` begins a run of digits immediately followed by `<` or `>`, return
/// the index just past the digits; otherwise `None`.
fn try_io_number(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i > start && matches!(chars.get(i), Some('<') | Some('>')) {
        Some(i)
    } else {
        None
    }
}

/// True for characters that end an unquoted word.
fn is_meta(c: char) -> bool {
    matches!(c, '|' | '&' | ';' | '<' | '>') || c.is_whitespace()
}

/// Lex one word starting at `start`; returns the token and the next index.
fn lex_word(chars: &[char], start: usize) -> Result<(Token, usize), LexError> {
    let mut text = String::new();
    let mut globbable = false;
    let mut i = start;

    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                let next = chars.get(i + 1).ok_or(LexError::DanglingEscape)?;
                text.push(*next);
                i += 2;
            }
            '\'' | '"' => {
                let quote = c;
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    if chars[i] == quote {
                        closed = true;
                        i += 1;
                        break;
                    }
                    // Inside double quotes, a backslash still escapes the quote/backslash.
                    if quote == '"' && chars[i] == '\\' {
                        if let Some(next) = chars.get(i + 1) {
                            if *next == '"' || *next == '\\' {
                                text.push(*next);
                                i += 2;
                                continue;
                            }
                        }
                    }
                    text.push(chars[i]);
                    i += 1;
                }
                if !closed {
                    return Err(LexError::UnterminatedQuote(quote));
                }
            }
            '*' => {
                globbable = true;
                text.push('*');
                i += 1;
            }
            c if is_meta(c) => break,
            c => {
                text.push(c);
                i += 1;
            }
        }
    }

    Ok((Token::Word { text, globbable }, i))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(input: &str) -> Vec<Token> {
        lex(input).unwrap()
    }

    #[test]
    fn simple_words() {
        assert_eq!(
            words("echo hello world"),
            vec![
                Token::Word { text: "echo".into(), globbable: false },
                Token::Word { text: "hello".into(), globbable: false },
                Token::Word { text: "world".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn operators() {
        assert_eq!(
            words("a | b && c || d ; e &"),
            vec![
                Token::Word { text: "a".into(), globbable: false },
                Token::Pipe,
                Token::Word { text: "b".into(), globbable: false },
                Token::AndIf,
                Token::Word { text: "c".into(), globbable: false },
                Token::OrIf,
                Token::Word { text: "d".into(), globbable: false },
                Token::Semi,
                Token::Word { text: "e".into(), globbable: false },
                Token::Amp,
            ]
        );
    }

    #[test]
    fn redirect_operators() {
        assert_eq!(
            words("a > b >> c < d"),
            vec![
                Token::Word { text: "a".into(), globbable: false },
                Token::Great,
                Token::Word { text: "b".into(), globbable: false },
                Token::DGreat,
                Token::Word { text: "c".into(), globbable: false },
                Token::Less,
                Token::Word { text: "d".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn no_spaces_around_operators() {
        assert_eq!(
            words("echo hi|cat>f"),
            vec![
                Token::Word { text: "echo".into(), globbable: false },
                Token::Word { text: "hi".into(), globbable: false },
                Token::Pipe,
                Token::Word { text: "cat".into(), globbable: false },
                Token::Great,
                Token::Word { text: "f".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn single_quotes_are_literal() {
        assert_eq!(
            words("echo 'a b|c'"),
            vec![
                Token::Word { text: "echo".into(), globbable: false },
                Token::Word { text: "a b|c".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn quoted_star_is_not_globbable() {
        let toks = words("ls '*.txt' *.rs");
        assert_eq!(toks[1], Token::Word { text: "*.txt".into(), globbable: false });
        assert_eq!(toks[2], Token::Word { text: "*.rs".into(), globbable: true });
    }

    #[test]
    fn double_quotes_group_and_escape() {
        assert_eq!(
            words(r#"echo "a \"b\" c""#),
            vec![
                Token::Word { text: "echo".into(), globbable: false },
                Token::Word { text: r#"a "b" c"#.into(), globbable: false },
            ]
        );
    }

    #[test]
    fn backslash_escapes_metachar() {
        assert_eq!(
            words(r"echo a\ b"),
            vec![
                Token::Word { text: "echo".into(), globbable: false },
                Token::Word { text: "a b".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn io_number_before_redirect() {
        assert_eq!(
            words("cmd 2>err 1>out"),
            vec![
                Token::Word { text: "cmd".into(), globbable: false },
                Token::IoNumber(2),
                Token::Great,
                Token::Word { text: "err".into(), globbable: false },
                Token::IoNumber(1),
                Token::Great,
                Token::Word { text: "out".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn digits_not_before_redirect_are_a_word() {
        assert_eq!(
            words("echo 2 files"),
            vec![
                Token::Word { text: "echo".into(), globbable: false },
                Token::Word { text: "2".into(), globbable: false },
                Token::Word { text: "files".into(), globbable: false },
            ]
        );
    }

    #[test]
    fn unterminated_quote_errors() {
        assert_eq!(lex("echo 'oops"), Err(LexError::UnterminatedQuote('\'')));
    }

    #[test]
    fn adjacent_quoted_and_unquoted_concatenate() {
        // foo"bar"baz => one word foobarbaz
        assert_eq!(
            words(r#"foo"bar"baz"#),
            vec![Token::Word { text: "foobarbaz".into(), globbable: false }]
        );
    }
}
