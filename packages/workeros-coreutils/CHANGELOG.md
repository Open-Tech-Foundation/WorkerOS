# Changelog — @opentf/workeros-coreutils

Notable changes to the coreutils — guest programs written against the native
`sys` ABI, which run as real, `ps`-visible, killable processes. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No release cut yet — see
**Unreleased**.

## [Unreleased]

### Added
- Initial coreutils set, installed at **`/sbin`** as **system binaries** (kept apart
  from the `/bin` OS/user programs so they read as untouchable OS internals), each
  executed as a real process:
  - **`echo`**, **`true`**, **`false`**, **`pwd`**, **`env`**
  - **`cat`**, **`ls`**, **`mkdir`**, **`rm`**, **`cp`**, **`mv`**
- Resolved via `PATH` (`/bin:/sbin`), so bare command names still work.
- Written against the kernel's WASI-shaped syscalls (stdio, path ops, args/env),
  so they compose under `wsh` pipes, redirects, and globbing.

[Unreleased]: https://github.com/opentf/workeros/commits/main
