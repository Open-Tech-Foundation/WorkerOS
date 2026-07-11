// `node:timers` — the timer module facade over the installed Node-style globals.
//
// GUEST code (INV-1): this is intentionally thin. The actual handle semantics and
// keep-alive behavior live in `event-loop.js`; this module just exposes the
// standard `node:timers` entrypoint over those already-installed globals.

export function createTimers(target = globalThis) {
  const mod = {
    setTimeout: (...args) => target.setTimeout(...args),
    clearTimeout: (handle) => target.clearTimeout(handle),
    setInterval: (...args) => target.setInterval(...args),
    clearInterval: (handle) => target.clearInterval(handle),
    setImmediate: (...args) => target.setImmediate(...args),
    clearImmediate: (handle) => target.clearImmediate(handle),
    // Legacy helpers some packages still touch. We keep them honest and minimal:
    // they annotate/return the handle but do not try to recreate libuv internals.
    active: (handle) => {
      if (handle && typeof handle.refresh === "function") handle.refresh();
      return handle;
    },
    enroll: (handle, msecs) => {
      if (handle && typeof handle === "object") handle._idleTimeout = msecs;
      return handle;
    },
    unenroll: (handle) => {
      if (handle && typeof handle.close === "function") handle.close();
      else if (handle && typeof target.clearTimeout === "function") target.clearTimeout(handle);
      return handle;
    },
  };
  mod.default = mod;
  return mod;
}

export const timers = createTimers();
export default timers;
