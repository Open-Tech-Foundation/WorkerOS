// "Try it" — the docs-site primitive: the user types JS that imports a real npm
// package, it executes inside WorkerOS (fetched into the VFS, run as a real
// process), and the console output comes back. This is the reference widget a
// package's docs site would embed via os.run().

const RUNTIME_URL = "/workeros/packages/workeros-web/src/index.js";
const loadRuntime = new Function("u", "return import(u)");

const DEFAULT_CODE = `import { camelCase, sum, uniq } from "@opentf/std";

console.log(camelCase("hello world from workeros"));
console.log("sum:", sum([1, 2, 3, 4, 5]));
console.log("uniq:", uniq([1, 1, 2, 3, 3]));`;

const EXAMPLES = [
  {
    label: "@opentf/std · strings",
    code: `import { camelCase, capitalize, snakeCase } from "@opentf/std";

console.log(camelCase("hello world"));
console.log(capitalize("workeros"));
console.log(snakeCase("Boots In A Worker"));`,
  },
  {
    label: "@opentf/utils · arrays",
    code: `import { chunk, uniq, compact, range } from "@opentf/utils";

console.log("chunk:", chunk([1, 2, 3, 4, 5], 2));
console.log("uniq:", uniq([3, 1, 3, 2, 1]));
console.log("compact:", compact([0, 1, false, 2, "", 3]));
console.log("range:", range(1, 6));`,
  },
  {
    label: "no imports · plain JS",
    code: `const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
for (let i = 0; i < 10; i++) console.log(i, "→", fib(i));`,
  },
];

export default function Try() {
  let status = $state("booting");
  let statusText = $state("booting kernel…");
  let running = $state(false);
  let note = $state("");

  onMount(() => {
    const editor = document.getElementById("code");
    const out = document.getElementById("out");
    const dec = new TextDecoder();
    let os = null;

    editor.value = DEFAULT_CODE;

    const write = (text, cls) => {
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = text;
      out.appendChild(span);
      out.scrollTop = out.scrollHeight;
    };

    async function run() {
      if (!os || running) return;
      running = true;
      out.replaceChildren();
      note = "";
      const t0 = performance.now();
      try {
        const { code, stdout, stderr } = await os.run(editor.value, {
          onInstall: (name) => write(`↓ installing ${name}…\n`, "sys"),
          onStdout: (b) => write(dec.decode(b)),
          onStderr: (b) => write(dec.decode(b), "err"),
        });
        if (!stdout && !stderr) write("(no output — use console.log)\n", "sys");
        const ms = Math.round(performance.now() - t0);
        note = `${code === 0 ? "✓" : "✗"} exited ${code} · ${ms}ms`;
      } catch (err) {
        write(`\nrun error: ${err?.message ?? err}\n`, "err");
        note = "✗ error";
      } finally {
        running = false;
      }
    }

    document.getElementById("run-btn").addEventListener("click", run);
    // Cmd/Ctrl+Enter to run.
    editor.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    });
    // Example chips replace the editor content.
    for (const el of document.querySelectorAll("[data-example]")) {
      el.addEventListener("click", () => {
        editor.value = EXAMPLES[Number(el.dataset.example)].code;
        editor.focus();
      });
    }
    window.__tryRun = run;

    (async () => {
      try {
        const { boot } = await loadRuntime(RUNTIME_URL);
        os = await boot();
        status = "ready";
        statusText = `${os.version} · run`;
      } catch (err) {
        status = "error";
        statusText = "boot failed";
        write(`boot failed: ${err?.message ?? err}\n`, "err");
      }
    })();
  });

  return (
    <div class="pg">
      <div class="pg-head">
        <h1>
          <span class="brand-mark">W</span> Try it
        </h1>
        <span class="sub">type JS that imports a real npm package — it runs inside the OS</span>
        <span class="nav-spacer" style="flex:1" />
        <span class={`pg-status ${status}`}>
          <span class="dot" /> {statusText}
        </span>
      </div>

      <div class="try-body">
        <section class="try-pane">
          <div class="try-toolbar">
            <span class="try-label">editor.js</span>
            <span class="nav-spacer" style="flex:1" />
            {EXAMPLES.map((ex, i) => (
              <span class="chip" data-example={i}>
                {ex.label}
              </span>
            ))}
            <button
              id="run-btn"
              class="btn btn-primary run-btn"
              disabled={status !== "ready" || running}
            >
              {running ? "Running…" : "Run ▶"}
            </button>
          </div>
          <textarea
            id="code"
            class="try-editor"
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
          />
        </section>

        <section class="try-pane">
          <div class="try-toolbar">
            <span class="try-label">output</span>
            <span class="nav-spacer" style="flex:1" />
            <span class="try-note">{note}</span>
          </div>
          <div id="out" class="try-output" />
        </section>
      </div>

      <p class="try-foot">
        Powered by <code>os.run(code)</code> — the snippet is written to the VFS, its
        bare <code>import</code>s are fetched into <code>/node_modules</code>, and it runs
        as a real, <code>ps</code>-visible process. Drop this into your package docs for a
        live “try it”. <span class="try-kbd">⌘/Ctrl + Enter</span> to run.
      </p>
    </div>
  );
}
