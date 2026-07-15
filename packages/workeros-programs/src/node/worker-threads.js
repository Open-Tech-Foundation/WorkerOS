// `node:worker_threads` — real background threads for a WorkerOS Node program.
//
// GUEST code (INV-1): a `Worker` is just another `/bin/node` process the kernel
// spawns (like `child_process`), plus a structured-clone message channel relayed
// through the kernel worker. It's reached over syscalls the runtime adds:
//
//   • `sys.spawnWorker({ file, eval, workerData, argv, env, cwd, token })` → { threadId }
//   • `sys.workerPost(target, data)`   target = threadId (main→worker) | "parent"
//                                               | { token } (a worker not yet online)
//   • `sys.onWorkerEvent(cb)`          cb(fromThreadId, "message"|"exit", payload)
//   • `sys.childKill(threadId, sig)`   (shared with child_process) — terminate()
//   • `sys.workerInit()`               resolved once at /bin/node startup → `init`
//
// The main thread sees `isMainThread === true`; a worker sees it false, with
// `parentPort` wired to the relay and `workerData` delivered as a structured clone.
// Messages ride postMessage hops through the kernel worker, so objects/typed arrays/
// Maps survive.
//
// An uncaught throw in a worker fires `worker.on('error')` with a reconstructed
// Error (message/stack/name relayed from the worker's process), both for a
// synchronous load-time throw and an async one; `receiveMessageOnPort(port)`
// synchronously drains a queued message.
//
// Honest limits (INV-5): a worker's console output goes to the parent's stdout
// (Node's default) — a per-worker `worker.stdout`/`stderr` stream isn't surfaced;
// `transferList` transferables are copied rather than moved (the data still
// arrives — structured clone copies it — but the sender's copy isn't neutered);
// and a `MessagePort` can't be *transferred* to another thread (in-thread
// `MessageChannel` works). These need shared-memory/pipe plumbing and are a
// separate effort — not faked here.

import { EventEmitter } from "./events.js";

const loop = () => globalThis.__workerosLoop;

// Signal name → number, for terminate() (a delivered signal hard-exits the worker).
const SIGTERM = 15;

// Per-process counter naming a Worker before the kernel has assigned its threadId.
let nextSpawnToken = 1;

// Join a possibly-relative worker file against the guest cwd, so `new Worker(
// './w.js')` resolves the same way the calling script's relative paths do — even
// after a chdir (process.cwd() is the guest-local view).
function resolveFile(file) {
  if (file.startsWith("/")) return file;
  const cwd = globalThis.process?.cwd?.() || "/";
  const segs = [];
  for (const part of (cwd + "/" + file).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}

export function createWorkerThreads(sys, init = {}) {
  const isMainThread = init.isMainThread !== false;
  const threadId = init.threadId || 0;
  const workerData = init.workerData ?? null;

  const workers = new Map(); // threadId → Worker (main side, live children)

  // A message-port-shaped emitter: inbound messages are *queued* until a `message`
  // listener exists and then delivered on a microtask — matching Node's MessagePort
  // (a port starts paused; adding a listener / start() begins delivery). Without
  // this, a message that races ahead of the listener (e.g. the spawner posts before
  // the worker script attaches its handler) would be silently dropped.
  class QueuedEmitter extends EventEmitter {
    constructor() { super(); this._q = []; this._flushing = false; }
    _receive(data) { this._q.push(data); this._scheduleFlush(); }
    _scheduleFlush() {
      if (this._flushing) return;
      this._flushing = true;
      queueMicrotask(() => {
        this._flushing = false;
        while (this._q.length && this.listenerCount("message") > 0) this.emit("message", this._q.shift());
      });
    }
    on(ev, fn) { super.on(ev, fn); if (ev === "message") this._scheduleFlush(); return this; }
    addListener(ev, fn) { return this.on(ev, fn); }
    once(ev, fn) { super.once(ev, fn); if (ev === "message") this._scheduleFlush(); return this; }
  }

  // ---- MessagePort / MessageChannel (in-thread linked pair) -----------------
  // A pragmatic same-thread port pair: postMessage on one queues onto the other.
  // Enough for libraries that wire ports locally; transferring a port across
  // threads is the honest limit (INV-5).
  class MessagePort extends QueuedEmitter {
    constructor() {
      super();
      this._other = null;
      this._closed = false;
    }
    postMessage(data) {
      const other = this._other;
      if (other && !other._closed) other._receive(data);
    }
    start() { this._scheduleFlush(); }
    close() {
      if (this._closed) return;
      this._closed = true;
      this.emit("close");
    }
    ref() { return this; }
    unref() { return this; }
  }

  class MessageChannel {
    constructor() {
      this.port1 = new MessagePort();
      this.port2 = new MessagePort();
      this.port1._other = this.port2;
      this.port2._other = this.port1;
    }
  }

  // ---- parentPort (worker side) — the cross-thread channel to the spawner -----
  // Keeps the worker's event loop alive while it has `message` listeners (as a
  // real worker stays alive while listening), releasing on close() / last removal.
  class ParentPort extends QueuedEmitter {
    constructor() {
      super();
      this._closed = false;
      this._refd = false;
    }
    postMessage(data) { sys.workerPost("parent", data); }
    start() { this._scheduleFlush(); }
    close() {
      if (this._closed) return;
      this._closed = true;
      this._syncRef();
      this.emit("close");
    }
    ref() { this._refd = true; loop()?.ref(); return this; }
    unref() { if (this._refd) { this._refd = false; loop()?.unref(); } return this; }
    _syncRef() {
      const want = !this._closed && this.listenerCount("message") > 0;
      if (want && !this._refd) { this._refd = true; loop()?.ref(); }
      else if (!want && this._refd) { this._refd = false; loop()?.unref(); }
    }
    on(ev, fn) { super.on(ev, fn); if (ev === "message") this._syncRef(); return this; }
    once(ev, fn) { super.once(ev, fn); if (ev === "message") this._syncRef(); return this; }
    off(ev, fn) { super.off(ev, fn); if (ev === "message") this._syncRef(); return this; }
    removeListener(ev, fn) { return this.off(ev, fn); }
    removeAllListeners(ev) { super.removeAllListeners(ev); this._syncRef(); return this; }
  }

  const parentPort = isMainThread ? null : new ParentPort();

  // ---- Worker (main side) — a live child process running /bin/node -----------
  class Worker extends QueuedEmitter {
    constructor(filename, options = {}) {
      super();
      this.threadId = -1;
      this._exited = false;
      // Names this worker until `spawnWorker` answers with its threadId, so a
      // message posted before then can still be addressed (see `postMessage`).
      this._token = nextSpawnToken++;
      this._refd = true;
      loop()?.ref(); // hold the process alive while the worker runs (as in Node)

      const opts = {
        file: options.eval ? String(filename) : resolveFile(String(filename)),
        eval: !!options.eval,
        workerData: options.workerData ?? null,
        argv: (options.argv || []).map(String),
        env: options.env || globalThis.process?.env || undefined,
        cwd: globalThis.process?.cwd?.() ?? sys.cwd,
        token: this._token,
      };
      sys
        .spawnWorker(opts)
        .then(({ threadId: id }) => {
          this.threadId = id;
          workers.set(id, this);
          this.emit("online");
        })
        .catch((e) => this._fail(e instanceof Error ? e : new Error(String(e))));
    }
    postMessage(data) {
      // Before the worker is online we address it by spawn token rather than
      // queueing here: the kernel worker registered the token while servicing the
      // (earlier, same-port, therefore already-processed) spawnWorker syscall, so
      // it can route the message on its own. Queueing would need *this* thread's
      // event loop to turn, which deadlocks a caller that posts and then blocks —
      // a wasm thread pool (rolldown) posts its module/memory and immediately
      // parks in Atomics.wait on the worker coming up.
      sys.workerPost(this.threadId >= 0 ? this.threadId : { token: this._token }, data);
    }
    // No live stdio streams (INV-5) — a worker's output goes to the parent's stdout.
    get stdout() { return null; }
    get stderr() { return null; }
    get stdin() { return null; }
    ref() { if (!this._refd) { this._refd = true; loop()?.ref(); } return this; }
    unref() { if (this._refd) { this._refd = false; loop()?.unref(); } return this; }
    terminate() {
      if (this.threadId >= 0 && !this._exited) sys.childKill(this.threadId, SIGTERM);
      return new Promise((resolve) => {
        if (this._exited) resolve(this.exitCode ?? 0);
        else this.once("exit", resolve);
      });
    }
    // getHeapSnapshot / performance / resourceLimits: no VM introspection (INV-5).
    _release() { if (this._refd) { this._refd = false; loop()?.unref(); } }
    _exit(code) {
      if (this._exited) return;
      this._exited = true;
      this.exitCode = code;
      if (this.threadId >= 0) workers.delete(this.threadId);
      // Only `exit` here — a plain non-zero/terminated exit is not an `error` in
      // Node (that's reserved for an uncaught throw, whose Error object we can't
      // carry across the process boundary yet; INV-5). Callers key off the code.
      this.emit("exit", code);
      this._release();
    }
    _fail(err) {
      this.emit("error", err);
      this._exit(1);
    }
    // The worker threw an uncaught error (relayed from its process). Reconstruct an
    // Error carrying the message/stack/name and emit it — Node's `error` event.
    _error(info) {
      const err = new Error(info && info.message ? info.message : "Worker error");
      if (info && info.name) err.name = info.name;
      if (info && info.stack) err.stack = info.stack;
      this.emit("error", err);
    }
  }

  // One dispatcher for all worker traffic delivered to this process: the kernel
  // tags each with the peer thread id (0 = the parent, for a worker receiving from
  // its spawner). Route messages/exits to the right Worker (main side) or the
  // parentPort (worker side).
  sys.onWorkerEvent?.((fromThreadId, kind, payload) => {
    if (kind === "message") {
      if (fromThreadId === 0) parentPort?._receive(payload);
      else workers.get(fromThreadId)?._receive(payload);
    } else if (kind === "exit") {
      workers.get(fromThreadId)?._exit(payload && typeof payload.code === "number" ? payload.code : 0);
    } else if (kind === "error") {
      workers.get(fromThreadId)?._error(payload);
    }
  });

  // receiveMessageOnPort(port): synchronously take the next already-queued message
  // (`{ message }`) or `undefined`. Works on any port with buffered input — the
  // in-thread MessagePorts and a parentPort/Worker whose messages have arrived.
  const receiveMessageOnPort = (port) =>
    port && port._q && port._q.length ? { message: port._q.shift() } : undefined;

  // Per-thread environment data store (getEnvironmentData/setEnvironmentData).
  const envData = new Map();

  const mod = {
    isMainThread,
    threadId,
    workerData,
    parentPort,
    Worker,
    MessageChannel,
    MessagePort,
    BroadcastChannel: globalThis.BroadcastChannel,
    SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
    receiveMessageOnPort,
    markAsUntransferable: () => {},
    moveMessagePortToContext: (port) => port,
    setEnvironmentData: (key, value) => { if (value === undefined) envData.delete(key); else envData.set(key, value); },
    getEnvironmentData: (key) => envData.get(key),
  };
  mod.default = mod;
  return mod;
}
