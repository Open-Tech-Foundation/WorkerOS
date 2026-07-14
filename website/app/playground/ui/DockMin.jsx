// A dock entry for a minimized window (click to restore). Rendered for every window
// but only shows when that window is minimized — reads its state from the store
// proxy so it appears/disappears reactively as windows minimize/restore.

import { wm, restore } from "../os/wm.js";

export default function DockMin({ winId }) {
  const i = wm.windows.findIndex((w) => w.id === winId);
  const win = i < 0 ? null : wm.windows[i];
  return win && win.state === "min" ? (
    <button class="dock-min" title={win.title} onclick={() => restore(win.id)}>
      <span class="dock-ico">{win.icon}</span>
      <span class="dock-min-name">{win.title}</span>
    </button>
  ) : null;
}
