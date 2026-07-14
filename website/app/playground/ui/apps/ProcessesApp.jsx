// A live process monitor: polls the kernel's real process table (os.ps()) and
// renders it, with per-row SIGTERM/SIGKILL. Proves the processes are real —
// spawn something in a Terminal window and watch it appear here, then kill it.

import { onMount } from "@opentf/web";
import { procs, startPolling, refreshProcs } from "../../os/processes.js";
import { contextMenu } from "../../os/menus.js";
import ProcRow from "./ProcRow.jsx";

export default function ProcessesApp() {
  onMount(() => startPolling());

  const bgMenu = contextMenu([{ label: "Refresh", icon: "↻", action: () => refreshProcs() }]);

  return (
    <div class="app-proc" oncontextmenu={bgMenu}>
      <div class="proc-bar">
        <span class="proc-count">
          {() => (procs.loaded ? `${procs.list.length} process${procs.list.length === 1 ? "" : "es"}` : "loading…")}
        </span>
        <button class="proc-refresh" title="Refresh now" onclick={() => refreshProcs()}>↻</button>
      </div>

      <div class="proc-table">
        <div class="proc-row proc-head">
          <span class="proc-pid">PID</span>
          <span class="proc-ppid">PPID</span>
          <span class="proc-state">STATE</span>
          <span class="proc-cmd">COMMAND</span>
          <span class="proc-act" />
        </div>
        <div class="proc-body">
          {procs.list.map((p) => (
            <ProcRow proc={p} />
          ))}
        </div>
      </div>

      {() => (procs.error ? <div class="proc-error">{procs.error}</div> : null)}
    </div>
  );
}
