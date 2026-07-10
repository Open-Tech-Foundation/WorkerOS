# Changelog — @opentf/workeros-web

Notable changes to the WorkerOS host runtime (kernel/program workers + the
main-thread client API). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **`wsh` prepends `node_modules/.bin` to `PATH`** (PLAN Phase 5·E). Before
  spawning an external command the shell driver prepends the `node_modules/.bin`
  chain (cwd and every ancestor, absolute) to the child's `PATH`, so an
  npm-installed package's `bin` runs as a bare name. This is npm's own
  convention — edit the environment; the kernel just does a plain `$PATH` search
  and knows nothing about `node_modules` (INV-1). `npm run` inherits it via
  `sys.exec`.
- **Synchronous `fs` for JS guests** (PLAN Phase 5·A). The per-process SAB
  sync-syscall channel is now exposed to a JS guest as `sys.syncFs`
  (open/read/**write**/close/seek/stat/readdir/mkdir/unlink/rmdir/rename), the
  basis for Node's `readFileSync`/`writeFileSync`/… A synchronous **`write`** was
  added: `makeSyncCaller` can carry a raw request payload after the JSON meta (new
  `MLEN` header field + `requestBytes`), and the kernel worker's `serviceSync`
  gains a `write` case that reports `nwritten`/`ENOSPC` back through the channel
  (terminal writes still stream to the sink). The guest runtime library
  (`@opentf/workeros-programs`'s node layer) is installed into the VFS at
  `/lib/workeros-node/` at boot so `/bin/node` imports it via the kernel resolver.
- **`tcgetattr`/`tcsetattr` syscalls** — the program worker's `sys` ABI gains
  `tcgetattr()` and `tcsetattr({ canonical, echo, isig })`, serviced by the kernel
  worker (`getattr`/`setattr`) from the kernel TTY's termios. A full-screen program
  can now take the terminal *raw + no-echo* on its own behalf (the REPL already
  did this internally); it restores the saved flags on exit. As a safety net the
  kernel worker resets the TTY to cooked when the foreground program exits, so a
  crashed TUI can't leave the prompt raw. First user: `/bin/nano`.
- **Readline prompt** (`src/shell/readline.js`). The interactive shell prompt is
  now a raw-mode line editor (like bash/readline) instead of the kernel cooked
  discipline: ↑/↓ command history, in-line cursor movement (←/→, Home/End,
  `Ctrl-A`/`E`/`B`/`F`), editing (Backspace, Del, `Ctrl-U`/`K`/`W`), and
  `Ctrl-L`. While the prompt is active the REPL owns the terminal in raw mode and
  echoes/redraws itself; a program that reads stdin still gets the kernel cooked
  discipline. (UTF-8 across chunks and bracketed paste are follow-ups.)
- **Soft-wrap in the readline prompt** — the line editor is now multi-line aware
  (à la GNU readline / linenoise): a prompt + command wider than the terminal
  wraps across rows, with correct cursor movement, editing, and redraw over the
  wrapped rows (it clears from the old cursor row up to the line's first row and
  repaints, tracking the tallest the line has been). It reads the terminal width
  each redraw, so a `SIGWINCH` resize while typing re-wraps the line in place;
  Enter/`Ctrl-C` first park the cursor at the end of the wrapped line so the
  newline breaks below the whole command. Fixes the garbled buffer and cursor
  drift on long or resized command lines.
- **Cooperative signals + `SIGWINCH`.** New protocol messages `SIGNAL`
  (kernel→program) and `SIGACTION` (program→kernel), and `sys.onSignal`/
  `sys.sighandle` on the ABI. A foreground process that installed a `SIGINT`
  handler now receives `Ctrl-C` cooperatively (and keeps running) instead of being
  hard-killed; one without a handler is still killed (130). A terminal resize
  delivers `SIGWINCH` to the foreground process; `Ctrl-Z` delivers `SIGTSTP`
  (default disposition: ignore — no job-control suspend yet).
- **`isatty`/`winsize` syscalls** — the program worker's `sys` ABI gains
  `isatty(fd)` and `winsize()`, serviced by the kernel worker from the kernel TTY,
  so guests (WASI + the node runtime) can detect the terminal and its size.
- **`echo -e`/`-E` in the shell** — the `wsh` `echo` builtin now interprets
  backslash escapes under `-e` (`\n \t \r \e \a \b \f \v \\`, `\xHH`, `\0NNN`,
  `\c`), option groups combine (`-ne`), so `echo -e "\e[31m…"` emits real ANSI.
- **Interactive terminal over the kernel TTY.** The kernel worker now runs the
  shell REPL itself, reading command lines from the kernel's TTY line discipline
  and streaming a single terminal output channel back to the main thread. New
  protocol messages `TTY_INPUT`/`RESIZE`/`TERM_START` (main→kernel) and
  `TERM_OUTPUT` (kernel→main); new client API `os.onOutput()`, `os.input()`,
  `os.resize()`, `os.startTerminal()`. `Ctrl-C` interrupts the foreground
  pipeline; the shell `read` builtin/prompts now read real interactive input
  (`shell-exec` gained a `readLine` dep, replacing the EOF stub).
- **`resolveGraph` syscall** — the program worker's `sys` ABI can ask the kernel to
  resolve a script's module graph, so the userland `/bin/node` runtime evaluates the
  script in its own worker instead of the kernel special-casing a `node` interpreter.
- **`wsh` is now a real shell interpreter** (`src/shell/interp.js`), replacing the
  one-line planner. The grammar stays in Rust (parsed via the kernel's `shell_parse`
  wasm binding, ADR-012); JS walks the AST and drives execution — a wasm module can
  neither spawn a worker nor await one, so the evaluator must be host-side.
  - **Expansion:** `$VAR`/`${…}` operators (`:-` `:=` `:+` `#`/`##`/`%`/`%%` strip,
    `/`//` replace, `${#x}`, substrings), command substitution `$(…)`/backticks,
    arithmetic `$(( … ))`, quoting, IFS field-splitting, `*`/`?`/`[…]` globbing.
  - **Control flow:** `if`/`elif`/`else`, `for`/`while`/`until`, `case`, brace groups,
    subshells, functions with `local`, `&&`/`||`/`;`/`|`, background `&`, `#` comments.
  - **Builtins with no external:** `test`/`[`, `read` (incl. `while read`), `export`,
    `unset`, `local`, `set -e`, `shift`, `trap`, `printf`, `eval`, `source`, `cd`, `:`, …
  - **Redirects:** `<`, `>`, `>>`, `2>&1`, `/dev/null` (externals stream via a kernel
    stdio plan; builtins/compounds buffer in JS).
  - Covered by `tools/shell-interp.test.js` (drives the interpreter through the real
    Rust wasm parser) and browser cases in `tools/shell.test.js`.
- **Synchronous syscall channel** (`sync-syscall.js`) — a per-process
  SharedArrayBuffer request/response slot (ADR-010/-016). A program worker writes a
  blocking syscall, signals the kernel worker, and parks in `Atomics.wait`; the
  kernel worker services it (`read`/`open`/`close`/`seek`/`stat`/`readdir`/`mkdir`/
  `rename`/…) and wakes it via `Atomics.notify`. Would-block reads are parked and released when
  data/EOF arrives. This gives a synchronous wasm `_start` real blocking I/O —
  `fd_read`, `path_open`, and blocking `stdin` from a pipe.
- **`sys.exec(line)` syscall** — system(3)-style: run a command line as a
  sub-process through the shell driver, routing its output to the caller's streams
  and resolving the exit code. Powers `npm run <script>`.
- **CommonJS execution path** — the program worker routes `require`-using `node`
  entries through the guest node runtime (`workeros-programs/node`), so
  `node index.js` resolves `node_modules` from the VFS; ES-module and plain async
  scripts keep the kernel-resolved graph + stitch path. The kernel worker installs
  the OS programs (`/bin/npm`, …) into the VFS at boot alongside the coreutils.
- **`boot()`** — spins up the kernel worker, loads the kernel wasm, performs the
  boot handshake, and resolves a `WorkerOS` handle (`version`, `abi`).
- **`WorkerOS` client** — thin main-thread API over the kernel worker:
  - `fs.read` / `fs.write` against the kernel VFS.
  - `spawn(argv, { env, cwd })` → a `Process` with streamed `onStdout`/`onStderr`
    (Uint8Array chunks), an `exited` promise, `writeStdin()`, and `kill(signal)`.
  - `exec(line, { onStdout, onStderr })` → runs a full `wsh` command line (pipes,
    redirects, `&&`/`||`/`;`, glob, background `&`, `cd`) and resolves
    `{ code, cwd }`.
  - `ps()` — a snapshot of the live process table.
  - `kill(pid, signal)` and `shutdown()`.
- **Kernel worker** — hosts the wasm kernel, dispatches syscalls, and manages the
  process table; spawns one **program worker** per process to run guest modules.
- **`wsh` execution driver** (`shell-exec`) — host-side orchestration only:
  spawns a worker per command, wires pipes, sequences `&&`/`||`, runs `cd`, and
  backgrounds jobs. Every decision is a call back into the kernel (INV-2).
- **Ring-buffer** helpers (`RingBuffer`, `allocRingBuffer`) over
  `SharedArrayBuffer` for streaming I/O.
- **Worker message protocol** (`protocol`) shared by client and workers.
- **Dev server** (`tools/serve.js`) that sets COOP/COEP for cross-origin
  isolation (ADR-010), plus headless boot/MVP/shell tests.

### Changed
- **The program worker no longer knows about `node`.** It installs one native surface
  for every guest (`sys` + a routing `console`) and evaluates each JS program the same
  way (stitch the kernel-resolved graph → import). The `process` global and the (host)
  CommonJS path are gone from here — Node.js compatibility now lives entirely in the
  `/bin/node` program, which installs `process` and loads its target itself.

[Unreleased]: https://github.com/opentf/workeros/commits/main
