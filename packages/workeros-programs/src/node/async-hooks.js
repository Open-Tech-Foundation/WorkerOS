// `node:async_hooks` — AsyncLocalStorage / AsyncResource for the WorkerOS Node
// runtime. GUEST code (INV-1).
//
// Node builds this on libuv's async-context tracking, which propagates the active
// store across every `await`, timer, and callback. WorkerOS has no such hook into
// the host event loop, so this is a best-effort, synchronous-scope implementation
// (INV-5): `run(store, fn)` makes `getStore()` return `store` for the *synchronous*
// execution of `fn`, and `enterWith(store)` sets it until the next `run`/`exit`.
// Continuations resumed after an `await` inside `fn` see the store that was current
// when they were *scheduled* only if nothing else ran `run`/`enterWith` in between
// — good enough for the common "wrap a request in run(), read getStore() in the
// handler" pattern, without pretending to do full async propagation.

let currentStore; // the active store for the running synchronous frame

// Real AsyncLocalStorage propagates the active store across every async hop — a
// `.then()` continuation, a timer, a microtask — because libuv threads the async
// context through them. WorkerOS has no libuv, so we thread it ourselves: when a
// continuation is *scheduled* while a store is active, capture the store and
// restore it while the continuation runs. This is what lets `@inquirer/core` (and
// anything hook-based) keep its store across the promise chain a prompt resolves
// through. Installed once, lazily, the first time node:async_hooks is used — so
// programs that never touch async_hooks pay nothing, and even for those that do,
// the wrap is skipped whenever no store is active (`currentStore === undefined`),
// which is the overwhelmingly common case.
function installContextPropagation() {
  if (globalThis.__workerosAlsPatched) return;
  globalThis.__workerosAlsPatched = true;

  // Wrap a scheduled callback so it runs under the store active *now* (at schedule
  // time). Returns the callback unchanged when no store is active — zero overhead.
  const bindCtx = (fn) => {
    if (typeof fn !== "function" || currentStore === undefined) return fn;
    const snapshot = currentStore;
    return function (...args) {
      const prev = currentStore;
      currentStore = snapshot;
      try {
        return fn.apply(this, args);
      } finally {
        currentStore = prev;
      }
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
}

export class AsyncLocalStorage {
  constructor() {
    this._enabled = true;
    // Install the async-context propagation the first time any store exists — so a
    // program that never uses AsyncLocalStorage never has its promises/timers
    // wrapped (the module merely being loaded costs nothing).
    installContextPropagation();
  }

  // Run `fn` with `store` as the active store, restoring the previous store when
  // `fn` returns (synchronously — a returned promise resolves under whatever store
  // is current then; that's the honest limit).
  run(store, fn, ...args) {
    const prev = currentStore;
    currentStore = store;
    try {
      return fn(...args);
    } finally {
      currentStore = prev;
    }
  }

  // Run `fn` with no active store, restoring afterwards.
  exit(fn, ...args) {
    const prev = currentStore;
    currentStore = undefined;
    try {
      return fn(...args);
    } finally {
      currentStore = prev;
    }
  }

  getStore() {
    return this._enabled ? currentStore : undefined;
  }

  // Set the active store for the rest of the current frame (no automatic restore).
  enterWith(store) {
    this._enabled = true;
    currentStore = store;
  }

  disable() {
    this._enabled = false;
    currentStore = undefined;
  }

  // Static helper Node added: bind a snapshot of the current store to `fn`.
  static bind(fn) {
    const snapshot = currentStore;
    return (...args) => {
      const prev = currentStore;
      currentStore = snapshot;
      try {
        return fn(...args);
      } finally {
        currentStore = prev;
      }
    };
  }

  static snapshot() {
    const snapshot = currentStore;
    return (fn, ...args) => {
      const prev = currentStore;
      currentStore = snapshot;
      try {
        return fn(...args);
      } finally {
        currentStore = prev;
      }
    };
  }
}

// AsyncResource: without libuv there is no real async id/destroy lifecycle, but
// the one behaviour libraries genuinely depend on is context propagation — an
// AsyncResource captures the active AsyncLocalStorage store at *construction* and
// restores it whenever its callback runs later, bridging the async gap that a
// plain `run()` can't. This is what makes `@inquirer/core` work: it binds its
// keypress/update handlers with `AsyncResource.bind(fn)` during a render (store
// active), and when a keystroke fires those handlers asynchronously, `getStore()`
// must still return that render's store. So we snapshot `currentStore` here.
export class AsyncResource {
  constructor(type, opts) {
    this.type = type;
    this._asyncId = typeof opts === "object" && opts && typeof opts.asyncId === "number" ? opts.asyncId : 1;
    this._store = currentStore; // the async context captured at creation time
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const prev = currentStore;
    currentStore = this._store;
    try {
      return Reflect.apply(fn, thisArg, args);
    } finally {
      currentStore = prev;
    }
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

  // Bind `fn` so every later call runs under the store captured by this resource.
  bind(fn) {
    const self = this;
    const bound = function (...args) { return self.runInAsyncScope(fn, this, ...args); };
    return bound;
  }

  // Static bind: snapshot the current store now, restore it on each later call.
  // Matches Node: `AsyncResource.bind(fn)` returns a function pinned to the async
  // context that was active when `bind` was called.
  static bind(fn, type, thisArg) {
    const res = new AsyncResource(type || fn.name || "bound-anonymous-fn");
    const bound = function (...args) {
      return res.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args);
    };
    return bound;
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
