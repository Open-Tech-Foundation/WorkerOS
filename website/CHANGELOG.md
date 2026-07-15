# Changelog — workeros-website

Notable changes to the WorkerOS website + live playground, built with the
[OTF Web](https://web.opentechf.org/) framework. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Private app, unversioned
— see **Unreleased**.

## [Unreleased]

### Added
- **Browser — a tabbed browser for servers running inside the OS.** An address like
  `localhost:3000` is a real process in WorkerOS listening on a port; there is no
  network. The service worker turns a fetch into raw HTTP/1.1 bytes, the page-side
  bridge relays them to the kernel injector, and the tab renders what the in-OS
  server wrote to the socket (ADR-021). Tabs each keep their own live frame (a
  background tab isn't reloaded or lost), plus back / forward / reload, an address
  bar that accepts `3000`, `localhost:3000/path` or `http://localhost:3000`, page
  titles picked up from the loaded document, and right-click menus on both tabs and
  the page. Unserved ports and non-OS addresses get a themed explanation instead of
  raw 502 text. Verified headlessly against two real in-OS Node servers (17 checks)
  — no console errors.
  **Not sandboxed, and that's a real gap.** A `sandbox` without `allow-same-origin`
  gives the frame an opaque origin, and a cross-origin-isolated page refuses to embed
  one at all (`CoepFrameResourceNeedsCoepHeader`) — verified across every sandbox
  combination: the frame renders only when `allow-same-origin` is present, which would
  be theatre, since the page then keeps our origin and can strip the attribute off
  itself. The isolation can't be dropped either — the kernel needs `SharedArrayBuffer`.
  Real containment needs previews served from a **separate origin** (a bootstrap client
  + service worker there, relaying cross-origin to the desktop). Until then a served
  page is same-origin with the desktop.
- **System Monitor — everything the OS is running, in one window.** The desktop's
  apps (window count + live state: focused / running / minimized, with Focus / New
  Window / Close All on right-click) above the kernel's real process table (PID /
  PPID / STATE / COMMAND, with SIGTERM / SIGKILL). Both halves update live and carry
  the same right-click affordances as the rest of the DE. Verified headlessly
  (11 checks) — no console errors.
  **No CPU/RAM columns:** the kernel doesn't account for them — `ps` reports pid /
  ppid / pgid / argv / cwd / state, and its `start_time` field is never fed a clock,
  so there's no honest per-process CPU, memory or uptime to show yet. Those columns
  need kernel-side accounting first; a made-up number in a system monitor is worse
  than an absent one.
- **Settings rebuilt as a real control panel — sidebar + content.** Two panes: a
  sidebar of sections on the left (Appearance / Storage / About), the selected
  section's content on the right, instead of one long scroll. **About this system**
  is now a Settings section rather than its own app — system info belongs in the
  control panel, so the About app is gone. Verified headlessly (11 checks) — no
  console errors.
- **A boot splash — the OS shows you it's starting.** Booting the kernel (worker +
  wasm) and reading the session back off the FS takes a moment, and the playground
  spent it as a blank white page. Startup is now an explicit staged pipeline
  (`os/boot.js`: kernel → filesystem → session) that publishes progress, and the
  splash paints on the first frame with the real stage it's on, then fades out to
  reveal a desktop that's already live. A stage that fails is reported but doesn't
  block boot. Verified headlessly (8 checks) — no console errors.
- **App-modal dialogs — a dialog belongs to its window, not the whole OS.** New file,
  rename, delete, and the Editor's Save As now raise a sheet scoped to the app window
  that asked for it: the dialog service takes a `winId`, raises that window, and the
  backdrop covers only that window's rect, so every other window on the desktop stays
  live. Escape now cancels from anywhere (a confirm/alert has no input to hold focus).
- **Dock context menu — pin/unpin apps.** Right-click a dock app for Open / New Window
  / Unpin from Dock; right-click any app in the launcher to pin or unpin it. Dock pins
  live in the real FS alongside the theme (`~/.config/workeros/settings.json`).
- **Context menus everywhere — every window carries its own.** Completed the
  right-click story across all apps so it's a universal DE affordance: **Terminal**
  (Copy / Paste / Clear / New Terminal, Copy disabled without a selection) and
  **Processes** (a row → Terminate/Force-kill; empty area → Refresh), joining the
  desktop, window title bar, Files, and Editor tabs — all through the one shared menu
  service. Verified headlessly (4 checks) — no console errors.
- **Editor rebuilt with tabs (multi-file) + a reusable tab-strip widget.** The Editor
  now holds several files at once: each tab is a buffer (path / name / content / dirty),
  one shared textarea shows the active tab (buffers are preserved across switches), `+`
  adds a tab, a per-tab close button and right-click **Close / Close Others** menu, and
  a dirty dot that clears on save. The tab strip uses shared `.tabs`/`.tab` styles that
  other apps can reuse. Verified headlessly (8 checks): dirty tracking, per-tab buffer
  preservation on switch, save→FS→reopen round-trip, and tab close — no console errors.
- **UI toolkit — toast notifications.** A DE-wide toast service (`os/notify.js` +
  `ui/Toasts.jsx`) so apps can report a non-modal outcome (`notify` / `notifySuccess`
  / `notifyError`) instead of a blocking dialog — a bottom-right stack above the dock
  that auto-dismisses or clears on click, themed by kind (info/success/error). Wired
  into Settings (“snapshot saved”) and Files (delete confirmation). Verified headlessly
  (3 checks) — no console errors.
- **Settings app — the OS control panel over the toolkit.** A real Settings app
  (`ui/apps/SettingsApp.jsx`, pinned to the dock) that drives the theme engine and
  FS-backed state directly: **Appearance** (theme mode System/Light/Dark, an accent
  swatch row, and wallpaper presets that reference the live tokens so they adapt to
  theme + accent), **Storage** (force a durable FS snapshot; shows where settings and
  session live on disk), and **About** (live kernel version / ABI). Every change
  repaints the desktop instantly and is persisted by the state layer — no save button.
  Verified headlessly (8 checks): accent/theme/wallpaper apply live with correct active
  states, and About reads the booted kernel — no console errors.
- **UI toolkit — Pillar D: system state persisted in the real filesystem.** Because
  this is a real OS, the desktop's state lives on the durable kernel FS (ADR-022), not
  in `localStorage` — the Terminal sees the same files. `os/state.js` hydrates on boot
  and writes changes back (debounced): **settings** — theme mode / accent / wallpaper —
  to `~/.config/workeros/settings.json`, and the **session** — every open window and
  its geometry — to `~/.local/state/workeros/session.json`. On load the desktop paints
  in the saved theme and **restores the windows that were open** (the default Welcome
  window only appears when there's nothing to restore); a timeout guards a slow kernel
  so the desktop is never left empty. Verified headlessly (6 checks): open Terminal +
  Files, switch to Light, reload — theme and all three windows come back from disk with
  no duplicate Welcome, no console errors.
- **UI toolkit — Pillar C (part 1): window reliability + per-app context menus.**
  The window manager gained a **dock-aware work area** so windows behave predictably:
  maximizing now reserves the dock strip (the dock stays visible and clickable), and
  dragging clamps the title bar above it instead of letting a window hide behind the
  dock or leave the screen. Stacking z-indexes **renormalize** before they can climb
  past the dock/overlay layers, so a long session can't push a window on top of the
  dock. And the shared context-menu service now reaches into apps: **Files** has
  right-click menus (empty area → New Folder / New File / Refresh; a row → Open /
  Rename / Delete, which also selects the row) — same menu widget as the desktop and
  window chrome, but with the app's own in-instance actions, which is the pattern
  every app will follow. Verified headlessly (7 checks) — no console errors.
- **UI toolkit — Pillar B (menus): one context-menu system for the whole DE.** A
  shared, data-driven menu service (`os/menus.js`) rendered once at the desktop
  level (`ui/ContextMenu.jsx`), so a right-click behaves identically on the desktop,
  a window title bar, or inside any app — no app rolls its own. Menu items are plain
  data (`{ label, icon?, action?, danger?, disabled?, checked?, separator?, submenu? }`),
  keeping UI out of app code (per the framework's no-component-values rule). The menu
  positions at the cursor and **clamps/flips inside the viewport**, dismisses on
  outside-click / Escape / scroll / blur, and supports **cascading submenus** (a
  sibling menu, not a nested list — a nested reactive list trips the list reconciler;
  rows are homogeneous `<button>`s for the same reason). Wired up two standard menus:
  the **window title-bar menu** (Minimize/Maximize/Close, labels tracking state) on
  every window regardless of app, and the **desktop menu** (New Terminal, Open Files,
  All Apps…, and an **Appearance** submenu that drives the theme engine). Verified
  headlessly (12 checks): open on desktop + title bar, submenu hover + theme switch,
  Close action, edge clamp, and all three dismiss paths — no console errors.
- **UI toolkit — Pillar A: an OS-owned theme engine.** First piece of the WorkerOS
  UI toolkit (a GTK/Qt-analog layer so every app inherits the same chrome, menus,
  focus, and theme). The desktop now owns its own palette independent of the
  website's light/dark toggle: the palette tokens are redefined scoped to `.dt`
  (keyed by `data-wos-theme`), so re-theming cascades to every window without
  touching per-app CSS. `os/theme.js` stamps `data-wos-theme` (light|dark, resolved
  from a `system` setting via `prefers-color-scheme`) on the desktop root and pushes
  optional **accent** and **wallpaper** overrides inline (`--wos-accent` /
  `--wos-wall`); accent-soft/glow derive from the accent so one custom color recolors
  the whole desktop. Wired into `ui/Desktop.jsx` (`attachTheme`). Verified headlessly
  (9 checks): system→dark/light flips live, palette + accent resolve per theme, a
  custom accent overrides and reverts — no console errors.
- **Desktop environment foundations + a real file manager.** The playground is
  becoming a proper WorkerOS DE, not a set of demo widgets. This lands the shared
  groundwork: a **home directory** (`/root` with `Desktop`/`Documents`/`Downloads`,
  seeded once on boot — the same tree the Terminal sees), a promise-based **modal
  dialog service** (`os/dialogs.js` + `ui/Dialog.jsx`: themed `confirm`/`prompt`/
  `alert`, replacing blocking `window.*`), a **VFS helper** (`os/vfs.js`: `~`-aware
  paths, `HOME`, seeding), and the kernel client now truly **boots once** for the
  whole desktop (`getOS()` caches on `globalThis`, so every app shares one kernel —
  previously the bundler could hand some apps their own). The **Files** app is
  rebuilt as a file manager: navigate (up / home / into folders), and real
  operations — **new folder, new file, rename, delete** (recursive) — via the client
  fs API and dialogs, with selection + an item count. Double-clicking a file opens it
  in the Editor. Verified headlessly: home seeds, create/rename/delete round-trip,
  navigation, and the Terminal sees the same `/root` — no console errors.
- **Playground desktop — Phase 3 (part 3): a Files browser.** A new Files app
  (`ui/apps/FilesApp.jsx`) browses the real VFS via the new `os.fs.list(path)`:
  directories sort first, clicking a folder navigates in, an up button climbs to the
  parent, and clicking a text file previews it with `os.fs.read` (binary files are
  detected and summarized rather than dumped). Each window keeps its own cwd in a
  component-local reactive store. Verified headlessly: root lists the VFS with its
  directories, a file created from a Terminal appears and previews its real content,
  and folder navigation + the up button update the path — no console errors.
  (Browser and Editor still render the placeholder.)
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

### Removed
- **The Processes app** — the System Monitor covers the same kernel process table
  (plus the app list) with the same per-row SIGTERM/SIGKILL, so keeping a second dock
  icon for a subset of it was just clutter. Its shared pieces (`ProcRow`,
  `os/processes.js`, the `.proc-*` table styles) stay where the monitor uses them.

### Fixed
- **"Nothing is listening on that port" while your server was running.** Each tab boots
  its own kernel, and the service worker — shared by the whole origin — was picking an
  arbitrary tab to route a preview request through. With a second playground tab open
  it routinely picked the wrong one, so the request hit a kernel with nothing on that
  port. The preview URL now names the OS instance
  (`/__preview__/<osId>/<port>/…`, see the workeros-web changelog) and only that tab's
  bridge answers. This also closes the leak in the other direction: a tab could
  previously load a *different* tab's server.
- **Window text couldn't be selected or copied.** The desktop set `user-select: none`
  on its root so dragging chrome wouldn't smear a selection, which also killed
  selection of the content inside every window. Window bodies are selectable again;
  chrome (title bars, dock, tabs, toolbars, sidebars, table headers) still isn't. The
  Terminal is unaffected — xterm draws its own selection and always had Copy.
- **The Browser no longer refuses an address.** `google.com` and friends are handed to
  the frame instead of being rejected as "not an address in this OS"; deciding what you
  may visit isn't the browser's job. There's no outbound network yet, so they won't
  load until a proxy lands — but the browser tries. A new tab is now blank rather than
  showing a start page.
- **The preview bridge was never installed on the desktop.** The service worker has
  been intercepting `/__preview__/<port>/…` all along, but nothing on the rebuilt
  playground relayed those requests into the kernel injector, so every one 502'd with
  "no app page to route through". `getOS()` now installs the bridge on boot — which is
  what makes the Browser app able to load anything.
- **Saved state could resurrect a removed app.** The dock pins and session windows are
  restored from the real FS, so an app deleted since (the old About/Processes) came back
  as a dead icon or a placeholder window. Hydration now drops app ids the registry
  doesn't know.
- **Closing a window closed a different one.** The window list rendered without a
  `key`, so the framework's list reconciler fell back to index keys: removing a middle
  window made every later window's node shift up, and the DOM dropped the wrong one —
  the same identity bug behind unreliable focus/minimize/restore. Every list that
  mutates (windows, dock, tabs, files, processes, toasts, launcher) is now keyed by a
  stable id.
- **The desktop defaults to dark.** It followed the system preference, which read as a
  flash of white on a light host; dark is the OS default and Settings still offers
  System/Light/Dark.
- **Clicking a running app in the dock opens a new window.** It now activates the
  running one — raise it, restore it if minimized, or minimize it if already focused —
  matching a real dock. "New Window" is still available from the dock's right-click.
- **The window minimize button was invisible in dark mode.** Its icon had no `fill`, so
  it painted black on the dark title bar; it uses `currentColor` like the other controls.
- **The Editor's path bar is gone.** The typed path field and Open button were a
  stand-in for a file chooser; the toolbar now shows the active file's location read-only,
  and saving an untitled buffer asks for a path. A native file dialog lands later. Full-screen
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
