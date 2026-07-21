// The context-menu host, mounted once at the desktop level (like ui/Dialog). It
// renders the active menu — and its one cascading child — from os/menus.js. Any
// pointerdown outside a menu, a scroll, a window blur, or Escape dismisses it.
//
// Items are data, so this component is the one place that turns a menu descriptor
// into DOM — every app's right-click menu looks and behaves the same. Each row is
// the SAME element (a <button>) so the framework's list reconciler diffs a
// homogeneous list; a separator is a non-interactive button styled as a divider.
// The submenu is rendered as its own sibling list (not nested) for the same reason.

import { onMount } from "@opentf/web";
import { menuState, closeMenu, closeSubmenu, openSubmenu } from "../os/menus.js";

export default function ContextMenu() {
  onMount(() => {
    const onDown = (e) => { if (!e.target.closest(".menu")) closeMenu(); };
    const onKey = (e) => { if (e.key === "Escape") closeMenu(); };
    const onScroll = () => closeMenu();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("scroll", onScroll, true);
    };
  });

  // Root-item click: submenu parents open on hover (ignore click); everything else
  // runs its action and dismisses the whole menu.
  const run = (it) => {
    if (it.separator || it.disabled || it.submenu) return;
    closeMenu();
    if (typeof it.action === "function") it.action();
  };
  // Hovering a root item opens its submenu, or closes any open one.
  const hover = (it, e) => {
    if (it.submenu) openSubmenu(e.currentTarget, it.submenu);
    else closeSubmenu();
  };
  const runSub = (it) => {
    if (it.separator || it.disabled) return;
    closeMenu();
    if (typeof it.action === "function") it.action();
  };

  const itemClass = (it) =>
    "menu-item" +
    (it.separator ? " is-sep" : "") +
    (it.submenu ? " has-sub" : "") +
    (it.danger ? " is-danger" : "") +
    (it.disabled ? " is-disabled" : "");

  return menuState.open ? (
    <div class="menu-portal" onpointerdown={(e) => e.stopPropagation()} oncontextmenu={(e) => e.preventDefault()}>
      <div class="menu menu-root" style={`left:${menuState.x}px;top:${menuState.y}px`}>
        {menuState.items.map((it) => (
          <button class={itemClass(it)} onclick={() => run(it)} onpointerenter={(e) => hover(it, e)}>
            <span class="menu-ico">{it.icon || ""}</span>
            <span class="menu-label">{it.label || ""}</span>
            <span class="menu-check">{it.checked ? "✓" : ""}</span>
            <span class="menu-arrow">{it.submenu ? "▸" : ""}</span>
          </button>
        ))}
      </div>
      {() =>
        menuState.sub.open ? (
          <div class="menu menu-sub" style={`left:${menuState.sub.x}px;top:${menuState.sub.y}px`}>
            {menuState.sub.items.map((it) => (
              <button class={itemClass(it)} onclick={() => runSub(it)}>
                <span class="menu-ico">{it.icon || ""}</span>
                <span class="menu-label">{it.label || ""}</span>
                <span class="menu-check">{it.checked ? "✓" : ""}</span>
              </button>
            ))}
          </div>
        ) : null
      }
    </div>
  ) : null;
}
