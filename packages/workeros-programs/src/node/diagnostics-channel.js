// `node:diagnostics_channel` — named pub/sub channels for the WorkerOS Node
// runtime.
//
// GUEST code (INV-1): a real implementation, not a stub. undici (bundled into
// Next.js's @edge-runtime/primitives) requires it at load time and publishes to
// channels for request tracing; `hasSubscribers` gates that work, so with no
// subscribers it is effectively free. The whole surface is synchronous in-process
// message passing — no host I/O — so it is implemented in full here: `Channel`
// (publish/subscribe + bindStore/runStores) and `tracingChannel` (the
// start/end/asyncStart/asyncEnd/error sub-channels with traceSync/tracePromise/
// traceCallback), which is what modern undici uses.

class Channel {
  constructor(name) {
    this.name = name;
    this._subscribers = [];
    this._stores = new Map(); // store -> transform
  }

  get hasSubscribers() {
    return this._subscribers.length > 0;
  }

  subscribe(onMessage) {
    this._subscribers.push(onMessage);
  }

  unsubscribe(onMessage) {
    const i = this._subscribers.indexOf(onMessage);
    if (i === -1) return false;
    this._subscribers.splice(i, 1);
    return true;
  }

  publish(message) {
    // Snapshot: a subscriber may unsubscribe during delivery. A throwing
    // subscriber must not abort the others (Node reports it as an uncaught
    // exception; here it is surfaced without stopping delivery).
    for (const fn of this._subscribers.slice()) {
      try {
        fn(message, this.name);
      } catch (e) {
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }

  bindStore(store, transform) {
    this._stores.set(store, transform || ((v) => v));
  }

  unbindStore(store) {
    return this._stores.delete(store);
  }

  runStores(message, fn, thisArg, ...args) {
    // AsyncLocalStorage-backed context. Nest each bound store's run() so the
    // callback sees every store set to its transformed value, then invoke fn.
    let run = () => fn.apply(thisArg, args);
    for (const [store, transform] of this._stores) {
      const inner = run;
      run = () => store.run(transform(message), inner);
    }
    return run();
  }
}

const channels = new Map(); // name -> Channel (weakly-referenced semantics not required here)

function channel(name) {
  let ch = channels.get(name);
  if (!ch) {
    ch = new Channel(name);
    channels.set(name, ch);
  }
  return ch;
}

function hasSubscribers(name) {
  const ch = channels.get(name);
  return ch ? ch.hasSubscribers : false;
}

function subscribe(name, onMessage) {
  channel(name).subscribe(onMessage);
}

function unsubscribe(name, onMessage) {
  const ch = channels.get(name);
  return ch ? ch.unsubscribe(onMessage) : false;
}

// The tracing-channel group: one composite over five named sub-channels.
class TracingChannel {
  constructor(nameOrChannels) {
    if (typeof nameOrChannels === "string") {
      const n = nameOrChannels;
      this.start = channel(`tracing:${n}:start`);
      this.end = channel(`tracing:${n}:end`);
      this.asyncStart = channel(`tracing:${n}:asyncStart`);
      this.asyncEnd = channel(`tracing:${n}:asyncEnd`);
      this.error = channel(`tracing:${n}:error`);
    } else {
      const c = nameOrChannels || {};
      this.start = c.start;
      this.end = c.end;
      this.asyncStart = c.asyncStart;
      this.asyncEnd = c.asyncEnd;
      this.error = c.error;
    }
  }

  get hasSubscribers() {
    return (
      this.start.hasSubscribers ||
      this.end.hasSubscribers ||
      this.asyncStart.hasSubscribers ||
      this.asyncEnd.hasSubscribers ||
      this.error.hasSubscribers
    );
  }

  subscribe(handlers) {
    for (const k of ["start", "end", "asyncStart", "asyncEnd", "error"]) {
      if (handlers[k]) this[k].subscribe(handlers[k]);
    }
  }

  unsubscribe(handlers) {
    let ok = true;
    for (const k of ["start", "end", "asyncStart", "asyncEnd", "error"]) {
      if (handlers[k]) ok = this[k].unsubscribe(handlers[k]) && ok;
    }
    return ok;
  }

  traceSync(fn, context = {}, thisArg, ...args) {
    this.start.publish(context);
    try {
      const result = fn.apply(thisArg, args);
      context.result = result;
      return result;
    } catch (err) {
      context.error = err;
      this.error.publish(context);
      throw err;
    } finally {
      this.end.publish(context);
    }
  }

  tracePromise(fn, context = {}, thisArg, ...args) {
    this.start.publish(context);
    let promise;
    try {
      promise = fn.apply(thisArg, args);
    } catch (err) {
      context.error = err;
      this.error.publish(context);
      this.end.publish(context);
      throw err;
    }
    this.end.publish(context);
    this.asyncStart.publish(context);
    return Promise.resolve(promise).then(
      (result) => {
        context.result = result;
        this.asyncEnd.publish(context);
        return result;
      },
      (err) => {
        context.error = err;
        this.error.publish(context);
        this.asyncEnd.publish(context);
        throw err;
      },
    );
  }

  traceCallback(fn, position, context = {}, thisArg, ...args) {
    this.start.publish(context);
    const self = this;
    const cb = args[position];
    if (typeof cb === "function") {
      args[position] = function (err, ...rest) {
        if (err) {
          context.error = err;
          self.error.publish(context);
        } else {
          context.result = rest[0];
        }
        self.asyncStart.publish(context);
        try {
          return cb.apply(this, [err, ...rest]);
        } finally {
          self.asyncEnd.publish(context);
        }
      };
    }
    try {
      return fn.apply(thisArg, args);
    } catch (err) {
      context.error = err;
      this.error.publish(context);
      throw err;
    } finally {
      this.end.publish(context);
    }
  }
}

function tracingChannel(nameOrChannels) {
  return new TracingChannel(nameOrChannels);
}

const diagnosticsChannel = {
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
  Channel,
  TracingChannel,
};
diagnosticsChannel.default = diagnosticsChannel;

export default diagnosticsChannel;
