// A pinned dock icon for one app. Clicking activates the app (open / focus /
// minimize / restore — see wm.activateApp). A running indicator dot shows when the
// app has at least one open window; the `wm.windows.some(...)` read is inlined in
// the class binding so it stays reactive as windows open and close.

import { wm, activateApp } from "../os/wm.js";
import { appMeta } from "../os/apps.js";

export default function DockApp({ appId }) {
  const a = appMeta(appId);
  return (
    <button
      class={"dock-app" + (wm.windows.some((w) => w.appId === appId) ? " is-running" : "")}
      title={a.name}
      onclick={() => activateApp(appId)}
    >
      <span class="dock-ico">{a.icon}</span>
    </button>
  );
}
