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
- Normal runtime failures use a non-zero status appropriate to the utility.

## Supported commands

| Command | Supported options or form |
| --- | --- |
| `echo` | `-n`, `-e`, `-E` |
| `true`, `false` | No options |
| `pwd`, `env`, `cat`, `cp`, `mv`, `seq` | No options |
| `ls` | `-a`, `-l`, `-h`, `-r`, `-R` |
| `mkdir` | `-p` |
| `rm` | `-r`, `-R`, `-f` |
| `head`, `tail` | `-n N`, `-nN`, `-N` |
| `wc` | `-l`, `-w`, `-c` |
| `sort` | `-r`, `-n`, `-u` |
| `uniq` | `-c` |
| `cut` | `-d DELIM`, `-f LIST` |
| `tr` | `-d`; otherwise `SET1 SET2` |

`echo` follows its traditional operand rules: an unrecognized option-looking
argument is printed as text. `true` and `false` ignore operands. Negative
numbers are valid `seq` operands without requiring `--`.

`grep` is a separate Rust `wasm32-wasip1` program installed in `/bin`, rather
than a JavaScript utility in this package.
