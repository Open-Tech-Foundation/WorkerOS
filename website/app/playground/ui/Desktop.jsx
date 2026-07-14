// The desktop root: a full-viewport surface that hosts the window layer, the
// Launchpad-style launcher overlay, and the dock. It owns only layout and a couple
// of global keys — window state lives in the reactive WM store, and each window's
// body comes from the app registry.

import { onMount } from "@opentf/web";
import { wm, openWindow, closeLauncher } from "../os/wm.js";
import WindowHost from "./WindowHost.jsx";
import Launcher from "./Launcher.jsx";
import Dock from "./Dock.jsx";

export default function Desktop() {
  onMount(() => {
    // Open a welcome window so the desktop isn't empty on first load. Guarded so a
    // repeated mount (SSG hydration) doesn't seed a second copy.
    if (wm.windows.length === 0) {
      openWindow({ appId: "welcome", title: "Welcome", icon: "👋", w: 520, h: 360 });
    }
    // Escape dismisses the launcher.
    const onKey = (e) => {
      if (e.key === "Escape") closeLauncher();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div class="dt">
      <div class="dt-wall" />

      {/* Window layer. `.map` subscribes to structure only, so opening/closing a
          window re-runs this — dragging one window does not. Each element is read
          back through the store proxy (`wm.windows[i]`) inside WindowHost so it
          stays reactive. */}
      <div class="dt-layer">
        {wm.windows.map((w) => (
          <WindowHost winId={w.id} />
        ))}
      </div>

      <Launcher />
      <Dock />
    </div>
  );
}
