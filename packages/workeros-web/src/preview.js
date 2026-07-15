// Client-side half of the preview transport (ADR-021). The combined service
// worker (public/preview-sw.js) intercepts a `fetch` to
// `/__preview__/<osId>/<port>/…`, serializes it to raw HTTP bytes, and asks the
// page that owns that OS instance to run it against the in-OS server. This module
// is that page-side bridge: it relays the SW's request to the kernel worker
// (`os.preview`) and returns the response bytes over the SW's `MessageChannel`
// port. The kernel worker's injector does the actual byte moving; here we only
// shuttle messages across the SW⇆page boundary that the SW cannot cross to the
// kernel worker directly.
//
// Why the URL carries an `osId`: every page that boots gets its OWN kernel, so
// "port 8080" means nothing without saying *whose* port 8080. A service worker is
// shared by every tab on the origin and cannot tell which tab an iframe (or its
// subresources) belongs to — `event.clientId` for a subresource is the preview
// iframe itself, which has no bridge. Without an id in the path the SW had to guess
// a client, and guessing wrong served one tab's request from another tab's kernel:
// two tabs open meant a request could hit a kernel with nothing on that port and
// come back "connection refused" while your server was running fine — or, worse,
// silently return another OS instance's page. The id makes the target explicit, so
// each bridge answers only for itself.

/** Ids are prefixed so `/__preview__/<osId>/<port>/` can't be confused with the
 *  legacy `/__preview__/<port>/` form (a port is all digits). */
const newPreviewId = () =>
  "wos" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

/**
 * Wire the Service Worker → page → kernel-worker relay. Call once after `boot()`.
 * Tags `os` with a `previewId` identifying this OS instance, and answers only the
 * requests addressed to it (a request with no id is answered by any bridge, which
 * keeps the legacy `/__preview__/<port>/` path working). Returns an unsubscribe fn;
 * a no-op where Service Workers are unavailable.
 */
export function installPreviewBridge(os) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return () => {};
  if (!os.previewId) os.previewId = newPreviewId();
  const onMessage = (event) => {
    const data = event.data;
    if (!data || data.type !== "workeros-preview") return;
    const replyPort = event.ports && event.ports[0];
    if (!replyPort) return;
    // Addressed to another tab's OS: decline, so the SW can take the answer from
    // whichever bridge owns it instead of ours.
    if (data.osId && data.osId !== os.previewId) {
      replyPort.postMessage({ ok: false, error: "not this OS instance", mismatch: true });
      return;
    }
    os.preview(data.port, data.bytes)
      .then((bytes) => replyPort.postMessage({ ok: true, bytes }))
      .catch((err) => replyPort.postMessage({ ok: false, error: String((err && err.message) || err) }));
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/**
 * Build the same-origin preview URL for one OS instance's port + path — e.g.
 * `previewPath(os.previewId, 5173)` → "/__preview__/wosab12cd/5173/". Relative
 * subresources on the served page resolve under that prefix, so they carry the
 * same `osId` back to the right kernel.
 */
export function previewPath(osId, port, path = "/") {
  const p = path.startsWith("/") ? path : "/" + path;
  return `/__preview__/${osId}/${port}${p}`;
}
