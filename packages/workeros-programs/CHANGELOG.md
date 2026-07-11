# Changelog — @opentf/workeros-programs

The OS programs package: installable `/bin` programs plus the Node-compatible
guest runtime. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- **Shared guest argv parser** (`src/cli/args.js`). A common POSIX/GNU-style
  tokenizer for WorkerOS guest programs: grouped short flags, long flags,
  option values, `--`, tar-style bare short clusters, and stop-at-first-operand
  behavior. Reused by `curl`, `tar`, `gzip`, `zip`, `unzip`, `sh`, `nano`,
  `/bin/node`, and `npm`, replacing ad hoc parsers. This fixes several
  argument-handling inconsistencies and gives the runtime one canonical
  program-level argv layer distinct from `wsh`'s shell parsing. Covered by
  `tools/args.test.js`.
- **`node:stream`** (`src/node/stream.js`). A first Node-compatible stream
  surface for the guest runtime: `Stream`, `Readable`, `Writable`, `Duplex`,
  `Transform`, `PassThrough`, `Readable.from`, `pipe`, `pipeline`,
  `finished`, and `stream.promises`. Registered as a real builtin so package
  feature-detection and light stream usage no longer fail on a missing module.
  Honest scope (INV-5): this is a pragmatic compatibility layer, not a full
  Node backpressure/object-mode implementation yet. Covered by
  `tools/stream.test.js`.
- **WASM codec behind `node:zlib` + `node:crypto`** (`crates/workeros-codec`,
  `src/node/wasm-codec.js`). A freestanding Rust→wasm module (miniz_oxide DEFLATE +
  RustCrypto hashes) accelerates the CPU-bound hot paths behind the *same* APIs.
  It carries a manual pointer/length ABI (no wasm-bindgen) so the guest can
  instantiate it **synchronously** — `new WebAssembly.Instance` off the main
  thread — and call it from inside Node's sync `gzipSync`/`createHash`. Loaded
  lazily per process from `/lib/workeros-codec/codec.wasm` via the sync-fs channel;
  `zlib`/`crypto` prefer it when present and fall back to the pure-JS impls
  otherwise (plain-Node unit tests, or an env that didn't run `npm run
  build:codec` — the binary is gitignored like `grep.wasm`). Measured: raw DEFLATE
  ~5× faster **and 2.8× smaller** (miniz's dynamic Huffman vs the JS fixed-Huffman
  encoder); SHA-256 ~1.2× (1 MB) to ~5× (small inputs) faster. The wasm is
  cross-validated against real Node zlib/crypto (`tools/codec.test.js`), and an
  end-to-end test proves it's actually active in a booted kernel by asserting gzip
  emits dynamic-Huffman blocks (`@opentf/workeros-web` `tools/archive-tools.test.js`).
- **`node:fs` file watching: `fs.watch` + `watchFile`** (`src/node/fs.js`). A real
  `FSWatcher` (an event emitter with `on`/`once`/`off`/`close`) that emits
  `change` `(eventType, filename)` — the kernel pushes change events to the
  process's single dispatcher (`sys.onFsEvent`), which fans each out by watch id.
  Supports `{ recursive }` and the encoding/listener argument shapes; watching a
  missing path throws `ENOENT`, and with no watch backing (unit tests) it throws
  `ENOTSUP`. `watchFile`/`unwatchFile` layer a `(curr, prev)` Stats StatWatcher on
  top. Unit-tested (fan-out + close teardown); driven end-to-end in a booted kernel.
- **Archive CLIs: `tar`, `gzip`/`gunzip`/`zcat`, `zip`/`unzip`** (`src/tar`,
  `src/gzip`, `src/zip`, `src/unzip`, `src/archive/{tar,zip}.js`). Day-to-day
  compression tools as real `/bin` guest programs (INV-1). The container framing
  lives in a shared, pure, dependency-free `/lib/workeros-archive` library —
  ustar (POSIX tar) and ZIP (local headers + central directory + EOCD) — with the
  DEFLATE payload + CRC-32 supplied by `node:zlib` (injected into the zip lib, not
  imported, so it carries no path coupling to the node tree). `tar` does
  create/list/extract with bundled or dashed flags, `-z` gzip (auto-detected on
  extract for `.gz`/`.tgz`), `-f`, `-C`, `-v`; `gzip` follows GNU semantics
  (in-place `.gz`, `-k`/`-c`/`-d`/`-f`, stdin→stdout, name-dispatched
  `gunzip`/`zcat`); `zip -r`/`unzip -l`/`-d` round-trip directory trees. The pure
  libs are cross-validated against **real GNU `tar` and Info-ZIP** in both
  directions (`tools/{tar,zip}.test.js`); the programs are driven end-to-end in a
  real booted kernel (`@opentf/workeros-web` `tools/archive-tools.test.js`).
  Honest scope (INV-5): `zip` writes a fresh archive (no in-place update); the VFS
  has no mode bits, so default permissions are used.
- **`node:fs` symlinks + real timestamps** (`src/node/fs.js`). Now that the VFS
  models symlinks and inode times (ADR-022), `fs` exposes them: `symlinkSync`,
  `readlinkSync` (with `'buffer'` encoding), and a proper `lstatSync` that does
  **not** follow a final link (so `Stats.isSymbolicLink()` can be true), plus the
  `promises` equivalents. `statSync`/`lstatSync`/`fstatSync` now report real
  `mtimeMs`/`ctimeMs`/`birthtimeMs` (from the host-stamped kernel clock) and
  `Date` accessors instead of epoch-zero constants; `atime` is reported as
  `mtime` (the VFS doesn't track access time — honest, INV-5). Unit-tested
  against the fake `syncFs` (which gained symlink + mtime modeling).
- **`node:zlib`** (`src/node/zlib.js`). Gzip/DEFLATE for the guest, one-shot sync
  + async. As with `node:crypto`, Node's API is *synchronous* (Vite's build
  reporter calls `gzipSync` inline) but the browser's only compressor,
  `CompressionStream`, is async-only — so the sync core is self-contained here: a
  full RFC-1951 INFLATE and a fixed-Huffman + LZ77 DEFLATE, wrapped for gzip
  (RFC 1952, CRC-32) and zlib (RFC 1950, Adler-32). Covers `{gzip,gunzip,deflate,
  inflate,deflateRaw,inflateRaw,unzip}Sync`, their async-callback forms,
  `zlib.crc32`, and `constants`. Cross-validated against **real Node's zlib** in
  both directions in `tools/zlib.test.js` (Node's inflate decodes ours; our
  inflate decodes Node's dynamic-Huffman output). Honest surface (INV-5): the
  encoder emits valid fixed-Huffman blocks (a little ratio for a small verifiable
  codec); Brotli has no host/JS backing and is *absent*, and streaming classes
  (`createGzip`, …) are a follow-up.
- **`node:crypto`** (`src/node/crypto.js`). A guest builtin covering the sync
  surface build tooling (Vite) and most of npm reach for. Two honest sources,
  split by what the browser does *synchronously* (Node's crypto API is sync):
  randomness (`randomBytes`/`randomFillSync`/`randomUUID`/`randomInt`) is backed
  by the host Web Crypto (`crypto.getRandomValues`), a real CSPRNG; hashing
  (`createHash`/`createHmac`) is self-contained sync digests — MD5, SHA-1/224/256/
  384/512 and HMAC over any of them — because the host's only hash
  (`crypto.subtle.digest`) is async and can't back a sync `.digest()`. Also
  `timingSafeEqual`, `getHashes`, and `webcrypto` (the host WebCrypto passthrough).
  Implementing the digests in-guest mirrors the kernel's own `hash.rs` and keeps
  the kernel ABI generic (INV-1) — a hash is not a primitive the kernel must own.
  Digests are checked against known-answer vectors in `tools/crypto.test.js`.
- **`node:events` + `node:util`** (`src/node/events.js`, `src/node/util.js`). Two
  pure builtins depended on transitively by much of npm. `events.js` is a real
  `EventEmitter` (the class packages extend): the full listener surface
  (on/once/off, prepend variants, removeAllListeners, listeners/rawListeners,
  listenerCount, eventNames), the `newListener`/`removeListener`/`error` special
  events, max-listeners tracking, and the statics `EventEmitter.once`/`on`/
  `getEventListeners` — and, like Node, the module *is* the constructor. `util.js`
  covers `promisify`/`callbackify` (with the custom-promisify symbol), a real
  recursive `inspect` (depth limit, circular detection, custom-symbol hook,
  Map/Set/Date/RegExp/Error/typed-array) and `format`/`formatWithOptions`,
  `deprecate`, `inherits`, `isDeepStrictEqual`, `types.*`, `debuglog`, the legacy
  `is*` predicates, and the `TextEncoder`/`TextDecoder` re-exports. Registered in
  `makeBuiltins`; unit-tested against Node's own `util`/`EventEmitter` as oracle.
- **`Buffer` (global + `node:buffer`) and the `global` alias** (`src/node/buffer.js`,
  `node-program.js`). A browser worker has neither, and a huge share of npm expects
  `Buffer` ambient (`Buffer.from(...)` at module top level), so both are now
  installed before the script loads. `buffer.js` is a real Buffer — a `Uint8Array`
  subclass (as in Node) with memory-sharing `slice`/`subarray`, the `from`/`alloc`
  factories, encoding-aware `toString`/`write` (utf8, utf16le/ucs2, latin1/binary,
  ascii, hex, base64, base64url), fixed- and variable-width numeric accessors
  (8/16/32-bit LE+BE, BigInt64, float/double, plus Node's lowercase `Uint`
  aliases), and `concat`/`compare`/`equals`/`copy`/`fill`/`indexOf`. Registered in
  `makeBuiltins`, so `require('buffer')` and `import { Buffer } from 'node:buffer'`
  resolve too. Unit-tested against Node's own Buffer as the oracle.
- **Node event-loop keep-alive** (`src/node/event-loop.js`, `node-program.js`).
  `/bin/node` returned to the program worker the instant the script's synchronous
  top level settled, so a top-level `setInterval`/`setTimeout` never fired (the
  process was reported exited at ~0 ms). New `event-loop.js` wraps the worker's
  native timers with Node's timer-handle surface (`ref`/`unref`/`hasRef`/`refresh`
  + numeric-id coercion, so `clear*` takes the handle or the id) over a reference
  count; `/bin/node` installs the wrapped globals and `await`s `whenIdle()` so
  timer-driven scripts (spinners, polling, deferred writes) run to completion and
  exit once the loop drains — a never-cleared `setInterval` keeps it alive
  forever, as in Node. `SIGINT` → `process.exit` stays clean (the post-exit
  `ProcessExit` is swallowed). `setImmediate` is a 0 ms one-shot (honest limit,
  INV-5). Unit-tested with real timers.
- **`node:tty` + `node:process` builtins** (`src/node/tty.js`, `node-program.js`).
  Packages import these rather than read the globals — chalk's `supports-color`
  does `import process from 'node:process'` and `import tty from 'node:tty'`, so
  `const {env} = process` threw with neither provided. `tty.js` is a real module:
  `isatty`, `WriteStream` (`cursorTo`/`moveCursor`/`clearLine`/`clearScreenDown`
  emitting the exact CSI escapes Node's `readline` writes, plus `getWindowSize`/
  `getColorDepth`/`hasColors`), and `ReadStream` (`setRawMode`, wired to the
  kernel line discipline via `tcsetattr`). `process.std{in,out,err}` are now real
  `tty` streams on a terminal fd (a plain reader/writer when redirected — Node's
  isTTY split). `process`/`tty` carry per-process state the pure `makeBuiltins`
  can't, so they're threaded into both the ESM registry and the CJS runtime
  (`makeBuiltins`/`createNodeRuntime` take an `extras` map) — `import` and
  `require` resolve the same objects. Unit-tested.
- **Package `imports` (`#…` subpath imports)** (`src/node/resolve.js`). The
  userland-resolver move (see the ESM entry below) ported `exports` but not its
  sibling `imports`, so chalk's `import '#ansi-styles'`/`'#supports-color'`
  resolved as bare packages and failed. `resolveFrom` now resolves a `#`-spec
  against the nearest enclosing `package.json` `imports` map — package-scoped,
  reusing the same condition-picking and `./*` wildcard logic as `exports`.
  Unit-tested.
- **npm bin-linking + PATH** (`npm/npm-program.js`, PLAN Phase 5·E). `npm install`
  now writes a generated launcher to `node_modules/.bin/<name>` for each package
  `bin` (a string, named after the package, or a `{ name: path }` map). The VFS
  has no symlinks, so the launcher is a tiny native program that re-execs
  `node <target>` via `sys.exec`, forwarding argv and the exit code. Paired with
  the shell prepending the `node_modules/.bin` chain to `PATH` (see
  `@opentf/workeros-web`), an installed package's command runs as a bare name
  (`esbuild …`) — the policy is npm's `PATH` convention in userland, not kernel
  knowledge (INV-1). Honest limit (INV-5): `sys.exec` doesn't forward stdin yet.
- **CJS-in-an-ESM-graph interop** (`node-program.js`, `module.js`). A CommonJS
  dependency reached via an ESM `import` (resolved into the graph as a leaf)
  can't be evaluated as an ES module. `/bin/node`'s ESM stitch now
  stands each such module up with a synthetic ES module — `export default
  module.exports` plus a named export per own key (interop for `import { x }`) —
  backed by the synchronous CJS loader (`module.js` `_load`), which resolves the
  dep's own `require` subtree on demand over the sync `fs`. End-to-end tested.
- **ESM `import` of `node:` builtins and installed packages — resolved in
  userland** (PLAN Phase 5·C-ESM / D). `/bin/node` now resolves its own ES module
  graph over the synchronous `fs` (`src/node/resolve.js` + `src/node/esm-graph.js`),
  because `node_modules`/`package.json` `exports`/`node:` is Node-ecosystem policy,
  not the kernel's business (INV-1 — the kernel does only generic relative
  resolution). `resolve.js` handles the `node_modules` walk, `exports`(".")/
  `module`/`main` with ESM conditions, `@scope` + `./*` subpath exports, and
  ext/`index` fallbacks; `esm-graph.js` scans imports (tokenized, so
  strings/comments don't false-positive) and builds the graph. Builtin imports
  become `builtin` edges that the stitch turns into a re-export module wired to
  the guest runtime — so `import fs from 'node:fs'` and
  `import { readFileSync } from 'fs'` both work (`makeBuiltins` is exported for
  this). ESM-only packages run; an uninstalled package fails honestly (INV-5).
  Unit-tested in pure Node and end-to-end in a browser.
- **`node:module` / `node:os` / `node:url` builtins + a fuller `process`** (PLAN
  Phase 5·B). Three more core `node:` builtins resolve through the CJS registry:
  - **`module`** (`src/node/module.js`) — the headline is `createRequire(filename)`:
    a *synchronous* `require` for arbitrary CJS modules, built on the synchronous
    `fs` (Phase 5·A). Unlike the ahead-of-time prefetch runtime, it resolves +
    reads + evaluates each module on demand (`fs.*Sync`), so computed requires and
    `createRequire(import.meta.url)('pkg')` — what tools like `esbuild`'s launcher
    need — work. Node CJS resolution subset (relative + `node_modules`, `.js`/
    `.cjs`/`.json` + `index`, package.json `exports`(".")/`main`). Also
    `builtinModules`/`isBuiltin`/`require.cache`/`require.resolve`.
  - **`os`** (`src/node/os.js`) — `EOL`/`platform`/`arch`/`tmpdir`/`homedir`/
    `hostname`/`endianness`/`cpus`/`availableParallelism`/`userInfo`/… Constants
    for the single posix personality; `cpus`/`totalmem` are best-effort browser
    signals (`navigator.hardwareConcurrency`/`deviceMemory`), honest where the
    browser can't tell us a true value (INV-5).
  - **`url`** (`src/node/url.js`) — re-exports WHATWG `URL`/`URLSearchParams` and
    adds `fileURLToPath`/`pathToFileURL` (posix) plus the legacy
    `parse`/`format`/`resolve`.
  - **`process`** (`src/node/node-program.js`) grows `chdir` (process-local view,
    honest until a kernel `chdir` lands), `hrtime`(+`.bigint`), `nextTick`,
    `arch`, and `versions` (reports a recent `node` for feature-detection while
    staying truthful in `version`/`release`). All unit-tested in pure Node;
    end-to-end tested in a browser.
- **`node:fs` — synchronous filesystem** (`src/node/fs.js`, PLAN Phase 5·A). The
  keystone for real tools: `createFs(sys.syncFs)` implements the sync `fs` surface
  (`readFileSync`/`writeFileSync`/`appendFileSync`/`openSync`/`readSync`/`writeSync`/
  `closeSync`/`statSync`/`existsSync`/`readdirSync`/`mkdirSync`(recursive)/`rmSync`/
  `rmdirSync`/`unlinkSync`/`renameSync`/`copyFileSync`/`realpathSync`/`fstatSync`) plus
  a thin `fs.promises`, over the per-process SAB sync-syscall channel exposed as
  `sys.syncFs`. Kernel errnos map to Node codes (`ENOENT`/`EEXIST`/`ENOSPC`/…).
  Honest surface (INV-5): reads return a `Uint8Array` unless an encoding is given;
  no symlinks/permissions/timestamps.
- **`node:path` (posix)** (`src/node/path.js`) — a real `path` builtin
  (join/resolve/dirname/basename/extname/normalize/relative/parse/format),
  replacing the ad-hoc helper.

### Changed
- **CommonJS loading now reuses the shared Node resolver** (`src/node/module.js`,
  `src/node/require-runtime.js`). The sync `node:module` loader and `/bin/node`'s
  CJS entry path both resolve through `src/node/resolve.js`, removing the older
  duplicated prefetch-era resolver. This brings CJS entry loading onto the same
  package policy as ESM and `createRequire` — including package `imports`
  (`#...`) support — while keeping CJS execution synchronous over the sync-fs
  channel. Covered by `tools/{module,require-runtime,resolve}.test.js`.
- **CommonJS `node:` builtin registry** (`require-runtime.js`) — `require('fs')`,
  `require('node:fs')`, `require('fs/promises')`, and `require('path')`/
  `require('node:path')` resolve to the guest builtins. `/bin/node` now runs a
  CommonJS entry through the CJS runtime (ESM entries keep the stitch path); the
  runtime library is installed into the VFS at `/lib/workeros-node/` and imported
  by `/bin/node` via the kernel resolver (INV-2), so `node` stays a self-contained
  guest program. Unit-tested in pure Node; end-to-end tested in a browser.
- **`nano`** (`src/nano/nano-program.js`) — a small modeless full-screen text
  editor at `/bin/nano`, WorkerOS's first interactive TUI. It takes the terminal
  raw + no-echo (`sys.tcsetattr`), uses the alternate screen, and paints frames
  with ANSI: a title bar, the text area, a message bar, and two shortcut bars.
  Editing (insert, Enter/Backspace/Del, Tab), cursor movement (arrows, Home/End,
  PgUp/PgDn, `^A`/`^E`, `^Y`/`^V`), `^O` write out (with a Save-As prompt), `^X`
  exit (prompting when the buffer is modified), `^K`/`^U` cut & paste lines, `^W`
  search, `^_` go-to-line, and `^C` cursor position. Honors `SIGWINCH` to
  re-layout, and restores the terminal on exit. Files round-trip with a trailing
  newline; tabs render on 8-column stops.
  - **Undo/redo** (`M-U`/`M-E`) — whole-document snapshots with a bounded
    history; a burst of typing (or a run of backspaces / of `^K` cuts) folds into
    one step, and a cursor move ends the run.
  - **Search & replace** (`^\`) — prompts for the needle and replacement, then
    walks matches from the cursor (wrapping), asking per instance or `A` for all;
    the whole replace is a single undo step.
  - **Wide-character & astral support** — East Asian wide / fullwidth glyphs and
    emoji render as two columns (a small `wcwidth`), with a horizontal-scroll
    slice that renders a clipped wide glyph as a space for its shown half, so
    columns line up. Cursor motion and deletion step by whole code points, so an
    emoji (surrogate pair) is never split. The pure width/slice helpers are
    exported and unit-tested (`tools/nano-text.test.js`); the `M-U`/`M-E`/`^\`
    flows and a wide-glyph round-trip are covered by the browser e2e.
  - **Line-number gutter** in 24-bit color — a left gutter numbers each line
    (accent for the current line, dim for the rest, via true-color SGR the
    terminal renders directly); on by default, toggle with `M-N` or `-L`. Text
    layout, horizontal scroll, and the cursor column all account for the gutter.
  - **Mouse support** — nano enables SGR mouse reporting with button-event
    tracking (`?1000`/`?1002`/`?1006`) and decodes the reports itself: a
    left-click positions the cursor (mapping the click cell back through tabs/wide
    glyphs to a code-unit index), a **click-drag selects a range** (motion reports
    extend the selection to the cursor), **double-click selects the word** and
    **triple-click the line**, and the wheel scrolls. No kernel/host change —
    xterm forwards the events and the raw TTY passes them through; disabled again
    on exit. `rxToCx`, `gutterWidthFor`, and `parseMouse` are exported and
    unit-tested; a real click, drag-select, and double-click are covered by e2e.
  - **Robust rendering & DOS/Mac files** — control characters now show as inverse
    caret notation (`^M`, `^A`, `^?`) instead of being emitted raw, so a stray CR
    can no longer move the cursor or blank a row. Line endings are detected on load
    (`\n`/`\r\n`/`\r`), stripped from the buffer, and re-applied on save, so a DOS or
    Mac file round-trips unchanged (`Read N lines [DOS]`). The chrome bars (title,
    message, prompts) now measure and pad by **display columns** (`dispWidth`/
    `fitCols`), so a wide-character filename no longer misaligns them. A `SIGWINCH`
    while a prompt is open repaints the prompt instead of clobbering it.
  - **Selection, copy & paste** — `^6` sets/clears a mark; the region between the
    mark and cursor is highlighted (inverse) and can be cut (`^K`) or copied
    (`M-6`); `^K` with no mark still cuts whole lines. The cut buffer is now text
    (may span lines) and `^U` re-inserts it at the cursor, so copy/paste works
    across the file.
  - **In-prompt line editing & completion** — message-bar prompts gain `←`/`→`,
    `Home`/`End`, and `Del` (surrogate-safe), and `Tab` completes a filename to
    the longest common prefix of the directory (appending `/` for a lone dir).
  - **`Esc` dismisses overlays reliably.** The key decoder no longer blocks after
    a lone `ESC` byte waiting for a continuation that never comes (which hung the
    keypress until the next one and misread `ESC`+key as an Alt chord). Because the
    TTY hands a program a whole keystroke's bytes in one read, a real CSI/SS3/Alt
    sequence already has its bytes buffered when `ESC` is seen, while a bare `ESC`
    arrives alone — so an empty buffer is treated as Escape immediately. `Esc` now
    closes the command palette (`M-p`), the file finder (`^P`), and prompts.
  - **Word motion & deletion** — `Ctrl-←`/`Ctrl-→` move by word; `M-Backspace`
    and `M-Del` delete the word before/after the cursor.
  - **Auto-indent** (on by default, `M-I` toggles) carries a line's leading
    whitespace onto the next line at `Enter`.
  - **Insert file** (`^R`) reads another file and inserts it at the cursor.
  - `wordLeftIndex`/`wordRightIndex` are exported and unit-tested; selection,
    word-delete, insert-file, auto-indent, in-prompt editing, and Tab-completion
    are covered by the browser e2e.
  - **Search options & soft-wrap** — the search/replace prompt gains `M-C` case
    sensitivity, `M-R` regex, and `M-B` backward toggles (shown as `[Case]`/
    `[Regex]`/`[Back]`); an empty `^W` repeats the last needle. `M-$` toggles
    **soft-wrap**, where a long line flows onto extra screen rows: the frame is
    laid out through a screen-row→document `visualMap` that also drives cursor
    placement and mouse hit-testing, so a click on a wrapped continuation lands
    the right column. `findNext`/`findInLine`/`wrapSegments` are exported and
    unit-tested; regex replace-all, repeat-search, and a wrapped-row click are
    covered by the browser e2e.
- **`process` signal handling.** The node runtime gains a minimal EventEmitter on
  `process` (and its streams): `process.on('SIGINT'|'SIGWINCH'|'SIGTSTP'…, cb)`,
  `once`/`off`/`emit`/`listenerCount`. Registering a signal handler tells the
  kernel (via `sys.sighandle`) to route that signal cooperatively. `SIGWINCH`
  refreshes `process.stdout.columns`/`rows` and emits `stdout`'s `resize` before
  the handler runs. Together with the kernel wiring this makes `Ctrl-C` catchable
  and terminal-resize observable from a script.
- **Terminal awareness for guests.** WASI programs now see stdio (fd 0/1/2) as a
  non-seekable character device, so `isatty(0..2)` returns true on the terminal
  (the WASI host clears the `FD_SEEK`/`FD_TELL` rights that made libc report
  false). The Node runtime sets `process.stdin/stdout/stderr.isTTY` and, on a TTY,
  `process.stdout.columns`/`rows` from the kernel window size — reversing the
  earlier `isTTY=false` stub, so `readline`/`chalk`-style TTY detection works.
  (WASI termios/window-size ioctls remain out of reach in Preview 1; a
  `require('tty')` builtin awaits the node: builtin registry.)
- **Program registry** (`src/index.js`) — one extensible list the kernel worker
  installs into the VFS at boot. Adding a program is a single entry (no package per
  program). Entries carry a `type` (`js` now, `wasm` later).
- **`node`** (`src/node/node-program.js`) — the Node.js-compatibility runtime, now
  a real user program at `/bin/node` instead of a kernel builtin. `node foo.js` asks
  the kernel to resolve `foo.js`'s module graph (`sys.resolveGraph`, INV-2), installs
  a `process` global, and evaluates the graph **in its own worker** — so the script
  is one process (killable as a unit, stdio shared) rather than a subprocess. The
  kernel has no `node` concept; replacing `/bin/node` swaps the whole compat layer.
  Scope today is ESM + `process` (argv/env/cwd/stdout/stderr/exit); CommonJS
  `require` (see `src/node/require-runtime.js`) is not wired in yet.
- **`npm`** (`src/npm/`) — the package manager, installed at `/bin/npm` and run
  from `wsh` (INV-1 — npm is just a program). Commands: `init`, `install [pkg…]`
  (npm-registry packument fetch, semver resolution — `^`/`~`/x-ranges/dist-tags,
  tarball download → in-browser `DecompressionStream` gunzip → untar into
  `<cwd>/node_modules`, transitive deps), `run <script>` (via `sys.exec`), `ls`.
- **WASI Preview 1 host** (`src/wasi/`) — `createWasiImports()` provides the
  `wasi_snapshot_preview1` import module bound to the kernel's `sys` syscalls, so an
  **unmodified `wasm32-wasip1` binary runs as a WorkerOS process** (the program
  worker reads the `.wasm` from the VFS, instantiates it, and calls `_start`).
  stdout/stderr, args, environ, clocks, random, and `proc_exit` work.
  - **Filesystem + blocking reads** work via the synchronous SAB syscall channel
    (see `@opentf/workeros-web` `sync-syscall.js`): `path_open`, `fd_read`,
    `fd_seek`, `fd_readdir`, `fd_close`, `fd_filestat_get`/`path_filestat_get`, and
    `path_create_directory`/`path_unlink_file`/`path_remove_directory`/`path_rename`,
    with a single `/` preopen so wasm resolves absolute paths; kernel errnos map to
    WASI errnos.
  - Verified with real rustc-built `wasm32-wasip1` binaries: reading a VFS file via
    `std::fs` (missing file → WASI `ENOENT`), blocking on `stdin` from a pipe
    (`echo … | prog.wasm`), `read_dir` of a directory, and `Seek`+read.
- **`sh` / `bash`** (`src/sh/`) — run a wsh script: from `-c "…"`, a script-file
  argument (with `$1…` positional params), or piped stdin. Runs it through the
  shell driver via `sys.exec`, so the installer idiom `curl -fsSL … | bash` now has
  a working entrypoint (subject to the wsh subset and the sandbox — no native
  binaries or sockets). Pairs with the expanded wsh interpreter in workeros-web.
- **`grep`** (`/bin/grep`) — a `type: "wasm"` program: the Rust `regex` binary
  from `crates/wsh-grep`, compiled to `wasm32-wasip1` and run through the WASI
  host (real regex, unlike a shell glob). The `.wasm` is gitignored and built by
  `npm run build:wasm` (dev) / the release GH action (publish); `fetchBytes` loads
  it into the VFS at boot.
- **`curl`** (`src/curl/`) — HTTP(S) transfer over the worker's `fetch` (ADR-008),
  streaming the response body through the `sys` ABI. Pairs with the WASI runtime:
  `curl` a wasm binary, then run it.
  - Download/output: `-o/--output` (`-` = stdout), `-O/--remote-name`, `-#` progress
    bar, and streamed writes (no full-response buffering).
  - Request shaping: `-X/--request`, `-H/--header` (repeatable), `-d/--data`,
    `--data-raw`/`--data-binary`/`--data-urlencode` (incl. `@file`), `-F/--form`
    multipart, `-G/--get`, `-T/--upload-file`, `-u/--user` (Basic auth),
    `-b/--cookie`, `-m/--max-time` (abort → exit 28).
  - Response: `-i/--include`, `-I/--head`, `-f/--fail` (exit 22 on ≥400),
    `-w/--write-out` (`%{http_code}`, `%{size_download}`, `%{content_type}`,
    `%{url_effective}`, `%{time_total}`, …), multiple URLs, `-s`/`-S`.
  - Honest about the browser ceiling (INV-5): cross-origin URLs must send CORS;
    forbidden request headers (Host/Cookie/User-Agent/…) are dropped with a warning;
    `-k`/`--compressed`/`-L` are accepted no-ops (the browser owns TLS, encoding,
    and redirect following). No raw sockets or non-HTTP protocols.
- **Node-compatible runtime** (`src/node/`) — the guest Node layer:
  - `process` shim (`argv`/`env`/`stdout`/`stderr`/`exit`).
  - CommonJS runtime (`createNodeRuntime`): a `require()` with relative +
    `node_modules` resolution (`exports`/`main`, `.js`/`.cjs`/`.json` + `index`
    fallbacks), reading files via `sys` and async-prefetching the graph so
    `require` is synchronous. Powers `node index.js` resolving installed packages.

### Notes
- Consolidated from the former `@opentf/workeros-npm` and `@opentf/workeros-node`
  packages so all OS programs and the node runtime live in one place.
- Node compatibility is an ongoing, incremental effort. Dependency dedupe is basic
  (hoist, first-writer-wins); lifecycle scripts and lockfiles are not implemented.

[Unreleased]: https://github.com/opentf/workeros/commits/main
