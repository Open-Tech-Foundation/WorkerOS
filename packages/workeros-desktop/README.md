# @opentf/workeros-desktop

The WorkerOS **desktop** — a full-viewport window-manager shell (wallpaper, dock,
launcher, draggable/resizable windows) with apps (Terminal, Files, Editor, Monitor,
Settings, Browser/preview, Welcome) running over the WorkerOS kernel.

It is developed **against the local runtime build** (`@opentf/workeros-web` resolved
through the workspace, i.e. its local `dist/`). This is where the desktop is built up;
once a feature reaches a milestone it graduates to the website's `/playground` for the
public demo. The website itself tracks the *published* packages and stays out of this
loop.

Built with the OTF Web framework (`@opentf/web` + `otfw`), same as the website — so
the code moves over with minimal churn.

## Use

```sh
# from packages/workeros-desktop/
npm run build:runtime   # (re)build the LOCAL WorkerOS runtime the desktop boots
npm run dev             # otfw dev server (prints its URL, ~http://localhost:3001)
```

Open the URL. On first load a service worker (`public/preview-sw.js`) registers and
reloads the page once to grant cross-origin isolation (SharedArrayBuffer), after which
`boot()` succeeds and the Terminal app opens a real shell.

## The iteration loop

`npm run dev` compiles the **desktop UI** (JSX) live with HMR, but it does **not**
rebuild the **kernel/runtime**. After changing runtime source
(`packages/workeros-programs/src`, `packages/workeros-web/src`, coreutils), run
`npm run build:runtime` (→ `build:bundles` + `build:dist` in `workeros-web`), then
reload the browser. Rust changes also need `npm --prefix ../workeros-web run build:wasm`.

| You changed… | Do this |
| --- | --- |
| Desktop UI (`app/**`) | nothing — HMR handles it |
| Runtime JS (`workeros-programs` / `workeros-web` / coreutils `src`) | `npm run build:runtime`, then reload |
| Rust (`crates/**`, wasm) | `build:wasm` in workeros-web, then `build:runtime`, then reload |

## Layout

- `app/page.jsx` → mounts `app/ui/Desktop.jsx` (the whole app is the desktop).
- `app/ui/**` — window manager, dock, launcher, dialogs, and the app windows.
- `app/os/**` — the desktop's own state/logic (kernel connection in `os/os.js`,
  boot sequence, window-manager store, vfs seeding, theme).
- `public/preview-sw.js` — COOP/COEP injection + preview routing (ADR-021).
- `public/vendor/xterm` — xterm.js, vendored same-origin for the Terminal app.

For a lightweight, terminal-only runtime smoke-test (no desktop), see the
repo-root `playground/` app instead.
