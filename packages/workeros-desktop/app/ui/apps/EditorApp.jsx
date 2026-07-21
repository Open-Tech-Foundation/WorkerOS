// A tabbed text editor over the real VFS. Each tab is a buffer ({ path, name,
// content, dirty }); one shared textarea (DOM-driven, keyed by window id) shows the
// active tab — on switch we flush the textarea into the current tab and load the
// next, so typing never fights a reactive value binding. Open a path (path bar or
// Files' "open") to load it; "+" adds a blank tab; Save writes the active tab.
// Multi-instance, so several editor windows can each hold several files.
//
// The tab strip uses the shared .tabs/.tab widget styles (also usable by other
// apps), so tabs look and behave the same across the DE.

import { onMount, reactive } from "@opentf/web";
import { getOS } from "../../os/os.js";
import { basename } from "../../os/vfs.js";
import { notifySuccess, notifyError } from "../../os/notify.js";
import { promptDialog } from "../../os/dialogs.js";
import { contextMenu } from "../../os/menus.js";

const dec = new TextDecoder();

export default function EditorApp({ win }) {
  const areaId = "edarea-" + win.id;
  let seq = 1;
  // `rev` bumps whenever a tab's own fields (name/dirty) change: mutating a field
  // of a `.map`-arg element doesn't re-run its binding on its own, so the per-tab
  // labels read `st.rev` to force a refresh. Structural changes to `st.tabs`
  // (push/splice) reconcile the list by themselves.
  const st = reactive({ tabs: [], activeId: null, error: null, rev: 0 });
  const touch = () => st.rev++;

  const areaEl = () => document.getElementById(areaId);
  const activeTab = () => st.tabs.find((t) => t.id === st.activeId) || null;

  // Snapshot the textarea into the active tab before switching away or saving.
  function flush() {
    const t = activeTab();
    const ta = areaEl();
    if (t && ta) t.content = ta.value;
  }

  function showTab(t) {
    st.activeId = t.id;
    const ta = areaEl();
    if (ta) ta.value = t.content;
    st.error = null;
    touch();
  }

  function newTab(path = "", content = "", dirty = false) {
    flush();
    const t = { id: seq++, path, name: path ? basename(path) : "untitled", content, dirty };
    st.tabs.push(t);
    showTab(t);
    return t;
  }

  function selectTab(t) {
    if (t.id === st.activeId) return;
    flush();
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

  async function openPath(path) {
    path = (path || "").trim();
    if (!path) return;
    try {
      const os = await getOS();
      const bytes = await os.fs.read(path);
      const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const content = dec.decode(arr);
      const t = activeTab();
      // Reuse a pristine blank tab; otherwise open the file in a new tab.
      if (t && !t.path && !t.dirty && !(areaEl() && areaEl().value)) {
        t.path = path; t.name = basename(path); t.content = content; t.dirty = false;
        showTab(t); touch();
      } else {
        newTab(path, content, false);
      }
    } catch (e) {
      st.error = String(e?.message || e);
    }
  }

  async function save() {
    const t = activeTab();
    if (!t) return;
    let path = t.path;
    if (!path) {
      // Untitled buffer: ask where to save (a stand-in until the native file
      // dialog lands). The dialog is scoped to this editor window.
      path = await promptDialog({
        title: "Save As", message: "Save this file as", winId: win.id,
        value: "/root/Documents/" + t.name, placeholder: "/path/to/file", confirmLabel: "Save",
      });
      if (!path) return;
      path = path.trim();
      if (!path) return;
    }
    flush();
    try {
      const os = await getOS();
      await os.fs.write(path, t.content);
      t.path = path; t.name = basename(path); t.dirty = false; touch();
      st.error = null;
      notifySuccess("Saved " + path);
    } catch (e) {
      st.error = String(e?.message || e);
      notifyError("Couldn't save: " + String(e?.message || e));
    }
  }

  onMount(() => {
    const initial = (win.props && win.props.path) || "";
    if (initial) openPath(initial);
    else newTab();
  });

  const tabMenu = (t) => contextMenu(() => [
    { label: "Close", icon: "✕", action: () => closeTab(t) },
    { label: "Close Others", disabled: st.tabs.length <= 1, action: () => st.tabs.slice().forEach((x) => x.id !== t.id && closeTab(x)) },
  ]);

  return (
    <div class="app-editor">
      <div class="tabs">
        {st.tabs.map((t) => (
          <div key={t.id} class={"tab" + (st.activeId === t.id ? " on" : "")} onpointerdown={() => selectTab(t)} oncontextmenu={tabMenu(t)}>
            <span class="tab-dot">{() => (st.rev, t.dirty ? "●" : "")}</span>
            <span class="tab-name">{() => (st.rev, t.name)}</span>
            <button class="tab-x" title="Close" onpointerdown={(e) => e.stopPropagation()} onclick={() => closeTab(t)}>✕</button>
          </div>
        ))}
        <button class="tab-new" title="New tab" onclick={() => newTab()}>+</button>
      </div>
      <div class="ed-bar">
        <span class="ed-loc">{() => (st.rev, (activeTab() && activeTab().path) || "untitled")}</span>
        <span class="ed-status">
          {() => (st.rev, st.error ? st.error : activeTab() && activeTab().dirty ? "● unsaved" : "")}
        </span>
        <button class="ed-btn ed-save" onclick={() => save()}>Save</button>
      </div>
      <textarea
        id={areaId}
        class="ed-area"
        spellcheck="false"
        placeholder="Open a file, or type a path above and start editing to create one."
        oninput={() => { const t = activeTab(); if (t && !t.dirty) { t.dirty = true; touch(); } st.error = null; }}
      />
    </div>
  );
}
