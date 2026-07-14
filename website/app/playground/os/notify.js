// A lightweight toast/notification service — the DE-wide way for apps to report a
// non-modal outcome (saved, deleted, failed) without a blocking dialog. One shared
// reactive list rendered by ui/Toasts at the desktop level; toasts auto-dismiss
// after a TTL, or on click. Like the other services (dialogs/menus), apps call a
// plain function and never touch UI.

import { reactive } from "@opentf/web";

export const toastState = reactive({ /** @type {Array<{id:number,kind:string,text:string}>} */ list: [] });

let nextId = 1;

/** Show a toast. `opts`: { kind: "info"|"success"|"error", ttl:ms (0 = sticky) }. */
export function notify(text, opts = {}) {
  const id = nextId++;
  const kind = opts.kind || "info";
  const ttl = opts.ttl ?? 3500;
  toastState.list.push({ id, kind, text: String(text) });
  if (ttl > 0) setTimeout(() => dismiss(id), ttl);
  return id;
}

export const notifySuccess = (text, opts) => notify(text, { ...opts, kind: "success" });
export const notifyError = (text, opts) => notify(text, { ttl: 6000, ...opts, kind: "error" });

export function dismiss(id) {
  const i = toastState.list.findIndex((t) => t.id === id);
  if (i >= 0) toastState.list.splice(i, 1);
}
