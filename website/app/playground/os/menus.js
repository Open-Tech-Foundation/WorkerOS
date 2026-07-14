// The desktop's context-menu service — the one menu system every surface shares,
// so a right-click behaves identically on the desktop, a window title bar, or
// inside any app. Modeled on os/dialogs.js: reactive state (stable objects toggled
// by `.open`, never nulled) rendered once by ui/ContextMenu at the desktop level.
//
// Items are plain data (not components) so any app can declare a menu without
// importing UI — respecting the OTF Web rule that components can't be passed as
// values. An item is:
//   { label, icon?, action?, danger?, disabled?, checked?, separator?, submenu? }
// `separator: true` draws a divider; `submenu: [items]` opens a cascading child
// menu on hover. The submenu is a SEPARATE top-level menu (not a nested list) — a
// nested reactive list trips the framework's list reconciler.

import { reactive } from "@opentf/web";

export const menuState = reactive({
  open: false,
  x: 0,
  y: 0,
  /** @type {Array<object>} */ items: [],
  // One cascading child level. Stable object; visibility is `sub.open`.
  sub: { open: false, x: 0, y: 0, items: [] },
});

function clamp(anchorLeft, elSelector, isSub) {
  const el = document.querySelector(elSelector);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pad = 6;
  const target = isSub ? menuState.sub : menuState;
  if (target.x + r.width > window.innerWidth - pad) {
    // Root: pull back from the right edge. Sub: flip to the left of its anchor.
    target.x = isSub
      ? Math.max(pad, anchorLeft - r.width - 2)
      : Math.max(pad, window.innerWidth - r.width - pad);
  }
  if (target.y + r.height > window.innerHeight - pad)
    target.y = Math.max(pad, window.innerHeight - r.height - pad);
}

/** Open a context menu at viewport coords `x,y` with a list of item descriptors.
 *  After paint the menu is clamped inside the viewport so it flips near edges. */
export function openMenu(x, y, items) {
  menuState.sub.open = false;
  menuState.items = items || [];
  menuState.x = x;
  menuState.y = y;
  menuState.open = true;
  requestAnimationFrame(() => menuState.open && clamp(0, ".menu-root", false));
}

/** Open a cascading child menu anchored to a root item's element. */
export function openSubmenu(anchorEl, items) {
  const r = anchorEl.getBoundingClientRect();
  menuState.sub.items = items || [];
  menuState.sub.x = r.right + 2;
  menuState.sub.y = r.top - 5;
  menuState.sub.open = true;
  requestAnimationFrame(() => menuState.sub.open && clamp(r.left, ".menu-sub", true));
}

export function closeSubmenu() {
  if (menuState.sub.open) menuState.sub.open = false;
}

export function closeMenu() {
  menuState.sub.open = false;
  if (menuState.open) menuState.open = false;
}

/**
 * Build an `oncontextmenu` handler that opens a menu at the cursor. Pass either a
 * static item array or a `(event) => items` builder (use the builder when the menu
 * depends on state at click time). Prevents the native browser menu.
 */
export function contextMenu(items) {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, typeof items === "function" ? items(e) : items);
  };
}
