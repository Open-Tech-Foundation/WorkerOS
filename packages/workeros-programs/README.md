# @opentf/workeros-programs

> The OS-supplied programs for [WorkerOS](https://github.com/opentf/WorkerOS) —
> the `/bin` tools plus the Node-compatible guest runtime.

WorkerOS is composed of separable pieces, one per concern:

| Package | Concern |
| --- | --- |
| [`@opentf/workeros-web`](https://www.npmjs.com/package/@opentf/workeros-web) | The kernel + host runtime — the machine and its host API. |
| [`@opentf/workeros-coreutils`](https://www.npmjs.com/package/@opentf/workeros-coreutils) | The base OS utilities (`/sbin`), shipped with the kernel. |
| **`@opentf/workeros-programs`** | **The OS-supplied programs (`/bin`) — `node`, `npm`, editors, archivers, …** |

This package is the program set: a registry of every program that isn't a base
system utility, each carrying the bytes to install into the VFS and the metadata
the kernel needs to run it. A host installs these programs into a running OS —
today `@opentf/workeros-web` ships a default set and installs it at boot; a
selectable, on-demand install manifest (an OS command / host API) is the
direction this registry is shaped for.

## Install

```sh
npm install @opentf/workeros-programs
```

## What's inside

**Programs** installed to `/bin`:

| | |
| --- | --- |
| `node`, `npm`, `npx` | The Node-compatible runtime and the **real** npm CLI (vendored), running against the WorkerOS syscall ABI. |
| `sh`, `bash` | `wsh`, the bash-like shell: pipes, `&&`/`\|\|`, redirects, glob. |
| `curl` | HTTP over the host `fetch`. |
| `grep` | A Rust `wasm32-wasip1` program. |
| `gzip`, `gunzip`, `zcat`, `tar`, `zip`, `unzip` | Archive and compression tools. |
| `nano` | A terminal text editor. |

**Guest runtime**, imported by name via subpath exports:

| Import | What it is |
| --- | --- |
| `@opentf/workeros-programs` | `{ programs, libraries }` — the VFS install manifest; each entry is `{ bin, type, source() }`. |
| `@opentf/workeros-programs/node/process-shim` | The Node `process` shim + CommonJS `require`, incl. `ProcessExit`. |
| `@opentf/workeros-programs/wasi` | `createWasiImports` — the WASI host for `wasm32-wasip1` guest programs. |

`/bin/node` runs `.js`/`.mjs`/`.cjs` **and** TypeScript (`.ts`/`.mts`/`.cts`/`.tsx`)
directly via oxc. `/bin/npm` is the real upstream npm CLI, and installs from the
registry work end to end (outbound HTTPS rides the host `fetch`).

## Usage

The manifest is the install API — a host iterates it to place programs into the
VFS. This is exactly what the kernel worker does at boot, and what an on-demand
installer would do for a selected subset:

```js
import { programs, libraries } from "@opentf/workeros-programs";

for (const p of programs) {
  const bytes = await p.source(); // string for js, ArrayBuffer for wasm
  vfs.install(p.bin, bytes, { type: p.type });
}
```

## Packaging

`dist/index.js` is self-contained: program/library text is inlined as strings,
and wasm images + the npm tarball are emitted under `dist/assets/` and referenced
with `new URL(..., import.meta.url)` so a downstream bundler ships them with your
app. No runtime `import.meta.url` fetch of a source tree is required.

## License

Apache-2.0. See the [repository NOTICE](https://github.com/opentf/WorkerOS/blob/main/NOTICE)
for attribution details, including the vendored npm CLI.
