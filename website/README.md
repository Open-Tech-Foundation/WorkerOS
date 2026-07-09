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

## Deploy to Cloudflare Pages

The site is a static bundle, and the playground gets its cross-origin isolation
from `public/coi-serviceworker.js`, so it runs on Cloudflare Pages with no server.
`public/_headers` additionally sets COOP/COEP at the edge (isolation on the first
load, no service-worker reload) and `public/_redirects` is the SPA fallback — both
are copied to `dist/` root, where Pages reads them.

**Recommended — build locally, upload the output** (the kernel `.wasm` is built by
the Rust/wasm-pack toolchain, which the Pages build image doesn't have):

```sh
# from repo root, once: build the kernel wasm
cd packages/workeros-web && npm install && npm run build:wasm

# then build + deploy the site
cd ../../website
bun run build                       # → website/dist (runs the runtime sync first)
npx wrangler pages deploy dist      # first run prompts to create/log in to a Pages project
```

**Git-connected Pages build** is also possible but only if the kernel wasm is
available at build time — either commit `packages/workeros-web/src/kernel-wasm/`
(currently git-ignored) or install Rust + `wasm-pack` in the Pages build command.
Set the build command to `npm run build`, output directory to `dist`, and root
directory to `website`.

## Note

On `otfw dev` the wasm is served without an `application/wasm` MIME type, so
wasm-bindgen logs one warning and falls back to `WebAssembly.instantiate` — harmless.
