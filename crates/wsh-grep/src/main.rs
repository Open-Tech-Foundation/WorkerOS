//! `grep` — print lines matching a regular expression. Built for `wasm32-wasip1`
//! and run as a WorkerOS process (reads args/stdin/files through the WASI host the
//! kernel provides). Real regex via the `regex` crate — the reason this one is a
//! wasm binary instead of a JS coreutil.
//!
//!   grep [-i] [-v] [-n] PATTERN [FILE...]
//!     -i  case-insensitive
//!     -v  invert (print non-matching lines)
//!     -n  prefix each line with its 1-based line number
//!
//! Exit status: 0 if any line matched, 1 if none, 2 on a usage/pattern error.

use regex::{Regex, RegexBuilder};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::process::exit;

fn grep(content: &str, re: &Regex, invert: bool, number: bool, out: &mut impl Write) -> bool {
    let mut matched = false;
    for (i, line) in content.lines().enumerate() {
        if re.is_match(line) != invert {
            matched = true;
            if number {
                let _ = write!(out, "{}:", i + 1);
            }
            let _ = writeln!(out, "{line}");
        }
    }
    matched
}

fn main() {
    // WASI has no process cwd; wasi-libc emulates one that starts at "/". The
    // host passes the kernel cwd as PWD — adopt it so relative FILE args behave.
    if let Ok(pwd) = env::var("PWD") {
        let _ = env::set_current_dir(&pwd);
    }

    let mut icase = false;
    let mut invert = false;
    let mut number = false;
    let mut positional: Vec<String> = Vec::new();

    for a in env::args().skip(1) {
        if a.len() > 1 && a.starts_with('-') && a != "--" {
            for c in a[1..].chars() {
                match c {
                    'i' => icase = true,
                    'v' => invert = true,
                    'n' => number = true,
                    _ => {
                        eprintln!("grep: unknown option -{c}");
                        exit(2);
                    }
                }
            }
        } else {
            positional.push(a);
        }
    }

    if positional.is_empty() {
        eprintln!("usage: grep [-ivn] PATTERN [file...]");
        exit(2);
    }
    let pattern = &positional[0];
    let files = &positional[1..];

    let re = match RegexBuilder::new(pattern).case_insensitive(icase).build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("grep: invalid pattern: {e}");
            exit(2);
        }
    };

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut matched = false;

    if files.is_empty() {
        let mut s = String::new();
        if io::stdin().read_to_string(&mut s).is_ok() {
            matched |= grep(&s, &re, invert, number, &mut out);
        }
    } else {
        for f in files {
            match fs::read_to_string(f) {
                Ok(s) => matched |= grep(&s, &re, invert, number, &mut out),
                Err(e) => eprintln!("grep: {f}: {e}"),
            }
        }
    }

    let _ = out.flush();
    exit(if matched { 0 } else { 1 });
}
