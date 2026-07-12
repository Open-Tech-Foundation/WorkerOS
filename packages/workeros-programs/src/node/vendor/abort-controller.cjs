// Alias target for readable-stream's `require('abort-controller')` inside the
// /bin/node bundle (see tools/bundle.mjs `readableStreamAliasPlugin`).
//
// readable-stream only reaches this require as a fallback: every call site is
// `globalThis.AbortController || require('abort-controller').AbortController`. The
// browser/worker always provides these globals, so the fallback is effectively
// dead code — but esbuild still resolves the specifier statically at bundle time,
// so we mirror the globals to keep the reference valid.
module.exports = {
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};
