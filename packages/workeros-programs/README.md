# @opentf/workeros-programs

> The installable `/bin` programs for [WorkerOS](https://github.com/opentf/WorkerOS),
> plus its Node-compatible guest runtime.

This is a **content package**: one registry of every WorkerOS program that isn't
a core system utility (those live in
[`@opentf/workeros-coreutils`](https://www.npmjs.com/package/@opentf/workeros-coreutils)).
The kernel worker installs the whole registry into the VFS at boot. Most users
never import this directly — it's a dependency of
[`@opentf/workeros-web`](https://www.npmjs.com/package/@opentf/workeros-web),
which is what you install to run WorkerOS.

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

You normally consume this transitively through `@opentf/workeros-web`. If you're
building your own host, the manifest is the entry point:

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
