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
import { coreutils } from "../../workeros-coreutils/src/index.js";
import { programs as osPrograms } from "../../workeros-programs/src/index.js";
import { allocSyncBuffer, readRequest, writeResponse } from "./sync-syscall.js";

const enc = new TextEncoder();
let kernel = null;
let shell = null;

// The interactive shell session state (cwd/env), persisted across exec lines.
const session = { cwd: "/", env: { HOME: "/", PATH: "/bin:/sbin" } };

// pid → { worker, sink, onExit, resolveExit, done }.
const programs = new Map();
// Parked pipe reads awaiting data/EOF: { pid, id, fd, max }.
let pendingReads = [];

const PROGRAM_WORKER_URL = new URL("./program-worker.js", import.meta.url);

function post(msg) {
  self.postMessage(msg);
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
  const exited = startWorker(spawned, { argv, env, cwd, sink, onExit: () => {} });
  return { pid: spawned.pid, exited };
}

/** Tear a process down once: mark exited, unblock downstream, reap, terminate. */
function handleExit(pid, code) {
  const rec = programs.get(pid);
  if (!rec || rec.done) return;
  rec.done = true;
  kernel.mark_exited(pid, code); // idempotent; closes its pipe/file fds → EOF downstream
  retryPendingReads(); // downstream pipe readers may now see EOF
  retrySyncPending();
  kernel.reap(pid);
  rec.worker.terminate();
  programs.delete(pid);
  pendingReads = pendingReads.filter((pr) => pr.pid !== pid);
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
      default:
        writeResponse(rec.syncSab, -1, { error: "unknown sync call: " + req.call });
    }
  } catch (e) {
    // A kernel errno (e.g. Noent). The WASI host maps a negative status to an errno.
    writeResponse(rec.syncSab, -1, { error: String(e && e.message ? e.message : e) });
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
  }
}

function handleSyscall(pid, msg) {
  const { id, call, args } = msg;
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
        break;
      case "readdir":
        reply(pid, id, true, kernel.sys_readdir(pid, args.path));
        break;
      case "stat":
        reply(pid, id, true, kernel.sys_stat(pid, args.path));
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
      default:
        reply(pid, id, false, "unknown syscall: " + call);
    }
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
          kernel.fs_write(prog.bin, typeof data === "string" ? enc.encode(data) : new Uint8Array(data));
        }
        shell = createShell({ kernel, startProcess, session });
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

      default:
        post({ type: MSG.ERROR, error: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    post({ type: MSG.ERROR, id: msg.id, error: String(err && err.stack ? err.stack : err) });
  }
};
