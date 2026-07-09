# WorkerOS website + playground

The marketing site and the **live playground**, built with the
[OTF Web](https://web.opentechf.org/) framework (`@opentf/web` + the `otfw` CLI).

- **`/`** — landing page.
- **`/playground`** — boots the **real** Rust→WASM kernel inside a Web Worker and
  drives `wsh`. The terminal accepts commands and executes them on Enter, streaming
  stdout/stderr from real, `ps`-visible processes.

## How the playground boots a real OS

The kernel runtime lives in `../packages/{workeros-web,workeros-node,workeros-coreutils}`.
Those worker files import each other with relative paths, so `tools/sync-runtime.mjs`
mirrors the `packages/<pkg>/src/...` layout verbatim into `public/workeros/` (served
same-origin). The playground loads it with a runtime-only dynamic import, so the site
bundler never touches the worker/wasm graph.

WorkerOS needs `SharedArrayBuffer`, which requires cross-origin isolation (COOP/COEP).
`otfw dev` (and most static hosts) don't set those headers, so `public/coi-serviceworker.js`
injects them client-side — the page becomes `crossOriginIsolated` on any host.

## Develop

The kernel wasm must be built first (the sync step checks for it):

```sh
cd ../packages/workeros-web && npm install && npm run build:wasm
```

Then, from this directory:

```sh
bun install          # or npm install
bun run dev          # syncs the runtime, then starts otfw dev on :3000
bun run build        # static production bundle in dist/
bun run build:ssg    # pre-render the marketing pages
```

`dev`/`build`/`serve` all run `tools/sync-runtime.mjs` first, so the playground always
serves the current kernel.

## Note

On `otfw dev` the wasm is served without an `application/wasm` MIME type, so
wasm-bindgen logs one warning and falls back to `WebAssembly.instantiate` — harmless.
