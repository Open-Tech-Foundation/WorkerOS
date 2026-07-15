// System Settings — the OS control panel, shaped like a real one: a sidebar of
// sections on the left, the selected section's content on the right.
//
// It's the UI over the OS theme engine (os/theme.js) and the FS-backed state layer
// (os/state.js). Changing anything here calls setTheme(), which repaints the desktop
// live and is persisted to ~/.config/workeros by the state layer's effect — no save
// button needed. "About this system" lives here as a section (it's system info, not
// an app), so there's one place to look up what you're running.

import { onMount, reactive } from "@opentf/web";
import { theme, setTheme } from "../../os/theme.js";
import { getOS } from "../../os/os.js";
import { notifySuccess, notifyError } from "../../os/notify.js";

// Accent presets ("" = the theme's built-in OTF orange).
const ACCENTS = [
  { name: "OTF", value: "" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Green", value: "#22c55e" },
  { name: "Violet", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
  { name: "Red", value: "#ef4444" },
];

// Wallpapers reference the live tokens (var(--accent)/var(--bg)), so they adapt to
// both the current theme and accent. "" restores the default desktop gradient.
const WALLS = [
  { name: "Default", value: "" },
  { name: "Aurora", value: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 24%, var(--bg)), var(--bg) 70%)" },
  { name: "Mesh", value: "radial-gradient(650px 460px at 18% 20%, var(--accent-glow), transparent 60%), radial-gradient(720px 520px at 82% 84%, color-mix(in srgb, var(--violet) 16%, transparent), transparent 60%), var(--bg)" },
  { name: "Solid", value: "var(--bg)" },
];

const MODES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const PANES = [
  { id: "appearance", label: "Appearance", icon: "◐" },
  { id: "storage", label: "Storage", icon: "💾" },
  { id: "about", label: "About", icon: "ℹ️" },
];

export default function SettingsApp() {
  const st = reactive({ pane: "appearance", version: "…", abi: "…", saving: false });

  onMount(() => {
    let disposed = false;
    getOS().then((os) => {
      if (disposed) return;
      st.version = os.version || "unknown";
      st.abi = os.abi != null ? String(os.abi) : "—";
    });
    return () => { disposed = true; };
  });

  const saveNow = async () => {
    st.saving = true;
    try {
      const os = await getOS();
      if (os.flush) await os.flush();
      notifySuccess("Filesystem snapshot saved to durable storage.");
    } catch (e) {
      notifyError("Couldn't save: " + String(e?.message || e));
    }
    st.saving = false;
  };

  return (
    <div class="app-settings">
      <nav class="set-side">
        {PANES.map((p) => (
          <button
            key={p.id}
            class={"set-nav" + (st.pane === p.id ? " on" : "")}
            onclick={() => (st.pane = p.id)}
          >
            <span class="set-nav-ico">{p.icon}</span>
            <span class="set-nav-label">{p.label}</span>
          </button>
        ))}
      </nav>

      {/* One pane at a time, dispatched by a ternary chain (the framework can't take
          a component as a value). */}
      <div class="set-pane">
        {() =>
          st.pane === "appearance" ? (
            <section class="set-section">
              <h3 class="set-h">Appearance</h3>

              <div class="set-row">
                <span class="set-label">Theme</span>
                <div class="seg">
                  {MODES.map((m) => (
                    <button key={m.id} class={"seg-btn" + (theme.mode === m.id ? " on" : "")} onclick={() => setTheme({ mode: m.id })}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div class="set-row">
                <span class="set-label">Accent</span>
                <div class="swatches">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.name}
                      class={"swatch" + (theme.accent === a.value ? " on" : "")}
                      title={a.name}
                      style={"--sw:" + (a.value || "var(--_accent-default)")}
                      onclick={() => setTheme({ accent: a.value })}
                    />
                  ))}
                </div>
              </div>

              <div class="set-row">
                <span class="set-label">Wallpaper</span>
                <div class="wall-picks">
                  {WALLS.map((w) => (
                    <button
                      key={w.name}
                      class={"wall-pick" + (theme.wallpaper === w.value ? " on" : "")}
                      onclick={() => setTheme({ wallpaper: w.value })}
                    >
                      <span class="wall-swatch" style={"background:" + (w.value || "var(--wos-wall)")} />
                      <span class="wall-name">{w.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          ) : st.pane === "storage" ? (
            <section class="set-section">
              <h3 class="set-h">Storage</h3>
              <div class="set-row">
                <span class="set-label">Durable snapshot</span>
                <button class="set-btn" disabled={st.saving} onclick={saveNow}>{() => (st.saving ? "Saving…" : "Save now")}</button>
              </div>
              <p class="set-note">Settings and your session are written to <code>~/.config/workeros</code> and <code>~/.local/state/workeros</code> on the real filesystem — the Terminal sees them too.</p>
            </section>
          ) : (
            <section class="set-section">
              <h3 class="set-h">About this system</h3>
              <div class="set-about-hero">
                <div class="set-about-mark">W</div>
                <div class="set-about-id">
                  <div class="set-about-name">WorkerOS</div>
                  <div class="set-about-tag">A real kernel, running as a tenant of your browser.</div>
                </div>
              </div>
              <dl class="set-about">
                <div><dt>Kernel</dt><dd>{() => st.version}</dd></div>
                <div><dt>Syscall ABI</dt><dd>{() => st.abi}</dd></div>
                <div><dt>Host</dt><dd>Web Worker · WASM</dd></div>
              </dl>
            </section>
          )
        }
      </div>
    </div>
  );
}
