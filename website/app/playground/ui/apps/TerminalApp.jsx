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

export default function TerminalApp({ win }) {
  const domId = "term-" + win.id;

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

      session = await os.openTerminal();
      if (disposed) { session.close(); term.dispose(); return; }

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
    };
  });

  return (
    <div class="app-term">
      <div id={domId} class="app-term-screen" />
    </div>
  );
}
