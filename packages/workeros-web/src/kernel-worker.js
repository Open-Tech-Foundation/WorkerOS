// The kernel worker. Exactly one per WorkerOS instance. It owns the Rust→wasm
// kernel (the sole authority) and drives the host side of the process model:
// it creates one program worker per process, relays their syscalls into the
// wasm kernel, and streams stdout/stderr/exit back to the main thread.
//
// It never executes guest code itself (ARCHITECTURE.md §4). Every decision —
// module resolution, VFS, process table, capabilities — is made by the wasm
// kernel; this file is transport and worker lifecycle.

import init, { WebKernel } from "./kernel-wasm/workeros_web_wasm.js";
import { MSG } from "./protocol.js";

let kernel = null;

// pid → { worker, cwd }. The kernel worker holds each program worker's handle so
// it can `terminate()` it — the only way to stop a runaway synchronous loop
// (INV-4/ADR-003).
const programs = new Map();

const PROGRAM_WORKER_URL = new URL("./program-worker.js", import.meta.url);

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function interpreterOf(argv) {
  return argv[0] === "node" ? "node" : "js";
}

/** Handle a message coming back from a program worker (identified by pid). */
function onProgramMessage(pid, msg) {
  switch (msg.type) {
    case MSG.SYSCALL: {
      if (msg.call === "write") {
        try {
          const eff = kernel.sys_write(pid, msg.fd, msg.data);
          if (eff.target === "stdout") {
            post({ type: MSG.STDOUT, pid, data: msg.data }, [msg.data.buffer]);
          } else if (eff.target === "stderr") {
            post({ type: MSG.STDERR, pid, data: msg.data }, [msg.data.buffer]);
          }
          // "file": already written to the VFS; nothing to forward.
        } catch (err) {
          post({ type: MSG.ERROR, pid, error: String(err) });
        }
      }
      break;
    }
    case MSG.PROC_EXIT: {
      kernel.mark_exited(pid, msg.code | 0);
      finishProcess(pid, msg.code | 0);
      break;
    }
  }
}

/** Tear down a process's worker and notify the main thread. The exit code must
 * already have been recorded in the kernel (via mark_exited or kill). */
function finishProcess(pid, code) {
  const entry = programs.get(pid);
  if (!entry) return;
  entry.worker.terminate();
  programs.delete(pid);
  post({ type: MSG.EXIT, pid, code });
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case MSG.BOOT: {
        await init({ module_or_path: msg.wasmUrl });
        kernel = WebKernel.boot();
        post({ type: MSG.BOOTED, version: kernel.version, abi: kernel.abi });
        break;
      }

      case MSG.FS_WRITE: {
        kernel.fs_write(msg.path, msg.data);
        post({ type: MSG.FS_WRITE, id: msg.id, ok: true });
        break;
      }

      case MSG.FS_READ: {
        const data = kernel.fs_read(msg.path);
        post({ type: MSG.FS_READ, id: msg.id, data }, [data.buffer]);
        break;
      }

      case MSG.SPAWN: {
        const envPairs = Object.entries(msg.env || {});
        // Rust resolver decides the entry + import graph and registers the pid.
        const spawned = kernel.spawn(msg.argv, envPairs, msg.cwd, Date.now(), 0);
        const worker = new Worker(PROGRAM_WORKER_URL, { type: "module" });
        worker.onmessage = (e) => onProgramMessage(spawned.pid, e.data);
        worker.onerror = (e) =>
          post({ type: MSG.ERROR, pid: spawned.pid, error: e.message });
        programs.set(spawned.pid, { worker, cwd: msg.cwd });
        worker.postMessage({
          type: MSG.START,
          interpreter: interpreterOf(msg.argv),
          argv: msg.argv,
          env: msg.env || {},
          cwd: msg.cwd,
          pid: spawned.pid,
          graph: spawned.graph,
        });
        post({ type: MSG.SPAWNED, id: msg.id, pid: spawned.pid });
        break;
      }

      case MSG.KILL: {
        const existed = kernel.kill(msg.pid, msg.signal ?? 9);
        if (existed) {
          finishProcess(msg.pid, 128 + (msg.signal ?? 9));
        }
        break;
      }

      case MSG.STDIN: {
        kernel.feed_stdin(msg.pid, msg.data);
        break;
      }

      default:
        post({ type: MSG.ERROR, error: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    post({ type: MSG.ERROR, id: msg.id, error: String(err && err.stack ? err.stack : err) });
  }
};
