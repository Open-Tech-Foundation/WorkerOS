// Boot the LOCAL build and wire an xterm terminal to it. Kept as a separate module
// (not inline in index.html) because the dev server rewrites bare imports only in
// served .js/.mjs — so `@opentf/workeros-web` below is rewritten to the workspace
// package's dist/ (which inlines the programs runtime + kernel wasm). That makes
// this app boot exactly what a consumer of the published package would.
import { boot } from "@opentf/workeros-web";

const hdr = document.getElementById("hdr");
const statusEl = document.getElementById("status");
const banner = document.getElementById("banner");
const setStatus = (t) => (statusEl.textContent = t);
const fail = (msg) => {
  hdr.classList.remove("ready");
  hdr.classList.add("failed");
  setStatus("boot failed");
  banner.style.display = "block";
  banner.textContent = msg;
};

// Surface a pre-shell crash (the class of bug this app exists to catch).
window.addEventListener("error", (e) => fail("Uncaught: " + (e.message || e)));
window.addEventListener("unhandledrejection", (e) =>
  fail("Unhandled rejection: " + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));

(async () => {
  try {
    if (!window.crossOriginIsolated) setStatus("waiting for isolation…");
    const os = await boot();
    window.os = os; // handy for poking from the devtools console

    const term = new window.Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: "#0b0c0f", foreground: "#d7dbe4", cursor: "#7c9cff",
        selectionBackground: "#2a3350" },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById("term"));
    fit.fit();

    os.onOutput((bytes) => term.write(bytes));
    term.onData((data) => os.input(data));

    let lastRows = 0, lastCols = 0;
    const refit = () => {
      try {
        fit.fit();
        if (term.rows !== lastRows || term.cols !== lastCols) {
          lastRows = term.rows; lastCols = term.cols;
          os.resize(term.rows, term.cols);
        }
      } catch {}
    };
    refit();
    new ResizeObserver(refit).observe(document.getElementById("term-wrap"));

    hdr.classList.add("ready");
    setStatus(`${os.version || "ready"} · wsh`);
    os.startTerminal();
    term.focus();
  } catch (err) {
    fail(String((err && (err.stack || err.message)) || err));
  }
})();
