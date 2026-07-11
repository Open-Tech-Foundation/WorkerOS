// `node:timers/promises` — promise/async-iterator timers over installed globals.
//
// GUEST code (INV-1): a thin async facade over the event-loop-backed timer
// globals. This keeps all actual scheduling and handle semantics in one place
// (`event-loop.js`) while exposing the promise helpers packages import directly.

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

function applyOptions(handle, options) {
  if (options && options.ref === false && handle && typeof handle.unref === "function") handle.unref();
}

function withAbort(signal, onAbort) {
  if (!signal) return () => {};
  const abort = () => onAbort(abortError());
  if (signal.aborted) {
    abort();
    return null;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export function createTimersPromises(target = globalThis) {
  const setTimeoutPromise = (delay = 1, value, options = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        cleanup?.();
        fn(arg);
      };
      const handle = target.setTimeout(() => done(resolve, value), delay);
      applyOptions(handle, options);
      const cleanup = withAbort(options.signal, (err) => {
        target.clearTimeout(handle);
        done(reject, err);
      });
      if (cleanup === null) {
        target.clearTimeout(handle);
        done(reject, abortError());
      }
    });

  const setImmediatePromise = (value, options = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        cleanup?.();
        fn(arg);
      };
      const handle = target.setImmediate(() => done(resolve, value));
      applyOptions(handle, options);
      const cleanup = withAbort(options.signal, (err) => {
        target.clearImmediate(handle);
        done(reject, err);
      });
      if (cleanup === null) {
        target.clearImmediate(handle);
        done(reject, abortError());
      }
    });

  const setIntervalAsync = async function* (delay = 1, value, options = {}) {
    if (options.signal?.aborted) throw abortError();
    const queue = [];
    let pendingResolve = null;
    let pendingReject = null;
    let finished = false;
    const emit = (entry) => {
      if (finished) return;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolve(entry);
      } else {
        queue.push(entry);
      }
    };
    const handle = target.setInterval(() => emit({ ok: true, value }), delay);
    applyOptions(handle, options);
    const cleanupAbort = withAbort(options.signal, (err) => {
      target.clearInterval(handle);
      finished = true;
      emit({ ok: false, error: err });
    });
    if (cleanupAbort === null) {
      target.clearInterval(handle);
      throw abortError();
    }
    try {
      for (;;) {
        const entry = queue.length
          ? queue.shift()
          : await new Promise((resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;
            });
        if (!entry.ok) throw entry.error;
        yield entry.value;
      }
    } finally {
      finished = true;
      if (pendingReject) pendingReject(abortError());
      cleanupAbort();
      target.clearInterval(handle);
    }
  };

  const scheduler = {
    wait: setTimeoutPromise,
    yield: () => setImmediatePromise(),
  };

  const mod = {
    setTimeout: setTimeoutPromise,
    setImmediate: setImmediatePromise,
    setInterval: setIntervalAsync,
    scheduler,
  };
  mod.default = mod;
  return mod;
}

export const timersPromises = createTimersPromises();
export default timersPromises;
