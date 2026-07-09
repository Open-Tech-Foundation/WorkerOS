# Changelog — @opentf/workeros-npm

Notable changes to the `npm` guest program for WorkerOS. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- Initial **`npm`** package manager, installed as a guest program at `/bin/npm`
  and run from `wsh` (INV-1 — npm is just a program; the kernel stays
  Node-agnostic). Commands:
  - **`init [-y]`** — scaffold a `package.json` in the cwd.
  - **`install [pkg…]`** (`i`, `add`) — fetch packuments from the npm registry,
    resolve semver (`^`, `~`, `x`-ranges, comparators, dist-tags), download each
    tarball, gunzip it in-browser via `DecompressionStream`, untar into
    `<cwd>/node_modules`, and recurse through dependencies. Writes added packages
    back to `package.json`. (ADR-008 — outbound fetch to the CORS-enabled registry.)
  - **`run <script>`** — execute a `package.json` script via `sys.exec`.
  - **`ls`** — list what's installed in `node_modules`.

### Notes
- Dependency dedupe is basic (hoist, first-writer-wins); lifecycle scripts
  (`postinstall`) and lockfiles are not implemented yet.

[Unreleased]: https://github.com/opentf/workeros/commits/main
