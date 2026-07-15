// The kernel worker. Exactly one per WorkerOS instance. It owns the Rust→wasm
// kernel (the sole authority) and drives the host side of the process model:
// one program worker per process, relaying their syscalls into the wasm kernel,
// wiring pipes, running the shell (`wsh`), and streaming output back to main.
//
// It never executes guest code itself (ARCHITECTURE.md §4). Every decision —
// resolution, VFS, glob, process table, capabilities — is the wasm kernel's;
// this file is transport, worker lifecycle, and the async shell driver.

import init, { WebKernel } from "./kernel-wasm/workeros_web_wasm.js";
import { MSG } from "./protocol.js";
import { createShell } from "./shell-exec.js";
import { createLineEditor } from "./shell/readline.js";
import { bundledCoreutils } from "../../workeros-coreutils/src/index.js";
import { programs as osPrograms, libraries as osLibraries } from "../../workeros-programs/src/index.js";
import { allocSyncBuffer, readRequest, requestBytes, writeResponse, views, STATE, S_IDLE } from "./sync-syscall.js";
import { frameExecResult } from "./exec-frame.js";
import { openPersistence } from "./persistence.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
let kernel = null;
let systemShell = null;

// Durable filesystem write-behind (ADR-022). `persistence` is the IndexedDB
// store; we re-snapshot only when the kernel's mutation counter advances past
// what we last stored, so an idle OS does no I/O.
let persistence = null;
let lastPersistedGen = 0;
let saving = false;
const AUTOSAVE_MS = 2000;
// Rolling auto-snapshot cadence (ADR-022, Stage 4). We checkpoint the durable
// tree into the last-10 undo ring at most this often, so a busy editor doesn't
// flood the ring (and retain chunks) on every keystroke. Set at boot so the
// first checkpoint is one interval in, not on the first change.
const AUTO_SNAPSHOT_MS = 5 * 60 * 1000;
let lastAutoSnap = 0;

// ---- watchdog: the temporal half of the sandbox (INV-6, ADR-020) -----------
//
// The kernel worker is the only agent with a clock and worker.terminate(), so
// it enforces the two limits the wasm kernel cannot (the kernel still records
// the kill reason — mark_killed — so ps/wait/the shell report an honest why).
//
// "CPU time" is measured as *continuous unresponsiveness*, not lifetime — a dev
// server must be allowed to run forever. A process counts as alive if it (a)
// makes any syscall, (b) answers the periodic PING with a PONG (its event loop
// turns), or (c) sits parked in a kernel-serviced blocking call (its SAB slot
// is non-idle — the kernel worker reads it directly; that wait is the kernel's,
// not a spin). Only a worker showing none of these for `wallTimeMs` — a
// synchronous `for(;;)` — is escalated: cooperative SIGTERM, a grace period,
// then terminate() with exit 152 (128+SIGXCPU) and reason "CPU time".
//
// Memory is a *soft, sampled* high-water mark (INV-5): each program worker
// self-reports performance.measureUserAgentSpecificMemory() where the API
// exists; a breach terminates with exit 137 and reason "out of memory". A
// synchronous allocation burst between samples can still OOM the tab — stated
// openly; a hard cap needs the future Wasm/Boa level (§7.1).
//
// Defaults mirror workeros-kernel/limits.rs WATCHDOG (the documented source of
// truth); a host override rides the BOOT message (used by tests, and the seam
// for a tight untrusted/AI-agent profile).
const watchdog = {
  wallTimeMs: 30_000,
  graceMs: 2_000,
  sampleMs: 2_000,
  memHighWaterBytes: 512 * 1024 * 1024,
};

const SIGXCPU_EXIT = 128 + 24;
const OOM_EXIT = 137; // 128 + SIGKILL, the conventional OOM-kill code

/** A watchdog/limit kill: record the reason in the kernel's process table,
 *  tell the process's stderr why (the shell-visible "Killed (…)"), then reap
 *  through the ordinary exit seam (fds close → EOF/EPIPE downstream, TTY
 *  restored, worker terminated). */
function killWithReason(pid, code, reason) {
  const rec = programs.get(pid);
  if (!rec || rec.done) return;
  kernel.mark_killed(pid, code, reason);
  tracer.record("proc", pid, "watchdog-kill", reason);
  try { rec.sink.stderr(enc.encode(`Killed (${reason})\n`)); } catch {}
  handleExit(pid, code);
}

function watchdogTick() {
  if (!kernel || !watchdog.wallTimeMs) return; // 0 disables (like idle_time_ms)
  const now = Date.now();
  for (const [pid, rec] of programs) {
    if (rec.done) continue;
    // Parked in a blocking syscall (Atomics.wait on its SAB): the kernel owes
    // it a response — that is waiting, not spinning.
    if (Atomics.load(views(rec.syncSab).i32, STATE) !== S_IDLE) {
      rec.lastActivity = now;
      rec.warnedAt = 0;
      continue;
    }
    const idle = now - rec.lastActivity;
    if (idle < watchdog.wallTimeMs) {
      rec.warnedAt = 0;
      rec.worker.postMessage({ type: MSG.PING }); // a live event loop PONGs back
      continue;
    }
    if (!rec.warnedAt) {
      // Cooperative first (the Ctrl-C two-phase): a guest that can still act
      // gets SIGTERM; a true synchronous spin can't — the grace covers both.
      rec.warnedAt = now;
      deliverSignal(pid, "SIGTERM");
      continue;
    }
    if (now - rec.warnedAt >= watchdog.graceMs) killWithReason(pid, SIGXCPU_EXIT, "CPU time");
  }
}

// Syscalls that mutate the filesystem — before servicing one we stamp the kernel
// clock (ADR-020) so the resulting inode mtimes/ctimes are real wall-clock times.
const MUTATING_CALLS = new Set([
  "write", "open", "mkdir", "unlink", "rmdir", "rename", "symlink", "link", "utimes",
]);

// Persist the durable tree to the content-addressed block store if it changed
// since the last flush (ADR-022). Writes only *new* chunk hashes (delta), then
// the manifest root and the snapshot set, then mark-sweeps unreferenced chunks.
// Coalesces concurrent calls; safe on a timer and on tab hide.
async function persistNow() {
  if (!kernel || !persistence || !persistence.available || saving) return;
  const gen = kernel.fsGeneration();
  if (gen === lastPersistedGen) return;
  saving = true;
  try {
    // Take a rolling auto-snapshot on a bounded cadence so the last-10 durable
    // states stay recoverable (the kernel evicts the oldest beyond the ring).
    const now = Date.now();
    if (now - lastAutoSnap >= AUTO_SNAPSHOT_MS) {
      kernel.snapshotAuto();
      lastAutoSnap = now;
    }
    // Read the kernel's durable projection synchronously — no writes can
    // interleave between these calls in the single-threaded worker. `live` is
    // every chunk the working tree *or* a retained snapshot needs.
    const manifest = kernel.manifest();
    const live = kernel.liveChunks();
    const liveSet = new Set(live);
    const known = await persistence.knownChunks();
    // Delta: store only chunks the block store doesn't already hold.
    for (const hex of live) {
      if (known.has(hex)) continue;
      const bytes = kernel.chunkBytes(hex);
      if (bytes) await persistence.putChunk(hex, bytes);
    }
    await persistence.saveManifest(manifest);
    await persistence.saveSnapshots(kernel.snapshotExport());
    // Mark-sweep GC: any previously-stored chunk no longer live is garbage.
    const garbage = [...known].filter((hex) => !liveSet.has(hex));
    if (garbage.length) await persistence.deleteChunks(garbage);
    lastPersistedGen = gen;
  } catch (err) {
    console.warn("[workeros] persist failed:", err && err.message);
  } finally {
    saving = false;
  }
}

// The shell session state (cwd/env) for non-interactive, host-driven runs: the
// client `exec()` channel and captured `system(3)`/child_process runs. Each
// interactive terminal keeps its *own* session (see `Terminal`); this is the base
// env those non-terminal runs default to (they usually override cwd/env per call).
// TERM/COLORTERM advertise the host xterm's ANSI color support so color-detecting
// tools (chalk's supports-color, etc.) light up 24-bit color instead of falling
// back to plain text on a TTY.
const systemSession = {
  cwd: "/",
  env: { HOME: "/", PATH: "/bin:/sbin", TERM: "xterm-256color", COLORTERM: "truecolor" },
};

// The primary controlling terminal (kernel `PRIMARY_TTY`), present from boot. The
// legacy single-terminal client API (`startTerminal`/`input`/`onOutput` without a
// session) drives this one; `openTerminal()` allocates additional ttys.
const PRIMARY_TTY = 1;

// pid → { worker, sink, onExit, resolveExit, done }.
const programs = new Map();
// Parked pipe reads awaiting data/EOF: { pid, id, fd, max }.
let pendingReads = [];
// Parked net accepts awaiting an inbound connection: { pid, id, listener }
// (ADR-021). Retried whenever a connection is added to some listener's backlog.
let pendingAccepts = [];
// The host-side network injector (ADR-021): a context-only kernel process whose
// fds carry the client end of each injected preview connection. `injectWaiters`
// are resolvers parked in `injectConnection`'s read loop, woken whenever a pipe
// may have advanced (a server write/close/exit).
let injectorPid = -1;
let injectWaiters = [];
function retryInjectReads() {
  if (injectWaiters.length === 0) return;
  const w = injectWaiters;
  injectWaiters = [];
  for (const r of w) r();
}

// ---- interactive terminals (the kernel-owned TTY REPLs) --------------------
// Each controlling terminal is a stream to one host terminal (an xterm window).
// The kernel owns the line discipline (echo/editing) per terminal; this side runs
// one shell prompt loop per terminal and delivers control-key signals to that
// terminal's foreground pipeline. Multiple terminals run independently: each owns
// its own kernel tty id, shell session (cwd/env), history, and foreground group.
const INTERRUPT = Symbol("tty-interrupt");
const caughtSignals = new Map(); // pid → Set<signal> the guest installed a handler for
// node:worker_threads: pid → { parentPid, workerData, threadId } for a process
// spawned as a Worker. Lets a worker answer `workerInit` (am I a worker? my data)
// and lets `workerPost` route a child→parent message to the right spawner.
const workerContexts = new Map();
// node:worker_threads: `${parentPid}:${token}` → worker pid. A guest names a
// Worker with a spawn token it picks *synchronously*, so it can post to a worker
// whose threadId hasn't reached it yet; we register the token while servicing
// spawnWorker, and a later workerPost on the same port resolves it (see the
// `workerPost` syscall). Dropped when the worker exits.
const workerTokens = new Map();

// Deliver a cooperative signal to a live JS program (posted to its worker).
function deliverSignal(pid, signal) {
  const rec = programs.get(pid);
  if (rec && !rec.done) rec.worker.postMessage({ type: MSG.SIGNAL, signal });
}

// Whether a process asked to catch `signal` (vs. taking the default disposition).
function catches(pid, signal) {
  return caughtSignals.get(pid)?.has(signal) ?? false;
}

// Shell builtins that have no on-disk program (mirrors interp.js BUILTINS) —
// offered alongside PATH programs when completing a command name.
const SHELL_BUILTINS = [
  ":", "true", "false", "echo", "printf", "pwd", "cd", "export", "unset", "local",
  "shift", "exit", "return", "break", "continue", "read", "test", "[", "[[", "set",
  "trap", "eval", "source", ".", "command", "type", "uname",
];

// program stdout/stderr → terminal stream; \n normalized to \r\n so a bare-LF
// program lands the cursor at col 0.
const crlf = (b) => {
  const s = dec.decode(b);
  return s.includes("\n") && !s.includes("\r\n") ? enc.encode(s.replace(/\n/g, "\r\n")) : b;
};

// One interactive terminal session, bound to a kernel tty id. Owns its shell
// session, prompt line editor, foreground bookkeeping, and REPL — all keyed to
// `ttyId` so terminals never cross-talk. Registered in `terminals` by id.
const terminals = new Map(); // ttyId → Terminal

class Terminal {
  constructor(ttyId) {
    this.ttyId = ttyId;
    // A private shell session, seeded from the base env (PATH etc. already applied
    // by the boot profile) so a new terminal starts ready without re-sourcing.
    this.session = { cwd: "/", env: { ...systemSession.env } };
    this.started = false; // the REPL loop is running
    this.execRunning = false; // a foreground command is running under the REPL
    this.termWaiter = null; // { resolve } awaiting the next committed input line
    this.history = []; // interactive command history (for the readline prompt)
    this.activeReadline = null; // the line editor while the prompt is being edited
    // Whether the last byte sent to the display was a newline (cursor at column 0).
    // Used to avoid the prompt redraw's `\r\x1b[K` erasing a command's trailing,
    // non-newline-terminated output (e.g. `printf foo`, `cat` of an EOL-less file).
    this.atLineStart = true;
    this.sink = { stdout: (b) => this.out(crlf(b)), stderr: (b) => this.out(crlf(b)) };
    // The shell driver for this terminal: its pipelines attach to this tty (ctty +
    // foreground), and its `read` builtin draws from this terminal's line editor.
    this.shell = createShell({
      kernel,
      startProcess: (o) => startProcess({ ...o, ttyId: this.ttyId }),
      session: this.session,
      readLine: () => this.readLineFromTty(),
    });
  }

  // Send bytes to this terminal's display (main thread → the right xterm).
  out(bytes) {
    if (bytes && bytes.length) {
      post({ type: MSG.TERM_OUTPUT, session: this.ttyId, data: bytes });
      this.atLineStart = bytes[bytes.length - 1] === 0x0a; // 0x0a === '\n'
    }
  }

  // This terminal's foreground process group members (the control-key delivery
  // set): tcgetpgrp on this tty + the group's live members (ADR-025). Exec'd
  // grandchildren inherit the group, so ^C reaches them too.
  fgMembers() {
    if (!kernel) return [];
    const g = kernel.tty_get_foreground(this.ttyId);
    return g ? Array.from(kernel.pgrp_members(g)) : [];
  }

  // Resolve a parked line-waiter if a full line has cleared this tty's discipline.
  pumpWaiter() {
    if (!this.termWaiter) return;
    const line = kernel.tty_read_line(this.ttyId); // Uint8Array, or null if no full line
    if (line != null) {
      const w = this.termWaiter;
      this.termWaiter = null;
      w.resolve(line);
    }
  }

  // Await the next committed input line (the REPL prompt and the shell `read`
  // builtin share this). Resolves with the line bytes, or INTERRUPT on ^C.
  waitForLine() {
    return new Promise((resolve) => {
      this.termWaiter = { resolve };
      this.pumpWaiter();
    });
  }

  // A ^C from this tty's line discipline: interrupt the foreground pipeline if one
  // is running, else cancel the line being typed. A foreground process that
  // installed a SIGINT handler receives it cooperatively (and keeps running); one
  // that did not is hard-killed with the conventional 130 (128 + SIGINT).
  onInterrupt() {
    if (this.execRunning) {
      for (const pid of this.fgMembers()) {
        if (catches(pid, "SIGINT")) deliverSignal(pid, "SIGINT");
        else handleExit(pid, 130);
      }
    }
    if (this.termWaiter) {
      const w = this.termWaiter;
      this.termWaiter = null;
      w.resolve(INTERRUPT); // unblock a `read` builtin / the prompt so it doesn't hang
    }
  }

  // A ^Z from the line discipline. WorkerOS has no job-control suspend yet, so the
  // default disposition is *ignore* (not stop); a foreground process that installed
  // a SIGTSTP handler is told, and can act on it.
  onSusp() {
    for (const pid of this.fgMembers()) {
      if (catches(pid, "SIGTSTP")) deliverSignal(pid, "SIGTSTP");
    }
  }

  prompt() {
    const cwd = this.session.cwd;
    return `${cwd === "/" ? "/" : cwd} $ `;
  }

  // Tab-completion for the prompt. Completes the token under the cursor against
  // the live VFS: a command name (PATH programs + builtins) in command position,
  // or a filesystem path otherwise (dir candidates carry a trailing "/"). Runs
  // through the injector's kernel context with absolute paths, resolving against
  // this terminal's session cwd.
  completeLine(line, pos) {
    const session = this.session;
    let start = pos;
    while (start > 0 && !/\s/.test(line[start - 1])) start--;
    const token = line.slice(start, pos);

    const readdir = (absDir) => {
      try { return kernel.sys_readdir(injectorPid, absDir) || []; } catch { return []; }
    };

    if (!token.includes("/") && /(^|[|&;(])\s*$/.test(line.slice(0, start))) {
      const items = new Set();
      for (const name of SHELL_BUILTINS) if (name.startsWith(token)) items.add(name);
      const path = (session.env && session.env.PATH) || "/bin:/sbin";
      for (const dir of path.split(":")) {
        if (!dir) continue;
        for (const e of readdir(dir)) if (!e.is_dir && e.name.startsWith(token)) items.add(e.name);
      }
      return { start, items: [...items].sort() };
    }

    const HOME = ((session.env && session.env.HOME) || "/").replace(/\/$/, "");
    const slash = token.lastIndexOf("/");
    const dirPart = slash < 0 ? "" : token.slice(0, slash + 1);
    const base = slash < 0 ? token : token.slice(slash + 1);
    const resolveTarget = dirPart.replace(/^~\//, HOME + "/");
    let absDir;
    try { absDir = kernel.resolve_dir(session.cwd, resolveTarget || "."); } catch { return { start, items: [] }; }
    const items = [];
    for (const e of readdir(absDir)) {
      if (e.name.startsWith(".") && !base.startsWith(".")) continue; // hide dotfiles
      if (!e.name.startsWith(base)) continue;
      items.push(dirPart + e.name + (e.is_dir ? "/" : ""));
    }
    return { start, items: items.sort() };
  }

  // Read one command line through the raw-mode line editor (history + cursor
  // editing). Resolves with the editor's result: a submitted line, an abort (^C),
  // or EOF (^D on an empty line).
  readCommandLine() {
    return new Promise((resolve) => {
      // If the previous command left the cursor mid-line (output without a trailing
      // newline), move to a fresh line first — otherwise the editor's initial
      // `\r\x1b[K` prompt redraw would erase that output.
      if (!this.atLineStart) this.out(enc.encode("\r\n"));
      const editor = createLineEditor({
        prompt: this.prompt(),
        history: this.history,
        write: (s) => this.out(enc.encode(s)),
        columns: () => (kernel.tty_get_winsize(this.ttyId) || {}).cols || 80,
        complete: (line, pos) => this.completeLine(line, pos),
        done: (r) => { this.activeReadline = null; resolve(r); },
      });
      this.activeReadline = editor;
      editor.start();
    });
  }

  // The interactive read-eval-print loop, reading command lines from this tty.
  async repl() {
    for (;;) {
      const res = await this.readCommandLine();
      if (res.aborted || res.eof) continue; // ^C / ^D on empty → fresh prompt
      const line = res.line;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      // Two conveniences the browser page used to own; now terminal-side. `clear`
      // is an ANSI screen wipe; `ps` formats the live process table.
      if (trimmed === "clear") {
        this.out(enc.encode("\x1b[2J\x1b[H"));
        this.atLineStart = true; // cursor homed to column 0 by \x1b[H
        continue;
      }
      if (trimmed === "ps") {
        const rows = kernel
          .list_processes()
          .map((p) => `${String(p.pid).padStart(4)} ${p.state.padEnd(8)} ${p.argv.join(" ")}`);
        this.out(enc.encode((rows.join("\r\n") || "(no live processes)") + "\r\n"));
        continue;
      }
      this.execRunning = true;
      try {
        await this.shell.exec(line, this.sink);
      } catch (e) {
        this.out(enc.encode("wsh: " + (e && e.message ? e.message : e) + "\r\n"));
      } finally {
        this.execRunning = false;
      }
    }
  }

  // The shell `read` builtin / prompts read a line from this terminal. Returns the
  // line text (newline stripped), or null on EOF / ^C.
  async readLineFromTty() {
    const b = await this.waitForLine();
    if (b === INTERRUPT || b == null) return null;
    return dec.decode(b).replace(/\n$/, "");
  }

  // Start the REPL once (idempotent — a repeated TERM_START is a no-op). The
  // session env was seeded from the already-profiled base env, so there's no need
  // to re-source /etc/profile per terminal.
  start() {
    if (this.started) return;
    this.started = true;
    this.repl().catch((e) =>
      this.out(enc.encode("wsh: repl crashed: " + (e && e.message ? e.message : e) + "\r\n")),
    );
  }
}

// Look up a terminal by kernel tty id, creating it on first use. The primary tty
// (the legacy single-terminal client path) and any `openTerminal()`-allocated tty
// resolve here; a stale id (its window already closed) yields `undefined`.
function terminalFor(ttyId, create) {
  let t = terminals.get(ttyId);
  if (!t && create) {
    t = new Terminal(ttyId);
    terminals.set(ttyId, t);
  }
  return t;
}

const PROGRAM_WORKER_URL = new URL("./program-worker.js", import.meta.url);

function post(msg) {
  self.postMessage(msg);
}

// ---- kernel tracer (opt-in, off by default) --------------------------------
// A strace-style ring buffer of recent kernel events — every syscall (the sync
// SAB path and the async postMessage path), plus process spawn/exit. This is the
// primary way to see what a guest program is *doing* when it hangs or misbehaves
// (which fd it's stuck reading, which path it can't find, whether it ever spawned
// a child). Off by default so it costs nothing; the main thread flips it on and
// reads the buffer via MSG.TRACE. When on, each event is also `console.debug`'d so
// a live/Playwright session sees it stream in real time.
const tracer = {
  on: false,
  seq: 0,
  max: 8000,
  buf: [],
  record(kind, pid, call, info) {
    if (!this.on) return;
    const ev = { seq: ++this.seq, t: Math.round(performance.now()), pid, kind, call, info: info || "" };
    this.buf.push(ev);
    if (this.buf.length > this.max) this.buf.shift();
    console.debug(`[wos] #${ev.seq} +${ev.t}ms pid=${pid} ${kind}:${call}${ev.info ? " " + ev.info : ""}`);
  },
};
// Summarize a syscall's fields into a short, log-safe string (never dump payload
// bytes — just their length). Covers the fields worth seeing at a glance.
function traceSumm(o) {
  if (!o) return "";
  const parts = [];
  for (const k of ["path", "fd", "max", "port", "offset", "whence", "signal", "target"]) {
    if (o[k] !== undefined && o[k] !== null) parts.push(`${k}=${o[k]}`);
  }
  if (o.data && o.data.length != null) parts.push(`bytes=${o.data.length}`);
  if (o.opts && typeof o.opts === "object") { const f = Object.keys(o.opts).filter((k) => o.opts[k]); if (f.length) parts.push(`opts=${f.join(",")}`); }
  return parts.join(" ");
}

// Monotonic id for node:child_process stdin temp files (see `spawnChild`).
let childTmpSeq = 0;

/** Concatenate a list of Uint8Array chunks into one. */
function concatChunks(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Run `line` through the shell driver with output *captured* (not routed to a
 *  process's streams), feeding `input` as its stdin. Resolves the child's exit
 *  code with the collected stdout/stderr — the primitive `child_process`'s
 *  synchronous forms (`execCaptureSync`) build on. */
function runCaptured(line, input, opts) {
  const outChunks = [];
  const errChunks = [];
  const sink = { stdout: (b) => outChunks.push(b), stderr: (b) => errChunks.push(b) };
  return systemShell.exec(line, sink, input, opts).then((code) => ({
    code: code | 0,
    stdout: concatChunks(outChunks),
    stderr: concatChunks(errChunks),
  }));
}

// ---- process lifecycle -----------------------------------------------------

// `opts.ppid` attributes the spawn to its initiating process so capabilities
// inherit (a denied-network guest cannot shell out to regain fetch — ADR-024);
// `opts.caps` ({ netEgress?: bool }) is an explicit host-policy override.
function spawnKernel(argv, env, cwd, plan, opts = {}) {
  return kernel.spawn(
    argv, Object.entries(env || {}), cwd, Date.now(), opts.ppid || 0, plan || null,
    opts.caps || null,
    // Process-group placement (ADR-025): undefined/null inherits the parent's
    // group; 0 becomes a new group's leader; a pid joins that group.
    opts.pgid,
    // Controlling terminal (multi-PTY): `undefined` here attaches to the primary
    // terminal so an interactive command (whose kernel ppid has no ctty) can read
    // terminal stdin. A per-session refactor will pass the real session id; nested
    // `system(3)`/child spawns will then pass `null` to inherit the parent's ctty.
    opts.ctty !== undefined ? opts.ctty : PRIMARY_TTY,
  );
}

function startWorker(spawned, { argv, env, cwd, sink, onExit }) {
  const worker = new Worker(PROGRAM_WORKER_URL, { type: "module" });
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  // Per-process synchronous-syscall buffer (used by WASI blocking calls; ADR-010).
  const syncSab = allocSyncBuffer();
  // Keep the spawn env/cwd on the record: `system(3)`-style `exec` (npm run,
  // `sh -c`) resolves its command line against the *calling* process's
  // environment (notably the PATH npm augments with node_modules/.bin), not the
  // shell driver's persistent session.
  programs.set(spawned.pid, {
    worker, sink, onExit, resolveExit, done: false, syncSab, env, cwd,
    // Watchdog liveness (ADR-020): refreshed by any message from the worker
    // (syscalls, PONGs); `warnedAt` marks a delivered SIGTERM awaiting grace.
    lastActivity: Date.now(), warnedAt: 0,
  });
  tracer.record("proc", spawned.pid, "spawn", (spawned.argv || argv || []).join(" ") + (cwd ? ` cwd=${cwd}` : ""));
  worker.onmessage = (e) => onProgramMessage(spawned.pid, e.data);
  worker.onerror = (e) => {
    try {
      sink.stderr(enc.encode(String(e.message) + "\n"));
    } catch {}
    // An *async* uncaught error (a timer/callback throw the guest didn't report):
    // relay it too, so a worker_threads Worker still fires `error` for these.
    relayWorkerError(spawned.pid, { message: String(e.message || e), stack: e.filename ? `${e.message}\n    at ${e.filename}:${e.lineno}` : undefined, name: "Error" });
    handleExit(spawned.pid, 1);
  };
  worker.postMessage({
    type: MSG.START,
    interpreter: spawned.interpreter,
    // The kernel may have rewritten argv (a `#!` shebang runs the script through
    // its interpreter); start the worker with that effective argv so `sys.argv`
    // matches what actually runs. Falls back to the caller's argv.
    argv: spawned.argv || argv,
    env,
    cwd,
    pid: spawned.pid,
    graph: spawned.graph,
    syncSab,
    // The kernel-granted egress capability (ADR-024): when false, the worker
    // strips the ambient network globals before any guest code runs.
    netEgress: spawned.net_egress !== false,
  });
  return exited;
}

/** Used by a shell driver: spawn one command with a stdio plan + sink.
 *  `pgroup` ({ leader }) places the process in a pipeline's process group
 *  (ADR-025): the first spawn ({ leader: 0 }) becomes the group leader; with a
 *  controlling terminal (`ttyId`, an interactive REPL) it also becomes that
 *  terminal's foreground group (tcsetpgrp) so ^C/^Z/SIGWINCH reach the whole
 *  pipeline. Later stages join `pgroup.leader`. `ttyId` undefined (captured
 *  `system(3)`/child runs) touches no terminal — those inherit the parent's ctty
 *  and never seize a foreground group. */
function startProcess({ argv, env, cwd, plan, sink, ppid, pgroup, ttyId }) {
  const pgid = pgroup ? pgroup.leader || 0 : undefined;
  // Interactive pipelines attach to their terminal; captured runs pass ctty=null
  // to inherit the calling process's terminal (isatty/winsize stay truthful).
  const ctty = ttyId != null ? ttyId : null;
  const spawned = spawnKernel(argv, env, cwd, plan, { ppid, pgid, ctty });
  if (pgroup && !pgroup.leader) {
    pgroup.leader = spawned.pid;
    if (ttyId != null) kernel.tty_set_foreground(ttyId, spawned.pid);
  }
  const exited = startWorker(spawned, { argv, env, cwd, sink, onExit: () => {} });
  return { pid: spawned.pid, exited };
}

/** Tear a process down once: mark exited, unblock downstream, reap, terminate. */
function handleExit(pid, code) {
  const rec = programs.get(pid);
  if (!rec || rec.done) return;
  rec.done = true;
  tracer.record("proc", pid, "exit", `code=${code}`);
  // The process's controlling terminal (captured before reap drops its context) —
  // job-control cleanup must target the *right* terminal in a multi-terminal world.
  const ctty = kernel.proc_ctty(pid);
  kernel.mark_exited(pid, code); // idempotent; closes its pipe/file fds → EOF downstream
  kernel.watchClosePid(pid); // drop this process's fs.watch registrations
  // Its parked I/O dies with it; then downstream pipe readers may see EOF and
  // upstream writers may see EPIPE — pump everything.
  syncPendingWrites = syncPendingWrites.filter((w) => w.pid !== pid);
  asyncWriteQueues.delete(pid);
  pumpIo();
  const fg = ctty ? kernel.tty_get_foreground(ctty) : 0;
  const wasForeground = fg !== 0 && kernel.proc_pgid(pid) === fg;
  kernel.reap(pid);
  rec.worker.terminate();
  programs.delete(pid);
  // Safety net: when the *last* member of the foreground group goes (e.g. an
  // editor killed before restoring termios), return its terminal to the shell —
  // cooked line discipline, foreground pgrp cleared (tcsetpgrp 0). A
  // well-behaved program restores termios itself; this covers the crash/kill path.
  if (wasForeground && kernel.pgrp_members(fg).length === 0) {
    kernel.tty_set_attr(ctty, { canonical: true, echo: true, isig: true });
    kernel.tty_set_foreground(ctty, 0);
  }
  caughtSignals.delete(pid);
  workerContexts.delete(pid);
  pendingReads = pendingReads.filter((pr) => pr.pid !== pid);
  pendingAccepts = pendingAccepts.filter((pa) => pa.pid !== pid);
  try {
    rec.onExit(code);
  } catch {}
  rec.resolveExit(code);
}

// ---- syscall relay ---------------------------------------------------------

function reply(pid, id, ok, payload) {
  const rec = programs.get(pid);
  if (!rec || rec.done) return;
  rec.worker.postMessage({
    type: MSG.SYSCALL_RESULT,
    id,
    ok,
    value: ok ? payload : undefined,
    error: ok ? undefined : payload,
  });
}

/** Re-attempt parked pipe reads after the pipe state may have changed.
 *  Returns whether anything advanced (a parked read completed). */
function retryPendingReads() {
  if (pendingReads.length === 0) return false;
  let progressed = false;
  const still = [];
  for (const pr of pendingReads) {
    const rec = programs.get(pr.pid);
    if (!rec || rec.done) continue;
    let res;
    try {
      res = kernel.sys_read(pr.pid, pr.fd, pr.max);
    } catch (e) {
      reply(pr.pid, pr.id, false, String(e.message || e));
      progressed = true;
      continue;
    }
    if (res.status === "again") still.push(pr);
    else {
      reply(pr.pid, pr.id, true, res);
      progressed = true;
    }
  }
  pendingReads = still;
  return progressed;
}

/** Re-attempt parked net accepts after a connection may have been queued.
 *  Returns whether anything advanced. */
function retryPendingAccepts() {
  if (pendingAccepts.length === 0) return false;
  let progressed = false;
  const still = [];
  for (const pa of pendingAccepts) {
    const rec = programs.get(pa.pid);
    if (!rec || rec.done) continue;
    let res;
    try {
      res = kernel.net_accept(pa.pid, pa.listener);
    } catch (e) {
      reply(pa.pid, pa.id, false, String(e.message || e));
      progressed = true;
      continue;
    }
    if (res.status === "again") still.push(pa);
    else {
      reply(pa.pid, pa.id, true, res);
      progressed = true;
    }
  }
  pendingAccepts = still;
  return progressed;
}

// ============================ net egress =====================================
// The ONE way out of this OS. A guest never touches the host's network: it has no
// `fetch` (the program worker deletes it), so anything leaving must come through
// `net_fetch` here, where the kernel decides. That makes egress a kernel policy
// question rather than a per-program habit — every request is routed, recorded,
// and (once a proxy lands) rewritable in one place, the way a real OS owns its
// network namespace.
//
// The boundary is HTTP, not TCP, and that's honest: a browser cannot open a raw
// socket, so the kernel's only means of reaching the outside is the host's `fetch`.
// Loopback is different — that's real byte-moving between guest processes and
// stays in `net_connect`/`net_listen` (INV-1).

/** Recent egress decisions, newest last. A ring: audit, not storage. */
const netLog = [];
const NET_LOG_MAX = 500;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * The kernel's routing table. Today: loopback names never leave (a guest asking to
 * "fetch" one is a bug — it should `connect`), everything else is allowed out.
 * This is the seam a proxy/allowlist hooks into; keep the decision here, not in
 * the caller.
 */
function netRoute({ url }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { action: "deny", reason: "not a URL: " + url };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { action: "deny", reason: "unsupported protocol: " + u.protocol };
  }
  if (LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
    // A loopback address is this OS. It has a real path (net_connect); egress must
    // not quietly resolve it against the HOST's network — that's how `localhost`
    // used to escape and hit the developer's own machine.
    return { action: "deny", reason: "loopback is not egress — use net_connect for " + u.host };
  }
  return { action: "egress" };
}

/** Route one guest HTTP request out of the OS (or refuse it), and record it. */
async function netFetch(pid, req) {
  const { url, method = "GET", headers = [], body } = req || {};
  const entry = { t: Date.now(), pid, method: String(method).toUpperCase(), url: String(url) };
  netLog.push(entry);
  if (netLog.length > NET_LOG_MAX) netLog.shift();

  const decision = netRoute({ url });
  if (decision.action !== "egress") {
    entry.action = "deny";
    entry.error = decision.reason;
    throw new Error(decision.reason);
  }
  entry.action = "egress";
  try {
    const res = await fetch(url, {
      method: entry.method,
      headers: new Headers(headers),
      body: body && body.length ? body : undefined,
      redirect: "follow",
      mode: "cors",
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    entry.status = res.status;
    entry.bytes = buf.length;
    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers],
      body: buf,
      url: res.url,
    };
  } catch (e) {
    entry.error = String((e && e.message) || e);
    throw e;
  }
}

/**
 * The host-side network injector (ADR-021): open a loopback connection to the
 * process listening on `port`, write the raw HTTP/1.1 request bytes, and collect
 * the raw response bytes until the server closes its side. Drives the connection
 * through the ordinary kernel syscalls on the injector pseudo-process, so the
 * kernel needs no host-specific data path. Returns `{ ok, bytes }` or
 * `{ ok:false, error }` (e.g. `ECONNREFUSED` when nothing listens on `port`).
 */
async function injectConnection(port, reqBytes) {
  if (injectorPid < 0) return { ok: false, error: "injector not ready" };
  let conn;
  try {
    conn = kernel.net_connect(injectorPid, port);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  // Deliver the request and wake the server's parked accept + reads. The pipe
  // buffer is bounded (ADR-023), so a large body streams: write what fits, wake
  // the server, and await a drain before writing more.
  for (let off = 0; off < reqBytes.length; ) {
    let eff;
    try {
      eff = kernel.sys_write(injectorPid, conn.wfd, off ? reqBytes.subarray(off) : reqBytes);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    off += eff.nwritten;
    pumpIo();
    if (off < reqBytes.length && eff.nwritten === 0) {
      await new Promise((res) => injectWaiters.push(res)); // full: await a server read
    }
  }
  pumpIo();

  // Read the response until EOF (the request carries `Connection: close`, so the
  // server closes its write end when done). Parks on "again" between server writes.
  const chunks = [];
  for (;;) {
    let r;
    try {
      r = kernel.sys_read(injectorPid, conn.rfd, 1 << 16);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    if (r.status === "data") {
      chunks.push(r.data);
      pumpIo(); // drained capacity: a parked server write may proceed
      continue;
    }
    if (r.status === "eof") break;
    await new Promise((res) => injectWaiters.push(res)); // "again": await advance
  }
  try { kernel.sys_close(injectorPid, conn.wfd); } catch {}
  try { kernel.sys_close(injectorPid, conn.rfd); } catch {}
  pumpIo(); // the closed client ends finalize the pipes for the server

  let n = 0;
  for (const c of chunks) n += c.length;
  const bytes = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return { ok: true, bytes };
}

// Parked synchronous reads (WASI) that would block: re-serviced when data/EOF
// arrives, at which point the response is written to the SAB and the program
// worker's Atomics.wait is released.
let syncPending = [];

function retrySyncPending() {
  if (syncPending.length === 0) return false;
  let progressed = false;
  const still = [];
  for (const item of syncPending) {
    const rec = programs.get(item.pid);
    if (!rec || rec.done) continue;
    let res;
    try {
      res = kernel.sys_read(item.pid, item.req.fd, item.req.max);
    } catch (e) {
      writeResponse(rec.syncSab, -1, { error: String(e.message || e) });
      progressed = true;
      continue;
    }
    if (res.status === "again") still.push(item);
    else {
      writeResponse(rec.syncSab, 0, res.status === "data" ? res.data : new Uint8Array(0));
      progressed = true;
    }
  }
  syncPending = still;
  return progressed;
}

// ---- pipe writes: bounded buffers, parked writers, EPIPE (ADR-023) ----------
//
// The kernel accepts at most a pipe's free capacity per write (a short count,
// `WriteEffect::Pipe`). The remainder parks here:
//  - a *blocking* write (SAB sync channel) keeps the guest thread in
//    `Atomics.wait` until every byte is accepted — POSIX blocking-write
//    semantics; the response carries the full count, so guests never see a
//    short pipe write;
//  - a *fire-and-forget* write (async postMessage — TTY streams, plus any
//    guest without the sync channel) queues its remainder per (pid, fd), and
//    later writes append behind it so per-fd order is preserved.
// Both drain in pumpIo() as readers consume. A write to a pipe whose last
// reader is gone is EPIPE, with the POSIX default disposition: the writer is
// killed with 128+SIGPIPE unless it asked to catch the signal — this is what
// ends `yes | head -1`.

// Parked blocking writes: { pid, fd, bytes, off }.
let syncPendingWrites = [];
// Fire-and-forget overflow, pid → Map(fd → [Uint8Array, ...]).
const asyncWriteQueues = new Map();

const SIGPIPE_EXIT = 128 + 13;

function isEpipe(e) {
  return /errno Pipe\b/.test(String((e && e.message) || e));
}

/** Apply the SIGPIPE disposition to a writer on a broken pipe. Returns true if
 *  the process catches SIGPIPE (caller reports EPIPE to it); false if the
 *  default killed it. */
function breakPipe(pid) {
  if (catches(pid, "SIGPIPE")) {
    deliverSignal(pid, "SIGPIPE");
    return true;
  }
  handleExit(pid, SIGPIPE_EXIT);
  return false;
}

function enqueueAsyncWrite(pid, fd, bytes) {
  let byFd = asyncWriteQueues.get(pid);
  if (!byFd) asyncWriteQueues.set(pid, (byFd = new Map()));
  let q = byFd.get(fd);
  if (!q) byFd.set(fd, (q = []));
  q.push(bytes);
}

/** Re-attempt parked pipe writes after a reader may have drained capacity.
 *  Returns whether anything advanced. */
function retryPendingWrites() {
  let progressed = false;
  if (syncPendingWrites.length > 0) {
    const still = [];
    for (const item of syncPendingWrites) {
      const rec = programs.get(item.pid);
      if (!rec || rec.done) continue;
      let broke = null;
      try {
        while (item.off < item.bytes.length) {
          const eff = kernel.sys_write(item.pid, item.fd, item.bytes.subarray(item.off));
          if (eff.nwritten === 0) break;
          item.off += eff.nwritten;
          progressed = true;
        }
      } catch (e) {
        broke = e;
      }
      if (broke) {
        progressed = true;
        if (!isEpipe(broke)) {
          writeResponse(rec.syncSab, -1, { error: String(broke.message || broke) });
        } else if (item.off > 0) {
          // Some bytes were accepted before the pipe broke: a short write
          // (POSIX); the *next* write will observe EPIPE.
          writeResponse(rec.syncSab, 0, { nwritten: item.off });
        } else if (breakPipe(item.pid)) {
          writeResponse(rec.syncSab, -1, { error: "errno Pipe (64)" });
        }
        continue;
      }
      if (item.off < item.bytes.length) still.push(item);
      else {
        writeResponse(rec.syncSab, 0, { nwritten: item.bytes.length });
        progressed = true;
      }
    }
    syncPendingWrites = still;
  }
  for (const [pid, byFd] of [...asyncWriteQueues]) {
    const rec = programs.get(pid);
    if (!rec || rec.done) {
      asyncWriteQueues.delete(pid);
      continue;
    }
    for (const [fd, q] of [...byFd]) {
      while (q.length > 0) {
        let eff;
        try {
          eff = kernel.sys_write(pid, fd, q[0]);
        } catch (e) {
          if (isEpipe(e)) breakPipe(pid); // no reply channel: bytes are dropped
          q.length = 0;
          progressed = true;
          break;
        }
        if (eff.nwritten === 0) break;
        progressed = true;
        if (eff.nwritten < q[0].length) {
          q[0] = q[0].subarray(eff.nwritten);
          break;
        }
        q.shift();
      }
      if (q.length === 0) byFd.delete(fd);
    }
    if (byFd.size === 0) asyncWriteQueues.delete(pid);
  }
  return progressed;
}

// One pump for every parked-I/O list. Any event that can advance a pipe (a
// write, a read, a close, an exit, an injected connection) calls this; it loops
// until no list advances, so a chain like "parked write fills pipe → parked
// read drains it → write completes" settles in one call. Re-entrant calls
// (e.g. handleExit fired by a SIGPIPE kill mid-pump) fold into the outer loop.
let pumping = false;
function pumpIo() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const advanced =
        // Bitwise-or on purpose: every retry list must run each round (|| would
        // short-circuit and starve the later lists).
        retryPendingWrites() | retryPendingReads() | retrySyncPending() | retryPendingAccepts();
      retryInjectReads(); // promise resolvers; they re-enter via their own awaits
      if (!advanced) break;
    }
  } finally {
    pumping = false;
  }
}

/** Service one synchronous syscall request sitting in a process's SAB. */
function serviceSync(pid) {
  const rec = programs.get(pid);
  if (!rec || rec.done) return;
  let req;
  try {
    req = readRequest(rec.syncSab);
  } catch (e) {
    writeResponse(rec.syncSab, -1, { error: String(e.message || e) });
    return;
  }
  // Stamp the kernel's wall clock before a mutating call so inode mtimes/ctimes
  // reflect real time (the kernel is clock-less per ADR-020).
  if (MUTATING_CALLS.has(req.call)) kernel.setTime(Date.now());
  tracer.record("sync", pid, req.call, traceSumm(req));
  try {
    switch (req.call) {
      case "read": {
        const res = kernel.sys_read(pid, req.fd, req.max);
        if (res.status === "again") {
          syncPending.push({ pid, req }); // park; respond when data/EOF arrives
          return;
        }
        writeResponse(rec.syncSab, 0, res.status === "data" ? res.data : new Uint8Array(0));
        pumpIo(); // a pipe read frees capacity → parked writers may proceed
        break;
      }
      case "write": {
        // Read the payload bytes before writing the response overwrites the SAB.
        const bytes = requestBytes(rec.syncSab);
        let eff;
        try {
          eff = kernel.sys_write(pid, req.fd, bytes);
        } catch (e) {
          if (!isEpipe(e)) throw e; // ordinary errno: outer catch responds
          // Broken pipe: apply the SIGPIPE disposition. If the default killed
          // the process, its worker is gone — no response to write.
          if (breakPipe(pid)) writeResponse(rec.syncSab, -1, { error: "errno Pipe (64)" });
          return;
        }
        // A write to an un-redirected terminal fd streams to the host; a file
        // write just reports nwritten. (Mirrors the async `write` handler.)
        if (eff.target === "stdout") rec.sink.stdout(bytes);
        else if (eff.target === "stderr") rec.sink.stderr(bytes);
        if (eff.target === "pipe" && eff.nwritten < bytes.length) {
          // Pipe full: park the remainder and leave the guest blocked in
          // Atomics.wait until every byte is accepted (POSIX blocking write,
          // ADR-023). The response is written by retryPendingWrites().
          syncPendingWrites.push({ pid, fd: req.fd, bytes, off: eff.nwritten });
          pumpIo();
          return;
        }
        writeResponse(rec.syncSab, 0, { nwritten: eff.nwritten });
        pumpIo(); // a pipe may have gained data → wake parked readers
        break;
      }
      case "open":
        writeResponse(rec.syncSab, 0, { fd: kernel.sys_open(pid, req.path, req.opts || {}) });
        break;
      case "close":
        kernel.sys_close(pid, req.fd);
        writeResponse(rec.syncSab, 0, {});
        // Closing a pipe end finalizes it for the peer: a drained reader now
        // sees EOF, a parked writer EPIPE.
        pumpIo();
        break;
      case "seek":
        writeResponse(rec.syncSab, 0, {
          offset: kernel.sys_seek(pid, req.fd, req.offset, req.whence),
        });
        break;
      case "stat":
        writeResponse(rec.syncSab, 0, kernel.sys_stat(pid, req.path));
        break;
      case "lstat":
        writeResponse(rec.syncSab, 0, kernel.sys_lstat(pid, req.path));
        break;
      case "symlink":
        kernel.sys_symlink(pid, req.target, req.path);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "readlink":
        writeResponse(rec.syncSab, 0, { target: kernel.sys_readlink(pid, req.path) });
        break;
      case "link":
        kernel.sys_link(pid, req.existing, req.path);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "realpath":
        writeResponse(rec.syncSab, 0, { path: kernel.sys_realpath(pid, req.path) });
        break;
      case "watchAdd":
        writeResponse(rec.syncSab, 0, {
          id: kernel.watchAdd(pid, req.path, !!req.recursive),
        });
        break;
      case "watchRemove":
        kernel.watchRemove(pid, req.id);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "readdir":
        writeResponse(rec.syncSab, 0, { entries: kernel.sys_readdir(pid, req.path) });
        break;
      case "mkdir":
        kernel.sys_mkdir(pid, req.path);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "unlink":
        kernel.sys_unlink(pid, req.path);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "rmdir":
        kernel.sys_rmdir(pid, req.path);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "rename":
        kernel.sys_rename(pid, req.from, req.to);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "utimes":
        kernel.sys_utimes(pid, req.path, req.atime, req.mtime);
        writeResponse(rec.syncSab, 0, {});
        break;
      case "execCapture": {
        // node:child_process synchronous forms (execSync/spawnSync/…). The guest
        // thread is parked on Atomics.wait; the shell driver runs async on *this*
        // (kernel) thread — spawning the child worker, servicing its syscalls —
        // and we write the framed { code, stdout, stderr } back when it exits,
        // waking the guest. `input` (this request's payload) is the child's stdin.
        const input = requestBytes(rec.syncSab);
        runCaptured(req.line, input.length ? input : undefined, { env: rec.env, cwd: rec.cwd, ppid: pid })
          .then((res) => writeResponse(rec.syncSab, 0, frameExecResult(res.code, res.stdout, res.stderr)))
          .catch((e) => writeResponse(rec.syncSab, -1, { error: String(e && e.message ? e.message : e) }));
        return; // response is written asynchronously above (no immediate write)
      }
      default:
        writeResponse(rec.syncSab, -1, { error: "unknown sync call: " + req.call });
    }
    if (MUTATING_CALLS.has(req.call)) deliverWatchEvents();
  } catch (e) {
    // A kernel errno (e.g. Noent). The WASI host maps a negative status to an errno.
    writeResponse(rec.syncSab, -1, { error: String(e && e.message ? e.message : e) });
  }
}

// Drain the kernel's pending fs.watch deliveries after a mutation and route each
// to the owning process worker, where its `fs.watch` listener fires (ADR-022).
function deliverWatchEvents() {
  const evs = kernel.drainWatchEvents();
  for (const ev of evs) {
    const rec = programs.get(ev.pid);
    if (rec && rec.worker && !rec.done) {
      rec.worker.postMessage({
        type: MSG.FS_EVENT,
        watchId: ev.watchId,
        eventType: ev.eventType,
        filename: ev.filename,
      });
    }
  }
}

function onProgramMessage(pid, msg) {
  // Any message from the worker is proof of life (ADR-020).
  const rec = programs.get(pid);
  if (rec) {
    rec.lastActivity = Date.now();
    rec.warnedAt = 0;
  }
  switch (msg.type) {
    case MSG.SYSCALL:
      handleSyscall(pid, msg);
      break;
    case MSG.SYNC:
      serviceSync(pid);
      break;
    case MSG.PONG:
      break; // liveness already recorded above
    case MSG.MEM_SAMPLE:
      // Self-reported footprint (soft/sampled, INV-5). Breach → OOM kill.
      if (watchdog.memHighWaterBytes && Number(msg.bytes) > watchdog.memHighWaterBytes) {
        killWithReason(pid, OOM_EXIT, "out of memory");
      }
      break;
    case MSG.PROC_EXIT:
      handleExit(pid, msg.code | 0);
      break;
    case MSG.SIGACTION: {
      let set = caughtSignals.get(pid);
      if (!set) caughtSignals.set(pid, (set = new Set()));
      if (msg.on) set.add(msg.signal);
      else set.delete(msg.signal);
      break;
    }
    case MSG.WORKER_ERROR_REPORT:
      relayWorkerError(pid, { message: msg.message, stack: msg.stack, name: msg.name });
      break;
  }
}

// Relay a worker's uncaught error to its spawner (→ `worker.on('error')`). A no-op
// if `workerPid` isn't a live worker (a normal process reporting is ignored).
function relayWorkerError(workerPid, info) {
  const ctx = workerContexts.get(workerPid);
  const pw = ctx && programs.get(ctx.parentPid);
  if (pw && !pw.done) {
    pw.worker.postMessage({ type: MSG.WORKER_ERROR, threadId: workerPid, ...info });
  }
}

function handleSyscall(pid, msg) {
  const { id, call, args } = msg;
  if (MUTATING_CALLS.has(call)) kernel.setTime(Date.now());
  tracer.record("async", pid, call, traceSumm(args));
  try {
    switch (call) {
      case "write": {
        // Fire-and-forget: no reply channel. Bytes a full pipe does not accept
        // are queued per (pid, fd) and drained by the pump, so nothing is lost
        // and per-fd order holds; EPIPE applies the SIGPIPE disposition.
        const queued = asyncWriteQueues.get(pid)?.get(args.fd);
        if (queued && queued.length > 0) {
          queued.push(args.data); // order behind the parked remainder
          pumpIo();
          break;
        }
        let eff;
        try {
          eff = kernel.sys_write(pid, args.fd, args.data);
        } catch (e) {
          if (!isEpipe(e)) throw e;
          breakPipe(pid); // caught: signal delivered, bytes dropped; else killed
          break;
        }
        const rec = programs.get(pid);
        if (rec) {
          if (eff.target === "stdout") rec.sink.stdout(args.data);
          else if (eff.target === "stderr") rec.sink.stderr(args.data);
        }
        if (eff.target === "pipe" && eff.nwritten < args.data.length) {
          enqueueAsyncWrite(pid, args.fd, args.data.subarray(eff.nwritten));
        }
        pumpIo(); // a pipe may have gained data
        break;
      }
      case "read": {
        const res = kernel.sys_read(pid, args.fd, args.max);
        if (res.status === "again") pendingReads.push({ pid, id, fd: args.fd, max: args.max });
        else {
          reply(pid, id, true, res);
          pumpIo(); // a pipe read frees capacity → parked writers may proceed
        }
        break;
      }
      case "readCancel": {
        // Withdraw this process's parked reads on `fd` (libuv semantics: a
        // paused stdin stops polling). Without this, a stream that paused after
        // its prompt leaves a read parked on the TTY forever — and that stale
        // read swallows the input a later foreground reader (an inherit-stdio
        // child's prompt, e.g. create-vite's) is waiting for. Each withdrawn
        // read resolves with status "cancelled" (distinct from EOF) so the
        // guest pump stops without ending the stream.
        const cancelled = pendingReads.filter((pr) => pr.pid === pid && pr.fd === args.fd);
        pendingReads = pendingReads.filter((pr) => !(pr.pid === pid && pr.fd === args.fd));
        for (const pr of cancelled) reply(pid, pr.id, true, { status: "cancelled" });
        reply(pid, id, true, { cancelled: cancelled.length });
        break;
      }
      case "open":
        reply(pid, id, true, kernel.sys_open(pid, args.path, args.opts || {}));
        break;
      case "close":
        kernel.sys_close(pid, args.fd);
        reply(pid, id, true, null);
        // Closing a pipe end finalizes it for the peer: a drained reader now
        // sees EOF (a downstream guest, or the injector's response reader), a
        // parked writer EPIPE.
        pumpIo();
        break;
      case "readdir":
        reply(pid, id, true, kernel.sys_readdir(pid, args.path));
        break;
      case "isatty":
        reply(pid, id, true, kernel.isatty(pid, args.fd));
        break;
      case "winsize":
        reply(pid, id, true, kernel.tty_get_winsize(kernel.proc_ctty(pid)));
        break;
      // termios (tcgetattr/tcsetattr): a full-screen program flips the line
      // discipline to raw + no-echo so it owns editing and rendering, then
      // restores the flags on exit. `setattr` merges the given keys, so a
      // program can go raw without spelling out every flag.
      case "getattr":
        reply(pid, id, true, kernel.tty_get_attr(kernel.proc_ctty(pid)));
        break;
      case "setattr":
        kernel.tty_set_attr(kernel.proc_ctty(pid), args.attr || {});
        // Going raw makes any already-buffered bytes readable, and a program
        // returning to cooked may have a line waiting — nudge parked reads.
        pumpIo();
        reply(pid, id, true, null);
        break;
      case "stat":
        reply(pid, id, true, kernel.sys_stat(pid, args.path));
        break;
      case "lstat":
        reply(pid, id, true, kernel.sys_lstat(pid, args.path));
        break;
      case "symlink":
        kernel.sys_symlink(pid, args.target, args.path);
        reply(pid, id, true, null);
        break;
      case "readlink":
        reply(pid, id, true, kernel.sys_readlink(pid, args.path));
        break;
      case "link":
        kernel.sys_link(pid, args.existing, args.path);
        reply(pid, id, true, null);
        break;
      case "realpath":
        reply(pid, id, true, kernel.sys_realpath(pid, args.path));
        break;
      case "mkdir":
        kernel.sys_mkdir(pid, args.path);
        reply(pid, id, true, null);
        break;
      case "unlink":
        kernel.sys_unlink(pid, args.path);
        reply(pid, id, true, null);
        break;
      case "rmdir":
        kernel.sys_rmdir(pid, args.path);
        reply(pid, id, true, null);
        break;
      case "rename":
        kernel.sys_rename(pid, args.from, args.to);
        reply(pid, id, true, null);
        break;
      case "utimes":
        kernel.sys_utimes(pid, args.path, args.atime, args.mtime);
        reply(pid, id, true, null);
        break;
      // ---- otf:net_* — port-keyed loopback sockets (ADR-021) ----
      case "net_listen":
        // Returns { listener, port }; port is the bound port (assigned when the
        // guest asked for 0), reported back for server.address().
        reply(pid, id, true, kernel.net_listen(pid, args.port));
        break;
      case "net_close":
        // In-process `server.close()`: free the listener's port now (not just on
        // reap), so a probe-then-rebind on the same port doesn't hit EADDRINUSE.
        kernel.net_close(pid, args.listener);
        reply(pid, id, true, {});
        break;
      case "net_connect": {
        const conn = kernel.net_connect(pid, args.port);
        reply(pid, id, true, conn);
        // A connection is now queued on the listener's backlog — wake any accept
        // parked on it (guest server, or the host injector's own accept).
        retryPendingAccepts();
        break;
      }
      case "net_accept": {
        const res = kernel.net_accept(pid, args.listener);
        if (res.status === "again") pendingAccepts.push({ pid, id, listener: args.listener });
        else reply(pid, id, true, res);
        break;
      }
      // The only way out of the OS: the kernel routes/records it, the guest never
      // touches the host's network itself.
      case "net_fetch":
        netFetch(pid, args)
          .then((res) => reply(pid, id, true, res))
          .catch((e) => reply(pid, id, false, String((e && e.message) || e)));
        break; // reply happens asynchronously above
      case "exec": {
        // system(3)-style: run a command line via the shell driver and route its
        // output to the caller's process streams. Replies with the exit code when
        // the sub-command finishes (async).
        const rec = programs.get(pid);
        const sink = rec
          ? rec.sink
          : { stdout: () => {}, stderr: () => {} };
        systemShell
          .exec(args.line, sink, undefined, rec && { env: rec.env, cwd: rec.cwd, ppid: pid })
          .then((code) => reply(pid, id, true, code | 0))
          .catch((e) => reply(pid, id, false, String(e && e.message ? e.message : e)));
        break; // reply happens asynchronously above
      }
      case "spawnChild": {
        // node:child_process streaming spawn: launch `argv` as a real child whose
        // exit posts CHILD_EXIT. Each stdio fd follows the caller's `args.stdio`
        // plan (Node semantics), per descriptor:
        //   • 'pipe'    — stdout/stderr stream *incrementally* back to this (parent)
        //                 worker as CHILD_STDOUT/CHILD_STDERR; stdin is a temp VFS
        //                 file seeded from `args.input` (empty ⇒ clean EOF).
        //   • 'inherit' — the child shares this controlling terminal: its output
        //                 goes straight to the display and its stdin reads the TTY,
        //                 so an interactive tool (e.g. `create-vite`, run via npm's
        //                 stdio:'inherit' path) can prompt. It joins the foreground
        //                 pipeline so ^C reaches it and termios is restored on exit.
        //   • 'ignore'  — output discarded; stdin is an immediate EOF.
        // cwd/env come straight from the caller (no shell).
        const stdio = args.stdio || ["pipe", "pipe", "pipe"];
        const parentRec = programs.get(pid);
        const parentWorker = parentRec && parentRec.worker;
        // A stdio:'inherit' child shares the parent's controlling terminal — route
        // its output to that terminal's display (multi-terminal aware).
        const parentTty = terminalFor(kernel.proc_ctty(pid), false);

        // stdin: 'inherit' reads the terminal directly; otherwise a temp VFS file
        // (seeded from `input` for a pipe, empty for 'ignore') gives a clean EOF.
        let stdin = { kind: "inherit" };
        let tmp = null;
        if (stdio[0] !== "inherit") {
          tmp = "/tmp/.cp-in-" + childTmpSeq++;
          const seed = stdio[0] === "pipe" && args.input && args.input.length ? args.input : new Uint8Array(0);
          try {
            kernel.fs_write(tmp, seed);
            stdin = { kind: "file", path: tmp, mode: "read" };
          } catch { tmp = null; /* /tmp missing → fall back to the terminal */ }
        }
        const plan = { stdin, stdout: { kind: "inherit" }, stderr: { kind: "inherit" } };
        const cleanup = () => { if (tmp) { try { kernel.sys_unlink(pid, tmp); } catch {} } };
        let spawned;
        try {
          // ctty=null: inherit the parent's controlling terminal, so an 'inherit'
          // child's isatty/stdin/foreground track the parent's terminal (multi-PTY).
          spawned = spawnKernel(args.argv, args.env || {}, args.cwd || systemSession.cwd, plan, { ppid: pid, ctty: null });
        } catch (e) {
          cleanup();
          reply(pid, id, false, String(e && e.message ? e.message : e));
          break;
        }
        const childPid = spawned.pid;
        // A terminal-reading child joins its parent's process group (spawn
        // inherited it, ADR-025), so if the parent is the foreground job the
        // child gets ^C + the termios restore on exit automatically.
        // Per-fd output routing: 'inherit' → the terminal display; 'pipe' → the
        // parent worker's child streams; 'ignore' → dropped.
        const route = (fd, msgType) => {
          const mode = stdio[fd];
          if (mode === "inherit") return (b) => parentTty && parentTty.out(crlf(b));
          if (mode === "ignore") return () => {};
          return (b) => parentWorker && parentWorker.postMessage({ type: msgType, pid: childPid, data: b });
        };
        const sink = { stdout: route(1, MSG.CHILD_STDOUT), stderr: route(2, MSG.CHILD_STDERR) };
        startWorker(spawned, {
          argv: args.argv,
          env: args.env || {},
          cwd: args.cwd || systemSession.cwd,
          sink,
          onExit: (code) => {
            cleanup();
            if (parentWorker) parentWorker.postMessage({ type: MSG.CHILD_EXIT, pid: childPid, code: code | 0 });
          },
        });
        reply(pid, id, true, { pid: childPid });
        break;
      }
      case "childKill": {
        // node:child_process kill() / worker_threads terminate(): signal a spawned
        // child. Mirrors the client MSG.KILL path — a delivered signal hard-exits
        // the process (128+signal).
        const sig = args.signal | 0;
        const delivered = kernel.kill(args.pid, sig);
        if (delivered) handleExit(args.pid, 128 + sig);
        reply(pid, id, true, delivered);
        break;
      }
      case "spawnWorker": {
        // node:worker_threads Worker: spawn `/bin/node <file>` (or `-e <code>`) as a
        // real child thread. Its stdout/stderr go to the *parent's* sink (a worker's
        // console output surfaces on the parent's stdout, Node's default); messages
        // travel over `workerPost`, not stdio. Record the worker context so the child
        // can answer `workerInit` and its child→parent messages can be routed.
        const parentRec = programs.get(pid);
        const argv = args.eval ? ["node", "-e", args.file] : ["node", args.file, ...(args.argv || [])];
        const env = args.env || (parentRec && parentRec.env) || {};
        const cwd = args.cwd || systemSession.cwd;
        let spawned;
        try {
          spawned = spawnKernel(argv, env, cwd, null);
        } catch (e) {
          reply(pid, id, false, String(e && e.message ? e.message : e));
          break;
        }
        const workerPid = spawned.pid;
        workerContexts.set(workerPid, { parentPid: pid, workerData: args.workerData ?? null, threadId: workerPid });
        // Register the spawn token *now*, before this syscall returns: the parent
        // may post to the worker before our reply reaches it (it may never reach
        // it — a parent that blocks after posting), and those messages arrive
        // addressed by token.
        const tokenKey = args.token === undefined ? null : `${pid}:${args.token}`;
        if (tokenKey) workerTokens.set(tokenKey, workerPid);
        const parentWorker = parentRec && parentRec.worker;
        startWorker(spawned, {
          argv,
          env,
          cwd,
          sink: (parentRec && parentRec.sink) || { stdout: () => {}, stderr: () => {} },
          onExit: (code) => {
            if (tokenKey) workerTokens.delete(tokenKey);
            if (parentWorker) parentWorker.postMessage({ type: MSG.WORKER_EXIT, threadId: workerPid, code: code | 0 });
          },
        });
        reply(pid, id, true, { threadId: workerPid });
        break;
      }
      case "workerInit": {
        // A starting /bin/node asks whether it is a worker (and if so, its data).
        const ctx = workerContexts.get(pid);
        reply(pid, id, true, ctx
          ? { isMainThread: false, threadId: ctx.threadId, workerData: ctx.workerData }
          : { isMainThread: true, threadId: 0, workerData: null });
        break;
      }
      case "workerPost": {
        // Relay a structured-clone message. From a worker (`to === "parent"`) →
        // route to its spawner as coming from thread 0; from the main side (`to` is a
        // worker's threadId, or `{ token }` for one whose threadId the parent hasn't
        // learned yet) → route to that worker as coming from the parent (0).
        if (args.to === "parent") {
          const ctx = workerContexts.get(pid);
          const pw = ctx && programs.get(ctx.parentPid);
          if (pw && !pw.done) pw.worker.postMessage({ type: MSG.WORKER_MESSAGE, threadId: pid, data: args.data });
        } else {
          const target = args.to && typeof args.to === "object"
            ? workerTokens.get(`${pid}:${args.to.token}`)
            : args.to | 0;
          const cw = target !== undefined && programs.get(target);
          if (cw && !cw.done) cw.worker.postMessage({ type: MSG.WORKER_MESSAGE, threadId: 0, data: args.data });
        }
        break; // fire-and-forget: no reply
      }
      default:
        reply(pid, id, false, "unknown syscall: " + call);
    }
    if (MUTATING_CALLS.has(call)) deliverWatchEvents();
  } catch (e) {
    if (id !== undefined) reply(pid, id, false, String(e.message || e));
  }
}

// ---- main-thread control ---------------------------------------------------

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case MSG.BOOT: {
        await init({ module_or_path: msg.wasmUrl });
        kernel = WebKernel.boot();
        // The network injector's pseudo-process (ADR-021): host-side endpoint the
        // Service Worker's preview requests are driven through.
        injectorPid = kernel.register_host_process();
        // Install the coreutils into /sbin (system binaries, kept apart from the
        // /bin OS programs) so the shell can resolve them via PATH. Each ships as
        // a single self-contained bundle (esbuild inlined its one shared import,
        // the CLI arg parser), fetched same-origin like the /bin programs.
        for (const util of bundledCoreutils) {
          const data = await util.source();
          kernel.fs_write(util.path, enc.encode(data));
        }
        // Install the OS programs (npm, …) into /bin. Everything at once for now;
        // a selectable install manifest is future work. Each program's source is
        // loaded on demand (js text is fetched same-origin; wasm would be bytes).
        for (const prog of osPrograms) {
          const data = await prog.source();
          if (data == null) continue; // a wasm program not built in this environment
          kernel.fs_write(prog.bin, typeof data === "string" ? enc.encode(data) : new Uint8Array(data));
          // A multicall binary (e.g. the uutils coreutils tier) installs once and
          // gets a /bin symlink per utility name; it dispatches on argv[0].
          for (const name of prog.links || []) {
            try { kernel.sys_symlink(injectorPid, prog.bin, "/bin/" + name); } catch { /* exists */ }
          }
        }
        // Install the guest runtime library (/lib/workeros-node): the CommonJS
        // runtime + node: builtins that /bin/node imports at load time (INV-2).
        for (const lib of osLibraries) {
          const data = await lib.source();
          if (data == null) continue; // an optional binary lib (codec.wasm) not built here
          kernel.fs_write(lib.path, typeof data === "string" ? enc.encode(data) : new Uint8Array(data));
        }
        // Ship the default system profile. Sourced by the login shell at startup
        // (shell-exec `sourceProfile`), it puts npm's global `.bin` on PATH so
        // `npm install -g` binaries run as bare commands — the userland way to
        // extend PATH, leaving the kernel resolver at /bin:/sbin (INV-1). `/etc`
        // is an OS-owned ephemeral tree (mount.rs), so this is reshipped every
        // boot (an upgraded default reaches existing sessions); user overrides
        // that persist go in ~/.profile, which sourceProfile also reads.
        kernel.fs_write(
          "/etc/profile",
          enc.encode(
            "# /etc/profile — system-wide shell startup (sourced by the login shell).\n" +
              "# Puts npm's global bin dir on PATH so `npm install -g` binaries run as\n" +
              "# bare commands. This file is OS-shipped and reset each boot; put your\n" +
              "# own persistent overrides in ~/.profile.\n" +
              "export PATH=/.node_modules/.bin:$PATH\n",
          ),
        );
        // Restore the durable filesystem (ADR-022) on top of the freshly
        // installed OS, from the content-addressed block store. The manifest
        // holds only persistent paths (the OS trees /bin,/sbin,/lib and /tmp are
        // ephemeral, so they never conflict). Chunks are loaded (integrity-
        // checked by hash) before the manifest references them.
        persistence = await openPersistence();
        try {
          const manifest = await persistence.loadManifest();
          if (manifest && manifest.length) {
            for (const hex of await persistence.allChunkKeys()) {
              const bytes = await persistence.getChunk(hex);
              if (!bytes) continue;
              const got = kernel.loadChunk(bytes);
              if (got !== hex) {
                console.warn(`[workeros] chunk ${hex} failed integrity (got ${got}); skipping`);
              }
            }
            kernel.hydrateManifest(manifest);
            // Re-register retained snapshots on top (their chunks were loaded
            // above, part of the live set). Ignored if none were stored.
            const snaps = await persistence.loadSnapshots();
            if (snaps && snaps.length) kernel.snapshotImport(snaps);
          }
        } catch (err) {
          console.warn("[workeros] hydrate failed:", err && err.message);
        }
        // Baseline the mutation counter *after* all boot writes + hydration so we
        // don't immediately re-persist the just-restored state; only genuine user
        // changes from here advance it. Then start the write-behind timer.
        lastPersistedGen = kernel.fsGeneration();
        lastAutoSnap = Date.now(); // first auto-snapshot is one interval out
        setInterval(persistNow, AUTOSAVE_MS);
        // Start the watchdog (INV-6, ADR-020). Host overrides (embedder policy,
        // tests) ride the boot message; defaults mirror limits.rs WATCHDOG.
        if (msg.watchdog) Object.assign(watchdog, msg.watchdog);
        setInterval(watchdogTick, watchdog.sampleMs);
        systemShell = createShell({ kernel, startProcess, session: systemSession, readLine: async () => null });
        // Apply the login profiles (PATH etc.) before any command can run, so
        // both the interactive REPL and programmatic exec see the global bin dir.
        await systemShell.sourceProfile();
        post({ type: MSG.BOOTED, version: kernel.version, abi: kernel.abi });
        break;
      }

      case MSG.FS_WRITE:
        kernel.fs_write(msg.path, msg.data);
        post({ type: MSG.FS_WRITE, id: msg.id, ok: true });
        break;

      case MSG.FS_READ: {
        const data = kernel.fs_read(msg.path);
        post({ type: MSG.FS_READ, id: msg.id, data });
        break;
      }

      case MSG.FS_READDIR: {
        // Host-side directory read, attributed to the registered injector process
        // (the same host pid the completion/preview paths use for sys_readdir).
        if (injectorPid < 0) {
          post({ type: MSG.ERROR, id: msg.id, error: "kernel not ready" });
          break;
        }
        try {
          const entries = kernel.sys_readdir(injectorPid, msg.path);
          post({ type: MSG.FS_READDIR, id: msg.id, entries });
        } catch (e) {
          post({ type: MSG.ERROR, id: msg.id, error: String(e?.message || e) });
        }
        break;
      }

      case MSG.FS_MKDIR: {
        // `mkdir -p`: create each missing ancestor, ignoring ones that already
        // exist as directories. Attributed to the injector host process.
        if (injectorPid < 0) { post({ type: MSG.ERROR, id: msg.id, error: "kernel not ready" }); break; }
        try {
          const comps = String(msg.path).split("/").filter(Boolean);
          let cur = "";
          for (const c of comps) {
            cur += "/" + c;
            try {
              kernel.sys_mkdir(injectorPid, cur);
            } catch (e) {
              // Tolerate an existing directory; rethrow anything else.
              try { kernel.sys_readdir(injectorPid, cur); } catch { throw e; }
            }
          }
          post({ type: MSG.FS_MKDIR, id: msg.id, ok: true });
        } catch (e) {
          post({ type: MSG.ERROR, id: msg.id, error: String(e?.message || e) });
        }
        break;
      }

      case MSG.FS_REMOVE: {
        // `rm -r`: unlink a file, or recursively empty and remove a directory.
        if (injectorPid < 0) { post({ type: MSG.ERROR, id: msg.id, error: "kernel not ready" }); break; }
        const removeRec = (p) => {
          let entries = null;
          try { entries = kernel.sys_readdir(injectorPid, p); } catch { entries = null; }
          if (entries !== null) {
            for (const e of entries) removeRec((p === "/" ? "" : p) + "/" + e.name);
            kernel.sys_rmdir(injectorPid, p);
          } else {
            kernel.sys_unlink(injectorPid, p);
          }
        };
        try {
          removeRec(String(msg.path));
          post({ type: MSG.FS_REMOVE, id: msg.id, ok: true });
        } catch (e) {
          post({ type: MSG.ERROR, id: msg.id, error: String(e?.message || e) });
        }
        break;
      }

      case MSG.FS_RENAME: {
        if (injectorPid < 0) { post({ type: MSG.ERROR, id: msg.id, error: "kernel not ready" }); break; }
        try {
          kernel.sys_rename(injectorPid, msg.from, msg.to);
          post({ type: MSG.FS_RENAME, id: msg.id, ok: true });
        } catch (e) {
          post({ type: MSG.ERROR, id: msg.id, error: String(e?.message || e) });
        }
        break;
      }

      // Opt-in tracing control (debugging). Toggle the tracer, read the recent
      // event ring buffer, and/or snapshot the live process table — then reply.
      case MSG.TRACE: {
        if (msg.on !== undefined) tracer.on = !!msg.on;
        const events = msg.dump ? tracer.buf.slice(-(msg.limit || tracer.max)) : undefined;
        let procs;
        if (msg.procs) { try { procs = kernel.list_processes(); } catch { procs = null; } }
        if (msg.clear) { tracer.buf = []; tracer.seq = 0; }
        post({ type: MSG.TRACE_RESULT, id: msg.id, on: tracer.on, events, procs });
        break;
      }

      case MSG.FS_FLUSH:
        // Best-effort durable flush (tab hidden/closing). Awaited so a caller
        // that can delay unload (visibilitychange) gives the write a chance.
        await persistNow();
        if (msg.id != null) post({ type: MSG.FS_FLUSH, id: msg.id, ok: true });
        break;

      case MSG.SPAWN: {
        const spawned = spawnKernel(msg.argv, msg.env, msg.cwd || systemSession.cwd, null, { caps: msg.caps });
        const pid = spawned.pid;
        const sink = {
          stdout: (b) => post({ type: MSG.STDOUT, pid, data: b }),
          stderr: (b) => post({ type: MSG.STDERR, pid, data: b }),
        };
        startWorker(spawned, {
          argv: msg.argv,
          env: msg.env || {},
          cwd: msg.cwd || systemSession.cwd,
          sink,
          onExit: (code) => post({ type: MSG.EXIT, pid, code }),
        });
        post({ type: MSG.SPAWNED, id: msg.id, pid });
        break;
      }

      case MSG.EXEC: {
        const execId = msg.id;
        const sink = {
          stdout: (b) => post({ type: MSG.EXEC_STDOUT, execId, data: b }),
          stderr: (b) => post({ type: MSG.EXEC_STDERR, execId, data: b }),
        };
        systemShell
          .exec(msg.line, sink)
          .then((code) => post({ type: MSG.EXEC_DONE, execId, code, cwd: systemSession.cwd }))
          .catch((e) => {
            sink.stderr(enc.encode(String(e && e.stack ? e.stack : e) + "\n"));
            post({ type: MSG.EXEC_DONE, execId, code: 1, cwd: systemSession.cwd });
          });
        break;
      }

      case MSG.PS:
        post({ type: MSG.PS_RESULT, id: msg.id, procs: kernel.list_processes() });
        break;

      case MSG.NET_LOG:
        post({ type: MSG.NET_LOG_RESULT, id: msg.id, entries: netLog.slice() });
        break;

      case MSG.KILL: {
        const signal = msg.signal ?? 9;
        if (kernel.kill(msg.pid, signal)) handleExit(msg.pid, 128 + signal);
        break;
      }

      case MSG.STDIN:
        tracer.record("stdin", msg.pid, "feed", `bytes=${msg.data?.length ?? 0}`);
        kernel.feed_stdin(msg.pid, msg.data);
        pumpIo();
        break;

      case MSG.PREVIEW_REQUEST: {
        // A Service-Worker preview request (ADR-021): inject the raw HTTP bytes
        // into the process listening on `msg.port`, stream the response back.
        const result = await injectConnection(msg.port, msg.bytes);
        post({
          type: MSG.PREVIEW_RESPONSE,
          id: msg.id,
          ok: result.ok,
          bytes: result.ok ? result.bytes : undefined,
          error: result.ok ? undefined : result.error,
        });
        break;
      }

      case MSG.TERM_OPEN: {
        // Allocate a fresh controlling terminal (an additional xterm window) and
        // its shell session. Reply with the kernel tty id the client tags all
        // subsequent input/resize/start/close for this terminal with.
        const ttyId = kernel.tty_open();
        terminalFor(ttyId, true);
        post({ type: MSG.TERM_OPENED, id: msg.id, session: ttyId });
        break;
      }

      case MSG.TTY_INPUT: {
        // The legacy single-terminal client omits `session` → the primary tty.
        const t = terminalFor(msg.session || PRIMARY_TTY, true);
        // While the shell prompt is being edited, the REPL owns the terminal in
        // raw mode: keystrokes go straight to the line editor (its own echo +
        // editing), bypassing the kernel's cooked discipline.
        if (t.activeReadline) {
          t.activeReadline.feed(msg.data);
          break;
        }
        // Otherwise a program (or the `read` builtin) is reading: run keystrokes
        // through the kernel cooked line discipline (echo + control-key signals).
        const res = kernel.tty_input(t.ttyId, msg.data);
        t.out(res.echo);
        if (res.signal === "int") t.onInterrupt();
        else if (res.signal === "susp") t.onSusp();
        // A committed line may now unblock a foreground program's read, or the
        // `read` builtin waiting on the prompt.
        pumpIo();
        t.pumpWaiter();
        break;
      }

      case MSG.RESIZE: {
        const t = terminalFor(msg.session || PRIMARY_TTY, true);
        kernel.tty_set_winsize(t.ttyId, msg.rows | 0, msg.cols | 0);
        // Re-wrap the shell prompt at the new width if it's being edited.
        if (t.activeReadline) t.activeReadline.resize();
        // Notify the foreground process(es) so a TUI can re-layout. Default
        // disposition is ignore, so a program without a handler is unaffected.
        for (const pid of t.fgMembers()) deliverSignal(pid, "SIGWINCH");
        break;
      }

      case MSG.TERM_START: {
        // Start (idempotently) the REPL for this terminal — primary by default.
        terminalFor(msg.session || PRIMARY_TTY, true).start();
        break;
      }

      case MSG.TERM_CLOSE: {
        // The window closed: stop reading, kill its foreground job, release the
        // kernel tty, and drop the session. The primary terminal is permanent.
        const ttyId = msg.session || PRIMARY_TTY;
        const t = terminals.get(ttyId);
        if (t) {
          for (const pid of t.fgMembers()) handleExit(pid, 129); // SIGHUP-ish
          if (t.termWaiter) { const w = t.termWaiter; t.termWaiter = null; w.resolve(null); }
        }
        if (ttyId !== PRIMARY_TTY) {
          kernel.tty_close(ttyId);
          terminals.delete(ttyId);
        }
        break;
      }

      default:
        post({ type: MSG.ERROR, error: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    post({ type: MSG.ERROR, id: msg.id, error: String(err && err.stack ? err.stack : err) });
  }
};
