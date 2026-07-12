// `node:events` — a Node-compatible EventEmitter for the WorkerOS Node runtime.
//
// GUEST code (INV-1): a real EventEmitter (the class most of npm extends or
// depends on transitively), not the minimal inline emitter /bin/node uses for
// `process`. Covers the full listener surface (on/once/off, prepend variants,
// removeAllListeners, listeners/rawListeners, listenerCount, eventNames), the
// special `newListener`/`removeListener`/`error` events, max-listeners tracking,
// and the static helpers `EventEmitter.once`/`on`/`getEventListeners`. Like Node,
// the module *is* the constructor (`require('events')` and its `.EventEmitter`
// property are the same function). Pure JS — no kernel involvement.

const kCapture = Symbol("nodejs.rejection");
const kErrorMonitor = Symbol("events.errorMonitor");

export function EventEmitter(options) {
  EventEmitter.init.call(this, options);
}

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.captureRejectionSymbol = kCapture;
EventEmitter.errorMonitor = kErrorMonitor;
EventEmitter.defaultMaxListeners = 10;

EventEmitter.init = function init(options) {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
    this._events = new Map();
    this._eventsCount = 0;
  }
  this._maxListeners = this._maxListeners ?? undefined;
  this[kCapture] = options && options.captureRejections ? true : false;
};

const listeners = (self, type) => self._events.get(type);

function addListener(self, type, listener, prepend) {
  if (typeof listener !== "function") throw new TypeError('The "listener" argument must be a function');
  if (self._events === undefined) EventEmitter.init.call(self);

  // 'newListener' fires before the listener is added (Node contract).
  if (self._events.has("newListener")) {
    self.emit("newListener", type, listener.listener ?? listener);
  }

  let existing = self._events.get(type);
  if (existing === undefined) {
    self._events.set(type, listener);
    self._eventsCount++;
  } else {
    if (typeof existing === "function") existing = [existing];
    if (prepend) existing.unshift(listener); else existing.push(listener);
    self._events.set(type, existing);
    // Max-listeners warning (non-fatal, exactly like Node).
    const max = self.getMaxListeners();
    if (max > 0 && existing.length > max && !existing.warned) {
      existing.warned = true;
      const w = new Error(
        `Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} ` +
          `listeners added. Use emitter.setMaxListeners() to increase limit`,
      );
      w.name = "MaxListenersExceededWarning";
      (globalThis.process?.emitWarning ?? ((e) => console.warn(e.message)))(w);
    }
  }
  return self;
}

function onceWrap(self, type, listener) {
  const state = { fired: false, wrapFn: undefined };
  const wrapped = function (...args) {
    if (state.fired) return;
    state.fired = true;
    self.removeListener(type, state.wrapFn);
    return listener.apply(self, args);
  };
  wrapped.listener = listener; // so removeListener(original) works
  state.wrapFn = wrapped;
  return wrapped;
}

Object.assign(EventEmitter.prototype, {
  _events: undefined,
  _eventsCount: 0,
  _maxListeners: undefined,

  setMaxListeners(n) {
    if (typeof n !== "number" || n < 0 || Number.isNaN(n)) {
      throw new RangeError('The value of "n" is out of range.');
    }
    this._maxListeners = n;
    return this;
  },
  getMaxListeners() {
    return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
  },

  addListener(type, listener) { return addListener(this, type, listener, false); },
  on(type, listener) { return addListener(this, type, listener, false); },
  prependListener(type, listener) { return addListener(this, type, listener, true); },
  once(type, listener) {
    if (typeof listener !== "function") throw new TypeError('The "listener" argument must be a function');
    return addListener(this, type, onceWrap(this, type, listener), false);
  },
  prependOnceListener(type, listener) {
    if (typeof listener !== "function") throw new TypeError('The "listener" argument must be a function');
    return addListener(this, type, onceWrap(this, type, listener), true);
  },

  removeListener(type, listener) {
    if (typeof listener !== "function") throw new TypeError('The "listener" argument must be a function');
    if (this._events === undefined) return this;
    const list = this._events.get(type);
    if (list === undefined) return this;

    const matches = (l) => l === listener || l.listener === listener;
    if (typeof list === "function") {
      if (matches(list)) {
        this._events.delete(type);
        this._eventsCount--;
        if (this._events.has("removeListener")) this.emit("removeListener", type, listener);
      }
      return this;
    }
    const idx = list.findIndex(matches);
    if (idx < 0) return this;
    const removed = list.splice(idx, 1)[0];
    if (list.length === 0) { this._events.delete(type); this._eventsCount--; }
    else if (list.length === 1) this._events.set(type, list[0]);
    if (this._events.has("removeListener")) this.emit("removeListener", type, removed.listener ?? removed);
    return this;
  },
  // `off` is aliased to `removeListener` (same function) after this object is
  // assigned — see below. It must NOT be a wrapper that calls `this.removeListener`:
  // a subclass that overrides `removeListener` to call `this.off` (minipass does
  // exactly this) would then recurse infinitely through `super.off`. Node aliases
  // them to the same function for the same reason.

  removeAllListeners(type) {
    if (this._events === undefined) return this;
    // No 'removeListener' hook → fast path.
    if (!this._events.has("removeListener")) {
      if (arguments.length === 0) { this._events = new Map(); this._eventsCount = 0; }
      else if (this._events.delete(type)) this._eventsCount--;
      return this;
    }
    if (arguments.length === 0) {
      for (const key of [...this._events.keys()]) {
        if (key === "removeListener") continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners("removeListener");
      this._events = new Map();
      this._eventsCount = 0;
      return this;
    }
    for (const l of this.rawListeners(type).reverse()) this.removeListener(type, l.listener ?? l);
    return this;
  },

  emit(type, ...args) {
    const list = this._events?.get(type);
    if (list === undefined) {
      // An unhandled 'error' throws — Node's defining behavior.
      if (type === "error") {
        const err = args[0];
        throw err instanceof Error ? err : Object.assign(new Error(`Unhandled error. (${err})`), { context: err });
      }
      return false;
    }
    // errorMonitor listeners see the error but don't count as "handled".
    if (type === "error" && this._events.has(kErrorMonitor)) {
      for (const l of [].concat(this._events.get(kErrorMonitor))) l.apply(this, args);
    }
    const handlers = typeof list === "function" ? [list] : list.slice();
    for (const h of handlers) {
      const r = h.apply(this, args);
      // captureRejections: route a rejected promise to 'error'.
      if (this[kCapture] && r && typeof r.then === "function") {
        r.then(undefined, (e) => this.emit("error", e));
      }
    }
    return true;
  },

  listeners(type) {
    return this.rawListeners(type).map((l) => l.listener ?? l);
  },
  rawListeners(type) {
    const list = this._events?.get(type);
    if (list === undefined) return [];
    return typeof list === "function" ? [list] : list.slice();
  },
  listenerCount(type, listener) {
    const list = this._events?.get(type);
    if (list === undefined) return 0;
    const arr = typeof list === "function" ? [list] : list;
    if (typeof listener === "function") {
      return arr.filter((l) => l === listener || l.listener === listener).length;
    }
    return arr.length;
  },
  eventNames() {
    return this._eventsCount > 0 ? [...this._events.keys()] : [];
  },
});

EventEmitter.prototype.constructor = EventEmitter;
// `off` IS `removeListener` (identical function), as in Node — never a wrapper
// (see the note above `removeAllListeners`).
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

// ---- static helpers -------------------------------------------------------

EventEmitter.listenerCount = (emitter, type) => emitter.listenerCount(type);
EventEmitter.getEventListeners = (emitter, type) =>
  typeof emitter.listeners === "function" ? emitter.listeners(type) : [];

// once(emitter, name[, opts]) → Promise resolving with the event args (rejects on
// 'error', or when an AbortSignal fires).
EventEmitter.once = function once(emitter, name, options = {}) {
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const onError = (err) => { cleanup(); reject(err); };
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => {
      emitter.removeListener(name, onEvent);
      if (name !== "error") emitter.removeListener("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    emitter.once(name, onEvent);
    if (name !== "error") emitter.once("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
};

// on(emitter, name[, opts]) → async iterator of event-arg arrays.
EventEmitter.on = function on(emitter, name, options = {}) {
  const signal = options.signal;
  const queue = [];
  const waiting = [];
  let finished = false;
  let error = null;

  const push = (args) => {
    if (waiting.length) waiting.shift().resolve({ value: args, done: false });
    else queue.push(args);
  };
  const onEvent = (...args) => push(args);
  const onError = (err) => { error = err; flushDone(); };
  const onAbort = () => { error = abortError(signal); flushDone(); };
  const flushDone = () => {
    finished = true;
    while (waiting.length) {
      const w = waiting.shift();
      error ? w.reject(error) : w.resolve({ value: undefined, done: true });
    }
  };
  const cleanup = () => {
    emitter.removeListener(name, onEvent);
    emitter.removeListener("error", onError);
    signal?.removeEventListener?.("abort", onAbort);
  };

  emitter.on(name, onEvent);
  emitter.on("error", onError);
  signal?.addEventListener?.("abort", onAbort, { once: true });

  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (error) { cleanup(); return Promise.reject(error); }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() { cleanup(); finished = true; return Promise.resolve({ value: undefined, done: true }); },
    throw(err) { cleanup(); return Promise.reject(err); },
    [Symbol.asyncIterator]() { return this; },
  };
};

EventEmitter.setMaxListeners = function setMaxListeners(n = 10, ...emitters) {
  for (const e of emitters) e.setMaxListeners?.(n);
  if (emitters.length === 0) EventEmitter.defaultMaxListeners = n;
};

function abortError(signal) {
  const reason = signal?.reason;
  if (reason !== undefined) return reason;
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

// The module is the constructor itself (Node: `require('events') === EventEmitter`),
// so `import EventEmitter from 'events'` and `import { EventEmitter } from 'events'`
// both land on the same function.
export const events = EventEmitter;
export default EventEmitter;
export const once = EventEmitter.once;
export const on = EventEmitter.on;
export const getEventListeners = EventEmitter.getEventListeners;
export const setMaxListeners = EventEmitter.setMaxListeners;
export const captureRejectionSymbol = kCapture;
export const errorMonitor = kErrorMonitor;
