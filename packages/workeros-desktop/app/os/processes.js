// Live process-table state for the Processes app: one shared poll loop over
// `os.ps()` (ref-counted so several Processes windows don't each poll), plus a
// kill action. The reactive store re-renders any open Processes window as the
// table changes.

import { reactive } from "@opentf/web";
import { getOS } from "./os.js";

/** @typedef {{pid:number, ppid:number, pgid:number, argv:string[], cwd:string,
 *   state:string, exit_code:number|null, kill_reason:string|null, start_time:number}} Proc */

export const procs = reactive({
  /** @type {Proc[]} */ list: [],
  error: null,
  loaded: false,
});

let timer = null;
let refs = 0;

/** Fetch a fresh snapshot into the store. */
export async function refreshProcs() {
  try {
    const os = await getOS();
    procs.list = await os.ps();
    procs.error = null;
    procs.loaded = true;
  } catch (e) {
    procs.error = String(e?.message || e);
  }
}

/** Begin polling (idempotent, ref-counted). Returns a stop fn for onMount cleanup. */
export function startPolling(intervalMs = 1500) {
  refs++;
  if (!timer) {
    refreshProcs();
    timer = setInterval(refreshProcs, intervalMs);
  }
  return () => {
    if (--refs <= 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Signal a process (default SIGTERM), then refresh shortly after so the table
 *  reflects the exit. SIGKILL (9) is the forceful option. */
export async function killProc(pid, signal = 15) {
  const os = await getOS();
  os.kill(pid, signal);
  setTimeout(refreshProcs, 150);
}
