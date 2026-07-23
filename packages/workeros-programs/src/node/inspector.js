// `node:inspector` (and `node:inspector/promises`) — the V8 inspector API, for
// the WorkerOS Node runtime.
//
// GUEST code (INV-1). WorkerOS has no V8 inspector to attach to, so this reports
// "no debugger" truthfully: `url()` is undefined, `open`/`waitForDebugger` are
// no-ops, and a `Session` connects but answers every command with an error
// (there is no backend). The surface exists in full so feature-detection code —
// Next.js dims console output only when `inspector.url()` is falsy — takes the
// right branch instead of crashing on a missing module.

import { EventEmitter } from "./events.js";

class Session extends EventEmitter {
  connect() {
    if (this._connected) throw new Error("The inspector session is already connected");
    this._connected = true;
  }
  connectToMainThread() {
    this.connect();
  }
  disconnect() {
    this._connected = false;
  }
  post(method, params, callback) {
    const cb = typeof params === "function" ? params : callback;
    // No inspector backend: report the command as unsupported, asynchronously,
    // exactly as a real failed post would deliver its error.
    if (typeof cb === "function") {
      queueMicrotask(() => cb(new Error(`inspector: command '${method}' is not available in WorkerOS`)));
    }
  }
}

const noop = () => {};

const inspectorModule = {
  Session,
  // No listening inspector → no URL (Node returns undefined when not open).
  url: () => undefined,
  open: noop,
  close: noop,
  waitForDebugger: noop,
  // The original, un-instrumented console (Node exposes it here); ours is the
  // process console.
  get console() {
    return globalThis.console;
  },
};
inspectorModule.default = inspectorModule;

// `node:inspector/promises` — same surface, with a promise-based Session.post.
class PromisesSession extends Session {
  post(method, params) {
    return new Promise((resolve, reject) => {
      super.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }
}

export const promises = {
  Session: PromisesSession,
  url: inspectorModule.url,
  open: noop,
  close: noop,
  waitForDebugger: noop,
  get console() {
    return globalThis.console;
  },
};
promises.default = promises;

export default inspectorModule;
