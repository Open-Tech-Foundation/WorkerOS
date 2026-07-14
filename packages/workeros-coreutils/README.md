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
| `cat` | `[FILE...]`; no options |
| `cp`, `mv` | `SOURCE DEST`; no options |
| `seq` | `[FIRST [INCREMENT]] LAST`; finite decimal numbers |
| `ls` | `[-alhrR] [FILE...]` |
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

With multiple files, `head` and `tail` process each file independently and add
section headers. `wc` prints a row per named file and a `total` row for multiple
files. `uniq` accepts at most one input and one output file; omitting the input
uses standard input, and omitting the output uses standard output.

`wc` decodes text for word classification, but counts newlines and `-c` directly
from the original bytes. UTF-8 multibyte characters therefore contribute their
encoded byte length to `-c` and to the default third column.

`grep` is a separate Rust `wasm32-wasip1` program installed in `/bin`, rather
than a JavaScript utility in this package.
