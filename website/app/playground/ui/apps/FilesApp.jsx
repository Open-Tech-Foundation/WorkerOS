// A VFS file browser: lists a directory via os.fs.list(), navigates into folders,
// and previews text files via os.fs.read(). Directories sort first. A component-
// local reactive store holds the cwd/entries/preview so each Files window browses
// independently. Read-only for now — editing lands with the Editor app.

import { onMount, reactive } from "@opentf/web";
import { getOS } from "../../os/os.js";

const dec = new TextDecoder();

function joinPath(dir, name) {
  return (dir === "/" ? "" : dir) + "/" + name;
}
function parentOf(dir) {
  if (dir === "/") return "/";
  const i = dir.lastIndexOf("/");
  return i <= 0 ? "/" : dir.slice(0, i);
}

export default function FilesApp() {
  const st = reactive({ cwd: "/", entries: [], preview: null, previewName: null, error: null });

  async function load(path) {
    try {
      const os = await getOS();
      const entries = await os.fs.list(path);
      entries.sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name < b.name ? -1 : 1));
      st.entries = entries;
      st.cwd = path;
      st.error = null;
    } catch (e) {
      st.error = String(e?.message || e);
      st.entries = [];
    }
  }

  async function openEntry(e) {
    if (e.is_dir) {
      st.preview = null;
      st.previewName = null;
      await load(joinPath(st.cwd, e.name));
    } else {
      try {
        const os = await getOS();
        const bytes = await os.fs.read(joinPath(st.cwd, e.name));
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        // Treat a NUL in the first few KB as binary rather than dumping bytes.
        const binary = arr.subarray(0, 4096).some((b) => b === 0);
        st.previewName = e.name;
        st.preview = binary ? `(binary file — ${arr.length} bytes)` : dec.decode(arr);
        st.error = null;
      } catch (err) {
        st.error = String(err?.message || err);
      }
    }
  }

  onMount(() => {
    load("/");
  });

  return (
    <div class="app-files">
      <div class="files-bar">
        <button class="files-up" title="Up one level" onclick={() => load(parentOf(st.cwd))}>↑</button>
        <span class="files-path">{() => st.cwd}</span>
      </div>

      <div class="files-main">
        <div class="files-list">
          {st.entries.map((e) => (
            <button class={"file-row" + (e.is_dir ? " is-dir" : "")} onclick={() => openEntry(e)}>
              <span class="file-ico">{e.is_dir ? "📁" : "📄"}</span>
              <span class="file-name">{e.name}</span>
            </button>
          ))}
          {() => (st.entries.length === 0 && !st.error ? <div class="files-empty">empty directory</div> : null)}
        </div>

        <div class="files-preview">
          {() => (st.previewName ? <div class="files-preview-head">{st.previewName}</div> : null)}
          {() =>
            st.preview != null ? (
              <pre class="files-preview-body">{st.preview}</pre>
            ) : (
              <div class="files-preview-empty">Select a file to preview</div>
            )
          }
        </div>
      </div>

      {() => (st.error ? <div class="files-error">{st.error}</div> : null)}
    </div>
  );
}
