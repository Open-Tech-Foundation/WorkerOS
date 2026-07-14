// App metadata (plain data): id, display name, dock icon, default window size, and
// whether it's pinned to the dock. The dock (pinned subset), the launcher (all
// apps), and the WM read this. App *components* live one-per-file under ui/apps/
// and are dispatched by ui/AppView.jsx (the OTF Web compiler turns each component
// into a custom element, so they can't be passed around as values). Apps without a
// real component yet render a placeholder until their phase lands.

export const APP_META = [
  { id: "terminal", name: "Terminal", icon: "🖥️", w: 720, h: 460, pinned: true, multi: true },
  { id: "files", name: "Files", icon: "🗂️", w: 620, h: 440, pinned: true },
  { id: "browser", name: "Browser", icon: "🧭", w: 760, h: 520, pinned: true },
  { id: "editor", name: "Editor", icon: "✏️", w: 720, h: 500, pinned: true, multi: true },
  { id: "processes", name: "Processes", icon: "📊", w: 560, h: 420, pinned: true },
  { id: "welcome", name: "Welcome", icon: "👋", w: 520, h: 360 },
  { id: "about", name: "About", icon: "ℹ️", w: 460, h: 360 },
];

/** Metadata for an id, or a safe fallback. */
export function appMeta(id) {
  return APP_META.find((a) => a.id === id) || { id, name: id, icon: "▪", w: 560, h: 400 };
}
