// The modal dialog host, mounted once at the desktop level. Renders the single
// active dialog from the dialog service (os/dialogs.js). `active` is a stable object
// (never null) toggled by `active.open`, so every field read here is safe even as
// the dialog opens and closes. Escape / backdrop click cancels; Enter confirms.

import { dialogState, resolveDialog } from "../os/dialogs.js";

export default function Dialog() {
  const a = dialogState.active;

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

  return dialogState.active.open ? (
    <div class="dlg-backdrop" onpointerdown={cancel}>
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
