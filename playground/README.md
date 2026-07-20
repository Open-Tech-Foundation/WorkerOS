# WorkerOS local testing app

A tiny, self-contained app for **verifying local source changes** by booting the OS
in a real browser with an interactive terminal. It loads the **local package
builds** (`@opentf/workeros-web`'s `dist/`, which inlines the programs runtime and
the kernel `.wasm`) — not the published npm releases, and with no dependency on
`website/`.

The website is meant to track the *published* packages; use this app for local
iteration instead.

## Use

```sh
# from playground/
npm run build     # rebuild the local runtime from source (esbuild bundles + dist)
npm run dev       # serve at http://localhost:8099
# or do both:
npm start
```

Open http://localhost:8099 and type in the terminal (e.g. `ls`, `node -e "console.log(1+1)"`,
`npm create next-app@latest my-app -- --skip-install`).

## The iteration loop

`npm run dev` does **not** compile anything — it just serves whatever is currently
built. After editing runtime source you must rebuild, then refresh the browser:

| You changed… | Run before refreshing |
| --- | --- |
| `packages/workeros-programs/src/**` (the `/bin/*` + `/lib/workeros-node/*` guest runtime) | `npm run build` |
| `packages/workeros-web/src/**` (kernel host / workers) | `npm run build` |
| `packages/workeros-coreutils/src/**` | `npm run build` |
| Rust (`crates/**`, kernel wasm, codec, bundler) | `npm run build:wasm` then `npm run build` |

`npm run build` runs `build:bundles` + `build:dist` in `packages/workeros-web`, which
re-inlines the current runtime into the served `dist/`. (`build:wasm` needs the Rust
toolchain and is slower, so it's separate.)

## Notes

- The dev server sets COOP/COEP so `crossOriginIsolated` is true (required for the
  kernel's synchronous syscalls) and sends `Cache-Control: no-store` so a refresh
  always shows the freshest build.
- A crash *before* the shell renders is shown in a red banner (and uncaught
  errors/rejections are surfaced), so a silent boot failure can't hide.
- `window.os` is exposed in the page for poking from devtools:
  `os.netLog()`, `os.trace(...)`, `os.spawn(...)`, etc.
- Change the port with `PORT=9000 npm run dev`.
