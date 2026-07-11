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
import { coreutils } from "../../workeros-coreutils/src/index.js";
import { programs as osPrograms, libraries as osLibraries } from "../../workeros-programs/src/index.js";
import { allocSyncBuffer, readRequest, requestBytes, writeResponse } from "./sync-syscall.js";
import { frameExecResult } from "./exec-frame.js";
import { openPersistence } from "./persistence.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
let kernel = null;
let shell = null;

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

// Syscalls that mutate the filesystem — before servicing one we stamp the kernel
// clock (ADR-020) so the resulting inode mtimes/ctimes are real wall-clock times.
const MUTATING_CALLS = new Set([
  "write", "open", "mkdir", "unlink", "rmdir", "rename", "symlink", "link",
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

// The interactive shell session state (cwd/env), persisted across exec lines.
// TERM/COLORTERM advertise the host xterm's ANSI color support so color-detecting
// tools (chalk's supports-color, etc.) light up 24-bit color instead of falling
// back to plain text on a TTY.
const session = {
  cwd: "/",
  env: { HOME: "/", PATH: "/bin:/sbin", TERM: "xterm-256color", COLORTERM: "truecolor" },
};

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

// ---- interactive terminal (the kernel-owned TTY REPL) ----------------------
// The controlling terminal is a single stream to the host (xterm). The kernel
// owns the line discipline (echo/editing); this side runs the shell prompt loop
// and delivers control-key signals to the foreground pipeline.
const INTERRUPT = Symbol("tty-interrupt");
let termStarted = false;
let execRunning = false; // a foreground command is running under the REPL
let termWaiter = null; // { resolve } awaiting the next committed input line
const foreground = new Set(); // pids of the current foreground pipeline (for ^C)
const history = []; // interactive command history (for the readline prompt)
let activeReadline = null; // the line editor while the prompt is being edited
const caughtSignals = new Map(); // pid → Set<signal> the guest installed a handler for
// node:worker_threads: pid → { parentPid, workerData, threadId } for a process
// spawned as a Worker. Lets a worker answer `workerInit` (am I a worker? my data)
// and lets `workerPost` route a child→parent message to the right spawner.
const workerContexts = new Map();

// Deliver a cooperative signal to a live JS program (posted to its worker).
function deliverSignal(pid, signal) {
  const rec = programs.get(pid);
  if (rec && !rec.done) rec.worker.postMessage({ type: MSG.SIGNAL, signal });
}

// Whether a process asked to catch `signal` (vs. taking the default disposition).
function catches(pid, signal) {
  return caughtSignals.get(pid)?.has(signal) ?? false;
}

// Send bytes to the terminal display (main thread → xterm).
function termOut(bytes) {
  if (bytes && bytes.length) post({ type: MSG.TERM_OUTPUT, data: bytes });
}

// Resolve a parked line-waiter if a full line has cleared the line discipline.
function pumpWaiter() {
  if (!termWaiter) return;
  const line = kernel.tty_read_line(); // Uint8Array, or null if no full line yet
  if (line != null) {
    const w = termWaiter;
    termWaiter = null;
    w.resolve(line);
  }
}

// Await the next committed input line (the REPL prompt and the shell `read`
// builtin share this). Resolves with the line bytes, or INTERRUPT on ^C.
function waitForLine() {
  return new Promise((resolve) => {
    termWaiter = { resolve };
    pumpWaiter();
  });
}

// A ^C from the line discipline: interrupt the foreground pipeline if one is
// running, else cancel the line being typed at the prompt. A foreground process
// that installed a SIGINT handler receives it cooperatively (and keeps running);
// one that did not is hard-killed with the conventional 130 (128 + SIGINT).
function onInterrupt() {
  if (execRunning) {
    for (const pid of [...foreground]) {
      if (catches(pid, "SIGINT")) deliverSignal(pid, "SIGINT");
      else handleExit(pid, 130);
    }
    if (termWaiter) {
      const w = termWaiter;
      termWaiter = null;
      w.resolve(INTERRUPT); // unblock a `read` builtin so it doesn't hang
    }
  } else if (termWaiter) {
    const w = termWaiter;
    termWaiter = null;
    w.resolve(INTERRUPT);
  }
}

// A ^Z from the line discipline. WorkerOS has no job-control suspend yet, so the
// default disposition is *ignore* (not stop); a foreground process that installed
// a SIGTSTP handler is told, and can act on it.
function onSusp() {
  for (const pid of [...foreground]) {
    if (catches(pid, "SIGTSTP")) deliverSignal(pid, "SIGTSTP");
  }
}

function prompt() {
  return `${session.cwd === "/" ? "/" : session.cwd} $ `;
}

// Read one command line through the raw-mode line editor (history + cursor
// editing). Resolves with the editor's result: a submitted line, an abort (^C),
// or EOF (^D on an empty line).
function readCommandLine() {
  return new Promise((resolve) => {
    const editor = createLineEditor({
      prompt: prompt(),
      history,
      write: (s) => termOut(enc.encode(s)),
      columns: () => (kernel.tty_get_winsize() || {}).cols || 80,
      done: (r) => { activeReadline = null; resolve(r); },
    });
    activeReadline = editor;
    editor.start();
  });
}

// The interactive read-eval-print loop, reading command lines from the TTY.
async function repl() {
  for (;;) {
    const res = await readCommandLine();
    if (res.aborted || res.eof) continue; // ^C / ^D on empty → fresh prompt
    const line = res.line;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Record non-empty lines in history, collapsing immediate duplicates.
    if (history[history.length - 1] !== line) history.push(line);
    // Two conveniences the browser page used to own; now terminal-side. `clear`
    // is an ANSI screen wipe; `ps` formats the live process table.
    if (trimmed === "clear") {
      termOut(enc.encode("\x1b[2J\x1b[H"));
      continue;
    }
    if (trimmed === "ps") {
      const rows = kernel
        .list_processes()
        .map((p) => `${String(p.pid).padStart(4)} ${p.state.padEnd(8)} ${p.argv.join(" ")}`);
      termOut(enc.encode((rows.join("\r\n") || "(no live processes)") + "\r\n"));
      continue;
    }
    execRunning = true;
    try {
      await shell.exec(line, termSink);
    } catch (e) {
      termOut(enc.encode("wsh: " + (e && e.message ? e.message : e) + "\r\n"));
    } finally {
      execRunning = false;
    }
  }
}

// The REPL's output sink: program stdout/stderr both flow to the single terminal
// stream. \n is normalized to \r\n so a bare-LF program lands the cursor at col 0.
const crlf = (b) => {
  const s = dec.decode(b);
  return s.includes("\n") && !s.includes("\r\n") ? enc.encode(s.replace(/\n/g, "\r\n")) : b;
};
const termSink = { stdout: (b) => termOut(crlf(b)), stderr: (b) => termOut(crlf(b)) };

// The shell `read` builtin / prompts read a line from the terminal. Returns the
// line text (newline stripped), or null on EOF / ^C.
async function readLineFromTty() {
  const b = await waitForLine();
  if (b === INTERRUPT || b == null) return null;
  return dec.decode(b).replace(/\n$/, "");
}

const PROGRAM_WORKER_URL = new URL("./program-worker.js", import.meta.url);

function post(msg) {
  self.postMessage(msg);
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
function runCaptured(line, input) {
  const outChunks = [];
  const errChunks = [];
  const sink = { stdout: (b) => outChunks.push(b), stderr: (b) => errChunks.push(b) };
  return shell.exec(line, sink, input).then((code) => ({
    code: code | 0,
    stdout: concatChunks(outChunks),
    stderr: concatChunks(errChunks),
  }));
}

// ---- process lifecycle -----------------------------------------------------

function spawnKernel(argv, env, cwd, plan) {
  return kernel.spawn(argv, Object.entries(env || {}), cwd, Date.now(), 0, plan || null);
}

function startWorker(spawned, { argv, env, cwd, sink, onExit }) {
  const worker = new Worker(PROGRAM_WORKER_URL, { type: "module" });
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  // Per-process synchronous-syscall buffer (used by WASI blocking calls; ADR-010).
  const syncSab = allocSyncBuffer();
  programs.set(spawned.pid, { worker, sink, onExit, resolveExit, done: false, syncSab });
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
    argv,
    env,
    cwd,
    pid: spawned.pid,
    graph: spawned.graph,
    syncSab,
  });
  return exited;
}

/** Used by the shell driver: spawn one command with a stdio plan + sink. */
function startProcess({ argv, env, cwd, plan, sink }) {
  const spawned = spawnKernel(argv, env, cwd, plan);
  // Shell-run programs form the terminal's foreground pipeline, so ^C can
  // interrupt them. (Client `spawn` uses startWorker directly and is not tracked.)
  foreground.add(spawned.pid);
  const exited = startWorker(spawned, { argv, env, cwd, sink, onExit: () => {} });
  return { pid: spawned.pid, exited };
}

/** Tear a process down once: mark exited, unblock downstream, reap, terminate. */
function handleExit(pid, code) {
  const rec = programs.get(pid);
  if (!rec || rec.done) return;
  rec.done = true;
  kernel.mark_exited(pid, code); // idempotent; closes its pipe/file fds → EOF downstream
  kernel.watchClosePid(pid); // drop this process's fs.watch registrations
  retryPendingReads(); // downstream pipe readers may now see EOF
  retrySyncPending();
  retryInjectReads(); // an injected preview connection may now see EOF/data
  kernel.reap(pid);
  rec.worker.terminate();
  programs.delete(pid);
  const wasForeground = foreground.delete(pid);
  // Safety net: if the foreground program left the TTY raw (e.g. an editor that
  // was killed before restoring termios), put it back to cooked so the shell
  // prompt is usable again. A well-behaved program restores it itself; this only
  // covers the crash/kill path.
  if (wasForeground && foreground.size === 0) {
    kernel.tty_set_attr({ canonical: true, echo: true, isig: true });
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

/** Re-attempt parked pipe reads after the pipe state may have changed. */
function retryPendingReads() {
  if (pendingReads.length === 0) return;
  const still = [];
  for (const pr of pendingReads) {
    const rec = programs.get(pr.pid);
    if (!rec || rec.done) continue;
    let res;
    try {
      res = kernel.sys_read(pr.pid, pr.fd, pr.max);
    } catch (e) {
      reply(pr.pid, pr.id, false, String(e.message || e));
      continue;
    }
    if (res.status === "again") still.push(pr);
    else reply(pr.pid, pr.id, true, res);
  }
  pendingReads = still;
}

/** Re-attempt parked net accepts after a connection may have been queued. */
function retryPendingAccepts() {
  if (pendingAccepts.length === 0) return;
  const still = [];
  for (const pa of pendingAccepts) {
    const rec = programs.get(pa.pid);
    if (!rec || rec.done) continue;
    let res;
    try {
      res = kernel.net_accept(pa.pid, pa.listener);
    } catch (e) {
      reply(pa.pid, pa.id, false, String(e.message || e));
      continue;
    }
    if (res.status === "again") still.push(pa);
    else reply(pa.pid, pa.id, true, res);
  }
  pendingAccepts = still;
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
  // Deliver the request and wake the server's parked accept + reads.
  try {
    kernel.sys_write(injectorPid, conn.wfd, reqBytes);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  retryPendingAccepts();
  retryPendingReads();
  retrySyncPending();

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
    if (r.status === "data") { chunks.push(r.data); continue; }
    if (r.status === "eof") break;
    await new Promise((res) => injectWaiters.push(res)); // "again": await advance
  }
  try { kernel.sys_close(injectorPid, conn.wfd); } catch {}
  try { kernel.sys_close(injectorPid, conn.rfd); } catch {}

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
  if (syncPending.length === 0) return;
  const still = [];
  for (const item of syncPending) {
    const rec = programs.get(item.pid);
    if (!rec || rec.done) continue;
    let res;
    try {
      res = kernel.sys_read(item.pid, item.req.fd, item.req.max);
    } catch (e) {
      writeResponse(rec.syncSab, -1, { error: String(e.message || e) });
      continue;
    }
    if (res.status === "again") still.push(item);
    else writeResponse(rec.syncSab, 0, res.status === "data" ? res.data : new Uint8Array(0));
  }
  syncPending = still;
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
  try {
    switch (req.call) {
      case "read": {
        const res = kernel.sys_read(pid, req.fd, req.max);
        if (res.status === "again") {
          syncPending.push({ pid, req }); // park; respond when data/EOF arrives
          return;
        }
        writeResponse(rec.syncSab, 0, res.status === "data" ? res.data : new Uint8Array(0));
        break;
      }
      case "write": {
        // Read the payload bytes before writing the response overwrites the SAB.
        const bytes = requestBytes(rec.syncSab);
        const eff = kernel.sys_write(pid, req.fd, bytes);
        // A write to an un-redirected terminal fd streams to the host; a file/pipe
        // write just reports nwritten. (Mirrors the async `write` handler.)
        if (eff.target === "stdout") rec.sink.stdout(bytes);
        else if (eff.target === "stderr") rec.sink.stderr(bytes);
        retryPendingReads(); // a pipe may have gained data
        retrySyncPending();
        retryInjectReads();
        writeResponse(rec.syncSab, 0, { nwritten: eff.nwritten });
        break;
      }
      case "open":
        writeResponse(rec.syncSab, 0, { fd: kernel.sys_open(pid, req.path, req.opts || {}) });
        break;
      case "close":
        kernel.sys_close(pid, req.fd);
        writeResponse(rec.syncSab, 0, {});
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
      case "execCapture": {
        // node:child_process synchronous forms (execSync/spawnSync/…). The guest
        // thread is parked on Atomics.wait; the shell driver runs async on *this*
        // (kernel) thread — spawning the child worker, servicing its syscalls —
        // and we write the framed { code, stdout, stderr } back when it exits,
        // waking the guest. `input` (this request's payload) is the child's stdin.
        const input = requestBytes(rec.syncSab);
        runCaptured(req.line, input.length ? input : undefined)
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
  switch (msg.type) {
    case MSG.SYSCALL:
      handleSyscall(pid, msg);
      break;
    case MSG.SYNC:
      serviceSync(pid);
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
  try {
    switch (call) {
      case "write": {
        const eff = kernel.sys_write(pid, args.fd, args.data);
        const rec = programs.get(pid);
        if (rec) {
          if (eff.target === "stdout") rec.sink.stdout(args.data);
          else if (eff.target === "stderr") rec.sink.stderr(args.data);
        }
        retryPendingReads(); // a pipe may have gained data
        retrySyncPending();
        retryInjectReads();
        break; // fire-and-forget: no reply
      }
      case "read": {
        const res = kernel.sys_read(pid, args.fd, args.max);
        if (res.status === "again") pendingReads.push({ pid, id, fd: args.fd, max: args.max });
        else reply(pid, id, true, res);
        break;
      }
      case "open":
        reply(pid, id, true, kernel.sys_open(pid, args.path, args.opts || {}));
        break;
      case "close":
        kernel.sys_close(pid, args.fd);
        reply(pid, id, true, null);
        // Closing a pipe write end lets a drained reader observe EOF — wake any
        // parked reader (a downstream guest, or the injector's response reader).
        retryPendingReads();
        retrySyncPending();
        retryInjectReads();
        break;
      case "readdir":
        reply(pid, id, true, kernel.sys_readdir(pid, args.path));
        break;
      case "isatty":
        reply(pid, id, true, kernel.isatty(pid, args.fd));
        break;
      case "winsize":
        reply(pid, id, true, kernel.tty_get_winsize());
        break;
      // termios (tcgetattr/tcsetattr): a full-screen program flips the line
      // discipline to raw + no-echo so it owns editing and rendering, then
      // restores the flags on exit. `setattr` merges the given keys, so a
      // program can go raw without spelling out every flag.
      case "getattr":
        reply(pid, id, true, kernel.tty_get_attr());
        break;
      case "setattr":
        kernel.tty_set_attr(args.attr || {});
        // Going raw makes any already-buffered bytes readable, and a program
        // returning to cooked may have a line waiting — nudge parked reads.
        retryPendingReads();
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
      case "resolveGraph":
        // The kernel's JS-resolution service: hand back the module graph rooted at
        // `path` so a userland runtime (e.g. /bin/node) can evaluate it in-process.
        reply(pid, id, true, kernel.resolve_graph(args.cwd, args.path));
        break;
      // ---- otf:net_* — port-keyed loopback sockets (ADR-021) ----
      case "net_listen":
        reply(pid, id, true, { listener: kernel.net_listen(pid, args.port) });
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
      case "exec": {
        // system(3)-style: run a command line via the shell driver and route its
        // output to the caller's process streams. Replies with the exit code when
        // the sub-command finishes (async).
        const rec = programs.get(pid);
        const sink = rec
          ? rec.sink
          : { stdout: () => {}, stderr: () => {} };
        shell
          .exec(args.line, sink)
          .then((code) => reply(pid, id, true, code | 0))
          .catch((e) => reply(pid, id, false, String(e && e.message ? e.message : e)));
        break; // reply happens asynchronously above
      }
      case "spawnChild": {
        // node:child_process streaming spawn: launch `argv` as a real, headless
        // child process (not in the terminal foreground) whose stdout/stderr are
        // streamed *incrementally* back to this (parent) process's worker as
        // CHILD_STDOUT/CHILD_STDERR, and whose exit posts CHILD_EXIT. stdin is a
        // temp VFS file seeded from `args.input` — always written (empty if none)
        // so a child that reads stdin sees a clean EOF instead of blocking on the
        // shared terminal. cwd/env come straight from the caller (no shell).
        const parentRec = programs.get(pid);
        const parentWorker = parentRec && parentRec.worker;
        const tmp = "/tmp/.cp-in-" + childTmpSeq++;
        let stdin = { kind: "inherit" };
        try {
          kernel.fs_write(tmp, args.input && args.input.length ? args.input : new Uint8Array(0));
          stdin = { kind: "file", path: tmp, mode: "read" };
        } catch { /* /tmp missing → fall back to inherit */ }
        const plan = { stdin, stdout: { kind: "inherit" }, stderr: { kind: "inherit" } };
        const cleanup = () => { if (stdin.kind === "file") { try { kernel.sys_unlink(pid, tmp); } catch {} } };
        let spawned;
        try {
          spawned = spawnKernel(args.argv, args.env || {}, args.cwd || session.cwd, plan);
        } catch (e) {
          cleanup();
          reply(pid, id, false, String(e && e.message ? e.message : e));
          break;
        }
        const childPid = spawned.pid;
        const sink = {
          stdout: (b) => parentWorker && parentWorker.postMessage({ type: MSG.CHILD_STDOUT, pid: childPid, data: b }),
          stderr: (b) => parentWorker && parentWorker.postMessage({ type: MSG.CHILD_STDERR, pid: childPid, data: b }),
        };
        startWorker(spawned, {
          argv: args.argv,
          env: args.env || {},
          cwd: args.cwd || session.cwd,
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
        const cwd = args.cwd || session.cwd;
        let spawned;
        try {
          spawned = spawnKernel(argv, env, cwd, null);
        } catch (e) {
          reply(pid, id, false, String(e && e.message ? e.message : e));
          break;
        }
        const workerPid = spawned.pid;
        workerContexts.set(workerPid, { parentPid: pid, workerData: args.workerData ?? null, threadId: workerPid });
        const parentWorker = parentRec && parentRec.worker;
        startWorker(spawned, {
          argv,
          env,
          cwd,
          sink: (parentRec && parentRec.sink) || { stdout: () => {}, stderr: () => {} },
          onExit: (code) => {
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
        // worker's threadId) → route to that worker as coming from the parent (0).
        if (args.to === "parent") {
          const ctx = workerContexts.get(pid);
          const pw = ctx && programs.get(ctx.parentPid);
          if (pw && !pw.done) pw.worker.postMessage({ type: MSG.WORKER_MESSAGE, threadId: pid, data: args.data });
        } else {
          const cw = programs.get(args.to | 0);
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
        // /bin OS programs) so the shell can resolve them via PATH.
        for (const [path, source] of Object.entries(coreutils)) {
          kernel.fs_write(path, enc.encode(source));
        }
        // Install the OS programs (npm, …) into /bin. Everything at once for now;
        // a selectable install manifest is future work. Each program's source is
        // loaded on demand (js text is fetched same-origin; wasm would be bytes).
        for (const prog of osPrograms) {
          const data = await prog.source();
          if (data == null) continue; // a wasm program not built in this environment
          kernel.fs_write(prog.bin, typeof data === "string" ? enc.encode(data) : new Uint8Array(data));
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
        shell = createShell({ kernel, startProcess, session, readLine: readLineFromTty });
        // Apply the login profiles (PATH etc.) before any command can run, so
        // both the interactive REPL and programmatic exec see the global bin dir.
        await shell.sourceProfile();
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

      case MSG.FS_FLUSH:
        // Best-effort durable flush (tab hidden/closing). Awaited so a caller
        // that can delay unload (visibilitychange) gives the write a chance.
        await persistNow();
        if (msg.id != null) post({ type: MSG.FS_FLUSH, id: msg.id, ok: true });
        break;

      case MSG.SPAWN: {
        const spawned = spawnKernel(msg.argv, msg.env, msg.cwd || session.cwd, null);
        const pid = spawned.pid;
        const sink = {
          stdout: (b) => post({ type: MSG.STDOUT, pid, data: b }),
          stderr: (b) => post({ type: MSG.STDERR, pid, data: b }),
        };
        startWorker(spawned, {
          argv: msg.argv,
          env: msg.env || {},
          cwd: msg.cwd || session.cwd,
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
        shell
          .exec(msg.line, sink)
          .then((code) => post({ type: MSG.EXEC_DONE, execId, code, cwd: session.cwd }))
          .catch((e) => {
            sink.stderr(enc.encode(String(e && e.stack ? e.stack : e) + "\n"));
            post({ type: MSG.EXEC_DONE, execId, code: 1, cwd: session.cwd });
          });
        break;
      }

      case MSG.PS:
        post({ type: MSG.PS_RESULT, id: msg.id, procs: kernel.list_processes() });
        break;

      case MSG.KILL: {
        const signal = msg.signal ?? 9;
        if (kernel.kill(msg.pid, signal)) handleExit(msg.pid, 128 + signal);
        break;
      }

      case MSG.STDIN:
        kernel.feed_stdin(msg.pid, msg.data);
        retryPendingReads();
        retrySyncPending();
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

      case MSG.TTY_INPUT: {
        // While the shell prompt is being edited, the REPL owns the terminal in
        // raw mode: keystrokes go straight to the line editor (its own echo +
        // editing), bypassing the kernel's cooked discipline.
        if (activeReadline) {
          activeReadline.feed(msg.data);
          break;
        }
        // Otherwise a program (or the `read` builtin) is reading: run keystrokes
        // through the kernel cooked line discipline (echo + control-key signals).
        const res = kernel.tty_input(msg.data);
        termOut(res.echo);
        if (res.signal === "int") onInterrupt();
        else if (res.signal === "susp") onSusp();
        // A committed line may now unblock a foreground program's read, or the
        // `read` builtin waiting on the prompt.
        retryPendingReads();
        retrySyncPending();
        pumpWaiter();
        break;
      }

      case MSG.RESIZE:
        kernel.tty_set_winsize(msg.rows | 0, msg.cols | 0);
        // Re-wrap the shell prompt at the new width if it's being edited.
        if (activeReadline) activeReadline.resize();
        // Notify the foreground process(es) so a TUI can re-layout. Default
        // disposition is ignore, so a program without a handler is unaffected.
        for (const pid of [...foreground]) deliverSignal(pid, "SIGWINCH");
        break;

      case MSG.TERM_START:
        if (!termStarted) {
          termStarted = true;
          repl().catch((e) =>
            termOut(enc.encode("wsh: repl crashed: " + (e && e.message ? e.message : e) + "\r\n")),
          );
        }
        break;

      default:
        post({ type: MSG.ERROR, error: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    post({ type: MSG.ERROR, id: msg.id, error: String(err && err.stack ? err.stack : err) });
  }
};
