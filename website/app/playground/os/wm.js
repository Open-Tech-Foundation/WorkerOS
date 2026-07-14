// The desktop window manager: a single reactive store of open windows plus the
// operations the UI drives (open/close/focus/move/resize/minimize/maximize). It is
// pure front-end state — no kernel knowledge — so the WM and the apps that fill the
// windows evolve independently.
//
// `reactive()` gives a deep store: a component's `wm.windows.map(...)` subscribes to
// *structure* (a window opening/closing), while each Window subscribes to its own
// element's fields (x/y/w/h/z/state). So dragging one window re-renders only that
// window, never the whole desktop.

import { reactive } from "@opentf/web";
import { appMeta } from "./apps.js";

/** @typedef {"normal"|"min"|"max"} WinState */

export const wm = reactive({
  /** @type {Array<{id:number, appId:string, title:string, icon:string,
   *   x:number, y:number, w:number, h:number, z:number, state:WinState,
   *   prev:{x:number,y:number,w:number,h:number}|null, props:object}>} */
  windows: [],
  focusedId: null,
  topZ: 10,
  launcherOpen: false,
});

let nextId = 1;
let cascade = 0;

// Reactive element by id (via index, so the returned object is the store proxy —
// mutating it propagates). `null` if the window is gone.
function win(id) {
  const i = wm.windows.findIndex((w) => w.id === id);
  return i < 0 ? null : wm.windows[i];
}

// Where to place the next window: a stepped cascade from a base offset, wrapped so
// it never marches off-screen. Sizes/positions are viewport-independent (px); the
// Desktop clamps within its bounds on drag.
function nextPlacement(w, h) {
  const step = 28;
  const n = cascade++ % 6;
  return { x: 80 + n * step, y: 64 + n * step, w, h };
}

/**
 * Open a window for an app. `spec`: { appId, title, icon?, w?, h?, x?, y?, props? }.
 * Returns the new window id. Focus goes to the new window.
 */
export function openWindow(spec) {
  const id = nextId++;
  const w = spec.w || 640;
  const h = spec.h || 420;
  const place = nextPlacement(w, h);
  wm.windows.push({
    id,
    appId: spec.appId,
    title: spec.title || spec.appId,
    icon: spec.icon || "▪",
    x: spec.x ?? place.x,
    y: spec.y ?? place.y,
    w,
    h,
    z: ++wm.topZ,
    state: "normal",
    prev: null,
    props: spec.props || {},
  });
  wm.focusedId = id;
  return id;
}

export function closeWindow(id) {
  const i = wm.windows.findIndex((w) => w.id === id);
  if (i < 0) return;
  wm.windows.splice(i, 1);
  if (wm.focusedId === id) {
    // Focus falls to the top-most remaining window.
    let top = null;
    for (const w of wm.windows) if (!top || w.z > top.z) top = w;
    wm.focusedId = top ? top.id : null;
  }
}

/** Raise a window to the top and mark it focused. No-op if already on top. */
export function focusWindow(id) {
  const w = win(id);
  if (!w) return;
  if (wm.focusedId !== id) wm.focusedId = id;
  if (w.z !== wm.topZ) w.z = ++wm.topZ;
}

export function moveWindow(id, x, y) {
  const w = win(id);
  if (!w) return;
  w.x = x;
  w.y = y;
}

export function resizeWindow(id, width, height) {
  const w = win(id);
  if (!w) return;
  w.w = Math.max(240, width);
  w.h = Math.max(140, height);
}

/** Minimize (hide to the dock). Keeps geometry; the dock restores it. */
export function minimize(id) {
  const w = win(id);
  if (!w) return;
  w.state = w.state === "min" ? "normal" : "min";
  if (w.state === "min" && wm.focusedId === id) {
    let top = null;
    for (const o of wm.windows) if (o.state !== "min" && (!top || o.z > top.z)) top = o;
    wm.focusedId = top ? top.id : null;
  }
}

/** Toggle maximize: fill the desktop, remembering the pre-max geometry to restore. */
export function toggleMax(id) {
  const w = win(id);
  if (!w) return;
  if (w.state === "max") {
    if (w.prev) { w.x = w.prev.x; w.y = w.prev.y; w.w = w.prev.w; w.h = w.prev.h; }
    w.state = "normal";
    w.prev = null;
  } else {
    w.prev = { x: w.x, y: w.y, w: w.w, h: w.h };
    w.state = "max";
  }
  focusWindow(id);
}

/** Restore a minimized window (from the dock) and focus it. */
export function restore(id) {
  const w = win(id);
  if (!w) return;
  if (w.state === "min") w.state = "normal";
  focusWindow(id);
}

/* ---------- launcher ---------- */
export function toggleLauncher() { wm.launcherOpen = !wm.launcherOpen; }
export function openLauncher() { wm.launcherOpen = true; }
export function closeLauncher() { if (wm.launcherOpen) wm.launcherOpen = false; }

/**
 * Dock/launcher click behavior for an app (macOS-like): open it if it has no
 * window; restore it if its top-most window is minimized; minimize it if that
 * window is already focused; otherwise raise/focus it. New windows use the app's
 * default geometry from the registry.
 */
export function activateApp(appId) {
  const a = appMeta(appId);
  const list = wm.windows.filter((w) => w.appId === appId);
  // Multi-instance apps (e.g. Terminal) always spawn a fresh window — that's how you
  // get several independent shells. Single-instance apps open once, then toggle.
  if (a.multi || list.length === 0) {
    openWindow({ appId: a.id, title: a.name, icon: a.icon, w: a.w, h: a.h });
    return;
  }
  let top = null;
  for (const w of list) if (!top || w.z > top.z) top = w;
  if (top.state === "min") { restore(top.id); return; }
  if (wm.focusedId === top.id) { minimize(top.id); return; }
  focusWindow(top.id);
}

/** True if the app has at least one open window (for a dock running indicator). */
export function appIsRunning(appId) {
  return wm.windows.some((w) => w.appId === appId);
}
