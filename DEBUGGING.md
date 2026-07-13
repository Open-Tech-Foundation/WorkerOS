# Debugging WorkerOS — the kernel tracer & e2e harness

Two tools exist for seeing what a guest program is actually *doing* when it hangs,
errors, or misbehaves: an in-kernel **syscall tracer** (an `strace(1)` for the OS),
and a Playwright-driven **end-to-end harness** that boots the OS, runs real
programs, drives interactive prompts, and dumps the trace on exit or timeout.

Both were built to diagnose real failures (an `npm install` truncating cached
packuments at exactly 1 MiB; `npm create hono`/`create vite` hanging inside an
interactive prompt) — the kind of bug you cannot find by reading code, only by
watching the running system.

---

## 1. The kernel tracer (`os.trace`)

A strace-style ring buffer inside the **kernel worker** (`kernel-worker.js`,
`tracer`). It is **off by default and costs nothing** until enabled. When on, it
records one event per:

- **syscall** — both transports: the synchronous SAB path (`serviceSync`) and the
  async `postMessage` path (`handleSyscall`). Covers `open`/`read`/`write`/`close`/
  `stat`/`mkdir`/`readdir`/`seek`/`isatty`/`setattr`/net/…
- **process spawn** (`startWorker`) — argv + cwd.
- **process exit** (`handleExit`) — exit code.
- **stdin feed** (`MSG.STDIN`) — bytes written to a process's stdin.

### Using it

From the main thread (or a Playwright `page.evaluate`), through the client handle:

```js
const os = await window.__wos.boot();

await os.trace({ on: true, clear: true });   // start recording (empty the buffer)

// … run whatever you're debugging …

const { events, procs } = await os.trace({ dump: true, procs: true, limit: 400 });
```

`os.trace(opts)` accepts `{ on?, dump?, clear?, procs?, limit? }` and resolves with
`{ on, events?, procs? }`:

- `on: true|false` — toggle the tracer.
- `dump: true` — return the recent events (most-recent `limit`, default = whole ring).
- `procs: true` — also return a live process-table snapshot (`kernel.list_processes()`).
- `clear: true` — empty the ring buffer.

Each event is:

```ts
{ seq: number,      // monotonic sequence id
  t: number,        // ms since the worker started (performance.now, rounded)
  pid: number,      // the process that made the call
  kind: "sync" | "async" | "proc" | "stdin",
  call: string,     // "read", "open", "spawn", "exit", "feed", …
  info: string }    // a short, log-safe summary (path=… fd=… bytes=… — never payload bytes)
```

When the tracer is on, every event is **also** `console.debug`'d as a one-liner:

```
[wos] #182 +414ms pid=3 sync:open path=/root/.npm/_cacache/index-v5/… opts=create
[wos] #183 +414ms pid=3 async:read fd=0 max=65536
[wos] #184 +415ms pid=3 stdin:feed bytes=1
```

so a live browser session — or Playwright's console capture — sees the stream in
real time. This is usually enough on its own: a process parked on `async:read fd=0`
with nothing after it is blocked on stdin; a lone `sync:open` followed by a write
to `fd=2` is a failing `open` reporting its error.

### Wiring

`MSG.TRACE` / `MSG.TRACE_RESULT` (`protocol.js`) carry the request/reply;
`client.js` exposes `os.trace()`; the tracer and its hooks live in
`kernel-worker.js`. Reads/writes never log their payloads — only lengths — so the
trace stays readable and cheap.

---

## 2. The e2e harness (`packages/workeros-web/tools/e2e-harness.mjs`)

Boots the OS in headless Chromium, runs a command, answers prompts, and — on exit
**or** hang — dumps the trace, the live process table, and a filesystem snapshot.
Importable (`runInOs`, `runInTerminal`) or a CLI. Requires the `playwright`
devDependency.

### `runInOs` — spawn a program directly (piped stdio)

```js
import { runInOs } from "./tools/e2e-harness.mjs";

const res = await runInOs({
  argv: ["node", "/app/script.js"],
  cwd: "/app",
  env: { HOME: "/root" },
  files: [{ path: "/app/script.js", src: "…" }],   // written before the run
  inputs: [{ when: "Continue\\?", send: "y\n" }],   // answer prompts by output match
  timeoutMs: 60000,
  snapshot: ["/app"],                                // recursive dir listing at the end
});
// → { code, stdout, stderr, trace, procs, snapshots }
```

`inputs` rules fire once, when the accumulated output first matches `when` (a
regex) — or, if `when` is a number, that many ms after launch. `send` understands
`\n \r \t \e` and `\uXXXX`.

### `runInTerminal` — drive the interactive shell over the TTY (the real user path)

Use this for **raw-mode prompts** (`@clack/prompts`, Inquirer) and for anything
launched through the shell (`npm create …`, `npx …`). It types into the terminal,
so input reaches the actual foreground process **however deeply nested** — which a
piped `writeStdin` cannot (see the gotcha below).

```js
import { runInTerminal } from "./tools/e2e-harness.mjs";

const res = await runInTerminal({
  command: "export npm_config_yes=true; npm create vite@latest my-app -- --template react",
  inputs: [{ when: "Which linter", send: "\r" }, { when: "Install with npm", send: "\r" }],
  doneWhen: "Scaffolding|npm install",
  snapshot: ["/my-app"],
  timeoutMs: 90000,
});
// → { done, output, trace, procs, snapshots }
```

### CLI

```
node tools/e2e-harness.mjs [--cwd DIR] [--timeout MS] [--snap DIR]…
                           [--on "REGEX=KEYS"]…  [--after "MS=KEYS"]…
                           -- <argv…>
```

`--on` answers a prompt when output matches `REGEX`; `--after` sends on a timer.
`TRACE_TAIL=N` controls how many trailing trace events the CLI prints.

---

## 3. Gotcha: stdin to a nested process

`writeStdin(pid)` (and `runInOs`'s `inputs`) feed **only that pid's** stdin. They do
**not** reach a process that pid later `exec`'d or spawned — e.g. `npm` (the
launcher) → `npm-cli.js` → `npx` → `sh -c` → the actual `create-*` tool. The trace
makes this obvious: `stdin:feed bytes=2 pid=2` while the parked `async:read fd=0`
belongs to `pid=5`.

In a real terminal the shared TTY carries input all the way down, so **drive nested
interactive programs with `runInTerminal`** (TTY), not `runInOs` (pipe). The trace's
process snapshot (`procs`) shows the whole `pid → argv` tree so you can see which
process is actually reading.
