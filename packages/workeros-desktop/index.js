// Package entry — the desktop as an importable component, so a host app (the
// repo-root `playground/`) can mount it: `import { Desktop } from
// "@opentf/workeros-desktop"`. Raw JSX; the consuming OTF Web (`otfw`) app compiles
// it (the same way it compiles `@opentf/web-docs`). The desktop can still run
// standalone here via `otfw dev` (app/page.jsx mounts the same component).
//
// `Desktop` pulls in the whole desktop through its own imports (os/ + ui/). Boot,
// window-manager, and app registry are reachable via the subpath exports below if a
// host wants to drive them directly.
export { default as Desktop } from "./app/ui/Desktop.jsx";
