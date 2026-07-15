// A tabbed browser.
//
// An address like `localhost:3000` is a real process in THIS OS listening on port
// 3000. The service worker (public/preview-sw.js) turns a fetch of
// /__preview__/<osId>/<port>/<path> into raw HTTP/1.1 bytes, the page-side bridge
// (installed in os/os.js) relays them to our kernel injector, and the server's
// response comes back as a real Response (ADR-021). So the frame is genuinely
// rendering bytes an in-OS process wrote to a socket. The `osId` in the path is what
// keeps a second tab's kernel from answering our requests — every tab boots its own.
//
// Anything that isn't an in-OS address (say `google.com`) is left alone and handed to
// the frame as an ordinary URL. There is no outbound network yet, so those won't load
// until a proxy lands — but the browser doesn't refuse to try, because deciding what
// you may visit isn't its job.
//
// Tabs keep their own history stack and take titles from the response we already
// fetched, rather than reading the frame's `contentDocument`/`history`. That's on
// purpose: it doesn't depend on the frame being same-origin, so it still works the day
// previews move to their own origin (see the `sandbox` note on the iframe below —
// containing a served page needs that move, not an attribute).

import { onMount, reactive } from "@opentf/web";
import { getOS } from "../../os/os.js";
import { contextMenu } from "../../os/menus.js";

/**
 * Parse what someone types into the address bar. An in-OS address (`3000`, `3000/x`,
 * `localhost:3000/x`, `http://localhost:3000/x`) becomes `{ kind: "os", port, path }`;
 * anything else is passed through as `{ kind: "web", url }` — nothing is rejected.
 */
export function parseAddr(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  const bare = s.replace(/^https?:\/\//i, "").replace(/^(localhost|127\.0\.0\.1|0\.0\.0\.0):/i, "");
  const m = bare.match(/^(\d{1,5})(\/.*)?$/);
  if (m) {
    const port = parseInt(m[1], 10);
    if (port > 0 && port < 65536) return { kind: "os", port, path: m[2] || "/" };
  }
  return { kind: "web", url: /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s };
}

/** Pull <title> out of a fetched HTML body — the sandboxed frame won't tell us. */
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  return m ? m[1].trim().replace(/\s+/g, " ").slice(0, 80) : "";
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
  const frameEl = (t) => document.getElementById(frameId(t.id));
  const addrEl = () => document.getElementById(addrId);
  // Read `rev` so these re-run when a tab's own fields change.
  const activeStatus = () => (st.rev, activeTab() ? activeTab().status : "blank");
  const activeError = () => (st.rev, (activeTab() && activeTab().error) || "");
  const canBack = () => (st.rev, !!activeTab() && activeTab().hi > 0);
  const canFwd = () => (st.rev, !!activeTab() && activeTab().hi < activeTab().hist.length - 1);

  function showTab(t) {
    st.activeId = t.id;
    const a = addrEl();
    if (a) a.value = t.addr;
    touch();
  }

  function newTab(addr = "") {
    // `hist` is our own history stack (index `hi`) — a sandboxed frame's own history
    // is off limits, and this keeps Back/Forward honest per tab anyway.
    const t = { id: seq++, addr: "", title: "New Tab", status: "blank", error: null, hist: [], hi: -1 };
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

  /** Load `raw` into `t`. `push` records it in the tab's history (Back/Forward don't). */
  async function navigate(t, raw, push = true) {
    const a = parseAddr(raw);
    if (!a) return;
    t.addr = raw.trim();
    t.status = "loading";
    t.error = null;
    t.title = t.addr;
    touch();
    if (st.activeId === t.id && addrEl()) addrEl().value = t.addr;

    const done = (ok) => {
      if (ok && push) {
        t.hist = t.hist.slice(0, t.hi + 1);
        t.hist.push(t.addr);
        t.hi = t.hist.length - 1;
      }
      touch();
    };

    if (a.kind === "web") {
      // Not ours to route or to block: hand it straight to the frame. Without a
      // network proxy this will fail to load, and the frame shows that itself.
      const f = frameEl(t);
      if (f) f.src = a.url;
      t.status = "ok";
      t.title = a.url.replace(/^https?:\/\//i, "").split("/")[0] || a.url;
      done(true);
      return;
    }

    const os = await getOS();
    const url = `/__preview__/${os.previewId}/${a.port}${a.path}`;
    // Ask once before handing the URL to the frame: the bridge answers an unserved
    // port with a 502 whose body would otherwise render as raw text inside it. This
    // costs the in-OS server a second GET per navigation, which buys telling
    // "nothing is listening" apart from "the page loaded" — and the response body
    // gives us the <title> the sandboxed frame can't.
    let res, body;
    try {
      res = await fetch(url, { cache: "no-store" });
      body = await res.text();
    } catch (e) {
      t.status = "error";
      t.error = "Couldn't reach the OS: " + String(e?.message || e);
      done(false);
      return;
    }
    if (!res.ok) {
      t.status = "error";
      t.error =
        res.status === 502
          ? `Nothing in this OS is listening on port ${a.port}. Start a server, then reload.`
          : `The server answered ${res.status} ${res.statusText || ""}`.trim();
      done(false);
      return;
    }
    const f = frameEl(t);
    if (f) f.src = url;
    t.status = "ok";
    t.title = titleOf(body) || `localhost:${a.port}`;
    done(true);
  }

  const go = () => { const t = activeTab(); if (t) navigate(t, addrEl() ? addrEl().value : ""); };
  const reload = () => {
    const t = activeTab();
    if (t && t.addr) navigate(t, t.addr, false);
  };
  // Back/Forward walk OUR stack, not the frame's (sandboxed: its history is opaque).
  const hist = (delta) => {
    const t = activeTab();
    if (!t) return;
    const next = t.hi + delta;
    if (next < 0 || next >= t.hist.length) return;
    t.hi = next;
    navigate(t, t.hist[next], false);
  };

  onMount(() => {
    const p = win.props || {};
    newTab(p.port ? `localhost:${p.port}${p.path || "/"}` : "");
  });

  const tabMenu = (t) => contextMenu(() => [
    { label: "Reload", icon: "↻", disabled: !t.addr, action: () => { showTab(t); reload(); } },
    { separator: true },
    { label: "Close Tab", icon: "✕", action: () => closeTab(t) },
    { label: "Close Others", disabled: st.tabs.length <= 1, action: () => st.tabs.slice().forEach((x) => x.id !== t.id && closeTab(x)) },
  ]);

  const viewMenu = contextMenu(() => [
    { label: "Back", icon: "←", disabled: !canBack(), action: () => hist(-1) },
    { label: "Forward", icon: "→", disabled: !canFwd(), action: () => hist(1) },
    { label: "Reload", icon: "↻", disabled: !activeTab() || !activeTab().addr, action: () => reload() },
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
        <button class="bw-nav" title="Back" disabled={!canBack()} onclick={() => hist(-1)}>←</button>
        <button class="bw-nav" title="Forward" disabled={!canFwd()} onclick={() => hist(1)}>→</button>
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
            title="Page"
            referrerpolicy="no-referrer"
            /* NOT sandboxed — deliberately, and this is a real gap. A sandbox without
               `allow-same-origin` gives the frame an opaque origin, and a
               cross-origin-isolated page refuses to embed one at all
               (ERR_BLOCKED_BY_RESPONSE / CoepFrameResourceNeedsCoepHeader) — verified
               against every sandbox combination: the frame renders only when
               `allow-same-origin` is present. We can't drop the isolation either, since
               the kernel needs SharedArrayBuffer. And `sandbox` WITH `allow-same-origin`
               would be theatre: the page keeps our origin, so it can reach parent.document
               and strip the attribute off itself.
               Real containment needs previews served from a SEPARATE ORIGIN, which is a
               design change (a bootstrap client + SW on that origin, relaying to this page
               cross-origin), not an attribute. Until then a served page is same-origin
               with the desktop — it's your own code, but it is not contained. */
          />
        ))}
        {/* One overlay for the active tab's non-page states, a SIBLING of the frame
            list (nesting it inside would break the list reconciler). A children block
            must be a single EXPRESSION — a block-bodied arrow gets stringified into
            the DOM instead of bound — hence the ternary chain. A new tab is blank on
            purpose. */}
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
            <div class="bw-page" />
          )
        }
      </div>
    </div>
  );
}
