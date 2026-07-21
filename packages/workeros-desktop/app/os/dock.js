// Which apps are pinned to the dock. Starts from the registry's `pinned` flag but is
// reactive and user-editable (pin/unpin from the dock or launcher right-click menu),
// and persisted to the FS by os/state.js. The dock renders `dockState.pinned` in
// order; unpinning an app just drops its icon (its windows are untouched).

import { reactive } from "@opentf/web";
import { APP_META } from "./apps.js";

export const dockState = reactive({
  /** @type {string[]} app ids, in dock order */
  pinned: APP_META.filter((a) => a.pinned).map((a) => a.id),
});

export const isPinned = (id) => dockState.pinned.includes(id);

export function pin(id) {
  if (!isPinned(id)) dockState.pinned.push(id);
}

export function unpin(id) {
  const i = dockState.pinned.indexOf(id);
  if (i >= 0) dockState.pinned.splice(i, 1);
}

export function togglePin(id) {
  isPinned(id) ? unpin(id) : pin(id);
}
