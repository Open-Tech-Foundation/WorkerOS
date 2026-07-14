// A minimal text editor over the real VFS: open a path with os.fs.read, edit, and
// save with os.fs.write (which also creates a new file). The path input and the
// textarea are uncontrolled (driven via their DOM elements, keyed by window id) so
// typing never fights a reactive value binding; only the status line is reactive.
// A window may be opened with `props.path` (e.g. Files' "Edit" button) to load a
// file on mount. Multi-instance, so several files can be edited at once.

import { onMount, reactive } from "@opentf/web";
import { getOS } from "../../os/os.js";

const dec = new TextDecoder();

export default function EditorApp({ win }) {
  const pathId = "edpath-" + win.id;
  const areaId = "edarea-" + win.id;
  const st = reactive({ status: "", dirty: false, error: null });

  const pathEl = () => document.getElementById(pathId);
  const areaEl = () => document.getElementById(areaId);

  async function load(path) {
    if (!path) return;
    try {
      const os = await getOS();
      const bytes = await os.fs.read(path);
      const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const ta = areaEl();
      if (ta) ta.value = dec.decode(arr);
      const pe = pathEl();
      if (pe) pe.value = path;
      st.dirty = false;
      st.status = "opened";
      st.error = null;
    } catch (e) {
      st.error = String(e?.message || e);
    }
  }

  async function save() {
    const path = (pathEl() && pathEl().value || "").trim();
    if (!path) { st.error = "no path"; return; }
    st.error = null;
    st.status = "saving…"; // the kernel may still be booting on the very first save
    try {
      const os = await getOS();
      await os.fs.write(path, areaEl() ? areaEl().value : "");
      st.dirty = false;
      st.status = "saved " + path;
    } catch (e) {
      st.error = String(e?.message || e);
    }
  }

  onMount(() => {
    const initial = (win.props && win.props.path) || "";
    if (initial) {
      const pe = pathEl();
      if (pe) pe.value = initial;
      load(initial);
    }
  });

  return (
    <div class="app-editor">
      <div class="ed-bar">
        <input
          id={pathId}
          class="ed-path"
          placeholder="/path/to/file"
          spellcheck="false"
          onkeydown={(e) => { if (e.key === "Enter") load(e.target.value.trim()); }}
        />
        <button class="ed-btn" onclick={() => load((pathEl() && pathEl().value || "").trim())}>Open</button>
        <button class="ed-btn ed-save" onclick={() => save()}>Save</button>
        <span class="ed-status">
          {() => (st.error ? st.error : st.status ? st.status : st.dirty ? "● unsaved" : "")}
        </span>
      </div>
      <textarea
        id={areaId}
        class="ed-area"
        spellcheck="false"
        placeholder="Open a file, or type a path above and start editing to create one."
        oninput={() => { st.dirty = true; st.status = ""; }}
      />
    </div>
  );
}
