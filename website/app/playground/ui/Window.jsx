// A draggable, resizable window frame. `win` is a reactive store element (see
// os/wm.js) — reading its fields subscribes this frame, mutating them (via the WM
// actions) re-renders only this window. Chrome is a distinct WorkerOS look: a
// title bar with the app icon + title on the left and the window controls
// (minimize / maximize / close) on the right. Content is passed as children.

import { wm, focusWindow, closeWindow, moveWindow, resizeWindow, minimize, toggleMax } from "../os/wm.js";

// Drag/resize share this: track the pointer on `window` until release, so a fast
// drag that outruns the element still follows.
function trackPointer(onMove) {
  const move = (e) => onMove(e);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export default function Window({ win, children }) {
  const startDrag = (e) => {
    if (win.state === "max") return; // a maximized window isn't draggable
    focusWindow(win.id);
    const ox = e.clientX - win.x;
    const oy = e.clientY - win.y;
    e.preventDefault();
    trackPointer((ev) => {
      // Keep the title bar reachable: clamp so it can't be dragged fully off-screen.
      const x = Math.min(Math.max(ev.clientX - ox, -win.w + 80), window.innerWidth - 80);
      const y = Math.min(Math.max(ev.clientY - oy, 0), window.innerHeight - 40);
      moveWindow(win.id, x, y);
    });
  };

  // `dir` is a set of edges: "e","w","s","n" or corners "se","sw","ne","nw".
  const startResize = (dir) => (e) => {
    if (win.state === "max") return;
    focusWindow(win.id);
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const x = win.x, y = win.y, w = win.w, h = win.h;
    trackPointer((ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let nx = x, ny = y, nw = w, nh = h;
      if (dir.includes("e")) nw = w + dx;
      if (dir.includes("s")) nh = h + dy;
      if (dir.includes("w")) { nw = w - dx; nx = x + dx; }
      if (dir.includes("n")) { nh = h - dy; ny = y + dy; }
      // Honor the min size when dragging a top/left edge (don't let the origin
      // overshoot once the box hits its minimum).
      if (nw < 240) { if (dir.includes("w")) nx = x + (w - 240); nw = 240; }
      if (nh < 140) { if (dir.includes("n")) ny = y + (h - 140); nh = 140; }
      moveWindow(win.id, nx, ny);
      resizeWindow(win.id, nw, nh);
    });
  };

  const stop = (e) => e.stopPropagation();

  return (
    <section
      class={
        "win" +
        (win.state === "max" ? " is-max" : "") +
        (win.state === "min" ? " is-min" : "") +
        (wm.focusedId === win.id ? " is-focused" : "")
      }
      // A maximized window is positioned by CSS (inset:0); inline geometry only
      // when floating, so it never fights the maximized layout.
      style={
        win.state === "max"
          ? `z-index:${win.z}`
          : `left:${win.x}px;top:${win.y}px;width:${win.w}px;height:${win.h}px;z-index:${win.z}`
      }
      onpointerdown={() => focusWindow(win.id)}
    >
      <header class="win-bar" onpointerdown={startDrag} ondblclick={() => toggleMax(win.id)}>
        <span class="win-title">
          <span class="win-ico">{win.icon}</span>
          <span class="win-name">{win.title}</span>
        </span>
        <span class="win-ctrls">
          <button class="win-btn win-min" title="Minimize" onpointerdown={stop} onclick={() => minimize(win.id)}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.4" width="8" height="1.2" rx="0.6" /></svg>
          </button>
          <button class="win-btn win-max" title="Maximize" onpointerdown={stop} onclick={() => toggleMax(win.id)}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
          </button>
          <button class="win-btn win-close" title="Close" onpointerdown={stop} onclick={() => closeWindow(win.id)}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
          </button>
        </span>
      </header>

      <div class="win-body">{children}</div>

      {/* Resize handles (hidden while maximized via CSS). */}
      <i class="rz rz-n" onpointerdown={startResize("n")} />
      <i class="rz rz-s" onpointerdown={startResize("s")} />
      <i class="rz rz-e" onpointerdown={startResize("e")} />
      <i class="rz rz-w" onpointerdown={startResize("w")} />
      <i class="rz rz-ne" onpointerdown={startResize("ne")} />
      <i class="rz rz-nw" onpointerdown={startResize("nw")} />
      <i class="rz rz-se" onpointerdown={startResize("se")} />
      <i class="rz rz-sw" onpointerdown={startResize("sw")} />
    </section>
  );
}
