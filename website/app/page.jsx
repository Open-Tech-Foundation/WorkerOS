import { Link } from "@opentf/web";

export default function Home() {
  return (
    <>
      {/* ---------------- hero ---------------- */}
      <section class="hero">
        <div class="container">
          <span class="eyebrow">
            <span class="dot" /> M3 — usable shell reached
          </span>
          <h1>
            An operating system that boots in a <span class="grad">Web Worker</span>.
          </h1>
          <p class="lead">
            WorkerOS is a language-agnostic OS personality whose executable format is
            JavaScript or WASM instead of native binaries — and whose “CPU” is the
            host’s own JS/WASM engine. The kernel is written in Rust, compiled to
            WASM, and is the sole authority for the VFS, processes, and capabilities.
          </p>
          <div class="hero-cta">
            <Link href="/playground" class="btn btn-primary">
              Launch the playground <span class="arrow">→</span>
            </Link>
          </div>
          <div class="quickstart">
            <span class="prompt">$</span>
            <span class="cmd">echo hi | cat &amp;&amp; ls /sbin &amp;&amp; ps</span>
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
                <code>||</code>/<code>;</code>, globbing, background jobs, and{" "}
                <code>cd</code>.
              </p>
            </div>
            <div class="card">
              <span class="ico">📦</span>
              <h3>JS or WASM executables</h3>
              <p>
                The executable format is a module. <code>import</code> is resolved by
                the kernel, so programs load their dependencies through real syscalls.
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

      {/* ---------------- milestones ---------------- */}
      <section class="section" id="milestones">
        <div class="container">
          <div class="section-head">
            <p class="kicker">Roadmap</p>
            <h2>Where WorkerOS is today.</h2>
          </div>

          <table class="mtable">
            <thead>
              <tr>
                <th>Milestone</th>
                <th>Scope</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>M1 — Boot</td>
                <td>Kernel boots, VFS + WASI-shaped syscall spine</td>
                <td><span class="pill done">✓ done</span></td>
              </tr>
              <tr>
                <td>M2 — Run JS (MVP)</td>
                <td>spawn / run / kill JS, concurrent, kernel-resolved import</td>
                <td><span class="pill done">✓ done</span></td>
              </tr>
              <tr>
                <td>M3 — Usable shell</td>
                <td>wsh (pipes, redirects, &amp;&amp;/||, glob, &amp;), IPC, coreutils, ps</td>
                <td><span class="pill done">✓ done</span></td>
              </tr>
              <tr>
                <td>M4+ — Beyond</td>
                <td>WASI binaries, npm, preview, persistence</td>
                <td><span class="pill wip">in progress</span></td>
              </tr>
            </tbody>
          </table>
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
