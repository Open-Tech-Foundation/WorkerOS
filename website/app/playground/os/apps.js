// App metadata (plain data): id, display name, dock icon, and default window size.
// The dock, launcher, and WM read this. App *components* live one-per-file under
// ui/apps/ and are dispatched by ui/AppView.jsx (the OTF Web compiler turns each
// component into a custom element, so they can't be passed around as values).

export const APP_META = [
  { id: "welcome", name: "Welcome", icon: "👋", w: 520, h: 360 },
];

/** Metadata for an id, or a safe fallback. */
export function appMeta(id) {
  return APP_META.find((a) => a.id === id) || { id, name: id, icon: "▪", w: 560, h: 400 };
}
