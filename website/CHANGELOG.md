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
  Worker and drives `wsh`: the terminal accepts commands and executes them on
  Enter, streaming stdout/stderr from real, `ps`-visible processes; includes
  command history (↑/↓), `clear`, and clickable examples.
- **Runtime sync** (`tools/sync-runtime.mjs`) — mirrors the three WorkerOS runtime
  packages into `public/workeros/` (layout preserved so the workers' relative
  imports resolve); runs before `dev`/`build`.
- **COI service worker** (`public/coi-serviceworker.js`) — injects COOP/COEP so
  `SharedArrayBuffer` works on `otfw dev` and on any static host.
- **Cloudflare Pages deploy** — `public/_headers` sets COOP/COEP + wasm MIME at the
  edge; `public/_redirects` is the SPA fallback. Both are emitted to `dist/` root.
  README documents the local-build + `wrangler pages deploy dist` flow.

[Unreleased]: https://github.com/opentf/workeros/commits/main
