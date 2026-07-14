# Changelog — workeros-website

Notable changes to the WorkerOS website + live playground, built with the
[OTF Web](https://web.opentechf.org/) framework. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Private app, unversioned
— see **Unreleased**.

## [Unreleased]

### Added
- **Playground desktop — Phase 3 (part 2): a live Processes monitor.** A new
  Processes app (`ui/apps/ProcessesApp.jsx`) polls the kernel's real process table
  via `os.ps()` and renders PID/PPID/STATE/COMMAND with per-row **SIGTERM/SIGKILL**
  buttons (`ui/apps/ProcRow.jsx`, `os.kill(pid, sig)`). One shared, ref-counted poll
  loop backs every open Processes window (`os/processes.js` reactive store), so the
  table updates live: spawn something in a Terminal and it appears here; kill it and
  it's gone. Verified headlessly (cross-origin isolated) — the table populates,
  a `node -e … &` process launched from a Terminal shows up, and SIGKILL removes it —
  no console errors. (Files, Browser, and Editor still render the placeholder.)
- **Playground desktop — Phase 3 (part 1): the Terminal is real, on the multi-PTY
  kernel.** The desktop now boots the Rust→WASM kernel **once** (a shared singleton,
  `app/playground/os/os.js`) and each Terminal window opens its **own kernel tty**
  via `os.openTerminal()` → an xterm.js screen (`ui/apps/TerminalApp.jsx`). Terminal
  is a **multi-instance** app: launching it from the dock/launcher spawns a fresh,
  fully independent shell every time — open several and they don't share input, cwd,
  or job control (the payoff of the Phase 0 multi-PTY work). Boot is DOM-gated so the
  SSG hydration double-mount can't start two ttys for one window, a ResizeObserver
  keeps the grid fitted through drag/resize/maximize, and closing the window releases
  the tty and disposes xterm. Also lands a real **About** app (`ui/apps/AboutApp.jsx`)
  showing the live kernel version/ABI. Verified end-to-end in headless (cross-origin
  isolated) Chromium: two terminals reach independent `wsh` prompts, `cd /bin; pwd`
  in one doesn't leak into the other, `ps` lists the real process table, About reads
  the booted kernel version, and closing one terminal leaves the other running — no
  console errors. Files, Browser, Editor, and Processes still render the placeholder.
- **Playground desktop — Phase 2: dock, launcher & app registry.** The temporary
  launch bar is now a real **dock** (`app/playground/ui/Dock.jsx`): a launcher
  button, the pinned apps with a **running indicator** dot under any app that has an
  open window (`ui/DockApp.jsx`), a tray of minimized windows, and the clock.
  Clicking a dock app is macOS-like — open it, focus it, minimize it if it's already
  focused, or restore it if minimized (`wm.activateApp`). A full-screen,
  Launchpad-style **launcher overlay** (`ui/Launcher.jsx`, toggled from the dock,
  dismissed by clicking the backdrop or pressing Escape) shows every app in a grid —
  no start menu, no top bar. The **app registry** (`os/apps.js`) grew from a single
  Welcome app to the full set — Terminal, Files, Browser, Editor, Processes, Welcome,
  About — with the not-yet-built ones rendering a shared placeholder body
  (`ui/apps/PlaceholderApp.jsx`, dispatched by `AppView`). Theme-aware; verified
  headlessly in light + dark (launcher open/close/Escape, launch-from-launcher,
  running dots, dock minimize/restore, no horizontal overflow, no console errors).
- **Playground is becoming a desktop OS shell (Phase 1: window manager).** The
  `/playground` route is now a full-viewport desktop instead of a fixed
  terminal+preview split: a reactive window manager (`app/playground/os/wm.js`,
  built on `@opentf/web`'s `reactive()` store) with draggable, resizable windows —
  edge/corner resize, focus-raises-z, minimize/maximize/restore/close, controls on
  the right — plus a bottom dock (launch apps, restore minimized windows, clock).
  Distinct WorkerOS look, theme-aware via the site's `data-theme`. Components:
  `ui/Desktop`, `ui/Window`, `ui/WindowHost`, `ui/AppView`, `ui/DockMin`, and a
  placeholder `ui/apps/WelcomeApp`; the app registry (`os/apps.js`) is metadata-only
  (each app component is a default-exported file dispatched by `AppView`, since the
  compiler turns components into custom elements). `RootLayout` now renders
  `/playground` bare (no marketing nav/footer), like `/docs`. The real apps
  (Terminal on the multi-PTY kernel, Files, Browser, …) land in later phases.
  Verified headlessly: single window on load, drag/resize/maximize/minimize/restore/
  close, opening a window doesn't remount existing ones, light + dark, no overflow.
- **Documentation section (`/docs`)** built with `@opentf/web-docs` — MDX pages
  under `app/docs/**`, a generated sidebar (`_meta.json` ordering), TOC, themed
  callouts, and **Pagefind full-text search** (⌘K). Rendered with the full
  `DocsLayout` (its own navbar + search + footer); `RootLayout` omits the marketing
  shell on `/docs` (a reactive `router.pathname` check) so there's no double navbar.
  Pages: Overview, Getting started, Architecture, The shell (wsh), Programs, and an
  API reference (`boot()`, `WorkerOS`, `Process`). The docs theme is served from
  `public/vendor/web-docs/theme.css` (refreshed from node_modules by
  `tools/sync-runtime.mjs`, since the otfw CSS pipeline doesn't resolve
  node_modules `@import`s). Adds `otfw.config.js` (a `docs` block enables the nav
  generator, search, + `/llms.txt`). Verified end-to-end in headless Chromium:
  sidebar order, callouts, tables, TOC, live search results, and chrome swapping
  correctly on SSG load *and* SPA navigation — no console errors.

### Changed
- **`build` is now an SSG build** (`otfw build --ssg`) — Pagefind search needs
  pre-rendered HTML, so the default build pre-renders every route and indexes it.
  The old SPA build is kept as `build:spa`.
- **The whole site is theme-aware; one navbar spans it.** The landing page gained a
  light palette (`global.css` splits its `--bg/--text/--accent/…` tokens into
  `[data-theme="dark"]` and `[data-theme="light"]` sets; the hero terminal and code
  sample stay dark in both), and `RootLayout` now renders the **same
  `@opentf/web-docs` `<Navbar>`** as the docs (brand, Docs/Playground links, GitHub,
  and the Light/Dark/System `ThemeToggle`) instead of a bespoke marketing nav — so
  the toggle drives light/dark across landing *and* docs. The `index.html` no-flash
  script now resolves the stored/system preference to `data-theme` on first paint
  (was: force-dark). Verified in headless Chromium: single navbar on home and docs,
  correct theme on dark- and light-preference systems, and the toggle choice
  persisting across home↔docs SPA navigation — no console errors.
- **Hero is now a live shell.** The homepage hero was a single centered column
  with a static one-line `quickstart`. It is now a two-column layout: copy on the
  left, and on the right a **real booted WorkerOS terminal** in a window frame —
  the same Rust→WASM kernel + xterm path as the full playground, embedded inline.
  One-click chips (`ls /`, `echo hi | cat`, `ps`, `uname -a`, and a Node one-liner
  `node -p "require('crypto').randomUUID()"`) type commands into the live shell so a
  visitor can try the OS — coreutils, pipes, the process table, and real `node`
  execution — without leaving the landing page.
  Verified end-to-end in headless Chromium (cross-origin isolated; boots to a
  `/ $` prompt; the `ps` chip runs and streams output).
- **Feature grid updated to the current runtime.** Added an *npm + node, for real*
  card (registry tarballs, semver + transitive deps, `node app.js` running
  CJS/ESM) and an *Unmodified WASI binaries* card (stdio/exit + blocking
  VFS/`stdin` over the SharedArrayBuffer syscall channel).
- **Hero lead reworded** — dropped the "language-agnostic" framing and the long
  executable-format explanation for a two-line description; the meta description in
  `index.html` was updated to match.

### Removed
- **Static `quickstart` command line** in the hero — superseded by the live shell.
- **Roadmap / milestone table dropped from the landing page.** The homepage now
  flows hero → what it is → architecture → CTA; the phase-by-phase status lives in
  [`PLAN.md`](../PLAN.md) rather than on the marketing page.

### Added
- **Landing page** (`/`) — hero, feature grid, architecture code sample, and the
  milestone roadmap, in an OTF-flavored dark theme.
- **Playground** (`/playground`) — boots the real Rust→WASM kernel inside a Web
  Worker and drives `wsh` through a **real VT/ANSI terminal** (xterm.js, vendored
  same-origin under `public/vendor/xterm/`). Keystrokes are shipped raw to the
  kernel's TTY device (`os.input`), which owns echo, line editing, `Ctrl-C`/
  `Ctrl-D`, and raw/cooked modes; the page just paints the bytes the kernel
  streams back (`os.onOutput`) and reports window size on resize (`os.resize`).
  Programs run as real, `ps`-visible processes; `clear` and `ps` are handled by
  the kernel-side REPL. (Command history via ↑/↓ is not yet reimplemented on the
  cooked-TTY path.)
- **Runtime sync** (`tools/sync-runtime.mjs`) — mirrors the three WorkerOS runtime
  packages into `public/workeros/` (layout preserved so the workers' relative
  imports resolve); runs before `dev`/`build`.
- **COI service worker** (`public/coi-serviceworker.js`) — injects COOP/COEP so
  `SharedArrayBuffer` works on `otfw dev` and on any static host.
- **Cloudflare Pages deploy** — `public/_headers` sets COOP/COEP + wasm MIME at the
  edge; `public/_redirects` is the SPA fallback. Both are emitted to `dist/` root.
  README documents the local-build + `wrangler pages deploy dist` flow.

### Fixed
- **Copy to the system clipboard works in the playground (OSC 52).** Full-screen
  TUIs like `nano` copy by emitting `ESC ] 52 ; c ; <base64> ST`, but xterm.js
  never touches the system clipboard on its own — and `Ctrl+Shift+C` only copies
  xterm's own text selection, not a TUI's inverse-video region — so a
  select-and-copy silently went nowhere. The playground now registers a
  `parser.registerOscHandler(52, …)` that base64-decodes the payload and writes it
  to `navigator.clipboard` (with a `document.execCommand("copy")` fallback). The
  kernel output runs within the copy keystroke's transient activation window, so
  the write is allowed. Covered by an e2e that pipes nano's exact sequence through
  the vendored xterm and reads the clipboard back (`tools/osc52-clipboard.test.js`).
- **Playground fits the viewport.** The playground is a full-viewport app, not a
  scrolling document, so its layout is now pinned to `100vh` and the marketing
  footer is dropped (both scoped via `.app:has(.pg)` so the landing page keeps its
  normal flow). Crucially `.main` is made a shrinkable flex column
  (`min-height: 0`); without it the default `min-height: auto` let the tall
  terminal balloon the shell past the fold, producing spurious vertical + then
  horizontal scrollbars and an oversized shell. xterm's FitAddon now sizes to a
  real, bounded box — full-screen TUIs like `nano` paint within the viewport.
- **Terminal grid no longer overflows its box.** FitAddon divides the container
  height by xterm's internal cell height, which the DOM renderer rounds up
  per-row — overcounting rows so the last one spilled below the viewport and a
  full-screen TUI's bottom bar (e.g. `nano`'s shortcut keys) was clipped. `refit`
  now re-measures the rendered row height and drops rows until the grid fits, then
  notifies the kernel (`os.resize`) of the corrected size.

[Unreleased]: https://github.com/opentf/workeros/commits/main
