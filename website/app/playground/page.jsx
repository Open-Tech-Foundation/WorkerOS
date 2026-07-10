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
// the site bundler leaves the worker/wasm graph untouched, and rely on the COI
// service worker (public/coi-serviceworker.js) for the cross-origin isolation
// SharedArrayBuffer needs.

const RUNTIME_URL = "/workeros/packages/workeros-web/src/index.js";
// Hidden from the bundler's static analysis — resolved purely at runtime.
const loadRuntime = new Function("u", "return import(u)");

const EXAMPLES = [
  "ls /sbin",
  "echo hello | cat",
  "mkdir -p a/b && ls a",
  "echo hi > /f.txt && cat /f.txt",
  "env",
  "pwd",
  "ps",
];

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

export default function Playground() {
  let status = $state("booting");
  let statusText = $state("booting kernel…");

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
        const { boot } = await loadRuntime(RUNTIME_URL);
        os = await boot();

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

        // Keep the kernel's winsize in step with the rendered geometry. Only
        // re-notify the kernel when rows/cols actually change (a pixel resize that
        // doesn't cross a cell boundary needs no SIGWINCH). Driven by the
        // framework's `onResize` hook above (which owns the ResizeObserver).
        let lastRows = 0;
        let lastCols = 0;
        refit = () => {
          try {
            fit.fit();
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

        // Clicking a chip "types" the command and runs it via the same input path.
        window.__pgRun = (line) => {
          if (!os) return;
          term.focus();
          os.input(line + "\r");
        };
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

        <aside class="pg-side">
          <h4>Try a command</h4>
          <div class="cmd-list">
            {EXAMPLES.map((c) => (
              <span class="chip" onclick={() => window.__pgRun(c)}>
                {c}
              </span>
            ))}
          </div>
          <h4>Built-in coreutils</h4>
          <p class="hint">
            <code>echo cat ls cp mv rm mkdir pwd env true false</code> — each runs as
            a real, <code>ps</code>-visible process.
          </p>
          <h4>Terminal</h4>
          <p class="hint">
            A real VT/ANSI terminal over a kernel TTY: line editing (Backspace,{" "}
            <code>Ctrl-U</code>/<code>Ctrl-W</code>), <code>Ctrl-C</code> to
            interrupt, <code>Ctrl-D</code> EOF, and <code>clear</code>. Pipes{" "}
            <code>|</code>, redirects <code>&gt;</code>, <code>&amp;&amp;</code>{" "}
            <code>||</code> <code>;</code>, glob, background <code>&amp;</code>, and{" "}
            <code>cd</code>.
          </p>
        </aside>
      </div>
    </div>
  );
}
