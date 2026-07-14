// The desktop's theme engine. WorkerOS owns its look independently of the
// website's light/dark toggle: the palette tokens are redefined under `.dt` (see
// the "WorkerOS desktop theme" block in app/global.css), and this module decides
// which set is live by stamping `data-wos-theme` on the desktop root, plus pushes
// optional accent/wallpaper overrides inline. Apps never touch theme directly —
// they render against the resulting palette/`--wos-*` tokens, so re-theming is
// instant and uniform across every window.
//
// State here is the in-memory source of truth; the FS-backed state layer (Pillar
// D) hydrates it from ~/.config/workeros/settings.json on boot and persists
// changes back. Until then it starts from DEFAULTS.

import { reactive } from "@opentf/web";

/** @typedef {"system"|"light"|"dark"} ThemeMode */

const DEFAULTS = {
  /** @type {ThemeMode} */ mode: "system",
  accent: "", // "" = the theme's built-in OTF orange; else a CSS color
  wallpaper: "", // "" = the default desktop gradient; else a CSS <image>/color
};

// Reactive so a Settings window (or anything reading it) re-renders on change.
export const theme = reactive({ ...DEFAULTS });

let rootEl = null;
let mql = null;

/** Resolve the abstract mode to a concrete "light"|"dark" (following the OS
 *  preference when mode is "system"). */
function resolveMode(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return mql && mql.matches ? "dark" : "light";
}

/** Push the current theme onto the desktop root as attribute + inline overrides. */
function paint() {
  if (!rootEl) return;
  rootEl.dataset.wosTheme = resolveMode(theme.mode);
  if (theme.accent) rootEl.style.setProperty("--wos-accent", theme.accent);
  else rootEl.style.removeProperty("--wos-accent");
  if (theme.wallpaper) rootEl.style.setProperty("--wos-wall", theme.wallpaper);
  else rootEl.style.removeProperty("--wos-wall");
}

/**
 * Bind the theme engine to the desktop root element and start following the OS
 * "system" preference. Idempotent-friendly: call from Desktop's onMount; returns
 * a cleanup fn that detaches the media-query listener.
 */
export function attachTheme(el) {
  rootEl = el;
  if (!mql && typeof window !== "undefined" && window.matchMedia) {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
    // Only matters while mode === "system"; harmless to keep bound otherwise.
    mql.addEventListener("change", paint);
  }
  paint();
  return () => {
    if (mql) mql.removeEventListener("change", paint);
    rootEl = null;
  };
}

/** Merge a patch into the theme and repaint. `{ mode?, accent?, wallpaper? }`.
 *  Pillar D persists the result to the FS. */
export function setTheme(patch) {
  Object.assign(theme, patch);
  paint();
}
