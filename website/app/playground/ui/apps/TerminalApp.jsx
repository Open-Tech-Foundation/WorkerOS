// A real terminal window: an xterm.js screen driven by its own kernel tty
// (`os.openTerminal()` → TerminalSession, from the multi-PTY foundation). Each
// Terminal window gets an independent shell — open two and they don't share input,
// cwd, or job control. The screen id is keyed by the window id.
//
// Boot is DOM-gated (a `data-booted` flag on the screen element) so the SSG
// hydration double-mount can't spin up two xterms/ttys for one window, and a
// ResizeObserver keeps the grid fitted as the window is dragged, resized, or
// maximized.

import { onMount } from "@opentf/web";
import { getOS, ensureXterm } from "../../os/os.js";
import { contextMenu } from "../../os/menus.js";
import { activateApp } from "../../os/wm.js";

export default function TerminalApp({ win }) {
  const domId = "term-" + win.id;
  // Lifted so the right-click menu (built at render time) can reach the live
  // xterm + tty session created inside onMount.
  let termRef = null;
  let sessionRef = null;

  // Every window carries the same context menu; the Terminal's is Copy/Paste/Clear
  // plus a shortcut to spawn another shell. Built at click time so Copy disables
  // when there's no selection.
  const termMenu = contextMenu(() => {
    const sel = termRef ? termRef.getSelection() : "";
    return [
      { label: "Copy", icon: "⧉", disabled: !sel, action: () => navigator.clipboard?.writeText(sel).catch(() => {}) },
      { label: "Paste", icon: "📋", action: async () => { try { const t = await navigator.clipboard.readText(); if (sessionRef && t) sessionRef.input(t); } catch {} } },
      { label: "Clear", icon: "␡", action: () => termRef && termRef.clear() },
      { separator: true },
      { label: "New Terminal", icon: "🖥️", action: () => activateApp("terminal") },
    ];
  });

  onMount(() => {
    let disposed = false;
    let session = null;
    let term = null;
    let ro = null;
    let offOutput = null;

    (async () => {
      await ensureXterm();
      const os = await getOS();
      if (disposed) return;

      const el = document.getElementById(domId);
      if (!el || el.dataset.booted) return; // gone, or a phantom double-mount
      el.dataset.booted = "1";

      term = new window.Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        theme: {
          background: "#0b0c0f",
          foreground: "#d7dbe4",
          cursor: "#7c9cff",
          selectionBackground: "#2a3350",
        },
      });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      termRef = term;

      session = await os.openTerminal();
      if (disposed) { session.close(); term.dispose(); return; }
      sessionRef = session;

      offOutput = session.onOutput((bytes) => term.write(bytes));
      term.onData((data) => session.input(data));

      let lastRows = 0;
      let lastCols = 0;
      const refit = () => {
        try {
          fit.fit();
          if (term.rows !== lastRows || term.cols !== lastCols) {
            lastRows = term.rows;
            lastCols = term.cols;
            session.resize(term.rows, term.cols);
          }
        } catch {}
      };
      refit();
      session.start();

      // Keep the grid fitted as the window frame resizes.
      ro = new ResizeObserver(() => refit());
      ro.observe(el);
      term.focus();
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      if (offOutput) offOutput();
      if (session) session.close();
      if (term) term.dispose();
      termRef = null;
      sessionRef = null;
    };
  });

  return (
    <div class="app-term" oncontextmenu={termMenu}>
      <div id={domId} class="app-term-screen" />
    </div>
  );
}
