// System state persisted in the REAL kernel filesystem — this is a real OS, so the
// desktop's settings and session live on disk (durable via ADR-022), not in
// localStorage. The Terminal sees these same files:
//
//   ~/.config/workeros/settings.json      — theme (mode / accent / wallpaper)
//   ~/.local/state/workeros/session.json  — open windows + geometry
//
// On boot we hydrate the theme (so the desktop paints in the saved look) and
// restore the open windows, then bind reactive effects that write changes back,
// debounced. All fs access goes through the one shared kernel client (os.fs.*).

import { effect, snapshot } from "@opentf/web";
import { getOS } from "./os.js";
import { theme, setTheme } from "./theme.js";
import { wm, openWindow } from "./wm.js";
import { dockState } from "./dock.js";
import { APP_META } from "./apps.js";

/** Saved state can name an app that no longer exists (one removed since it was
 *  written, e.g. the old About/Processes apps). Drop those rather than restore a
 *  dead dock icon or a placeholder window. */
const isKnownApp = (id) => APP_META.some((a) => a.id === id);

const CONFIG_DIR = "/root/.config/workeros";
const STATE_DIR = "/root/.local/state/workeros";
const SETTINGS_PATH = CONFIG_DIR + "/settings.json";
const SESSION_PATH = STATE_DIR + "/session.json";

async function readJSON(path) {
  try {
    const os = await getOS();
    const data = await os.fs.read(path); // Uint8Array, or throws if missing
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    return JSON.parse(text);
  } catch {
    return null; // missing/corrupt → treat as no saved state
  }
}

async function writeJSON(path, dir, obj) {
  try {
    const os = await getOS();
    await os.fs.mkdir(dir); // mkdir -p
    await os.fs.write(path, JSON.stringify(obj, null, 2));
  } catch {
    // Best-effort: a failed persist must never break the desktop.
  }
}

// Coalesce bursty changes (a drag fires many geometry writes) into one fs write.
const timers = {};
function schedule(key, fn, ms = 400) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

let started = false;

/**
 * Hydrate settings + session from disk, then start persisting changes. Returns the
 * number of windows restored (so the desktop knows whether to open its default
 * Welcome window). Idempotent.
 */
export async function startState() {
  if (started) return 0;
  started = true;

  const settings = await readJSON(SETTINGS_PATH);
  if (settings && settings.theme) setTheme(settings.theme);
  if (settings && Array.isArray(settings.dock)) dockState.pinned = settings.dock.filter(isKnownApp);

  let restored = 0;
  const session = await readJSON(SESSION_PATH);
  if (session && Array.isArray(session.windows) && wm.windows.length === 0) {
    for (const w of session.windows) {
      if (!isKnownApp(w.appId)) continue;
      openWindow({
        appId: w.appId,
        title: w.title,
        icon: w.icon,
        x: w.x, y: w.y, w: w.w, h: w.h,
        props: w.props || {},
      });
      restored++;
    }
  }

  bindPersistence();
  return restored;
}

function bindPersistence() {
  // Settings: persist theme + dock pins whenever they change.
  effect(() => {
    const t = { mode: theme.mode, accent: theme.accent, wallpaper: theme.wallpaper };
    const dock = dockState.pinned.slice();
    schedule("settings", () => writeJSON(SETTINGS_PATH, CONFIG_DIR, { theme: t, dock }));
  });

  // Session: persist the set of open windows + their geometry. Reading each field
  // inside the map subscribes the effect, so opening/closing/moving/resizing a
  // window reschedules a write. Minimized/maximized windows persist their FLOATING
  // geometry (state is intentionally not restored across reloads yet).
  effect(() => {
    const windows = wm.windows.map((w) => ({
      appId: w.appId,
      title: w.title,
      icon: w.icon,
      x: w.x, y: w.y, w: w.w, h: w.h,
      props: snapshot(w.props),
    }));
    schedule("session", () => writeJSON(SESSION_PATH, STATE_DIR, { windows }));
  });
}
