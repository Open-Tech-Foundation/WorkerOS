# WorkerOS coreutils

Small system utilities that run as WorkerOS guest processes over the native
`sys` ABI. They are installed in `/sbin` and resolved through the normal
`PATH`.

## Compatibility policy

WorkerOS implements a deliberately useful subset of POSIX/GNU command-line
behavior. It does not aim to copy every GNU coreutils option.

- Supported short options may be grouped, such as `sort -rn`.
- `--` ends option parsing, allowing operands such as `cat -- -notes`.
- For commands that parse options, an option outside the documented subset
  prints an error and exits with status `2`. Unsupported options are never
  silently ignored.
- Missing, extra, or malformed operands print an error and exit with status `1`.
- Normal runtime failures use a non-zero status appropriate to the utility.

## Supported commands

| Command | Supported options or form |
| --- | --- |
| `echo` | `-n`, `-e`, `-E` |
| `true`, `false` | No options |
| `pwd`, `env` | No options or operands |
| `cat` | `[-n] [FILE...]` |
| `cp` | `[-r] SOURCE DEST` or `[-r] SOURCE... DIRECTORY` |
| `mv` | `SOURCE DEST` or `SOURCE... DIRECTORY`; no options |
| `seq` | `[FIRST [INCREMENT]] LAST`; finite decimal numbers |
| `ls` | `[-alhrRdt] [FILE...]` |
| `mkdir` | `[-p] DIRECTORY...` |
| `rm` | `[-rRf] FILE...`; `rm -f` also accepts no files |
| `head`, `tail` | `[-n N] [FILE...]`, `-nN`, or `-N`; `N` is a non-negative integer |
| `wc` | `[-lwc] [FILE...]`; `-c` counts input bytes |
| `sort` | `-r`, `-n`, `-u` |
| `uniq` | `[-c] [INPUT [OUTPUT]]` |
| `cut` | `[-d DELIM] -f LIST [FILE...]`; one-character delimiter and positive fields/closed ranges |
| `tr` | `SET1 SET2` or `-d SET1` |

`echo` follows its traditional operand rules: an unrecognized option-looking
argument is printed as text. `true` and `false` ignore operands. Negative
numbers are valid `seq` operands without requiring `--`.

`env` currently displays the environment only. Environment assignments and
command execution are not part of the supported form, so operands are rejected
rather than silently ignored.

`seq` writes output in bounded chunks instead of constructing the entire
sequence in memory. An increment that cannot advance at the current numeric
magnitude is rejected rather than causing an infinite loop.

`cat -n` numbers every output line while streaming original bytes. Numbering
continues across files, and adjacent files without an intervening newline remain
one logical line.

`cp` and `mv` accept multiple source files only when the final operand is an
existing directory. They process remaining sources after an individual source
fails and return a non-zero final status. `cp -r` recursively creates and copies
directory trees; other copy-policy and metadata-preservation flags remain out of
scope. `cp` rejects an identical source and destination path before opening
either file for output.

`rm -f` ignores a path only when it does not exist. Permission failures,
directory operands without `-r`, and other removal errors remain visible and
produce a non-zero status. `rm -r` removes nested directory trees.

With multiple files, `head` and `tail` process each file independently and add
section headers. `wc` prints a row per named file and a `total` row for multiple
files. `uniq` accepts at most one input and one output file; omitting the input
uses standard input, and omitting the output uses standard output.

`uniq` reads and emits adjacent groups incrementally, retaining only the current
line and group count. It preserves an unterminated final line and rejects an
identical input/output path before opening the output for truncation.

`sort -n` treats a line without a numeric prefix as numeric zero, uses lexical
order to make equal numeric keys deterministic, and makes `-u` unique by numeric
key. Readable files are still sorted when another input file fails, with a
non-zero final status. Sorting necessarily retains its input lines in memory.

`head` scans input bytes incrementally and stops reading as soon as the requested
line count is reached. It does not manufacture a trailing newline when the
selected input does not contain one.

`tail` scans input bytes into a bounded ring containing only the requested final
lines. Memory use therefore follows the selected output plus the current line,
not the total number of input lines, and unterminated final lines stay
unterminated.

`ls -l` reports the VFS entry type, real hard-link count, size, and modification
time in UTC. WorkerOS does not currently model Unix owner/group or permission
bits, so the leading access text is a conventional display profile based on the
entry type rather than editable mode metadata.

`ls -d` lists directory operands themselves instead of their contents. It can be
combined with `-l`; when combined with `-R`, treating the directory as an entry
also means there is no recursive descent.

`ls -t` sorts directory entries by real VFS modification time, newest first.
Equal timestamps use name order for deterministic output, and `-r` reverses the
result.

`wc` counts incrementally without retaining entire files. It counts newlines and
`-c` directly from original input chunks, while a streaming UTF-8 decoder keeps
word boundaries correct when a multibyte character crosses two reads. UTF-8
characters contribute their encoded byte length to the default third column.

`cut -f` preserves lines that do not contain the delimiter. Selected fields are
written in their original input order, and overlapping field ranges do not
duplicate output fields.

`cut` decodes and transforms input incrementally, including UTF-8 characters
split across reads. Output is flushed in bounded chunks, an unterminated final
line remains unterminated, and later files are still processed after one fails.

`tr` translates or deletes characters incrementally from standard input. Its
streaming UTF-8 decoder keeps multibyte characters intact across read boundaries,
and translation mappings operate on Unicode code points rather than UTF-16
surrogate halves.

Utilities close every file descriptor they open, including when an input read,
output write, or later open operation fails. Standard input and output remain
owned by the process runtime and are not closed by a utility.

Filesystem diagnostics retain the kernel-provided cause, such as `ENOENT`,
`EIO`, or `EPERM`. `mkdir -p` suppresses an error only after confirming that the
path already exists as a directory.

`grep` is a separate Rust `wasm32-wasip1` program installed in `/bin`, rather
than a JavaScript utility in this package.
