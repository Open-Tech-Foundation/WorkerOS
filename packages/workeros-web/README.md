# @opentf/workeros-web

> An operating system that boots in a Web Worker.

The host runtime for [WorkerOS](https://github.com/opentf/WorkerOS): the
Rust→WASM kernel, its kernel-worker and program-worker shims, and the
main-thread client API. This is the package you install to embed WorkerOS in a
web app — it pulls in the OS programs ([`@opentf/workeros-programs`](https://www.npmjs.com/package/@opentf/workeros-programs))
and coreutils ([`@opentf/workeros-coreutils`](https://www.npmjs.com/package/@opentf/workeros-coreutils))
and installs them into the VFS at boot.

A real kernel runs real processes, where a JS or WASM module — not a native
binary — is the executable format and the host's own JS/WASM engine is the
"CPU". You get a real VFS, POSIX-style coreutils, and bash-like scripting
(`wsh`).

## Install

```sh
npm install @opentf/workeros-web
```

## Usage

```js
import { boot } from "@opentf/workeros-web";

// Boot the Rust→WASM kernel inside a Web Worker.
const os = await boot();

// The VFS is real: write a file, then run a program against it.
await os.fs.write("/hello.txt", "from the WorkerOS VFS\n");

// wsh: pipes, &&, redirects, glob — all executed by the kernel.
await os.exec("cat /hello.txt | cat && ls /sbin", {
  onStdout: (bytes) => screen.write(bytes),
});

// Processes are real — inspect the live process table.
const procs = await os.ps();
```

### An interactive terminal

```js
import { boot } from "@opentf/workeros-web";

const os = await boot();
const term = os.terminal({ onStdout: (bytes) => screen.write(bytes) });

term.write("node -e 'console.log(1 + 1)'\n");
```

## Exports

| Import | What it is |
| --- | --- |
| `boot()` | Boot the kernel in a Web Worker; resolves to a `WorkerOS` instance. |
| `WorkerOS` | The client handle: `fs`, `exec()`, `ps()`, `terminal()`, `trace()`. |
| `Process` | A handle to a running process (stdio, exit). |
| `TerminalSession` | A TTY-backed session that reaches nested foreground processes. |
| `RingBuffer`, `allocRingBuffer`, `HEADER_LEN` | The `SharedArrayBuffer` ring used for sync syscalls. |
| `installPreviewBridge`, `previewPath` | Serve a guest dir over an in-page HTTP preview (dev servers, static apps). |

## Cross-origin isolation (required)

WorkerOS uses `SharedArrayBuffer` for synchronous syscalls, so the page **must**
be cross-origin isolated. Serve your app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers `SharedArrayBuffer` is unavailable and `boot()` will fail.

## Bundler notes

The package ships self-contained ESM in `dist/`. The kernel `.wasm`, program
bundles, and the npm tarball are emitted as assets referenced via
`new URL(..., import.meta.url)` — the static form Vite/esbuild/webpack recognise
and copy into your build output automatically. No manual asset wiring or
sibling-tree serving is required.

## License

Apache-2.0. See the [repository NOTICE](https://github.com/opentf/WorkerOS/blob/main/NOTICE)
for attribution details.
