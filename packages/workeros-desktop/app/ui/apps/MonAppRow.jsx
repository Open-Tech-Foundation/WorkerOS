// One row of the System Monitor's app table: a running DE app, its window count and
// live state. Takes only an `appId` and reads the WM store itself, so the row stays
// reactive as its windows open, close, focus and minimize (mutating a field of a
// map-arg element wouldn't re-run the parent's binding).

import { wm, activateApp, openApp, closeWindow } from "../../os/wm.js";
import { appMeta } from "../../os/apps.js";
import { contextMenu } from "../../os/menus.js";

export default function MonAppRow({ appId }) {
  const meta = appMeta(appId);
  const windows = () => wm.windows.filter((w) => w.appId === appId);

  // "Focused" if any of the app's windows holds focus; otherwise it's minimized only
  // when every one of its windows is.
  const status = () => {
    const list = windows();
    if (list.length === 0) return "stopped";
    if (list.some((w) => w.id === wm.focusedId && w.state !== "min")) return "focused";
    if (list.every((w) => w.state === "min")) return "minimized";
    return "running";
  };

  const rowMenu = contextMenu(() => [
    { label: "Focus", icon: meta.icon, action: () => activateApp(appId) },
    { label: "New Window", icon: "🪟", action: () => openApp(appId) },
    { separator: true },
    { label: windows().length > 1 ? "Close All Windows" : "Close", icon: "✕", danger: true,
      action: () => windows().forEach((w) => closeWindow(w.id)) },
  ]);

  return (
    <div class="mon-row" oncontextmenu={rowMenu} ondblclick={() => activateApp(appId)}>
      <span class="mon-app-ico">{meta.icon}</span>
      <span class="mon-app-name">{meta.name}</span>
      <span class="mon-app-wins">{() => String(windows().length)}</span>
      <span class={"mon-app-state st-" + status()}>{() => status()}</span>
      <span class="mon-act">
        <button class="proc-kill" title="Focus this app" onclick={() => activateApp(appId)}>show</button>
        <button class="proc-kill proc-kill9" title="Close every window" onclick={() => windows().forEach((w) => closeWindow(w.id))}>close</button>
      </span>
    </div>
  );
}
