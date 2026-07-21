// Bridges a window id (a stable primitive from the WM list) to the reactive store
// element and renders the window + its app body. Desktop's list maps over ids only
// (so its reactive bindings never close over a per-item local), and the reactive
// element lookup — `wm.windows[i]` returns the store proxy — happens here, keeping
// each window's geometry/state bindings live.

import { wm } from "../os/wm.js";
import Window from "./Window.jsx";
import AppView from "./AppView.jsx";

export default function WindowHost({ winId }) {
  const i = wm.windows.findIndex((w) => w.id === winId);
  const win = i < 0 ? null : wm.windows[i];
  return win ? (
    <Window win={win}>
      <AppView win={win} />
    </Window>
  ) : null;
}
