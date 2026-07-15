// The toast host, mounted once at the desktop level. Renders the shared toast list
// (os/notify.js) as a bottom-right stack above the dock. Rows are homogeneous
// <div>s (the reconciler diffs a uniform list); click a toast to dismiss early.

import { toastState, dismiss } from "../os/notify.js";

export default function Toasts() {
  return (
    <div class="toasts">
      {toastState.list.map((t) => (
        <div key={t.id} class={"toast toast-" + t.kind} onclick={() => dismiss(t.id)}>
          <span class="toast-ico">{t.kind === "success" ? "✓" : t.kind === "error" ? "!" : "·"}</span>
          <span class="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
