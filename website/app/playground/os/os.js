// The desktop's single connection to the WorkerOS kernel. The kernel boots exactly
// once (module-level promise) and is shared by every app window — a Terminal window
// opens its own tty via `os.openTerminal()`, the About box reads `os.version`, and
// later apps (Files, Processes, …) use the same instance. The singleton also makes
// boot idempotent under SSG hydration double-mounts (module state persists across
// the phantom remount).
//
// The runtime is served unbundled from /workeros/... by tools/sync-runtime.mjs; a
// hidden dynamic import keeps the site bundler from touching the worker/wasm graph
// (same trick as app/page.jsx).

const RUNTIME_URL = "/workeros/packages/workeros-web/src/index.js";
const loadRuntime = new Function("u", "return import(u)");

// The singletons live on `globalThis`, not module scope: the OTF Web compiler emits
// each app component as its own custom-element module, and the bundler can duplicate
// a shared import (this file) across those chunks — a module-level `let` would then
// give each app its OWN kernel. A global cache guarantees exactly one kernel (and one
// xterm load) shared by every window.

/** Boot (or reuse) the one shared kernel. Resolves with the `WorkerOS` client. */
export function getOS() {
  if (!globalThis.__wosOS) {
    globalThis.__wosOS = (async () => {
      const { boot } = await loadRuntime(RUNTIME_URL);
      return boot();
    })();
  }
  return globalThis.__wosOS;
}

// ---- xterm.js (vendored same-origin under /vendor/xterm/) ----

/** Load xterm.js + the fit addon + its CSS once. Resolves when `window.Terminal`
 *  is available. Only terminal windows need this, so it's separate from getOS(). */
export function ensureXterm() {
  if (!globalThis.__wosXterm) {
    globalThis.__wosXterm = (async () => {
      loadCss("/vendor/xterm/xterm.css");
      await loadScript("/vendor/xterm/xterm.js");
      await loadScript("/vendor/xterm/addon-fit.js");
    })();
  }
  return globalThis.__wosXterm;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}
