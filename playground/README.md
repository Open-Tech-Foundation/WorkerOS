# WorkerOS playground

The local **host app** for running and iterating on the WorkerOS desktop. It mounts
the `@opentf/workeros-desktop` package (imported, not copied) and boots it against the
**local runtime build** (`@opentf/workeros-web` via the workspace). This is where you
run the desktop while developing it; the desktop UI itself lives in
`packages/workeros-desktop`.

It's a tiny OTF Web (`otfw`) app: `app/page.jsx` is just
`import { Desktop } from "@opentf/workeros-desktop"` → `<Desktop />`. otfw compiles the
package's JSX the same way it compiles `@opentf/web-docs`.

## Use

```sh
# from playground/
npm run build:runtime   # (re)build the LOCAL WorkerOS runtime the desktop boots
npm run dev             # otfw dev server (prints its URL, ~http://localhost:3000)
```

Open the URL. On first load a service worker (`public/preview-sw.js`) registers and
reloads the page once to grant cross-origin isolation (SharedArrayBuffer), after which
`boot()` succeeds and the desktop comes up (open the Terminal from the dock for a shell).

## The iteration loop

- **Desktop UI** (`packages/workeros-desktop/app/**`): edit there — `otfw dev` here
  HMR-recompiles it live (it's imported, so changes flow through). No rebuild.
- **Kernel/runtime** (`packages/workeros-programs/src`, `packages/workeros-web/src`,
  coreutils): `npm run dev` does **not** rebuild these. Run `npm run build:runtime`
  (→ `build:bundles` + `build:dist` in `workeros-web`), then reload the browser.
- **Rust** (`crates/**`, wasm): `npm run build:wasm`, then `npm run build:runtime`,
  then reload.

## Layout

- `app/page.jsx` — mounts `<Desktop />` from `@opentf/workeros-desktop`.
- `app/layout.jsx` — bare, full-viewport.
- `app/global.css` — a **symlink** to the desktop package's stylesheet (otfw can't
  bundle CSS imported from JS, so it's linked from `index.html` and served at `/app/`;
  the symlink keeps it live with the package instead of a copy).
- `public/` — `preview-sw.js` (COOP/COEP + preview routing), vendored xterm, headers.
- `index.html` — theme bootstrap + service-worker registration + the `global.css` link.

The desktop can also run standalone from `packages/workeros-desktop` (`npm run dev`);
this app exists so the desktop is driven from one place against the local runtime.
