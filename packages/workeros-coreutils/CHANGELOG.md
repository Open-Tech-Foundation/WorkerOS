# Changelog — @opentf/workeros-coreutils

Notable changes to the coreutils — guest programs written against the native
`sys` ABI, which run as real, `ps`-visible, killable processes. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Fixed
- Unsupported options now produce a clear diagnostic and exit status `2`
  instead of being silently discarded by the shared argument tokenizer. This
  applies to both the shared-parser utilities and the custom parsers used by
  `head`, `tail`, and `cut`; `--` remains available for option-looking file
  operands.
- `seq` now recognizes negative numbers as operands while still rejecting
  unknown options.

### Added
- **Shared argv parsing in the coreutils prelude** (`src/index.js`). The
  builtins now use the same guest-side POSIX/GNU-style argument tokenizer as the
  user programs, so grouped short flags, long flags, and the `--` operand
  terminator are handled consistently across the OS.
- **`ls`** — enhanced to support `-l` (long format), `-h` (human-readable sizes), `-r` (reverse sort), and `-R` (recursive directory traversal).
- **`echo -e`/`-E`** — interpret (or not) backslash escapes: `\n \t \r \e \a \b \f
  \v \\`, `\xHH`, `\0NNN`, and `\c`. Option groups combine (`-ne`). Lets `echo -e
  "\e[31m…"` emit real ANSI so the terminal renders color.

### Added (initial)
- Initial coreutils set, installed at **`/sbin`** as **system binaries** (kept apart
  from the `/bin` OS/user programs so they read as untouchable OS internals), each
  executed as a real process:
  - **`echo`**, **`true`**, **`false`**, **`pwd`**, **`env`**
  - **`cat`**, **`ls`**, **`mkdir`**, **`rm`**, **`cp`**, **`mv`**
- **Text-pipeline tools** — the utilities that make `wsh` pipelines useful:
  - **`seq`** `[FIRST [INCR]] LAST`, **`head`**/**`tail`** `[-n N]`, **`wc`** `[-l|-w|-c]`
  - **`sort`** `[-r|-n|-u]`, **`uniq`** `[-c]`, **`cut`** `-d DELIM -f LIST` (ranges/lists)
  - **`tr`** `SET1 [SET2]` / `-d`
  - `grep` is **not** a JS coreutil — it's a Rust `regex` binary compiled to
    `wasm32-wasip1` (`crates/wsh-grep`, installed at `/bin/grep`), for real regex.
  - All read file operands or stdin, so `seq 5 | grep 3 | sort -rn | head -n 2` works.
  - Covered by `tools/coreutils.test.js` (Node) and browser pipeline cases.
- Resolved via `PATH` (`/bin:/sbin`), so bare command names still work.
- Written against the kernel's WASI-shaped syscalls (stdio, path ops, args/env),
  so they compose under `wsh` pipes, redirects, and globbing.

[Unreleased]: https://github.com/opentf/workeros/commits/main
