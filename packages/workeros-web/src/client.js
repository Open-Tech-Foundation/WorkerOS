// The main-thread client API for WorkerOS.
//
// Phase 2 surface: boot(), fs.write / fs.read, spawn(argv) → a Process handle
// with streamed stdout/stderr, an `exited` promise, kill(), and writeStdin().
// Every call is thin: the kernel worker (and behind it the wasm kernel) makes
// all the decisions.

import { MSG } from "./protocol.js";

const encoder = new TextEncoder();

function toBytes(data) {
  return typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
}

/**
 * Boot a WorkerOS instance.
 *
 * @param {object} [opts]
 * @param {string} [opts.workerUrl] URL of kernel-worker.js.
 * @param {string} [opts.wasmUrl] URL of the kernel .wasm binary.
 * @returns {Promise<WorkerOS>}
 */
export function boot(opts = {}) {
  // WorkerOS runs synchronous syscalls over a SharedArrayBuffer + Atomics.wait
  // (ADR-010). SharedArrayBuffer only exists in a cross-origin-isolated page, so
  // fail here with an actionable message rather than letting every later syscall
  // die deep in a worker with a bare "SharedArrayBuffer is not defined" (surfacing
  // as e.g. "ls: SharedArrayBuffer is not defined" on the first command).
  if (typeof SharedArrayBuffer === "undefined" || !globalThis.crossOriginIsolated) {
    return Promise.reject(new Error(
      "WorkerOS needs a cross-origin-isolated page (SharedArrayBuffer is unavailable). " +
      "Serve it with `Cross-Origin-Opener-Policy: same-origin` and " +
      "`Cross-Origin-Embedder-Policy: require-corp` (the dev server in tools/serve.js " +
      "already does), then reload — `globalThis.crossOriginIsolated` must be true.",
    ));
  }

  const workerUrl =
    opts.workerUrl || new URL("./kernel-worker.js", import.meta.url).href;
  const wasmUrl =
    opts.wasmUrl ||
    new URL("./kernel-wasm/workeros_web_wasm_bg.wasm", import.meta.url).href;

  const worker = new Worker(workerUrl, { type: "module" });

  return new Promise((resolve, reject) => {
    const onFirst = (ev) => {
      const msg = ev.data;
      if (msg.type === MSG.BOOTED) {
        worker.removeEventListener("message", onFirst);
        resolve(new WorkerOS(worker, { version: msg.version, abi: msg.abi }));
      } else if (msg.type === MSG.ERROR) {
        worker.removeEventListener("message", onFirst);
        worker.terminate();
        reject(new Error(`kernel boot failed: ${msg.error}`));
      }
    };
    worker.addEventListener("message", onFirst);
    worker.addEventListener("error", (e) =>
      reject(new Error(`kernel worker error: ${e.message}`)),
    );
    // `opts.watchdog` optionally overrides the temporal limits (ADR-020):
    // { wallTimeMs, graceMs, sampleMs, memHighWaterBytes } — e.g. a tight
    // profile for untrusted/AI-agent code, or fast budgets in tests.
    worker.postMessage({ type: MSG.BOOT, wasmUrl, watchdog: opts.watchdog });
  });
}

/** A booted WorkerOS instance handle. */
export class WorkerOS {
  constructor(worker, handshake) {
    this._worker = worker;
    this.version = handshake.version;
    this.abi = handshake.abi;

    this._nextId = 1;
    this._pending = new Map(); // request id → {resolve, reject}
    this._procs = new Map(); // pid → Process
    this._execs = new Map(); // exec id → {onStdout, onStderr, resolve}
    this._termListeners = []; // terminal-output subscribers (Uint8Array chunks)
    this._termBuffer = []; // output emitted before a listener attached

    /** @type {{ write: (path: string, data: Uint8Array|string) => Promise<void>,
     *           read: (path: string) => Promise<Uint8Array> }} */
    this.fs = {
      write: (path, data) => this._request(MSG.FS_WRITE, { path, data: toBytes(data) }),
      // fs.read is a synchronous kernel op; exposed via a request round-trip.
      read: (path) => this._request(MSG.FS_READ, { path }),
    };

    worker.addEventListener("message", (ev) => this._dispatch(ev.data));

    // Persist the durable filesystem when the tab is hidden or unloading
    // (ADR-022). `visibilitychange → hidden` is the reliable pre-close signal on
    // desktop and mobile; `pagehide` covers bfcache/navigation. The write-behind
    // timer in the worker already bounds loss to a couple seconds; this trims it.
    if (typeof document !== "undefined" && document.addEventListener) {
      const flushOnHide = () => {
        if (document.visibilityState === "hidden") this.flush();
      };
      document.addEventListener("visibilitychange", flushOnHide);
      addEventListener("pagehide", () => this.flush());
    }
  }

  /** Force a durable snapshot of the filesystem now. Resolves when stored. */
  flush() {
    return this._request(MSG.FS_FLUSH, {});
  }

  _request(type, payload) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ type, id, ...payload });
    });
  }

  _dispatch(msg) {
    switch (msg.type) {
      case MSG.SPAWNED:
      case MSG.FS_WRITE:
      case MSG.FS_FLUSH:
      case MSG.FS_READ:
      case MSG.TRACE_RESULT:
      case MSG.PS_RESULT: {
        const p = this._pending.get(msg.id);
        if (p) {
          this._pending.delete(msg.id);
          if (msg.type === MSG.SPAWNED) p.resolve(msg.pid);
          else if (msg.type === MSG.FS_READ) p.resolve(msg.data);
          else if (msg.type === MSG.PS_RESULT) p.resolve(msg.procs);
          else if (msg.type === MSG.TRACE_RESULT) p.resolve({ on: msg.on, events: msg.events, procs: msg.procs });
          else p.resolve();
        }
        break;
      }
      case MSG.PREVIEW_RESPONSE: {
        // The kernel injector's raw HTTP response bytes for a preview request
        // (ADR-021); resolve with the bytes or reject (e.g. ECONNREFUSED).
        const p = this._pending.get(msg.id);
        if (p) {
          this._pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.bytes);
          else p.reject(new Error(msg.error || "preview failed"));
        }
        break;
      }
      case MSG.EXEC_STDOUT:
      case MSG.EXEC_STDERR: {
        const e = this._execs.get(msg.execId);
        if (e) {
          const cb = msg.type === MSG.EXEC_STDOUT ? e.onStdout : e.onStderr;
          if (cb) cb(msg.data);
        }
        break;
      }
      case MSG.EXEC_DONE: {
        const e = this._execs.get(msg.execId);
        if (e) {
          this._execs.delete(msg.execId);
          e.resolve({ code: msg.code, cwd: msg.cwd });
        }
        break;
      }
      case MSG.STDOUT:
      case MSG.STDERR: {
        const proc = this._procs.get(msg.pid);
        if (proc) proc._emit(msg.type === MSG.STDOUT ? "stdout" : "stderr", msg.data);
        break;
      }
      case MSG.TERM_OUTPUT: {
        if (this._termListeners.length === 0) this._termBuffer.push(msg.data);
        else for (const cb of this._termListeners) cb(msg.data);
        break;
      }
      case MSG.EXIT: {
        const proc = this._procs.get(msg.pid);
        if (proc) proc._finish(msg.code);
        break;
      }
      case MSG.ERROR: {
        if (msg.id && this._pending.has(msg.id)) {
          const p = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          p.reject(new Error(msg.error));
        } else if (msg.pid && this._procs.has(msg.pid)) {
          this._procs.get(msg.pid)._emit("stderr", encoder.encode(msg.error + "\n"));
        }
        break;
      }
    }
  }

  /**
   * Spawn a process. `argv` like `["node", "main.js"]`.
   * @param {string[]} argv
   * @param {object} [opts] { env?: object, cwd?: string }
   * @returns {Promise<Process>}
   */
  async spawn(argv, opts = {}) {
    const env = opts.env || {};
    const cwd = opts.cwd || "/";
    // Register the Process before the pid resolves so no early output is missed:
    // the kernel worker sends SPAWNED before any stdout, but we still guard by
    // buffering in Process until listeners attach.
    const pid = await this._request(MSG.SPAWN, { argv, env, cwd });
    const proc = new Process(this, pid);
    this._procs.set(pid, proc);
    return proc;
  }

  /**
   * Run a `wsh` command line (pipes, redirects, `&&`/`||`/`;`, `&`, glob, `cd`).
   * @param {string} line
   * @param {object} [opts] { onStdout?, onStderr? } — receive Uint8Array chunks
   * @returns {Promise<{code: number, cwd: string}>}
   */
  exec(line, opts = {}) {
    const id = this._nextId++;
    return new Promise((resolve) => {
      this._execs.set(id, { onStdout: opts.onStdout, onStderr: opts.onStderr, resolve });
      this._worker.postMessage({ type: MSG.EXEC, id, line });
    });
  }

  /** `ps` — a snapshot of the live process table. */
  ps() {
    return this._request(MSG.PS, {});
  }

  /**
   * Kernel tracing (debugging). `trace({ on })` toggles the strace-style tracer;
   * `trace({ dump: true, procs: true, limit })` reads back the recent syscall/
   * spawn/exit events and a live process snapshot. Resolves with
   * `{ on, events?, procs? }`. Events are `{ seq, t, pid, kind, call, info }`.
   */
  trace(opts = {}) {
    return this._request(MSG.TRACE, opts);
  }

  /**
   * Inject a raw HTTP/1.1 request (Uint8Array) into the process listening on
   * `port` and resolve with the raw response bytes (ADR-021). The Service-Worker
   * preview bridge (`installPreviewBridge`) drives this; rejects on ECONNREFUSED
   * (nothing listening) or a kernel error.
   */
  preview(port, bytes) {
    return this._request(MSG.PREVIEW_REQUEST, { port, bytes });
  }

  // ---- interactive terminal (kernel-owned TTY) ----

  /**
   * Subscribe to terminal-display output (Uint8Array chunks: prompt, echo, and
   * program stdout/stderr). Any output buffered before the first listener
   * attaches is flushed immediately. Returns an unsubscribe fn.
   */
  onOutput(cb) {
    this._termListeners.push(cb);
    if (this._termBuffer.length) {
      const buffered = this._termBuffer;
      this._termBuffer = [];
      for (const chunk of buffered) cb(chunk);
    }
    return () => {
      this._termListeners = this._termListeners.filter((f) => f !== cb);
    };
  }

  /** Send raw keystrokes to the terminal (through the kernel line discipline). */
  input(data) {
    this._send({ type: MSG.TTY_INPUT, data: toBytes(data) });
  }

  /** Report a new terminal window size (rows/cols in character cells). */
  resize(rows, cols) {
    this._send({ type: MSG.RESIZE, rows: rows | 0, cols: cols | 0 });
  }

  /** Start the interactive shell REPL. Call after attaching `onOutput`. */
  startTerminal() {
    this._send({ type: MSG.TERM_START });
  }

  /** Send a signal to a process by pid (defaults to SIGKILL). */
  kill(pid, signal = 9) {
    this._send({ type: MSG.KILL, pid, signal });
  }

  _send(msg, transfer) {
    this._worker.postMessage(msg, transfer || []);
  }

  /** Tear down the instance (terminates the kernel worker and all programs). */
  shutdown() {
    this._worker.terminate();
  }
}

/** A handle to one spawned process. */
export class Process {
  constructor(os, pid) {
    this.pid = pid;
    this._os = os;
    this._listeners = { stdout: [], stderr: [] };
    this._exitCode = undefined;
    this._exitResolvers = [];
    /** Resolves with the exit code when the process exits. */
    this.exited = new Promise((resolve) => this._exitResolvers.push(resolve));
  }

  /** Subscribe to stdout chunks (Uint8Array). Returns an unsubscribe fn. */
  onStdout(cb) {
    this._listeners.stdout.push(cb);
    return () => this._off("stdout", cb);
  }
  /** Subscribe to stderr chunks (Uint8Array). Returns an unsubscribe fn. */
  onStderr(cb) {
    this._listeners.stderr.push(cb);
    return () => this._off("stderr", cb);
  }

  _off(kind, cb) {
    this._listeners[kind] = this._listeners[kind].filter((f) => f !== cb);
  }
  _emit(kind, data) {
    for (const cb of this._listeners[kind]) cb(data);
  }
  _finish(code) {
    if (this._exitCode !== undefined) return;
    this._exitCode = code;
    for (const r of this._exitResolvers) r(code);
  }

  /** Write bytes to the process's stdin. */
  writeStdin(data) {
    this._os._send({ type: MSG.STDIN, pid: this.pid, data: toBytes(data) });
  }

  /** Send a signal; defaults to SIGKILL (hard terminate). */
  kill(signal = 9) {
    this._os._send({ type: MSG.KILL, pid: this.pid, signal });
  }
}
