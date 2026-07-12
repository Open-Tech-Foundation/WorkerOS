// Alias target for readable-stream's `require('process/')` inside the /bin/node
// bundle (see tools/bundle.mjs `readableStreamAliasPlugin`).
//
// WorkerOS installs the real process object on globalThis during boot, but this
// module can be evaluated *before* that assignment runs: node:stream is a static
// import of node-program.js, so readable-stream initializes as the import graph is
// wired, ahead of `globalThis.process = process`. We therefore must NOT snapshot
// the value — proxy every read to the live global at access time. `nextTick` and
// friends are only ever *called* at runtime, long after boot, when the global is
// set. Methods are bound to the real process so `this` stays correct.
module.exports = new Proxy(
  {},
  {
    get(_t, k) {
      const p = globalThis.process;
      const v = p ? p[k] : undefined;
      return typeof v === "function" ? v.bind(p) : v;
    },
    has(_t, k) {
      return globalThis.process ? k in globalThis.process : false;
    },
  },
);
