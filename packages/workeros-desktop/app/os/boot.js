// The desktop's boot sequence — the staged startup the splash reports on.
//
// Booting a real kernel (worker + wasm) and reading the session back off the FS takes
// a moment, and until it lands there is nothing to paint. Rather than leave a blank
// page, the DE runs its startup as explicit stages and publishes progress here, so
// ui/BootSplash.jsx can show what the OS is actually doing.
//
// Each stage is best-effort: a stage that throws is logged into `error` and boot
// continues, because a failed session restore must still land you on a desktop.

import { reactive } from "@opentf/web";
import { getOS } from "./os.js";
import { seedHome } from "./vfs.js";
import { startState } from "./state.js";

// The stages, in order. `label` is what the splash shows while the stage runs.
const STAGES = [
  { label: "Starting kernel", run: () => getOS() },
  { label: "Mounting filesystem", run: () => seedHome() },
  { label: "Restoring session", run: () => startState() },
];

export const bootState = reactive({
  step: 0, // stages completed
  total: STAGES.length,
  label: STAGES[0].label,
  done: false,
  error: null,
});

// The number of windows restored by the session stage — the desktop needs it to
// decide whether to open a fresh Welcome window.
let restored = 0;

let booting = null;

/**
 * Run the boot sequence once. Resolves with the number of windows restored from the
 * saved session. Idempotent: the module-level promise survives the SSG hydration
 * double-mount, so the kernel is never booted twice.
 */
export function bootDesktop() {
  if (!booting) booting = run();
  return booting;
}

async function run() {
  for (const stage of STAGES) {
    bootState.label = stage.label;
    try {
      const out = await stage.run();
      if (typeof out === "number") restored = out;
    } catch (e) {
      // Keep going: a broken stage costs a feature, not the whole desktop.
      bootState.error = String(e?.message || e);
    }
    bootState.step++;
  }
  bootState.label = "Welcome";
  bootState.done = true;
  return restored;
}
