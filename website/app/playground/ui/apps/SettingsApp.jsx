// System Settings — the UI over the OS theme engine (os/theme.js) and the
// FS-backed state layer (os/state.js). Changing anything here calls setTheme(),
// which repaints the desktop live and is persisted to ~/.config/workeros by the
// state layer's effect — no save button needed. Panes: Appearance (theme mode,
// accent, wallpaper), Storage (force a durable snapshot), and About (live kernel
// version/ABI).

import { onMount } from "@opentf/web";
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

export default function SettingsApp() {
  let version = $state("…");
  let abi = $state("…");
  let saving = $state(false);

  onMount(() => {
    let disposed = false;
    getOS().then((os) => {
      if (disposed) return;
      version = os.version || "unknown";
      abi = os.abi != null ? String(os.abi) : "—";
    });
    return () => { disposed = true; };
  });

  const saveNow = async () => {
    saving = true;
    try {
      const os = await getOS();
      if (os.flush) await os.flush();
      notifySuccess("Filesystem snapshot saved to durable storage.");
    } catch (e) {
      notifyError("Couldn't save: " + String(e?.message || e));
    }
    saving = false;
  };

  return (
    <div class="app-settings">
      <section class="set-section">
        <h3 class="set-h">Appearance</h3>

        <div class="set-row">
          <span class="set-label">Theme</span>
          <div class="seg">
            {MODES.map((m) => (
              <button class={"seg-btn" + (theme.mode === m.id ? " on" : "")} onclick={() => setTheme({ mode: m.id })}>
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

      <section class="set-section">
        <h3 class="set-h">Storage</h3>
        <div class="set-row">
          <span class="set-label">Durable snapshot</span>
          <button class="set-btn" disabled={saving} onclick={saveNow}>{() => (saving ? "Saving…" : "Save now")}</button>
        </div>
        <p class="set-note">Settings and your session are written to <code>~/.config/workeros</code> and <code>~/.local/state/workeros</code> on the real filesystem — the Terminal sees them too.</p>
      </section>

      <section class="set-section">
        <h3 class="set-h">About</h3>
        <dl class="set-about">
          <div><dt>Kernel</dt><dd>{version}</dd></div>
          <div><dt>Syscall ABI</dt><dd>{abi}</dd></div>
          <div><dt>Host</dt><dd>Web Worker · WASM</dd></div>
        </dl>
      </section>
    </div>
  );
}
