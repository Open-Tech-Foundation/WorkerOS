// The live WorkerOS playground: boots the real Rust→WASM kernel inside a Web
// Worker and drives `wsh`. The terminal accepts commands and executes them on
// Enter, streaming stdout/stderr from real, ps-visible processes.
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

export default function Playground() {
  let status = $state("booting");
  let statusText = $state("booting kernel…");

  onMount(() => {
    const screen = document.getElementById("term-screen");
    const input = document.getElementById("term-input");
    const promptEl = document.getElementById("term-prompt");
    const dec = new TextDecoder();

    let cwd = "/";
    let os = null;
    const history = [];
    let hix = -1;

    const write = (text, cls) => {
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = text;
      screen.appendChild(span);
      screen.scrollTop = screen.scrollHeight;
    };
    const setPrompt = () => {
      promptEl.textContent = `${cwd} $`;
    };

    async function runLine(line) {
      write(`${cwd} $ ${line}\n`, "cmd");
      if (!line.trim()) return;
      history.push(line);
      hix = history.length;

      if (line.trim() === "clear") {
        screen.replaceChildren();
        return;
      }
      if (line.trim() === "ps") {
        const procs = await os.ps();
        const rows = procs.map(
          (p) =>
            `${String(p.pid).padStart(4)} ${p.state.padEnd(8)} ${p.argv.join(" ")}`,
        );
        write((rows.join("\n") || "(no live processes)") + "\n");
        return;
      }

      const { code, cwd: newCwd } = await os.exec(line, {
        onStdout: (b) => write(dec.decode(b)),
        onStderr: (b) => write(dec.decode(b), "err"),
      });
      if (newCwd) cwd = newCwd;
      setPrompt();
      if (code !== 0) write(`[exit ${code}]\n`, "err");
    }

    // Terminal input handling: run on Enter, history on ↑/↓.
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const line = input.value;
        input.value = "";
        if (!os) return;
        input.disabled = true;
        try {
          await runLine(line);
        } catch (err) {
          write(`playground error: ${err?.message ?? err}\n`, "err");
        } finally {
          input.disabled = false;
          input.focus();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (hix > 0) input.value = history[--hix];
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (hix < history.length - 1) input.value = history[++hix];
        else {
          hix = history.length;
          input.value = "";
        }
      }
    });

    // Let sidebar chips (and clicking anywhere) drop focus into the prompt.
    screen.parentElement.addEventListener("click", () => input.focus());
    window.__pgRun = (line) => {
      if (!os || input.disabled) return;
      input.value = line;
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    };

    // Boot sequence.
    (async () => {
      try {
        if (!window.crossOriginIsolated) {
          write("waiting for cross-origin isolation (service worker)…\n", "sys");
          // The COI service worker reloads the page once on first visit; if we
          // somehow got here without isolation, surface a clear message.
        }
        write("• loading kernel runtime…\n", "sys");
        const { boot } = await loadRuntime(RUNTIME_URL);
        write("• booting kernel worker…\n", "sys");
        os = await boot();
        await os.fs.write("/readme.txt", "hello from the WorkerOS VFS\n");
        write(
          `\nWorkerOS ${os.version} (${os.abi}) — wsh ready.\n` +
            `Type a command and press Enter. Try: ls /sbin · echo hi | cat · ps · clear\n\n`,
          "ok",
        );
        status = "ready";
        statusText = `${os.version} · wsh`;
        setPrompt();
        input.focus();
      } catch (err) {
        status = "error";
        statusText = "boot failed";
        write(`\nboot failed: ${err?.message ?? err}\n`, "err");
        if (!window.crossOriginIsolated) {
          write(
            "This browser is not cross-origin isolated, so SharedArrayBuffer is " +
              "unavailable. Reload the page; if it persists, the COI service worker " +
              "could not register (needs a secure context).\n",
            "err",
          );
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
        <span class="sub">real kernel, booted in your browser</span>
        <span class="nav-spacer" style="flex:1" />
        <span class={`pg-status ${status}`}>
          <span class="dot" /> {statusText}
        </span>
      </div>

      <div class="pg-body">
        <div class="terminal">
          <div id="term-screen" class="term-screen" />
          <form
            class="term-form"
            onsubmit={(e) => e.preventDefault()}
          >
            <span id="term-prompt" class="term-prompt">/ $</span>
            <input
              id="term-input"
              class="term-input"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              placeholder="type a command…"
            />
          </form>
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
          <h4>Shell features</h4>
          <p class="hint">
            Pipes <code>|</code>, redirects <code>&gt;</code>, <code>&amp;&amp;</code>{" "}
            <code>||</code> <code>;</code>, globbing, background <code>&amp;</code>,
            and <code>cd</code>. History with ↑/↓, <code>clear</code> to reset.
          </p>
        </aside>
      </div>
    </div>
  );
}
