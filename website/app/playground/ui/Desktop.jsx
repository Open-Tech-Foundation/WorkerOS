// The desktop root: a full-viewport surface that hosts the window layer and (in
// later phases) the dock + launcher. It owns nothing but layout — the window state
// lives in the reactive WM store, and each window's body comes from the app
// registry. A clock/version sits in a corner; a temporary launch bar seeds windows
// until the real dock lands in Phase 2.

import { onMount } from "@opentf/web";
import { wm, openWindow } from "../os/wm.js";
import { APP_META } from "../os/apps.js";
import WindowHost from "./WindowHost.jsx";
import DockMin from "./DockMin.jsx";

export default function Desktop() {
  let clock = $state(nowLabel());

  onMount(() => {
    // Open a welcome window so the desktop isn't empty on first load. Guarded so a
    // repeated mount (hydration) doesn't seed a second copy.
    if (wm.windows.length === 0) {
      openWindow({ appId: "welcome", title: "Welcome", icon: "👋", w: 520, h: 360 });
    }
    const t = setInterval(() => (clock = nowLabel()), 1000);
    return () => clearInterval(t);
  });

  return (
    <div class="dt">
      <div class="dt-wall" />

      {/* Window layer. `.map` subscribes to structure only, so opening/closing a
          window re-runs this — dragging one window does not. Each element is read
          back through the store proxy (`wm.windows[i]`) so it stays reactive. */}
      <div class="dt-layer">
        {wm.windows.map((w) => (
          <WindowHost winId={w.id} />
        ))}
      </div>

      {/* Temporary launch bar (a real dock replaces this in Phase 2): opens apps and
          restores minimized windows. */}
      <div class="dt-dock">
        <div class="dt-dock-apps">
          {APP_META.map((a) => (
            <button class="dock-app" title={a.name} onclick={() => openWindow({ appId: a.id, title: a.name, icon: a.icon, w: a.w, h: a.h })}>
              <span class="dock-ico">{a.icon}</span>
            </button>
          ))}
        </div>
        <div class="dt-dock-mins">
          {wm.windows.map((w) => (
            <DockMin winId={w.id} />
          ))}
        </div>
        <div class="dt-clock">{clock}</div>
      </div>
    </div>
  );
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
