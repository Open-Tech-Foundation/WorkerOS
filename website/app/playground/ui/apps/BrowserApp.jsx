// A tabbed browser for servers running inside WorkerOS.
//
// There is no network here: an address like `localhost:3000` is a real process in
// this OS listening on port 3000. The service worker (public/preview-sw.js) turns a
// fetch of /__preview__/<port>/<path> into raw HTTP/1.1 bytes, the page-side bridge
// (installed in os/os.js) relays them to the kernel injector, and the server's
// response comes back as a real Response (ADR-021). So the iframe below is genuinely
// rendering bytes that an in-OS process wrote to a socket.
//
// Each tab keeps its OWN live iframe (hidden when inactive), the way a real browser
// keeps background tabs alive — switching tabs doesn't reload the page or lose its
// state. The frames are driven imperatively (src / history / reload) rather than by a
// reactive `src` binding, so navigation can't fight the iframe's own history.

import { onMount, reactive } from "@opentf/web";
import { contextMenu } from "../../os/menus.js";

/** The same-origin URL the service worker routes into the kernel. */
const previewURL = (port, path) => `/__preview__/${port}${path.startsWith("/") ? path : "/" + path}`;

/**
 * Parse what someone types into the address bar. Accepts `3000`, `3000/x`,
 * `localhost:3000/x`, `127.0.0.1:3000`, `http://localhost:3000/x`. Returns
 * `{ port, path }`, or null if it isn't an in-OS address.
 */
export function parseAddr(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^(localhost|127\.0\.0\.1|0\.0\.0\.0):/i, "");
  const m = s.match(/^(\d{1,5})(\/.*)?$/);
  if (!m) return null;
  const port = parseInt(m[1], 10);
  if (!(port > 0 && port < 65536)) return null;
  return { port, path: m[2] || "/" };
}

export default function BrowserApp({ win }) {
  // `rev` forces the per-tab labels to refresh: mutating a field of a `.map`-arg
  // element doesn't re-run its binding on its own (structural changes do).
  const st = reactive({ tabs: [], activeId: null, rev: 0 });
  const touch = () => st.rev++;
  let seq = 1;

  const frameId = (id) => `bw-frame-${win.id}-${id}`;
  const addrId = "bw-addr-" + win.id;
  const activeTab = () => st.tabs.find((t) => t.id === st.activeId) || null;
  // Read `rev` so these re-run when a tab's own fields change.
  const activeStatus = () => (st.rev, activeTab() ? activeTab().status : "blank");
  const activeError = () => (st.rev, (activeTab() && activeTab().error) || "");
  const frameEl = (t) => document.getElementById(frameId(t.id));
  const addrEl = () => document.getElementById(addrId);
  const addrOf = (t) => (t.port ? `localhost:${t.port}${t.path}` : "");

  function showTab(t) {
    st.activeId = t.id;
    const a = addrEl();
    if (a) a.value = addrOf(t);
    touch();
  }

  function newTab(addr = "") {
    const t = { id: seq++, port: null, path: "/", title: "New Tab", status: "blank", error: null };
    st.tabs.push(t);
    showTab(t);
    if (addr) navigate(t, addr);
    return t;
  }

  function selectTab(t) {
    if (t.id === st.activeId) return;
    showTab(t);
  }

  function closeTab(t) {
    const i = st.tabs.findIndex((x) => x.id === t.id);
    if (i < 0) return;
    const wasActive = st.activeId === t.id;
    st.tabs.splice(i, 1);
    if (st.tabs.length === 0) { newTab(); return; }
    if (wasActive) showTab(st.tabs[i] || st.tabs[i - 1]);
  }

  async function navigate(t, raw) {
    const a = parseAddr(raw);
    if (!a) {
      t.status = "error";
      t.error = "Not an address in this OS. Try a port a process is listening on, like localhost:3000.";
      touch();
      return;
    }
    t.port = a.port;
    t.path = a.path;
    t.title = `localhost:${a.port}`;
    t.status = "loading";
    t.error = null;
    touch();
    if (addrEl() && st.activeId === t.id) addrEl().value = addrOf(t);

    const url = previewURL(a.port, a.path);
    // Ask once before handing the URL to the iframe: the bridge answers an
    // unserved port with a 502 whose body would otherwise render as raw text
    // inside the frame. This costs the in-OS server a second GET on navigation,
    // which is a fair price for telling "nothing is listening" apart from "the
    // page loaded". (Reload goes through the iframe's own history, not here.)
    let res;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (e) {
      t.status = "error";
      t.error = "Couldn't reach the OS: " + String(e?.message || e);
      touch();
      return;
    }
    if (!res.ok) {
      t.status = "error";
      t.error =
        res.status === 502
          ? `Nothing is listening on port ${a.port}. Start a server in the Terminal, then reload.`
          : `The server answered ${res.status} ${res.statusText || ""}`.trim();
      touch();
      return;
    }
    const f = frameEl(t);
    if (f) f.src = url;
    t.status = "ok";
    touch();
  }

  // The frame is same-origin (the SW serves it under our own origin), so we can read
  // the loaded document's title for the tab label.
  function onFrameLoad(t) {
    if (t.status !== "ok") return;
    const f = frameEl(t);
    try {
      const title = f && f.contentDocument && f.contentDocument.title;
      if (title) { t.title = title; touch(); }
    } catch {
      // Cross-origin or torn down — keep the host:port label.
    }
  }

  const go = () => { const t = activeTab(); if (t) navigate(t, addrEl() ? addrEl().value : ""); };
  const reload = () => {
    const t = activeTab();
    if (!t) return;
    if (t.status !== "ok") return void navigate(t, addrOf(t) || (addrEl() && addrEl().value) || "");
    const f = frameEl(t);
    try { f.contentWindow.location.reload(); } catch { navigate(t, addrOf(t)); }
  };
  const hist = (delta) => {
    const t = activeTab();
    if (!t || t.status !== "ok") return;
    const f = frameEl(t);
    try { f.contentWindow.history.go(delta); } catch { /* nothing to go to */ }
  };

  onMount(() => {
    const p = win.props || {};
    newTab(p.port ? `localhost:${p.port}${p.path || "/"}` : "");
  });

  const tabMenu = (t) => contextMenu(() => [
    { label: "Reload", icon: "↻", disabled: t.status !== "ok", action: () => { showTab(t); reload(); } },
    { separator: true },
    { label: "Close Tab", icon: "✕", action: () => closeTab(t) },
    { label: "Close Others", disabled: st.tabs.length <= 1, action: () => st.tabs.slice().forEach((x) => x.id !== t.id && closeTab(x)) },
  ]);

  const viewMenu = contextMenu(() => [
    { label: "Back", icon: "←", disabled: !activeTab() || activeTab().status !== "ok", action: () => hist(-1) },
    { label: "Forward", icon: "→", disabled: !activeTab() || activeTab().status !== "ok", action: () => hist(1) },
    { label: "Reload", icon: "↻", disabled: !activeTab() || activeTab().status !== "ok", action: () => reload() },
    { separator: true },
    { label: "New Tab", icon: "＋", action: () => newTab() },
  ]);

  return (
    <div class="app-browser">
      <div class="tabs">
        {st.tabs.map((t) => (
          <div key={t.id} class={"tab" + (st.activeId === t.id ? " on" : "")} onpointerdown={() => selectTab(t)} oncontextmenu={tabMenu(t)}>
            <span class="tab-name">{() => (st.rev, t.title)}</span>
            <button class="tab-x" title="Close" onpointerdown={(e) => e.stopPropagation()} onclick={() => closeTab(t)}>✕</button>
          </div>
        ))}
        <button class="tab-new" title="New tab" onclick={() => newTab()}>+</button>
      </div>

      <div class="bw-bar">
        <button class="bw-nav" title="Back" onclick={() => hist(-1)}>←</button>
        <button class="bw-nav" title="Forward" onclick={() => hist(1)}>→</button>
        <button class="bw-nav" title="Reload" onclick={() => reload()}>↻</button>
        <input
          id={addrId}
          class="bw-addr"
          spellcheck="false"
          placeholder="localhost:3000"
          onkeydown={(e) => { if (e.key === "Enter") go(); }}
        />
        <button class="bw-go" onclick={() => go()}>Go</button>
      </div>

      <div class="bw-view" oncontextmenu={viewMenu}>
        {st.tabs.map((t) => (
          <iframe
            key={t.id}
            id={frameId(t.id)}
            class={"bw-frame" + (st.activeId === t.id ? " on" : "")}
            title="In-OS page"
            onload={() => onFrameLoad(t)}
          />
        ))}
        {/* One overlay for the active tab's non-page states, a SIBLING of the frame
            list (nesting it inside would break the list reconciler). A children block
            must be a single EXPRESSION — a block-bodied arrow gets stringified into
            the DOM instead of bound — hence the ternary chain. */}
        {() =>
          activeStatus() === "ok" ? null
          : activeStatus() === "loading" ? (
            <div class="bw-page"><div class="bw-msg">Loading…</div></div>
          ) : activeStatus() === "error" ? (
            <div class="bw-page">
              <div class="bw-msg bw-msg-err">
                <div class="bw-msg-h">Can't open this page</div>
                <div class="bw-msg-p">{activeError()}</div>
              </div>
            </div>
          ) : (
            <div class="bw-page">
              <div class="bw-msg">
                <div class="bw-msg-h">Browse this OS</div>
                <div class="bw-msg-p">
                  Every address here is a process in WorkerOS listening on a port — there's no
                  network. Start a server in the Terminal, then enter its port above.
                </div>
                <pre class="bw-msg-code">node /srv/server.js &amp;</pre>
              </div>
            </div>
          )
        }
      </div>
    </div>
  );
}
