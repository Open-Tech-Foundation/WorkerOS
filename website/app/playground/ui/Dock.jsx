// The dock: a launcher button, the pinned apps (with running indicators), a tray of
// minimized windows, and a clock. No start menu, no top bar — the launcher button
// opens a full-screen Launchpad-style overlay (see Launcher.jsx). The dock owns the
// clock so the desktop stays pure layout.

import { onMount } from "@opentf/web";
import { wm, toggleLauncher } from "../os/wm.js";
import { dockState } from "../os/dock.js";
import DockApp from "./DockApp.jsx";
import DockMin from "./DockMin.jsx";

export default function Dock() {
  let clock = $state(nowLabel());

  onMount(() => {
    const t = setInterval(() => (clock = nowLabel()), 1000);
    return () => clearInterval(t);
  });

  return (
    <div class="dt-dock">
      <button
        class={"dock-launch" + (wm.launcherOpen ? " is-open" : "")}
        title="Apps"
        aria-label="Open app launcher"
        onclick={() => toggleLauncher()}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="2" width="6.5" height="6.5" rx="2" />
          <rect x="11.5" y="2" width="6.5" height="6.5" rx="2" />
          <rect x="2" y="11.5" width="6.5" height="6.5" rx="2" />
          <rect x="11.5" y="11.5" width="6.5" height="6.5" rx="2" />
        </svg>
      </button>

      <span class="dock-sep" />

      <div class="dt-dock-apps">
        {dockState.pinned.map((id) => (
          <DockApp key={id} appId={id} />
        ))}
      </div>

      {/* Minimized windows (any app) — click a chip to restore. */}
      <div class="dt-dock-mins">
        {wm.windows.map((w) => (
          <DockMin key={w.id} winId={w.id} />
        ))}
      </div>

      <span class="dt-clock">{clock}</span>
    </div>
  );
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
