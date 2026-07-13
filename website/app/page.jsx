import { Link } from "@opentf/web";

// The kernel runtime is served (unbundled) from /workeros/... by the sync step
// (tools/sync-runtime.mjs → public/). Load it with a hidden dynamic import so the
// site bundler leaves the worker/wasm graph untouched. Same approach as the
// full playground (app/playground/page.jsx), reused here to boot a live shell in
// the hero.
const RUNTIME_URL = "/workeros/packages/workeros-web/src/index.js";
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

export default function Home() {
  let statusText = $state("booting…");

  // Captured after boot so the command chips can drive the same shell.
  let osRef = null;
  let termRef = null;

  // Type a command into the live shell (chip click). `\r` submits it.
  const runCmd = (cmd) => {
    if (!osRef) return;
    if (termRef) termRef.focus();
    osRef.input(cmd + "\r");
  };

  // Refit the terminal to its container; a no-op until the kernel has booted.
  let refit = () => {};
  onResize(() => refit());

  onMount(() => {
    let os = null;
    let term = null;

    (async () => {
      try {
        loadCss("/vendor/xterm/xterm.css");
        await loadScript("/vendor/xterm/xterm.js");
        await loadScript("/vendor/xterm/addon-fit.js");

        if (!window.crossOriginIsolated) statusText = "waiting for isolation…";
        const { boot } = await loadRuntime(RUNTIME_URL);
        os = await boot();
        osRef = os;

        const el = document.getElementById("hero-term");
        term = new window.Terminal({
          convertEol: false,
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
        termRef = term;
        fit.fit();

        os.onOutput((bytes) => term.write(bytes));
        term.onData((data) => os.input(data));

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

        statusText = `${os.version} · wsh`;
        os.startTerminal();
      } catch (err) {
        statusText = "boot failed";
        const msg = `boot failed: ${err?.message ?? err}\r\n`;
        if (term) term.write(msg);
        else {
          const el = document.getElementById("hero-term");
          if (el) el.textContent = msg;
        }
      }
    })();
  });

  return (
    <>
      {/* ---------------- hero ---------------- */}
      <section class="hero">
        <div class="container hero-grid">
          <div class="hero-copy">
            <h1>
              An operating system that boots in a{" "}
              <span class="grad">Web Worker</span>.
            </h1>
            <p class="lead">
              A real kernel running real processes — where JS and WASM are the
              native executable format. POSIX-style coreutils and bash-like scripting.
            </p>
          </div>

          <div class="hero-demo">
            <div class="term-window">
              <div class="code-bar">
                <span class="dots"><i /><i /><i /></span>
                <span class="file">wsh — WorkerOS</span>
                <span class="term-status">{statusText}</span>
              </div>
              <div id="hero-term" class="hero-term-screen" />
            </div>
            <div class="term-cmds">
              <span class="term-cmds-label">Try</span>
              <button class="cmd-chip" onclick={() => runCmd("ls /")}>ls /</button>
              <button class="cmd-chip" onclick={() => runCmd("echo hi | cat")}>echo hi | cat</button>
              <button class="cmd-chip" onclick={() => runCmd("ps")}>ps</button>
              <button class="cmd-chip" onclick={() => runCmd("uname -a")}>uname -a</button>
              <button
                class="cmd-chip"
                onclick={() => runCmd(`node -p "require('crypto').randomUUID()"`)}
              >
                node -p "require('crypto').randomUUID()"
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- what it is ---------------- */}
      <section class="section" id="what">
        <div class="container">
          <div class="section-head">
            <p class="kicker">What it is</p>
            <h2>A real kernel, running as a tenant of your browser.</h2>
            <p>
              Programs are spawned as genuine processes — streamed stdout/stderr,
              killable, visible in <code>ps</code>. The kernel makes every decision;
              the host runtime is a thin messenger. Node compatibility is a swappable
              guest-side layer, never baked into the kernel.
            </p>
          </div>

          <div class="grid cols-3">
            <div class="card">
              <span class="ico">🧠</span>
              <h3>Rust kernel → WASM</h3>
              <p>
                VFS, process table, syscall dispatch, module resolution and the{" "}
                <code>wsh</code> parser live in a Node-agnostic Rust core that’s fully
                native-testable.
              </p>
            </div>
            <div class="card">
              <span class="ico">⚙️</span>
              <h3>Real processes</h3>
              <p>
                <code>spawn</code>, <code>kill</code>, concurrent execution, IPC pipes,
                and streamed I/O — coreutils run as actual, <code>ps</code>-visible
                programs.
              </p>
            </div>
            <div class="card">
              <span class="ico">🐚</span>
              <h3>A bash-flavored shell</h3>
              <p>
                <code>wsh</code> supports pipes, redirects, <code>&amp;&amp;</code>/
                <code>||</code>/<code>;</code>, globbing, background jobs,{" "}
                <code>if</code>/<code>for</code>/<code>while</code>, and functions.
              </p>
            </div>
            <div class="card">
              <span class="ico">📦</span>
              <h3>npm + node, for real</h3>
              <p>
                <code>npm install</code> fetches real registry tarballs — semver +
                transitive deps — into <code>node_modules</code>; <code>node app.js</code>{" "}
                runs CommonJS/ESM that <code>require</code>/<code>import</code> them.
              </p>
            </div>
            <div class="card">
              <span class="ico">🧊</span>
              <h3>Unmodified WASI binaries</h3>
              <p>
                A <code>wasm32-wasip1</code> binary runs as a real process — stdio,
                args/env, clocks, <code>proc_exit</code>, and blocking VFS +{" "}
                <code>stdin</code> I/O over a SharedArrayBuffer syscall channel.
              </p>
            </div>
            <div class="card">
              <span class="ico">🔒</span>
              <h3>Capability-secure</h3>
              <p>
                The kernel is the sole authority for granting capabilities — guests
                get exactly what they’re handed, nothing ambient.
              </p>
            </div>
            <div class="card">
              <span class="ico">🌐</span>
              <h3>Runs anywhere JS runs</h3>
              <p>
                Boots inside a Web Worker with cross-origin isolation; the same core is
                designed to be host-agnostic beyond the browser.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- architecture ---------------- */}
      <section class="section" id="architecture">
        <div class="container">
          <div class="section-head">
            <p class="kicker">Architecture</p>
            <h2>Kernel-authoritative by design.</h2>
            <p>
              The main thread holds a thin client. The kernel worker owns the wasm
              kernel; program workers run guest modules against a native syscall ABI.
              Nothing about Node leaks into the core.
            </p>
          </div>

          <div class="code-wrap">
            <div class="code-bar">
              <span class="dots"><i /><i /><i /></span>
              <span class="file">playground.js — boot &amp; run a program</span>
            </div>
            <pre class="code">
{`import { boot } from "@opentf/workeros-web";

`}<span class="c">// Boot the Rust→WASM kernel inside a Web Worker.</span>{`
const os = await `}<span class="f">boot</span>{`();

`}<span class="c">// The VFS is real: write a file, then run a program.</span>{`
await os.fs.`}<span class="f">write</span>{`(`}<span class="s">"/hello.txt"</span>{`, `}<span class="s">"from the WorkerOS VFS\\n"</span>{`);

`}<span class="c">// wsh: pipes, &&, redirects, glob — executed by the kernel.</span>{`
await os.`}<span class="f">exec</span>{`(`}<span class="s">"cat /hello.txt | cat && ls /sbin"</span>{`, {
  onStdout: (b) => screen.write(b),
});

`}<span class="c">// Processes are real — inspect the live table.</span>{`
const procs = await os.`}<span class="f">ps</span>{`();`}
            </pre>
          </div>
        </div>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section class="cta-band">
        <div class="container">
          <h2>Boot it yourself.</h2>
          <p>
            The playground runs the real kernel in your browser — a live{" "}
            <code>wsh</code> prompt, ready to accept commands.
          </p>
          <Link href="/playground" class="btn btn-primary">
            Open the playground <span class="arrow">→</span>
          </Link>
        </div>
      </section>
    </>
  );
}
