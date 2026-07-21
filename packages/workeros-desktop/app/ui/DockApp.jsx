// A pinned dock icon for one app. Clicking activates the app (open / focus /
// minimize / restore — see wm.activateApp). A running indicator dot shows when the
// app has at least one open window. Right-click for a New Window / Unpin menu.

import { wm, activateApp, openApp } from "../os/wm.js";
import { unpin } from "../os/dock.js";
import { appMeta } from "../os/apps.js";
import { contextMenu } from "../os/menus.js";

export default function DockApp({ appId }) {
  const a = appMeta(appId);
  const menu = contextMenu([
    { label: "Open", icon: a.icon, action: () => activateApp(appId) },
    { label: "New Window", icon: "🪟", action: () => openApp(appId) },
    { separator: true },
    { label: "Unpin from Dock", icon: "📌", action: () => unpin(appId) },
  ]);
  return (
    <button
      class={"dock-app" + (wm.windows.some((w) => w.appId === appId) ? " is-running" : "")}
      title={a.name}
      onclick={() => activateApp(appId)}
      oncontextmenu={menu}
    >
      <span class="dock-ico">{a.icon}</span>
    </button>
  );
}
