// A full-screen, Launchpad-style app launcher overlay (no start menu, no top bar).
// The top-level ternary reads `wm.launcherOpen` reactively — same shape as DockMin —
// so toggling the dock's launcher button shows/hides it. Clicking an app opens (or
// focuses) it and dismisses the overlay; clicking the backdrop dismisses it. Escape
// is handled at the desktop level.

import { wm, closeLauncher, activateApp } from "../os/wm.js";
import { isPinned, togglePin } from "../os/dock.js";
import { APP_META } from "../os/apps.js";
import { contextMenu } from "../os/menus.js";

export default function Launcher() {
  const appMenu = (a) => contextMenu(() => [
    { label: isPinned(a.id) ? "Unpin from Dock" : "Pin to Dock", icon: "📌", action: () => togglePin(a.id) },
  ]);
  return wm.launcherOpen ? (
    <div class="dt-launcher" onclick={() => closeLauncher()}>
      <div class="lp-grid" onclick={(e) => e.stopPropagation()}>
        {APP_META.map((a) => (
          <button
            key={a.id}
            class="lp-app"
            onclick={() => {
              activateApp(a.id);
              closeLauncher();
            }}
            oncontextmenu={appMenu(a)}
          >
            <span class="lp-ico">{a.icon}</span>
            <span class="lp-name">{a.name}</span>
          </button>
        ))}
      </div>
    </div>
  ) : null;
}
