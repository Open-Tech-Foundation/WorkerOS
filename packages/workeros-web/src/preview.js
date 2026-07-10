// Client-side half of the preview transport (ADR-021). The combined service
// worker (public/preview-sw.js) intercepts a `fetch` to `/__preview__/<port>/…`,
// serializes it to raw HTTP bytes, and asks the controlling page to run it
// against the in-OS server. This module is that page-side bridge: it relays the
// SW's request to the kernel worker (`os.preview`) and returns the response bytes
// over the SW's `MessageChannel` port. The kernel worker's injector does the
// actual byte moving; here we only shuttle messages across the SW⇆page boundary
// that the SW cannot cross to the kernel worker directly.

/**
 * Wire the Service Worker → page → kernel-worker relay. Call once after `boot()`.
 * Returns an unsubscribe fn. No-op (returns a no-op) where Service Workers are
 * unavailable.
 */
export function installPreviewBridge(os) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return () => {};
  const onMessage = (event) => {
    const data = event.data;
    if (!data || data.type !== "workeros-preview") return;
    const replyPort = event.ports && event.ports[0];
    if (!replyPort) return;
    os.preview(data.port, data.bytes)
      .then((bytes) => replyPort.postMessage({ ok: true, bytes }))
      .catch((err) => replyPort.postMessage({ ok: false, error: String((err && err.message) || err) }));
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/** Build the same-origin preview URL for a port + path (e.g. "/__preview__/5173/"). */
export function previewPath(port, path = "/") {
  const p = path.startsWith("/") ? path : "/" + path;
  return `/__preview__/${port}${p}`;
}
