/*! WorkerOS single service worker: cross-origin isolation + preview (ADR-021).
 *
 * One SW owns the page scope, so this folds two jobs into one file:
 *   1. COOP/COEP header injection so `crossOriginIsolated` (→ SharedArrayBuffer)
 *      works on any host — the coi-serviceworker v0.1.7 behavior, verbatim.
 *   2. Preview interception: a `fetch` to `/__preview__/<port>/…` is turned into
 *      raw HTTP/1.1 bytes, relayed to the page (which drives the kernel injector),
 *      and the raw response bytes become a `Response`.
 *
 * Like coi-serviceworker, the `typeof window` branch decides role: included as a
 * <script> it self-registers; as the SW itself it runs the handlers below.
 *
 * The byte transforms are inlined from ../packages/workeros-web/src/preview-http.js,
 * which is node-tested (tools/preview-http.test.js). Keep the two in sync (the
 * same tested-reference/mirror discipline as the ringbuffer, ADR-015).
 */
let coepCredentialless = false;

if (typeof window === "undefined") {
  // ============================ service worker =============================
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const CRLF = "\r\n";

  const concatBytes = (parts) => {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };

  const serializeRequest = ({ method, path, host, headers = [], body = null }) => {
    let head = `${method} ${path} HTTP/1.1${CRLF}`;
    let sawHost = false;
    for (const [name, value] of headers) {
      const lc = name.toLowerCase();
      if (lc === "connection" || lc === "transfer-encoding") continue;
      if (lc === "host") sawHost = true;
      head += `${name}: ${value}${CRLF}`;
    }
    if (!sawHost) head += `Host: ${host}${CRLF}`;
    head += `Connection: close${CRLF}${CRLF}`;
    const headBytes = enc.encode(head);
    return body && body.length ? concatBytes([headBytes, body]) : headBytes;
  };

  const headerBoundary = (buf) => {
    for (let i = 3; i < buf.length; i++) {
      if (buf[i] === 10 && buf[i - 1] === 13 && buf[i - 2] === 10 && buf[i - 3] === 13) return i + 1;
    }
    return -1;
  };

  const dechunk = (buf) => {
    const out = [];
    let pos = 0;
    const readLine = () => {
      let i = pos;
      while (i < buf.length && !(buf[i] === 13 && buf[i + 1] === 10)) i++;
      const line = dec.decode(buf.subarray(pos, i));
      pos = i + 2;
      return line;
    };
    for (;;) {
      if (pos >= buf.length) break;
      const size = parseInt(readLine().split(";")[0].trim(), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      out.push(buf.subarray(pos, pos + size));
      pos += size + 2;
    }
    return concatBytes(out);
  };

  const parseResponse = (buf) => {
    const end = headerBoundary(buf);
    if (end < 0) return { status: 502, statusText: "Bad Gateway", headers: [], body: new Uint8Array(0) };
    const lines = dec.decode(buf.subarray(0, end)).split(CRLF).filter((l) => l.length);
    const parts = (lines.shift() || "HTTP/1.1 502 Bad Gateway").split(" ");
    const status = parseInt(parts[1], 10) || 502;
    const statusText = parts.slice(2).join(" ");
    let chunked = false;
    const headers = [];
    for (const line of lines) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      const lc = name.toLowerCase();
      if (lc === "transfer-encoding") { if (/chunked/i.test(value)) chunked = true; continue; }
      if (lc === "content-length" || lc === "connection") continue;
      headers.push([name, value]);
    }
    let body = buf.subarray(end);
    if (chunked) body = dechunk(body);
    return { status, statusText, headers, body };
  };

  // ---- lifecycle + coi control message ----
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  // Ask one page to drive its kernel injector for a preview connection. A bridge
  // whose OS isn't the addressed `osId` rejects, so the caller can take the answer
  // from whichever page owns it.
  const relayToClient = (client, osId, port, bytes) =>
    new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => reject(new Error("preview timeout")), 30000);
      ch.port1.onmessage = (e) => {
        clearTimeout(timer);
        if (e.data && e.data.ok) resolve(e.data.bytes);
        else reject(new Error((e.data && e.data.error) || "preview failed"));
      };
      client.postMessage({ type: "workeros-preview", osId, port, bytes }, [ch.port2]);
    });

  const handlePreview = (event, osId, port, path) => {
    event.respondWith(
      (async () => {
        const req = event.request;
        const body =
          req.method === "GET" || req.method === "HEAD"
            ? null
            : new Uint8Array(await req.arrayBuffer());
        const reqBytes = serializeRequest({
          method: req.method,
          path,
          host: "localhost:" + port,
          headers: [...req.headers],
          body,
        });
        // Relay to the *app* pages that installed a bridge — never the preview
        // iframe itself. A subresource (e.g. style.css) has event.clientId set to
        // the iframe, which has no bridge; only a top page under a non-preview URL
        // can drive a kernel injector. (This is why the iframe navigation worked but
        // its subresources 502'd.)
        //
        // Every tab boots its OWN kernel, so we cannot just take the first page we
        // find: that served one tab's request from another tab's OS. Ask them all
        // and let the bridge whose `previewId` matches the URL answer — the others
        // decline. `osId` is null only for the legacy /__preview__/<port>/ form,
        // where any bridge may answer.
        const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const pages = wins.filter((c) => {
          try { return !new URL(c.url).pathname.startsWith("/__preview__/"); }
          catch { return false; }
        });
        if (!pages.length) return new Response("preview: no app page to route through", { status: 502 });
        let respBytes;
        try {
          // First page to accept wins; rejects (incl. "not this OS instance") are skipped.
          respBytes = await Promise.any(pages.map((c) => relayToClient(c, osId, port, reqBytes)));
        } catch (e) {
          // Promise.any → AggregateError once every bridge has declined or failed.
          const errs = e && e.errors ? e.errors : [e];
          const real = errs.find((x) => x && !/not this OS instance/.test(x.message || ""));
          const msg = (real && real.message) || "no OS instance owns this address";
          return new Response("preview: " + msg, { status: 502 });
        }
        const { status, statusText, headers, body: rbody } = parseResponse(respBytes);
        const hdrs = new Headers();
        for (const [k, v] of headers) hdrs.append(k, v);
        // Keep the preview iframe inside the cross-origin-isolated context.
        hdrs.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
        hdrs.set("Cross-Origin-Resource-Policy", "cross-origin");
        hdrs.set("Cross-Origin-Opener-Policy", "same-origin");
        const noBody = status === 204 || status === 304 || req.method === "HEAD";
        return new Response(noBody ? null : rbody, { status, statusText, headers: hdrs });
      })(),
    );
  };

  self.addEventListener("fetch", (event) => {
    const r = event.request;
    const url = new URL(r.url);

    // Preview scope: /__preview__/<osId>/<port>/<path>?<query> — the osId says which
    // tab's kernel owns the address (ids are "wos"-prefixed, so they can't be read as
    // a port).
    const mo = url.pathname.match(/^\/__preview__\/(wos[a-z0-9]+)\/(\d+)(\/[^?]*)?$/i);
    if (mo) {
      handlePreview(event, mo[1], parseInt(mo[2], 10), (mo[3] || "/") + url.search);
      return;
    }
    // Legacy scope: /__preview__/<port>/<path> — no instance named, any bridge answers.
    const m = url.pathname.match(/^\/__preview__\/(\d+)(\/[^?]*)?$/);
    if (m) {
      handlePreview(event, null, parseInt(m[1], 10), (m[2] || "/") + url.search);
      return;
    }

    // Everything else: COI header injection (coi-serviceworker, verbatim).
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    const request =
      coepCredentialless && r.mode === "no-cors" ? new Request(r, { credentials: "omit" }) : r;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp",
          );
          if (!coepCredentialless) newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e)),
    );
  });
} else {
  // ============================ window: self-register ======================
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf === "coepdegrade";

    const n = navigator;
    const controlling = n.serviceWorker && n.serviceWorker.controller;

    const coi = {
      shouldRegister: () => !reloadedBySelf,
      coepCredentialless: () => !(window.chrome !== undefined || window.netscape !== undefined),
      doReload: () => window.location.reload(),
      quiet: false,
    };

    if (controlling) {
      n.serviceWorker.controller.postMessage({
        type: "coepCredentialless",
        value: coi.coepCredentialless(),
      });
    }

    if (!window.crossOriginIsolated && !coepDegrading && coi.shouldRegister()) {
      if (!window.isSecureContext) {
        !coi.quiet &&
          console.log("WorkerOS SW not registered: a secure context is required.");
      } else if (n.serviceWorker) {
        n.serviceWorker
          .register(window.document.currentScript.src)
          .then((registration) => {
            !coi.quiet && console.log("WorkerOS SW registered", registration.scope);
            registration.addEventListener("updatefound", () => {
              window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
              coi.doReload();
            });
            if (registration.active && !n.serviceWorker.controller) {
              window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
              coi.doReload();
            }
          })
          .catch((err) => {
            !coi.quiet && console.error("WorkerOS SW failed to register:", err);
          });
      }
    }
  })();
}
