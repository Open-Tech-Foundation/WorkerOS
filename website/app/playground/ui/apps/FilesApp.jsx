// A file manager over the real VFS. Navigation (up / home / into folders) plus real
// operations — new folder, new file, rename, delete — via the client fs API and the
// DE's dialog service. Double-clicking a file opens it in the Editor; the Terminal
// sees the same tree. Each window keeps its own cwd in a component-local reactive
// store.

import { onMount, reactive } from "@opentf/web";
import { getOS } from "../../os/os.js";
import { HOME, join, parent, basename, displayPath, seedHome } from "../../os/vfs.js";
import { promptDialog, confirmDialog, alertDialog } from "../../os/dialogs.js";
import { openWindow } from "../../os/wm.js";
import { contextMenu } from "../../os/menus.js";

export default function FilesApp() {
  const st = reactive({ cwd: HOME, entries: [], selected: null, error: null });

  async function load(path) {
    try {
      const os = await getOS();
      const entries = await os.fs.list(path);
      entries.sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name < b.name ? -1 : 1));
      st.entries = entries;
      st.cwd = path;
      st.selected = null;
      st.error = null;
    } catch (e) {
      st.error = String(e?.message || e);
    }
  }

  const refresh = () => load(st.cwd);
  const selectedEntry = () => st.entries.find((e) => e.name === st.selected) || null;

  async function open(entry) {
    if (!entry) return;
    if (entry.is_dir) await load(join(st.cwd, entry.name));
    else openWindow({ appId: "editor", title: entry.name, icon: "✏️", w: 720, h: 500, props: { path: join(st.cwd, entry.name) } });
  }

  async function newFolder() {
    const name = await promptDialog({ title: "New folder", message: "Folder name", placeholder: "untitled folder", confirmLabel: "Create" });
    if (!name) return;
    try { const os = await getOS(); await os.fs.mkdir(join(st.cwd, name)); await refresh(); }
    catch (e) { await alertDialog({ title: "Couldn't create folder", message: String(e?.message || e) }); }
  }

  async function newFile() {
    const name = await promptDialog({ title: "New file", message: "File name", placeholder: "untitled.txt", confirmLabel: "Create" });
    if (!name) return;
    try { const os = await getOS(); await os.fs.write(join(st.cwd, name), ""); await refresh(); }
    catch (e) { await alertDialog({ title: "Couldn't create file", message: String(e?.message || e) }); }
  }

  async function rename() {
    const entry = selectedEntry();
    if (!entry) return;
    const name = await promptDialog({ title: "Rename", message: "New name", value: entry.name, confirmLabel: "Rename" });
    if (!name || name === entry.name) return;
    try { const os = await getOS(); await os.fs.rename(join(st.cwd, entry.name), join(st.cwd, name)); await refresh(); }
    catch (e) { await alertDialog({ title: "Couldn't rename", message: String(e?.message || e) }); }
  }

  async function remove() {
    const entry = selectedEntry();
    if (!entry) return;
    const ok = await confirmDialog({
      title: "Delete " + entry.name + "?",
      message: entry.is_dir ? "The folder and everything inside it will be deleted." : "This file will be deleted.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try { const os = await getOS(); await os.fs.remove(join(st.cwd, entry.name)); await refresh(); }
    catch (e) { await alertDialog({ title: "Couldn't delete", message: String(e?.message || e) }); }
  }

  onMount(() => {
    seedHome().then(() => load(HOME)).catch(() => load(HOME));
  });

  // Right-click menus, built with the shared context-menu service so Files looks
  // and behaves like every other app's menu — but its actions stay in-instance.
  const bgMenu = contextMenu([
    { label: "New Folder", icon: "📁", action: () => newFolder() },
    { label: "New File", icon: "📄", action: () => newFile() },
    { separator: true },
    { label: "Refresh", icon: "⟳", action: () => refresh() },
  ]);

  return (
    <div class="app-files">
      <div class="fm-bar">
        <div class="fm-nav">
          <button class="fm-ico-btn" title="Up" disabled={st.cwd === "/"} onclick={() => load(parent(st.cwd))}>↑</button>
          <button class="fm-ico-btn" title="Home" onclick={() => load(HOME)}>⌂</button>
        </div>
        <span class="fm-path">{() => displayPath(st.cwd)}</span>
        <div class="fm-actions">
          <button class="fm-btn" onclick={() => newFolder()}>New Folder</button>
          <button class="fm-btn" onclick={() => newFile()}>New File</button>
          <button class="fm-btn" disabled={!st.selected} onclick={() => rename()}>Rename</button>
          <button class="fm-btn fm-danger" disabled={!st.selected} onclick={() => remove()}>Delete</button>
        </div>
      </div>

      <div class="fm-list" onpointerdown={() => (st.selected = null)} oncontextmenu={bgMenu}>
        {st.entries.map((e) => (
          <button
            class={"fm-row" + (e.is_dir ? " is-dir" : "") + (st.selected === e.name ? " sel" : "")}
            onpointerdown={(ev) => { ev.stopPropagation(); st.selected = e.name; }}
            ondblclick={() => open(e)}
            oncontextmenu={contextMenu(() => {
              st.selected = e.name;
              return [
                { label: e.is_dir ? "Open" : "Open in Editor", icon: e.is_dir ? "📂" : "✏️", action: () => open(e) },
                { label: "Rename", icon: "✎", action: () => rename() },
                { separator: true },
                { label: "Delete", icon: "🗑", danger: true, action: () => remove() },
              ];
            })}
          >
            <span class="fm-row-ico">{e.is_dir ? "📁" : "📄"}</span>
            <span class="fm-row-name">{e.name}</span>
          </button>
        ))}
        {() => (st.entries.length === 0 && !st.error ? <div class="fm-empty">This folder is empty</div> : null)}
        {() => (st.error ? <div class="fm-error">{st.error}</div> : null)}
      </div>

      <div class="fm-status">
        {() => `${st.entries.length} item${st.entries.length === 1 ? "" : "s"}${st.selected ? " · " + st.selected : ""}`}
      </div>
    </div>
  );
}
