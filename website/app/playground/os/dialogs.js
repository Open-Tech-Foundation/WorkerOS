// A promise-based modal dialog service for the DE: confirm / prompt / alert. One
// dialog is active at a time (rendered by ui/Dialog.jsx at the desktop level). Apps
// call these and `await` the result instead of using the browser's blocking
// window.confirm/prompt — so dialogs are themed, non-blocking, and consistent.

import { reactive } from "@opentf/web";

// `active` is never nulled — visibility is the `open` flag. (Nulling it would let a
// reactive child text binding read `active.title` on a null during teardown and
// throw; keeping a stable object makes every field read safe.)
export const dialogState = reactive({
  active: { kind: "alert", title: "", message: "", value: "", placeholder: "", confirmLabel: "OK", danger: false, open: false },
});

let resolver = null;

function open(spec) {
  // Replace any in-flight dialog (resolve it as cancelled) so we never leak one.
  if (resolver) { const r = resolver; resolver = null; r(spec.kind === "prompt" ? null : false); }
  return new Promise((resolve) => {
    resolver = resolve;
    Object.assign(dialogState.active, {
      kind: spec.kind,
      title: spec.title || "",
      message: spec.message || "",
      value: spec.value || "",
      placeholder: spec.placeholder || "",
      confirmLabel: spec.confirmLabel || "OK",
      danger: !!spec.danger,
      open: true,
    });
  });
}

/** Ask yes/no. Resolves `true` (confirmed) or `false` (cancelled). */
export const confirmDialog = (opts) => open({ ...opts, kind: "confirm" });
/** Ask for a string. Resolves the entered value, or `null` if cancelled. */
export const promptDialog = (opts) => open({ ...opts, kind: "prompt" });
/** Show a message with a single OK. Resolves when dismissed. */
export const alertDialog = (opts) => open({ ...opts, kind: "alert", confirmLabel: opts.confirmLabel || "OK" });

/** Close the active dialog with a result (called by ui/Dialog.jsx). */
export function resolveDialog(result) {
  const r = resolver;
  resolver = null;
  dialogState.active.open = false;
  if (r) r(result);
}
