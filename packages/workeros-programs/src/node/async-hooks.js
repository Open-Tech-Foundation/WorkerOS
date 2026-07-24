// `node:async_hooks` — AsyncLocalStorage / AsyncResource for the WorkerOS Node
// runtime. GUEST code (INV-1).
//
// Node builds this on libuv's async-context tracking, which propagates each
// store across every `await`, timer, and callback. WorkerOS has no such hook, so
// this threads the context itself (INV-5). Two mechanisms combine:
//
//   1. Each `run(store, fn)` keeps its instance's store active for the WHOLE
//      async lifetime of `fn` (until the promise it returns settles), not just
//      the synchronous frame. V8's native `await` resumes through internal
//      promise reactions we cannot wrap, so a store scoped to the sync frame
//      would vanish at the first `await`. Because the store lives on the instance,
//      resumptions still observe it.
//   2. Explicitly scheduled continuations (`.then`, timers, microtasks, message
//      ports) snapshot the full context at schedule time and restore it when they
//      run — covering callbacks that outlive the `run()` that scheduled them.
//
// Each AsyncLocalStorage instance is INDEPENDENT (its own store), exactly as in
// Node — Next relies on several instances (`workAsyncStorage`,
// `workUnitAsyncStorage`, …) holding different stores at once. The honest limit is
// concurrency: the stores are real per-instance state, but with no libuv two
// genuinely-interleaved async trees share those instances, so a callback from one
// that resumes while the other is active can see the other's store. For the
// dominant one-async-task-at-a-time pattern (a server handling one request, a
// render) this is correct.

// Every AsyncLocalStorage instance ever created, so context snapshot/restore can
// span all of them at once (Set membership is cheap; Next has ~10 instances).
const allInstances = new Set();

// The unpatched `Promise.prototype.then`, captured before installContextPropagation
// monkeypatches it — used to schedule a store-restore reaction that must NOT itself
// be context-bound (that would fight the restore).
const nativeThen = Promise.prototype.then;

// Capture the store of every instance, or null when none is active (the common
// case → callers skip all wrapping and pay nothing).
function snapshotContext() {
  let active = false;
  const snap = [];
  for (const als of allInstances) {
    snap.push([als, als._store]);
    if (als._store !== undefined) active = true;
  }
  return active ? snap : null;
}

// Run `fn` with the snapshot installed across all instances, restoring the prior
// values afterwards.
function runWithContext(snap, fn, thisArg, args) {
  const saved = [];
  for (const als of allInstances) saved.push([als, als._store]);
  for (const [als, v] of snap) als._store = v;
  try {
    return Reflect.apply(fn, thisArg, args);
  } finally {
    for (const [als, v] of saved) als._store = v;
  }
}

function installContextPropagation() {
  if (globalThis.__workerosAlsPatched) return;
  globalThis.__workerosAlsPatched = true;

  // Wrap a scheduled callback so it runs under the context active *now* (at
  // schedule time). Returns the callback unchanged when no store is active.
  const bindCtx = (fn) => {
    if (typeof fn !== "function") return fn;
    const snap = snapshotContext();
    if (!snap) return fn;
    return function (...args) {
      return runWithContext(snap, fn, this, args);
    };
  };

  // Promises: then/catch/finally carry the context of the code that registered them.
  const proto = Promise.prototype;
  const origThen = proto.then;
  proto.then = function (onF, onR) {
    return origThen.call(this, bindCtx(onF), bindCtx(onR));
  };
  const origCatch = proto.catch;
  if (typeof origCatch === "function") {
    proto.catch = function (onR) {
      return origCatch.call(this, bindCtx(onR));
    };
  }
  const origFinally = proto.finally;
  if (typeof origFinally === "function") {
    proto.finally = function (onFin) {
      return origFinally.call(this, bindCtx(onFin));
    };
  }

  // Microtasks + timers: same idea for the other ways a continuation is deferred.
  const patchScheduler = (name) => {
    const orig = globalThis[name];
    if (typeof orig !== "function") return;
    globalThis[name] = function (cb, ...rest) {
      return orig.call(this, bindCtx(cb), ...rest);
    };
  };
  patchScheduler("queueMicrotask");
  patchScheduler("setTimeout");
  patchScheduler("setInterval");
  patchScheduler("setImmediate");
  if (globalThis.process && typeof globalThis.process.nextTick === "function") {
    const origNextTick = globalThis.process.nextTick;
    globalThis.process.nextTick = function (cb, ...rest) {
      return origNextTick.call(this, bindCtx(cb), ...rest);
    };
  }

  // MessagePort message events. In a Worker `MessageChannel` exists, so libraries
  // that yield to the event loop via a channel — notably React's `scheduler`,
  // which does `port1.onmessage = work; port2.postMessage(null)` to slice server
  // rendering — run their continuation in a 'message' handler, not a timer. Node
  // threads the context through a MessagePort; we carry a FIFO of context
  // snapshots from a port to its entangled peer (linked in the MessageChannel
  // wrapper below; delivery is ordered and 1:1) and restore the match per message.
  const MP = globalThis.MessagePort;
  const MC = globalThis.MessageChannel;
  if (typeof MP === "function" && MP.prototype && typeof MC === "function" && !MP.prototype.__wosCtxPatched) {
    MP.prototype.__wosCtxPatched = true;
    const origPost = MP.prototype.postMessage;
    MP.prototype.postMessage = function (...args) {
      const peer = this.__wosPeer;
      if (peer) (peer.__wosCtxQ || (peer.__wosCtxQ = [])).push(snapshotContext());
      return origPost.apply(this, args);
    };
    const wrapHandler = (port, fn) => {
      if (typeof fn !== "function") return fn;
      return function (...a) {
        const q = port.__wosCtxQ;
        const snap = q && q.length ? q.shift() : null;
        return snap ? runWithContext(snap, fn, this, a) : fn.apply(this, a);
      };
    };
    const onmsg = Object.getOwnPropertyDescriptor(MP.prototype, "onmessage");
    if (onmsg && onmsg.set) {
      Object.defineProperty(MP.prototype, "onmessage", {
        configurable: true,
        enumerable: onmsg.enumerable,
        get: onmsg.get,
        set(fn) { onmsg.set.call(this, wrapHandler(this, fn)); },
      });
    }
    const origAdd = MP.prototype.addEventListener;
    if (typeof origAdd === "function") {
      MP.prototype.addEventListener = function (type, listener, ...rest) {
        return type === "message" && typeof listener === "function"
          ? origAdd.call(this, type, wrapHandler(this, listener), ...rest)
          : origAdd.call(this, type, listener, ...rest);
      };
    }
    globalThis.MessageChannel = function MessageChannel() {
      const ch = new MC();
      if (ch.port1 && ch.port2) { ch.port1.__wosPeer = ch.port2; ch.port2.__wosPeer = ch.port1; }
      return ch;
    };
    globalThis.MessageChannel.prototype = MC.prototype;
  }
}

export class AsyncLocalStorage {
  constructor() {
    this._enabled = true;
    this._store = undefined;
    allInstances.add(this);
    // Install async-context propagation the first time any store exists — a program
    // that never uses AsyncLocalStorage pays nothing (loading the module is free).
    installContextPropagation();
  }

  // Run `fn` with `store` as this instance's active store. If `fn` is async
  // (returns a thenable), hold the store until that promise settles so the awaited
  // work sees it (see the module header); otherwise restore at the sync boundary.
  run(store, fn, ...args) {
    const prev = this._store;
    this._store = store;
    let result;
    try {
      result = fn(...args);
    } catch (err) {
      this._store = prev;
      throw err;
    }
    if (result != null && typeof result.then === "function") {
      // Restore only if nothing deeper re-pointed this instance meanwhile, so an
      // inner run/enterWith that outlives us isn't clobbered.
      const restore = () => { if (this._store === store) this._store = prev; };
      nativeThen.call(result, restore, restore);
      return result;
    }
    this._store = prev;
    return result;
  }

  // Run `fn` with no active store for this instance, restoring afterwards.
  exit(fn, ...args) {
    const prev = this._store;
    this._store = undefined;
    try {
      return fn(...args);
    } finally {
      this._store = prev;
    }
  }

  getStore() {
    return this._enabled ? this._store : undefined;
  }

  // Set the active store for the rest of the current async context (no auto-restore).
  enterWith(store) {
    this._enabled = true;
    this._store = store;
  }

  disable() {
    this._enabled = false;
    this._store = undefined;
  }

  // Bind a snapshot of the current (all-instance) context to `fn`.
  static bind(fn) {
    const snap = snapshotContext();
    return function (...args) {
      return snap ? runWithContext(snap, fn, this, args) : fn.apply(this, args);
    };
  }

  static snapshot() {
    const snap = snapshotContext();
    return (fn, ...args) => (snap ? runWithContext(snap, fn, undefined, args) : fn(...args));
  }
}

// AsyncResource: without libuv there is no real async id/destroy lifecycle, but
// the behaviour libraries depend on is context propagation — capture the active
// context at construction and restore it whenever the callback runs later. This is
// what makes `@inquirer/core` work: it binds its keypress handlers with
// `AsyncResource.bind(fn)` during a render (stores active), and when a keystroke
// fires them asynchronously, `getStore()` still returns that render's stores.
export class AsyncResource {
  constructor(type, opts) {
    this.type = type;
    this._asyncId = typeof opts === "object" && opts && typeof opts.asyncId === "number" ? opts.asyncId : 1;
    this._snap = snapshotContext(); // the async context captured at creation time
  }

  runInAsyncScope(fn, thisArg, ...args) {
    return this._snap ? runWithContext(this._snap, fn, thisArg, args) : Reflect.apply(fn, thisArg, args);
  }

  emitDestroy() {
    return this;
  }

  asyncId() {
    return this._asyncId;
  }

  triggerAsyncId() {
    return 0;
  }

  // Bind `fn` so every later call runs under the context captured by this resource.
  bind(fn) {
    const self = this;
    return function (...args) { return self.runInAsyncScope(fn, this, ...args); };
  }

  // Static bind: snapshot the current context now, restore it on each later call.
  static bind(fn, type, thisArg) {
    const res = new AsyncResource(type || fn.name || "bound-anonymous-fn");
    return function (...args) {
      return res.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args);
    };
  }
}

// Diagnostic hooks are inert (no libuv lifecycle to observe), but the constructor
// and enable/disable API must exist for libraries that register a hook defensively.
export function createHook(callbacks) {
  return {
    enable() {
      return this;
    },
    disable() {
      return this;
    },
    _callbacks: callbacks,
  };
}

export function executionAsyncId() {
  return 1;
}

export function triggerAsyncId() {
  return 0;
}

export function executionAsyncResource() {
  return Object.create(null);
}

const asyncHooks = {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  triggerAsyncId,
  executionAsyncResource,
};

export default asyncHooks;
