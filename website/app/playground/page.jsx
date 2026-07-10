// The live WorkerOS playground: boots the real Rust→WASM kernel inside a Web
// Worker and drives `wsh` through a real terminal.
//
// The display is xterm.js (a full VT/ANSI emulator), vendored same-origin under
// /vendor/xterm/. The *line discipline* — echo, editing, raw/cooked modes, ^C —
// lives in the kernel's TTY device, not here: xterm just ships raw keystrokes to
// `os.input()` and paints whatever bytes the kernel streams back via `onOutput`.
// So this page is a dumb glass teletype; the OS owns the terminal semantics.
//
// The kernel runtime is served (unbundled) from /workeros/... by the sync step
// (tools/sync-runtime.mjs → public/). We load it with a hidden dynamic import so
// the site bundler leaves the worker/wasm graph untouched, and rely on the single
// WorkerOS service worker (public/preview-sw.js) for both the cross-origin
// isolation SharedArrayBuffer needs (ADR-010) and preview routing (ADR-021).

const RUNTIME_URL = "/workeros/packages/workeros-web/src/index.js";
// Hidden from the bundler's static analysis — resolved purely at runtime.
const loadRuntime = new Function("u", "return import(u)");

// Load a same-origin UMD script once; resolves when the global is installed.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

// Last-resort clipboard write for when navigator.clipboard is unavailable or
// rejects (older/insecure contexts): a throwaway textarea + execCommand("copy").
function copyFallback(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    /* nothing more we can do */
  }
}

export default function Playground() {
  let status = $state("booting");
  let statusText = $state("booting kernel…");
  // The preview iframe src ("/__preview__/<port>/"), set when the user opens a
  // port a guest is serving on (ADR-021). Empty until then.
  let previewSrc = $state("");

  // Point the preview iframe at the port in the toolbar input. The cache-bust
  // param forces a reload even when the same port is re-opened (the Reload button).
  const openPreview = () => {
    const input = document.getElementById("preview-port");
    const port = parseInt((input && input.value) || "0", 10);
    if (port) previewSrc = `/__preview__/${port}/?t=${Date.now()}`;
  };

  // Refit the terminal to its container. Assigned once the kernel has booted and
  // the xterm instance exists; a no-op before then.
  let refit = () => {};

  // The framework's onResize observes this component's *root* element (`.pg`),
  // whose size is fixed by the viewport — not by `fit()`, which only resizes the
  // xterm canvas inside `#term-screen`. Observing the stable root (instead of the
  // element fit() mutates) is what avoids the ResizeObserver feedback loop.
  onResize(() => refit());

  onMount(() => {
    let os = null;
    let term = null;

    (async () => {
      try {
        // 1. Bring in the terminal emulator (vendored, same-origin — CSP-safe).
        loadCss("/vendor/xterm/xterm.css");
        await loadScript("/vendor/xterm/xterm.js");
        await loadScript("/vendor/xterm/addon-fit.js");

        // 2. Boot the real kernel.
        if (!window.crossOriginIsolated) {
          statusText = "waiting for cross-origin isolation…";
        }
        const { boot, installPreviewBridge } = await loadRuntime(RUNTIME_URL);
        os = await boot();
        // Bridge the service worker's preview requests to the kernel injector, so
        // a guest `http.createServer(...).listen(port)` is reachable at
        // /__preview__/<port>/ in the iframe below (ADR-021).
        installPreviewBridge(os);

        // 3. Wire up xterm ⇆ the kernel TTY.
        const el = document.getElementById("term-screen");
        term = new window.Terminal({
          convertEol: false, // the kernel line discipline already emits CRLF
          cursorBlink: true,
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
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

        // Keystrokes → kernel line discipline; kernel output → the screen.
        os.onOutput((bytes) => term.write(bytes));
        term.onData((data) => os.input(data));

        // OSC 52 → system clipboard. TUIs like nano copy by emitting
        // `ESC ] 52 ; c ; <base64> ST`; xterm.js doesn't touch the clipboard on
        // its own (and Ctrl+Shift+C only copies xterm's own text selection, not a
        // TUI's inverse-video region), so bridge it to navigator.clipboard here.
        // The kernel output runs shortly after the keypress that triggered the
        // copy, so transient user activation is still valid. Returning true marks
        // the sequence handled.
        term.parser.registerOscHandler(52, (payload) => {
          const semi = payload.indexOf(";"); // strip the `c;` selection prefix
          const b64 = semi >= 0 ? payload.slice(semi + 1) : payload;
          if (!b64 || b64 === "?") return true; // empty or a (read) query — ignore
          let text;
          try {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            text = new TextDecoder().decode(arr);
          } catch {
            return true; // malformed base64 — swallow the sequence anyway
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => copyFallback(text));
          } else {
            copyFallback(text);
          }
          return true;
        });

        // Keep the kernel's winsize in step with the rendered geometry. Only
        // re-notify the kernel when rows/cols actually change (a pixel resize that
        // doesn't cross a cell boundary needs no SIGWINCH). Driven by the
        // framework's `onResize` hook above (which owns the ResizeObserver).
        let lastRows = 0;
        let lastCols = 0;
        refit = () => {
          try {
            fit.fit();
            // FitAddon sizes the grid by dividing the container height by xterm's
            // internal cell height — which the DOM renderer then rounds *up*
            // per-row. That overcounts rows, so the last one spills below the
            // viewport and a full-screen TUI's bottom bar (e.g. nano's shortcut
            // keys) gets clipped. Re-measure the rendered row height and drop rows
            // until the grid actually fits its box.
            const rowsEl = el.querySelector(".xterm-rows");
            const firstRow = rowsEl && rowsEl.firstElementChild;
            const box = el.querySelector(".xterm");
            if (firstRow && box) {
              const cellH = firstRow.getBoundingClientRect().height;
              const avail = box.clientHeight;
              let rows = term.rows;
              while (rows > 1 && rows * cellH > avail + 1) rows--;
              if (rows !== term.rows) term.resize(term.cols, rows);
            }
            if (term.rows !== lastRows || term.cols !== lastCols) {
              lastRows = term.rows;
              lastCols = term.cols;
              os.resize(term.rows, term.cols);
            }
          } catch {}
        };
        refit();

        // 4. Start the interactive shell REPL and hand focus to the terminal.
        status = "ready";
        statusText = `${os.version} · wsh`;
        term.focus();
        os.startTerminal();

      } catch (err) {
        status = "error";
        statusText = "boot failed";
        const msg = `boot failed: ${err?.message ?? err}\r\n`;
        if (term) term.write(msg);
        else {
          const el = document.getElementById("term-screen");
          if (el) el.textContent = msg;
        }
        if (!window.crossOriginIsolated) {
          const note =
            "This browser is not cross-origin isolated, so SharedArrayBuffer is " +
            "unavailable. Reload; if it persists, the COI service worker could not " +
            "register (needs a secure context).\r\n";
          if (term) term.write(note);
        }
      }
    })();
  });

  return (
    <div class="pg">
      <div class="pg-head">
        <h1>
          <span class="brand-mark">W</span> WorkerOS Playground
        </h1>
        <span class="sub">real kernel · real TTY · booted in your browser</span>
        <span class="nav-spacer" style="flex:1" />
        <span class={`pg-status ${status}`}>
          <span class="dot" /> {statusText}
        </span>
      </div>

      <div class="pg-body">
        <div class="terminal">
          <div id="term-screen" class="term-screen" />
        </div>

        <div class="preview-pane">
          <div class="preview-bar">
            <span class="preview-label">Preview</span>
            <span class="preview-addr">
              localhost:
              <input
                id="preview-port"
                class="preview-input"
                type="number"
                placeholder="5173"
                value="5173"
              />
            </span>
            <button class="chip" onclick={() => openPreview()}>
              Open
            </button>
            <button class="chip" onclick={() => openPreview()}>
              Reload
            </button>
            <span class="preview-url">{previewSrc ? previewSrc.split("?")[0] : ""}</span>
          </div>
          {previewSrc ? (
            <iframe class="preview-frame" src={previewSrc} title="preview" />
          ) : (
            <div class="preview-empty">
              <p>Run a server in the terminal, then open its port here.</p>
              <pre>node -e "require('http').createServer((q,r)=&gt;r.end('&lt;h1&gt;hello from WorkerOS&lt;/h1&gt;')).listen(5173)"</pre>
              <p class="preview-empty-hint">
                Then set the port to <b>5173</b> and click <b>Open</b>. HMR/WebSocket
                isn't wired yet — plain HTTP responses render.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
