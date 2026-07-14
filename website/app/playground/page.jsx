// The WorkerOS playground is a desktop-style shell: a full-viewport window manager
// (drag/resize/focus windows), a dock, and apps — the Terminal app boots the real
// Rust→WASM kernel (added in a later phase). This page just mounts the desktop; all
// window state lives in the reactive WM store (os/wm.js) and app content comes from
// the app registry (os/apps.jsx).

import Desktop from "./ui/Desktop.jsx";

export default function Playground() {
  return <Desktop />;
}
