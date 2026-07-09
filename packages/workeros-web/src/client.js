// The main-thread client API for WorkerOS.
//
// Phase 2 surface: boot(), fs.write / fs.read, spawn(argv) → a Process handle
// with streamed stdout/stderr, an `exited` promise, kill(), and writeStdin().
// Every call is thin: the kernel worker (and behind it the wasm kernel) makes
// all the decisions.

import { MSG } from "./protocol.js";
import { installPackage, scanImports, isBare, rewriteSpecifier } from "./npm.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    worker.postMessage({ type: MSG.BOOT, wasmUrl });
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
    this._runSeq = 0; // unique temp-file counter for run()
    this._pkgCache = new Map(); // installed npm specifier → VFS path

    /** @type {{ write: (path: string, data: Uint8Array|string) => Promise<void>,
     *           read: (path: string) => Promise<Uint8Array> }} */
    this.fs = {
      write: (path, data) => this._request(MSG.FS_WRITE, { path, data: toBytes(data) }),
      // fs.read is a synchronous kernel op; exposed via a request round-trip.
      read: (path) => this._request(MSG.FS_READ, { path }),
    };

    worker.addEventListener("message", (ev) => this._dispatch(ev.data));
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
      case MSG.FS_READ:
      case MSG.PS_RESULT: {
        const p = this._pending.get(msg.id);
        if (p) {
          this._pending.delete(msg.id);
          if (msg.type === MSG.SPAWNED) p.resolve(msg.pid);
          else if (msg.type === MSG.FS_READ) p.resolve(msg.data);
          else if (msg.type === MSG.PS_RESULT) p.resolve(msg.procs);
          else p.resolve();
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

  /**
   * Run a snippet of JS as a real WorkerOS process and collect its output.
   *
   * Bare `import`s (e.g. `import { camelCase } from "@opentf/std"`) are resolved
   * the Node way — outside the kernel (INV-1): each package is fetched from a CDN
   * into the VFS and the specifier is rewritten to its absolute VFS path, which
   * the kernel then graph-walks and runs. `console.log` output is streamed and
   * accumulated. This is the primitive a docs-site "try it" widget calls: user
   * types code, it executes in the OS, and you get its output back.
   *
   * @param {string} code  the JS source to run (ES module; may use bare imports)
   * @param {object} [opts]
   * @param {(b: Uint8Array) => void} [opts.onStdout]  live stdout chunks
   * @param {(b: Uint8Array) => void} [opts.onStderr]  live stderr chunks
   * @param {(name: string) => void} [opts.onInstall]  called before fetching each package
   * @param {object} [opts.env]
   * @param {string} [opts.cwd]
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
   */
  async run(code, opts = {}) {
    // Resolve + install every bare package the snippet imports.
    const specs = scanImports(code).filter(isBare);
    let src = code;
    for (const spec of specs) {
      if (!this._pkgCache.has(spec)) opts.onInstall?.(spec);
      const vfsPath = await installPackage(this, spec, this._pkgCache);
      src = rewriteSpecifier(src, spec, vfsPath);
    }

    const path = `/tmp/run-${++this._runSeq}.mjs`;
    await this.fs.write(path, src);

    const proc = await this.spawn(["node", path], { env: opts.env, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    proc.onStdout((b) => {
      stdout += decoder.decode(b);
      opts.onStdout?.(b);
    });
    proc.onStderr((b) => {
      stderr += decoder.decode(b);
      opts.onStderr?.(b);
    });
    const code2 = await proc.exited;
    this._procs.delete(proc.pid);
    return { stdout, stderr, code: code2 };
  }

  /** `ps` — a snapshot of the live process table. */
  ps() {
    return this._request(MSG.PS, {});
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
