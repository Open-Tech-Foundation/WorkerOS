//! WorkerOS coreutils from uutils — one multicall binary for `wasm32-wasip1`.
//!
//! Dispatches on the invoked name (argv[0] basename, following the /bin symlink
//! the OS installs per utility), with `coreutils NAME ARGS…` as the explicit
//! fallback form. Each `uu_*::uumain` expects clap-style argv where the first
//! element is the utility name, so the invoked argv passes through unchanged.

use std::ffi::OsString;
use std::process::exit;

/// One dispatch arm per vendored utility; adding a utility is one Cargo
/// dependency line plus one row here.
macro_rules! dispatch {
    ($name:expr, $args:expr, { $($util:literal => $krate:ident),+ $(,)? }) => {
        match $name {
            $($util => Some($krate::uumain($args)),)+
            _ => None,
        }
    };
}

fn run(name: &str, args: impl Iterator<Item = OsString> + 'static) -> Option<i32> {
    dispatch!(name, args, {
        "base32" => uu_base32,
        "base64" => uu_base64,
        "basename" => uu_basename,
        "cksum" => uu_cksum,
        "comm" => uu_comm,
        "date" => uu_date,
        "dd" => uu_dd,
        "dirname" => uu_dirname,
        "expand" => uu_expand,
        "fold" => uu_fold,
        "join" => uu_join,
        "ln" => uu_ln,
        "mktemp" => uu_mktemp,
        "nl" => uu_nl,
        "od" => uu_od,
        "paste" => uu_paste,
        "printf" => uu_printf,
        "readlink" => uu_readlink,
        "realpath" => uu_realpath,
        "shuf" => uu_shuf,
        "sleep" => uu_sleep,
        "split" => uu_split,
        "tee" => uu_tee,
        "touch" => uu_touch,
        "truncate" => uu_truncate,
        "unexpand" => uu_unexpand,
        "yes" => uu_yes,
    })
}

fn basename(path: &OsString) -> String {
    let s = path.to_string_lossy();
    s.rsplit('/').next().unwrap_or(&s).to_string()
}

fn main() {
    // WASI has no process cwd; wasi-libc emulates one that starts at "/". The
    // host passes the kernel cwd as PWD — adopt it so relative paths behave.
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }

    let args: Vec<OsString> = std::env::args_os().collect();
    let invoked = args.first().map(basename).unwrap_or_default();

    // Invoked as a utility name (via its /bin symlink): pass argv through.
    if invoked != "coreutils" {
        match run(&invoked, args.clone().into_iter()) {
            Some(code) => exit(code),
            None => {
                eprintln!("coreutils: '{invoked}' is not a vendored utility");
                exit(127);
            }
        }
    }

    // Explicit form: `coreutils NAME ARGS…` (argv[0] becomes the utility name).
    if args.len() < 2 {
        eprintln!("usage: coreutils NAME [ARGS]…");
        exit(2);
    }
    let name = basename(&args[1]);
    match run(&name, args.into_iter().skip(1)) {
        Some(code) => exit(code),
        None => {
            eprintln!("coreutils: '{name}' is not a vendored utility");
            exit(127);
        }
    }
}
