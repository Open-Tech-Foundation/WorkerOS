//! The controlling terminal device (§10, the TTY layer).
//!
//! A single kernel-owned TTY sits between the host terminal (xterm.js on the
//! main thread) and the processes reading stdin. It owns the **line discipline**:
//! in *canonical* mode it buffers a line, handles editing keys (backspace, kill,
//! word-erase), and echoes what the user types — releasing bytes to a reader only
//! once a full line is committed with Enter. In *raw* mode each byte is available
//! to `read` immediately with no editing. It also owns the terminal window size
//! and the termios flags a program flips via `tty_set_attr`.
//!
//! This is the honest "real OS" model: the kernel — not the browser — owns echo
//! and editing, so `wsh` and guest programs just `read()` a TTY like on Unix, and
//! `isatty` tells the truth. Keeping it pure Rust means the whole discipline is
//! unit-tested natively (INV-2).

use std::collections::VecDeque;

// Control characters the line discipline recognizes (the conventional c_cc set).
const CTRL_C: u8 = 0x03; // INTR  → SIGINT
const CTRL_D: u8 = 0x04; // EOF   → end-of-input on an empty line
const BS: u8 = 0x08; // ^H     → erase
const LF: u8 = 0x0a; // \n
const CR: u8 = 0x0d; // \r     → translated to \n (icrnl)
const CTRL_U: u8 = 0x15; // KILL  → erase whole line
const CTRL_W: u8 = 0x17; // WERASE→ erase previous word
const CTRL_Z: u8 = 0x1a; // SUSP  → SIGTSTP
const DEL: u8 = 0x7f; // ^?     → erase (most terminals send this for Backspace)

/// termios-lite: the subset of line-discipline flags WorkerOS honors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Termios {
    /// Canonical (cooked) input: line-buffered and editable. When `false`, input
    /// is *raw* — each byte is delivered to `read` as it arrives (no editing).
    pub canonical: bool,
    /// Echo input characters back to the terminal display.
    pub echo: bool,
    /// Generate signals for the INTR/SUSP control keys (Ctrl-C / Ctrl-Z).
    pub isig: bool,
}

impl Default for Termios {
    /// A fresh terminal is cooked, echoing, and signal-generating — like a login
    /// shell's TTY.
    fn default() -> Self {
        Termios { canonical: true, echo: true, isig: true }
    }
}

/// The terminal window size in character cells, reported to programs via
/// `TIOCGWINSZ` and updated when the host terminal is resized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Winsize {
    pub rows: u16,
    pub cols: u16,
}

impl Default for Winsize {
    /// The classic default, used until the host reports the real geometry.
    fn default() -> Self {
        Winsize { rows: 24, cols: 80 }
    }
}

/// A signal the line discipline raised from a control key, for the host to
/// deliver to the terminal's foreground process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtySignal {
    /// Ctrl-C — SIGINT.
    Int,
    /// Ctrl-Z — SIGTSTP.
    Susp,
}

/// The outcome of feeding input bytes through the line discipline.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TtyInput {
    /// Bytes to echo back to the terminal display (already CRLF-translated).
    pub echo: Vec<u8>,
    /// A control-key signal, if one fired this batch (INTR/SUSP under `isig`).
    pub signal: Option<TtySignal>,
}

/// What a `read` on the TTY yields, mirroring the pipe/stdin streaming contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtyRead {
    /// Bytes available for the reader (never empty).
    Data(Vec<u8>),
    /// End of input (Ctrl-D on an empty line): a one-shot EOF.
    Eof,
    /// Nothing ready yet — in canonical mode, no line has been committed. The
    /// host parks the reader and retries when more input arrives.
    WouldBlock,
}

/// The controlling terminal: line discipline, edit buffer, termios, and winsize.
#[derive(Debug)]
pub struct Tty {
    /// Bytes past the line discipline, waiting to be `read` by a program.
    ready: VecDeque<u8>,
    /// The line currently being edited (canonical mode only; not yet readable).
    line: Vec<u8>,
    /// A pending one-shot EOF (Ctrl-D on an empty line).
    eof: bool,
    pub termios: Termios,
    pub winsize: Winsize,
}

impl Default for Tty {
    fn default() -> Self {
        Tty {
            ready: VecDeque::new(),
            line: Vec::new(),
            eof: false,
            termios: Termios::default(),
            winsize: Winsize::default(),
        }
    }
}

impl Tty {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed host keystrokes through the line discipline, returning the bytes to
    /// echo and any control-key signal. In canonical mode this edits the current
    /// line and only commits it (making it readable) on Enter; in raw mode each
    /// byte becomes immediately readable.
    pub fn input(&mut self, bytes: &[u8]) -> TtyInput {
        let mut out = TtyInput::default();
        for &b in bytes {
            // INTR/SUSP fire in either mode when `isig` is set (a raw program that
            // wants the raw byte clears isig, as termios requires).
            if self.termios.isig && b == CTRL_C {
                self.line.clear();
                if self.termios.echo {
                    out.echo.extend_from_slice(b"^C\r\n");
                }
                out.signal = Some(TtySignal::Int);
                continue;
            }
            if self.termios.isig && b == CTRL_Z {
                if self.termios.echo {
                    out.echo.extend_from_slice(b"^Z");
                }
                out.signal = Some(TtySignal::Susp);
                continue;
            }

            if self.termios.canonical {
                self.canonical_byte(b, &mut out.echo);
            } else {
                // Raw: deliver the byte as-is; echo it verbatim if echo is on.
                self.ready.push_back(b);
                if self.termios.echo {
                    out.echo.push(b);
                }
            }
        }
        out
    }

    /// Process one byte in canonical mode: handle editing keys, else buffer +
    /// echo, committing the line on CR/LF.
    fn canonical_byte(&mut self, b: u8, echo: &mut Vec<u8>) {
        match b {
            CR | LF => {
                // Commit the edited line (with a trailing newline) to the reader,
                // and move the cursor to a fresh line on screen.
                self.line.push(b'\n');
                self.ready.extend(self.line.drain(..));
                echo.extend_from_slice(b"\r\n");
            }
            BS | DEL => {
                if self.line.pop().is_some() && self.termios.echo {
                    // Rub out the last glyph: back up, overwrite with space, back up.
                    echo.extend_from_slice(b"\x08 \x08");
                }
            }
            CTRL_U => {
                let n = self.line.len();
                self.line.clear();
                if self.termios.echo {
                    for _ in 0..n {
                        echo.extend_from_slice(b"\x08 \x08");
                    }
                }
            }
            CTRL_W => {
                let erased = self.erase_word();
                if self.termios.echo {
                    for _ in 0..erased {
                        echo.extend_from_slice(b"\x08 \x08");
                    }
                }
            }
            CTRL_D => {
                if self.line.is_empty() {
                    // EOF on an empty line: the next read returns Eof.
                    self.eof = true;
                } else {
                    // EOF mid-line delivers what's typed so far, without a newline.
                    self.ready.extend(self.line.drain(..));
                }
            }
            _ => {
                self.line.push(b);
                if self.termios.echo {
                    echo.push(b);
                }
            }
        }
    }

    /// Erase the trailing word from the edit line (trailing spaces, then a run of
    /// non-spaces). Returns how many characters were removed (for echo).
    fn erase_word(&mut self) -> usize {
        let before = self.line.len();
        while self.line.last() == Some(&b' ') {
            self.line.pop();
        }
        while matches!(self.line.last(), Some(&c) if c != b' ') {
            self.line.pop();
        }
        before - self.line.len()
    }

    /// Read up to `max` bytes that have cleared the line discipline. Returns
    /// [`TtyRead::WouldBlock`] when nothing is ready (canonical: no committed
    /// line yet) so the host parks the reader, exactly like a pipe. In canonical
    /// mode a single read never crosses a line boundary (one `read` → one line),
    /// matching cooked-TTY semantics; in raw mode it drains up to `max`.
    pub fn read(&mut self, max: usize) -> TtyRead {
        if self.ready.is_empty() {
            if self.eof {
                self.eof = false; // one-shot: a subsequent read blocks again
                return TtyRead::Eof;
            }
            return TtyRead::WouldBlock;
        }
        let mut n = max.min(self.ready.len());
        if self.termios.canonical {
            // Stop at the first newline so a read yields at most one line.
            if let Some(nl) = self.ready.iter().take(n).position(|&b| b == b'\n') {
                n = nl + 1;
            }
        }
        TtyRead::Data(self.ready.drain(..n).collect())
    }

    /// Take the next committed line (through its trailing `\n`) for the shell's
    /// interactive prompt, or `None` if no full line is buffered yet. This is the
    /// terminal's default reader when no foreground program is consuming stdin.
    pub fn read_line(&mut self) -> Option<Vec<u8>> {
        let nl = self.ready.iter().position(|&b| b == b'\n')?;
        Some(self.ready.drain(..=nl).collect())
    }

    /// Drop any buffered input and pending EOF (used when the foreground changes).
    pub fn flush_input(&mut self) {
        self.ready.clear();
        self.line.clear();
        self.eof = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(tty: &mut Tty, s: &str) -> TtyInput {
        tty.input(s.as_bytes())
    }

    #[test]
    fn canonical_blocks_until_a_line_is_committed() {
        let mut tty = Tty::new();
        feed(&mut tty, "hi");
        // Nothing readable until Enter.
        assert_eq!(tty.read(64), TtyRead::WouldBlock);
        feed(&mut tty, "\r");
        assert_eq!(tty.read(64), TtyRead::Data(b"hi\n".to_vec()));
        // Drained → blocks again.
        assert_eq!(tty.read(64), TtyRead::WouldBlock);
    }

    #[test]
    fn canonical_echoes_typed_characters_and_crlf_on_enter() {
        let mut tty = Tty::new();
        assert_eq!(feed(&mut tty, "ab").echo, b"ab".to_vec());
        assert_eq!(feed(&mut tty, "\r").echo, b"\r\n".to_vec());
    }

    #[test]
    fn cr_and_lf_both_terminate_a_line() {
        let mut tty = Tty::new();
        feed(&mut tty, "x\n");
        assert_eq!(tty.read(64), TtyRead::Data(b"x\n".to_vec()));
    }

    #[test]
    fn backspace_erases_last_char_and_rubs_it_out() {
        let mut tty = Tty::new();
        feed(&mut tty, "ho");
        let out = tty.input(&[DEL]);
        assert_eq!(out.echo, b"\x08 \x08".to_vec());
        feed(&mut tty, "i\r");
        assert_eq!(tty.read(64), TtyRead::Data(b"hi\n".to_vec()));
    }

    #[test]
    fn backspace_on_empty_line_is_a_noop() {
        let mut tty = Tty::new();
        assert_eq!(tty.input(&[BS]).echo, Vec::<u8>::new());
    }

    #[test]
    fn ctrl_u_kills_the_whole_line() {
        let mut tty = Tty::new();
        feed(&mut tty, "throwaway");
        let out = tty.input(&[CTRL_U]);
        assert_eq!(out.echo.len(), "throwaway".len() * 3); // \x08 \x08 per char
        feed(&mut tty, "keep\r");
        assert_eq!(tty.read(64), TtyRead::Data(b"keep\n".to_vec()));
    }

    #[test]
    fn ctrl_w_erases_the_previous_word() {
        let mut tty = Tty::new();
        feed(&mut tty, "foo bar");
        tty.input(&[CTRL_W]);
        feed(&mut tty, "\r");
        assert_eq!(tty.read(64), TtyRead::Data(b"foo \n".to_vec()));
    }

    #[test]
    fn ctrl_d_on_empty_line_is_eof_once_then_blocks() {
        let mut tty = Tty::new();
        assert_eq!(tty.input(&[CTRL_D]).echo, Vec::<u8>::new());
        assert_eq!(tty.read(64), TtyRead::Eof);
        assert_eq!(tty.read(64), TtyRead::WouldBlock);
    }

    #[test]
    fn ctrl_d_mid_line_delivers_partial_input_without_newline() {
        let mut tty = Tty::new();
        feed(&mut tty, "par");
        tty.input(&[CTRL_D]);
        assert_eq!(tty.read(64), TtyRead::Data(b"par".to_vec()));
    }

    #[test]
    fn ctrl_c_raises_int_and_discards_the_line() {
        let mut tty = Tty::new();
        feed(&mut tty, "abandon");
        let out = tty.input(&[CTRL_C]);
        assert_eq!(out.signal, Some(TtySignal::Int));
        assert_eq!(out.echo, b"^C\r\n".to_vec());
        assert_eq!(tty.read(64), TtyRead::WouldBlock); // line was discarded
    }

    #[test]
    fn ctrl_z_raises_susp() {
        let mut tty = Tty::new();
        assert_eq!(tty.input(&[CTRL_Z]).signal, Some(TtySignal::Susp));
    }

    #[test]
    fn raw_mode_delivers_each_byte_immediately_without_editing() {
        let mut tty = Tty::new();
        tty.termios.canonical = false;
        feed(&mut tty, "a");
        assert_eq!(tty.read(64), TtyRead::Data(b"a".to_vec()));
        // A backspace byte is delivered literally in raw mode, not treated as erase.
        tty.input(&[DEL]);
        assert_eq!(tty.read(64), TtyRead::Data(vec![DEL]));
    }

    #[test]
    fn noecho_suppresses_display_but_still_reads() {
        let mut tty = Tty::new();
        tty.termios.echo = false;
        assert_eq!(feed(&mut tty, "secret").echo, Vec::<u8>::new());
        feed(&mut tty, "\r");
        assert_eq!(tty.read(64), TtyRead::Data(b"secret\n".to_vec()));
    }

    #[test]
    fn read_respects_max_and_leaves_the_rest_buffered() {
        let mut tty = Tty::new();
        feed(&mut tty, "hello\r");
        assert_eq!(tty.read(2), TtyRead::Data(b"he".to_vec()));
        assert_eq!(tty.read(64), TtyRead::Data(b"llo\n".to_vec()));
    }

    #[test]
    fn raw_mode_still_honors_isig_ctrl_c() {
        let mut tty = Tty::new();
        tty.termios.canonical = false;
        assert_eq!(tty.input(&[CTRL_C]).signal, Some(TtySignal::Int));
        // With isig cleared, Ctrl-C is delivered as a literal byte.
        tty.termios.isig = false;
        assert_eq!(tty.input(&[CTRL_C]).signal, None);
        assert_eq!(tty.read(64), TtyRead::Data(vec![CTRL_C]));
    }

    #[test]
    fn canonical_read_stops_at_a_line_boundary() {
        let mut tty = Tty::new();
        feed(&mut tty, "one\rtwo\r");
        // Two lines are buffered, but one read yields only the first line.
        assert_eq!(tty.read(64), TtyRead::Data(b"one\n".to_vec()));
        assert_eq!(tty.read(64), TtyRead::Data(b"two\n".to_vec()));
    }

    #[test]
    fn read_line_returns_whole_lines_or_none() {
        let mut tty = Tty::new();
        feed(&mut tty, "cmd");
        assert_eq!(tty.read_line(), None); // not committed yet
        feed(&mut tty, "\r");
        assert_eq!(tty.read_line(), Some(b"cmd\n".to_vec()));
        assert_eq!(tty.read_line(), None);
    }

    #[test]
    fn winsize_defaults_to_80x24() {
        let tty = Tty::new();
        assert_eq!(tty.winsize, Winsize { rows: 24, cols: 80 });
    }
}
