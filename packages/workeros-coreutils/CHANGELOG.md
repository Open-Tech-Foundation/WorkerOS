# Changelog — @opentf/workeros-coreutils

Notable changes to the coreutils — guest programs written against the native
`sys` ABI, which run as real, `ps`-visible, killable processes. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Fixed
- `sort -n` now handles nonnumeric lines as numeric zero with deterministic
  lexical ties, `sort -nu` deduplicates numeric keys, and readable files are
  still sorted after an individual input error.
- `tr` now translates and deletes incrementally with a streaming UTF-8 decoder,
  including code-point-safe mappings and multibyte characters split across
  reads.
- `cut` now transforms lines incrementally with bounded output chunks, preserves
  unterminated final lines, handles UTF-8 split across reads, and continues with
  later files after an input error.
- `uniq` now processes adjacent groups incrementally instead of retaining the
  complete input, preserves unterminated final lines, and rejects identical
  input/output paths before truncation.
- `wc` now counts files incrementally instead of retaining their complete
  contents. Word classification uses a streaming UTF-8 decoder, so multibyte
  characters split across read boundaries remain one character.
- `tail` now retains only the requested final lines in a byte-preserving ring
  instead of decoding the entire input, including correct unterminated-line and
  chunk-boundary behavior.
- `head` now scans bytes incrementally, stops reading after the requested line
  count, and preserves an unterminated final line without adding a newline.
- `seq` now streams bounded output chunks instead of retaining the complete
  sequence, and rejects floating-point increments that cannot make numeric
  progress rather than looping forever.
- `cat`, `ls`, and `mkdir` diagnostics now retain the underlying kernel error
  instead of replacing it with a generic message. `mkdir -p` ignores a failed
  create only when `stat` confirms the path is already a directory.
- `ls -l` now includes real VFS hard-link counts and modification times, and
  distinguishes file, directory, and symlink display types. Its access text
  remains a documented conventional profile because the VFS has no Unix mode
  or ownership metadata.
- `cp` now rejects an identical source and destination path before opening the
  destination, preventing accidental truncation.
- `cut -f` now preserves non-delimited lines and emits selected fields in input
  order without duplicating fields selected by overlapping or reordered lists.
- File descriptors opened by shared input handling, `cat`, `cp`, and `uniq` are
  now closed on read, write, and open failures instead of leaking until process
  teardown.
- `wc -c` and the default third column now count original input bytes instead
  of JavaScript UTF-16 string units, including correct totals for UTF-8 input.
- Multi-file text processing now follows command boundaries: `head` and `tail`
  process and label each file independently while continuing after read errors,
  `wc` reports filenames and a total row, and `uniq` treats its second operand
  as an output file instead of concatenating arbitrary input files.
- Commands now reject missing, extra, and malformed operands instead of
  silently succeeding or ignoring input. Validation covers numeric `seq`
  operands, `head`/`tail` line counts, `cut` delimiters and field lists,
  `tr` operand counts, and the fixed-arity/filesystem utilities. `rm -f` keeps
  its useful no-operand success behavior.
- Unsupported options now produce a clear diagnostic and exit status `2`
  instead of being silently discarded by the shared argument tokenizer. This
  applies to both the shared-parser utilities and the custom parsers used by
  `head`, `tail`, and `cut`; `--` remains available for option-looking file
  operands.
- `seq` now recognizes negative numbers as operands while still rejecting
  unknown options.

### Added
- `ls -t` sorts entries newest-first using real VFS modification times, with
  deterministic name ties and `-r` composition.
- `ls -d` lists directory operands themselves, composes with `-l`, and suppresses
  descent when paired with `-R`.
- `cat -n` numbers all streamed output lines, including blank lines, while
  continuing line state correctly across file operands and chunk boundaries.
- `cp -r` recursively copies nested directory trees, either to a new destination
  or beneath an existing directory. Directory operands without `-r` fail
  explicitly; unrelated copy-policy flags remain unsupported.
- `cp SOURCE... DIRECTORY` and `mv SOURCE... DIRECTORY` now process multiple
  source files, require an existing directory target, continue after individual
  source failures, and return a combined non-zero status when needed.
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
