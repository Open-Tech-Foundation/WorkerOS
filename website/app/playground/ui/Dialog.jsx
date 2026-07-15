// The modal dialog host, mounted once at the desktop level. Renders the single
// active dialog from the dialog service (os/dialogs.js). `active` is a stable object
// (never null) toggled by `active.open`, so every field read here is safe even as
// the dialog opens and closes. Escape / backdrop click cancels; Enter confirms.
//
// A dialog with a `winId` is app-modal: the backdrop covers only that window's rect
// (so the rest of the desktop stays usable), matching how a real DE scopes a sheet
// to its parent window. Without one it falls back to desktop-modal (CSS inset:0).

import { onMount } from "@opentf/web";
import { dialogState, resolveDialog } from "../os/dialogs.js";
import { wm, workArea } from "../os/wm.js";

let keysBound = false;

export default function Dialog() {
  const a = dialogState.active;

  // The backdrop is a child of `.dt`, so absolute coords line up with window x/y/w/h.
  const backdropStyle = () => {
    const id = a.winId;
    if (id == null) return "";
    const w = wm.windows.find((x) => x.id === id);
    if (!w || w.state === "min") return "";
    if (w.state === "max") {
      const area = workArea();
      return `left:${area.left}px;top:${area.top}px;right:auto;bottom:auto;width:${area.right - area.left}px;height:${area.bottom - area.top}px`;
    }
    return `left:${w.x}px;top:${w.y}px;right:auto;bottom:auto;width:${w.w}px;height:${w.h}px;border-radius:11px`;
  };

  const confirm = () => {
    if (!a.open) return;
    if (a.kind === "prompt") resolveDialog(a.value);
    else if (a.kind === "confirm") resolveDialog(true);
    else resolveDialog(undefined);
  };
  const cancel = () => {
    if (!a.open) return;
    resolveDialog(a.kind === "prompt" ? null : a.kind === "confirm" ? false : undefined);
  };

  // Escape cancels from anywhere, not just the prompt input — a confirm/alert has no
  // input to hold focus. Capture phase so it beats the launcher's Escape handler.
  // `keysBound` guards the SSG hydration double-mount from stacking listeners.
  onMount(() => {
    if (typeof document === "undefined" || keysBound) return;
    keysBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !dialogState.active.open) return;
      e.stopPropagation();
      cancel();
    }, true);
  });

  return dialogState.active.open ? (
    <div class={"dlg-backdrop" + (a.winId != null ? " is-win" : "")} style={backdropStyle()} onpointerdown={cancel}>
      <div class="dlg" onpointerdown={(e) => e.stopPropagation()}>
        {() => (a.title ? <div class="dlg-title">{a.title}</div> : null)}
        {() => (a.message ? <div class="dlg-msg">{a.message}</div> : null)}
        {() =>
          a.kind === "prompt" ? (
            <input
              class="dlg-input"
              spellcheck="false"
              autofocus
              value={a.value}
              placeholder={a.placeholder}
              oninput={(e) => (a.value = e.target.value)}
              onkeydown={(e) => { if (e.key === "Enter") confirm(); else if (e.key === "Escape") cancel(); }}
            />
          ) : null
        }
        <div class="dlg-actions">
          {() => (a.kind !== "alert" ? <button class="dlg-btn" onclick={cancel}>Cancel</button> : null)}
          <button class={"dlg-btn dlg-primary" + (a.danger ? " dlg-danger" : "")} onclick={confirm}>
            {() => a.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;
}
