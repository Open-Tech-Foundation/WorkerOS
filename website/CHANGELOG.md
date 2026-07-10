# Changelog — workeros-website

Notable changes to the WorkerOS website + live playground, built with the
[OTF Web](https://web.opentechf.org/) framework. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Private app, unversioned
— see **Unreleased**.

## [Unreleased]

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
