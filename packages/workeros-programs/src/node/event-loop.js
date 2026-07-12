// Node event-loop keep-alive for the WorkerOS Node runtime. GUEST code (INV-1).
//
// A browser worker won't self-terminate while timers are pending, but `/bin/node`
// hands control back to the program worker the moment the script's top level
// settles — so a `setInterval`/`setTimeout` scheduled at top level would never
// fire unless the runtime waits for it. This mirrors Node's loop: the process
// stays alive while *ref'd* timers are outstanding, and `whenIdle()` resolves once
// none remain (a never-cleared `setInterval` keeps it pending forever, as in Node).
//
// Pure over the host's native timer functions: it wraps them with Node's timer
// handle surface (`ref`/`unref`/`hasRef`/`refresh` + numeric-id coercion) over a
// reference count, and `install(target)` publishes the wrapped globals. `unref()`
// drops a timer from the keep-alive count without cancelling it — the mechanism a
// library uses to avoid holding the process open.

export function createEventLoop(native) {
  const nativeSet = native.setTimeout;
  const nativeClear = native.clearTimeout;
  const nativeSetInterval = native.setInterval;
  const nativeClearInterval = native.clearInterval;

  const handles = new Map(); // our own id → Timeout
  let nextId = 1;
  let refCount = 0;
  let notifyIdle = null;
  let idleCheckScheduled = false;
  // Notify idle on a *macrotask*, not the instant the count first touches 0, then
  // re-check. A ref'd task ending and another beginning across async turns (e.g.
  // `await exec(...)` then `spawn(...)` in node:child_process) dips the count to 0
  // for one microtask flush before the next task re-refs; firing synchronously
  // there would end the loop mid-flight. Deferring lets those continuations re-ref
  // first, so we only resolve when the loop is *actually* drained.
  const scheduleIdleCheck = () => {
    if (idleCheckScheduled) return;
    idleCheckScheduled = true;
    nativeSet(() => {
      idleCheckScheduled = false;
      if (refCount <= 0 && notifyIdle) { const done = notifyIdle; notifyIdle = null; done(); }
    }, 0);
  };
  const bump = (n) => {
    refCount += n;
    if (refCount <= 0 && notifyIdle) scheduleIdleCheck();
  };

  class Timeout {
    constructor(set, clear, fn, delay, args, repeat) {
      // Expose our own integer id, not the native handle — a browser worker's
      // setTimeout returns a number but Node's returns an object, so keying/
      // coercing on the native handle isn't portable. `_native` is kept solely to
      // hand back to the native clear.
      this._id = nextId++;
      this._clear = clear;
      this._repeat = repeat;
      this._settled = false;
      this._refd = true;
      bump(1);
      this._native = set((...a) => {
        // Run the callback first, so any timers it schedules are counted before
        // this one-shot decrements — else the loop could momentarily read as idle.
        try { fn(...a); }
        catch (e) { if (!e || e.name !== "ProcessExit") throw e; /* exit already reported */ }
        finally { if (!repeat) this._settle(); }
      }, delay, ...args);
      handles.set(this._id, this);
    }
    _settle() {
      if (this._settled) return;
      this._settled = true;
      handles.delete(this._id);
      if (this._refd) bump(-1);
    }
    clear() { if (!this._settled) { this._clear(this._native); this._settle(); } }
    ref() { if (!this._refd && !this._settled) { this._refd = true; bump(1); } return this; }
    unref() { if (this._refd && !this._settled) { this._refd = false; bump(-1); } return this; }
    hasRef() { return this._refd && !this._settled; }
    refresh() { return this; } // honest limit (INV-5): no timer restart
    [Symbol.toPrimitive]() { return this._id; }
  }

  const asTimeout = (h) => (h instanceof Timeout ? h : handles.get(Number(h)));
  const api = {
    setTimeout: (fn, delay, ...args) => new Timeout(nativeSet, nativeClear, fn, delay, args, false),
    setInterval: (fn, delay, ...args) =>
      new Timeout(nativeSetInterval, nativeClearInterval, fn, delay, args, true),
    // setImmediate isn't a worker global; approximate with a 0ms one-shot (honest
    // limit: runs asap, not strictly before timers / after I/O the way Node does).
    setImmediate: (fn, ...args) => new Timeout(nativeSet, nativeClear, fn, 0, args, false),
    clearTimeout: (h) => { const t = asTimeout(h); if (t) t.clear(); },
  };
  api.clearInterval = api.clearTimeout;
  api.clearImmediate = api.clearTimeout;

  // Resolves once no ref'd timers remain — the script's event loop has drained.
  // Always settle on a *deferred* macrotask (via scheduleIdleCheck), never
  // synchronously on `refCount <= 0` at call time: an entry's top-level can return
  // with async work still queued as microtasks that haven't ref'd the loop yet —
  // e.g. an async CLI like npm that fires its command (`cli(process)`) without
  // awaiting it. Deferring one macrotask lets those microtasks run and re-ref
  // first, so we don't declare the loop drained before it has even started.
  const whenIdle = () => new Promise((r) => { notifyIdle = r; scheduleIdleCheck(); });
  const install = (target) => { for (const k of Object.keys(api)) target[k] = api[k]; };

  // Manual keep-alive for non-timer work (an open network listener/connection —
  // ADR-021): `ref()` holds the loop open the way a pending socket does in Node,
  // `unref()` releases it. Symmetric with a timer's ref/unref on the same count.
  const ref = () => bump(1);
  const unref = () => bump(-1);

  return { install, whenIdle, api, activeRefs: () => refCount, ref, unref };
}
