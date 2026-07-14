# Changelog — @opentf/workeros-web

Notable changes to the WorkerOS host runtime (kernel/program workers + the
main-thread client API). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **`os.fs.list(path)` — directory enumeration from the client.** Alongside
  `fs.read`/`fs.write`, the client now exposes a directory read that resolves with
  `[{ name, is_dir }]` (a `FS_READDIR` round-trip handled in the kernel worker via
  the registered injector process's `sys_readdir`; no wasm change). Lets host UIs —
  e.g. the playground's Files app — browse the real VFS without shelling out to
  `ls`. Covered by an mvp.test.js browser case.
- **Multiple independent terminals (multi-PTY).** The single kernel-owned TTY is
  now a table of controlling terminals: each has its own line discipline, termios,
  window size, foreground process group, shell session (cwd/env), and history, so
  several xterm windows can drive fully separate shells with no cross-talk. The
  kernel gains `open_tty`/`close_tty` and a per-process `ctty` (inherited on spawn;
  `sys_read` routes terminal stdin to the caller's terminal); tty ops and `spawn`
  thread a tty id through the wasm bindings. The kernel worker runs one REPL per
  terminal (a `Terminal` class keyed by tty id); captured `system(3)`/child_process
  runs share a neutral `systemShell` that never seizes a terminal's foreground. New
  client API: `os.openTerminal() → TerminalSession` (`onOutput`/`input`/`resize`/
  `start`/`close`), alongside the unchanged legacy primary-terminal methods. New
  protocol messages `TERM_OPEN`/`TERM_OPENED`/`TERM_CLOSE` and a `session` tag on
  the TTY channel. Verified headlessly: two terminals hold independent cwds and
  echo, input routes only to the addressed terminal, and the existing 84 single-
  terminal tests (cooked discipline, ^C, SIGWINCH, isTTY, `nano`, readline,
  child_process inherit) still pass. Adds `tools/multi-tty.test.js`; 4 new kernel
  unit tests cover independent input queues, foreground/winsize, ctty inheritance,
  and close→EOF.
- **Node-compat website report + canonical test classifier.** New shared
  `tools/node-compat-classify.mjs` normalizes every official test to a canonical
  Node builtin (folding upstream naming quirks like `test-h2-*` → http2,
  `test-runner-*` → test-runner, `test-messageport-*` → worker; genuine one-offs
  fall into `misc`, ~1%). The raw runner now imports it instead of an inline
  heuristic that produced 247 noisy buckets (now 77 real modules). New
  `tools/node-compat-report.mjs` (`npm run report:node-compat`, and auto-run at
  the end of `test:node-compat:full`) emits a stable, public-shaped
  `report.json` — target, overall counts, `topFailures`, per-module/per-suite
  pass rates — for the website to fetch. Current raw full-tree result:
  1,332 / 4,699 pass (28.3%).
- **`fs.link`/`fs.realpath` syscalls wired.** The sync channel + async ABI gain
  `link` (mutating — stamps the clock + emits a watch event) and `realpath`,
  routed to the new kernel `sys_link`/`sys_realpath`; new wasm bindings expose
  both. Closes the last filesystem-level gaps for a pnpm-style store (hard links
  + symlink canonicalization). Proven end-to-end by a headless-browser `node`
  script that hard-links a store file into a project (nlink 2, survives unlinking
  the original) and `realpath`s a symlinked `.pnpm` package dir.
- **`fs.watch` delivery across the worker boundary.** The sync channel gains
  `watchAdd`/`watchRemove` (register/unregister a watch synchronously, returning a
  watch id); after every mutating syscall the kernel worker drains the kernel's
  pending watch deliveries and posts each as a new `MSG.FS_EVENT` to the *owning*
  process worker, where `node:fs` fans it out to the right `FSWatcher`. A process's
  watches are torn down on exit (`watchClosePid`). New wasm bindings:
  `watchAdd`/`watchRemove`/`watchClosePid`/`drainWatchEvents`; the program worker
  exposes `sys.onFsEvent`. Proven end-to-end by a headless-browser test where a
  running `node` process `fs.watch`es a directory and receives the change event
  from a later write (`tools/sync-fs.test.js`).
- **`node:fs` symlink + mtime syscalls wired through the stack.** The sync-syscall
  channel + async ABI gain `lstat`/`symlink`/`readlink` (routed to the new kernel
  ops), `stat` now returns real timestamps, and the kernel worker **stamps the
  kernel clock (`setTime`) before every mutating call** so persisted mtimes/ctimes
  are wall-clock real (the kernel is clock-less per ADR-020). New wasm bindings:
  `sys_lstat`/`sys_symlink`/`sys_readlink`/`setTime`. Proven end-to-end by a
  headless-browser test running a `node` script that symlinks, `readlink`s,
  `lstat`s, and reads a real `mtimeMs` (`tools/sync-fs.test.js`).
- **Durable filesystem: snapshots + mark-sweep GC (ADR-022, PLAN Phase 7).** The
  write-behind flush now persists against the kernel's **live set** (`liveChunks()`
  — working tree ∪ retained snapshots) instead of just the working tree, saves the
  serialized snapshot set (`snapshotExport()`) to a meta key, and **garbage-collects**
  by deleting any stored chunk no longer live. On a bounded cadence (5 min) it takes
  a rolling auto-snapshot (`snapshotAuto()`) so the last-10 durable states stay
  recoverable; boot re-registers persisted snapshots (`snapshotImport()`) on top of
  the hydrated tree. New wasm bindings expose `snapshotCreate`/`snapshotAuto`/
  `snapshotDestroy`/`snapshotRestore`/`snapshotList`/`liveChunks`/`snapshotExport`/
  `snapshotImport`; `persistence.js` gains `saveSnapshots`/`loadSnapshots`. Proven by
  a headless-browser test that overwrites a multi-chunk file and asserts its old
  chunks are swept from IndexedDB on the next flush (`tools/persistence.test.js`).
- **Durable filesystem: content-addressed block store + delta flush (ADR-022,
  PLAN Phase 7).** `src/persistence.js` is a content-addressed IndexedDB block
  store: file data lives as SHA-256-keyed **chunks** (each compressed with
  `deflate-raw` via Compression Streams, written once — identical chunks dedup)
  and a **manifest** ties them into the durable tree. It degrades to a no-op store
  (OS still runs, no durability) when IndexedDB or Compression Streams are absent.
  At boot the kernel worker installs the OS, loads each stored chunk (verifying the
  chunk's bytes hash back to its key before trusting it), then `hydrateManifest()`
  rebuilds the tree. A write-behind timer flushes only when the kernel's
  `fsGeneration()` advances, and each flush writes just the **new** chunk hashes
  (delta) plus the manifest — not a whole-tree blob. `MSG.FS_FLUSH` (from the
  client on `visibilitychange:hidden`/`pagehide`) forces a durable flush before
  the tab closes; the client API gains `os.flush()`. New wasm bindings expose
  `manifest()`/`referencedChunks()`/`chunkBytes()`/`loadChunk()`/`hydrateManifest()`
  (plus `fsGeneration()`/`mount()`). Durability is path-based: files at `/` persist
  across reloads while `/tmp` (scaffold-and-discard) is ephemeral. Proven end-to-end
  by headless-browser reload-survival tests, including a 200 KiB multi-chunk binary
  file that round-trips byte-exact through chunk/compress/reassemble
  (`tools/persistence.test.js`). Honest limit (INV-5): eventually-consistent
  (~2s window); snapshots + GC land in Stage 4.
- **Color-capable default terminal env** (`kernel-worker.js`). The interactive
  shell session now seeds `TERM=xterm-256color` and `COLORTERM=truecolor`, so
  color-detecting guest tools (chalk's `supports-color`, etc.) light up 24-bit
  color instead of falling back to plain text on a TTY — honest, since the host
  xterm already renders ANSI color.
- **`nano` fuzzy file finder** (`^P`, Ctrl-P "go to file"). Recursively scans the
  cwd (skipping `node_modules`/`.git`, capped at 4k files) and offers a fuzzy-ranked
  picker — basename matches beat path matches, more contiguous and shorter paths
  first. Picking a file loads it into the (single) buffer, prompting to save first if
  there are unsaved changes, and re-runs language + indentation detection. Reuses the
  command-palette overlay/loop; also available as "Open File…" in the palette.
- **`nano` modernized chrome** (VSCode-style). The two always-on shortcut bars and
  the separate message bar are replaced by a **single status bar** on the last row:
  a transient message / discoverability hint on the left, and `Ln, Col` · indent ·
  language · EOL (LF/CRLF) segments on the right. This frees **two editing rows**
  (chrome is now title + status). `^G` opens a centered **shortcuts dialog** over the
  buffer (any key dismisses); `M-p` opens a fuzzy **command palette** (type to filter,
  ↑/↓ to select, Enter to run, Esc to cancel). The hardcoded `TABSTOP` having become
  `tabWidth`, `textRows` is now `screenRows - 2`.
- **`nano` tabs-vs-spaces indentation** (VSCode-style). Tab inserts spaces or a real
  `\t` per the current mode; in spaces mode one Backspace over leading whitespace
  removes a whole soft-tab. The mode + size are **detected** from the file on open
  (`detectIndent`), falling back to **spaces / 4**. A right-aligned message-bar
  indicator shows `Spaces: 4` / `Tab Size: 8` (it yields to status text on a narrow
  screen). `M-t` opens a prompt to change type then size; the chosen size is also the
  tab display width. The hardcoded `TABSTOP` is now a settable `tabWidth`.
- **`nano` syntax highlighting** (`M-y` toggles; on by file extension). A single
  generic, heuristic tokenizer driven by a per-language *data* table — adding a
  language is ~10 lines of data, not code. Ships JS/TS, JSON, shell, Python, Go,
  Rust, C/C++, CSS, YAML, TOML and Markdown; unknown extensions stay plain.
  Multiline constructs (block comments, template/triple-quoted strings) are tracked
  with a per-line carried state, and only the visible rows are tokenized (cached,
  invalidated on edit). Colors compose under the selection highlight (inverse wins)
  and horizontal scroll / soft-wrap. Not a real parser — regex-vs-divide and nested
  templates can mis-color, the same trade real nano's `.nanorc` rules make.
- **`nano` copies to the system clipboard (OSC 52).** Cutting (`^K`) and copying
  (`M-6`) now also emit `ESC ] 52 ; c ; <base64> ST` so the selection lands on the
  host clipboard, not just nano's internal cut buffer — the copy-out counterpart to
  the bracketed-paste support (see **Fixed**). Successive `^K` cuts mirror the
  accumulated buffer; payloads over ~74 KB are skipped (the common terminal cap).
  Base64 is encoded in the guest without `atob`/`btoa`.
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

### Fixed
- **`nano` no longer stair-steps a pasted block.** The editor now enables
  bracketed-paste mode (`ESC[?2004h`) and gathers the whole `ESC[200~ … ESC[201~`
  block, inserting it literally instead of feeding each newline through
  `insertNewline()` — so auto-indent no longer compounds the leading whitespace of
  pasted (already-indented) code line after line. Typed Enter still auto-indents;
  only genuine pastes bypass it. CR/CRLF in the paste are normalized to LF.

### Changed
- **The program worker no longer knows about `node`.** It installs one native surface
  for every guest (`sys` + a routing `console`) and evaluates each JS program the same
  way (stitch the kernel-resolved graph → import). The `process` global and the (host)
  CommonJS path are gone from here — Node.js compatibility now lives entirely in the
  `/bin/node` program, which installs `process` and loads its target itself.

[Unreleased]: https://github.com/opentf/workeros/commits/main
