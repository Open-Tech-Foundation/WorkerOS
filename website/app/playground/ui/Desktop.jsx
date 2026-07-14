// The desktop root: a full-viewport surface that hosts the window layer, the
// Launchpad-style launcher overlay, and the dock. It owns only layout and a couple
// of global keys — window state lives in the reactive WM store, and each window's
// body comes from the app registry.

import { onMount } from "@opentf/web";
import { wm, openWindow, closeLauncher, activateApp, openLauncher } from "../os/wm.js";
import { seedHome } from "../os/vfs.js";
import { attachTheme, theme, setTheme } from "../os/theme.js";
import { startState } from "../os/state.js";
import { contextMenu } from "../os/menus.js";
import WindowHost from "./WindowHost.jsx";
import Launcher from "./Launcher.jsx";
import Dock from "./Dock.jsx";
import Dialog from "./Dialog.jsx";
import ContextMenu from "./ContextMenu.jsx";
import Toasts from "./Toasts.jsx";

export default function Desktop() {
  onMount(() => {
    // Bind the OS theme engine to the desktop root so WorkerOS controls its own
    // palette/accent/wallpaper (and follows the 'system' preference), independent
    // of the site's light/dark toggle.
    const detachTheme = attachTheme(document.querySelector(".dt"));
    // Seed the home directory early so it exists before Files/Editor open (idempotent).
    seedHome().catch(() => {});
    // Hydrate settings + restore the saved session from the real FS. Only fall back
    // to a fresh Welcome window if nothing was restored; a timeout guards against a
    // slow kernel so the desktop is never left empty. `welcomed` + the length check
    // keep it idempotent under the SSG hydration double-mount.
    let welcomed = false;
    const ensureWelcome = () => {
      if (welcomed || wm.windows.length > 0) return;
      welcomed = true;
      openWindow({ appId: "welcome", title: "Welcome", icon: "👋", w: 520, h: 360 });
    };
    startState().then((n) => { if (n === 0) ensureWelcome(); }).catch(ensureWelcome);
    setTimeout(ensureWelcome, 1800);
    // Escape dismisses the launcher.
    const onKey = (e) => {
      if (e.key === "Escape") closeLauncher();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      detachTheme();
    };
  });

  // The desktop (wall) menu — right-clicking empty space. Built at click time so
  // the Appearance checks reflect the current theme mode.
  const deskMenu = contextMenu(() => [
    { label: "New Terminal", icon: "🖥️", action: () => activateApp("terminal") },
    { label: "Open Files", icon: "🗂️", action: () => activateApp("files") },
    { label: "All Apps…", icon: "▦", action: () => openLauncher() },
    { separator: true },
    {
      label: "Appearance",
      icon: "◐",
      submenu: [
        { label: "System", checked: theme.mode === "system", action: () => setTheme({ mode: "system" }) },
        { label: "Light", checked: theme.mode === "light", action: () => setTheme({ mode: "light" }) },
        { label: "Dark", checked: theme.mode === "dark", action: () => setTheme({ mode: "dark" }) },
      ],
    },
  ]);

  return (
    <div class="dt" oncontextmenu={deskMenu}>
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
      <Dialog />
      <ContextMenu />
      <Toasts />
    </div>
  );
}
